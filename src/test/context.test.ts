import { test } from "node:test";
import assert from "node:assert/strict";
import { connect, nextMessage, startBroker, tok } from "./helpers.js";
import type { AgentNote, WorldIntro } from "../protocol.js";

const BOSS = { name: "boss", kind: "human", admin: true };

function api(http: string, who: string) {
  return async <T = Record<string, unknown>>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> => {
    const r = await fetch(`${http}${path}`, {
      method,
      headers: { authorization: `Bearer ${tok(who)}`, "content-type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: r.status, data: (await r.json()) as T };
  };
}

test("world intro: any token reads it (the draft until an admin saves one), only admins write it", async () => {
  const { broker, http } = await startBroker([{ name: "bot" }, { name: "olena", kind: "human" }, BOSS]);
  try {
    const bot = api(http, "bot");
    const boss = api(http, "boss");
    const first = await bot<{ intro: WorldIntro; limits: Record<string, number> }>("GET", "/api/intro");
    assert.equal(first.data.intro.draft, true);
    assert.equal(first.data.intro.by, "aichat");
    assert.match(first.data.intro.text, /^# AIChat/);
    assert.deepEqual(first.data.limits, { maxHops: 8, ratePerMinute: 30, maxTextLength: 20000, maxFileSizeMB: 20 });
    assert.equal((await bot("PUT", "/admin/api/intro", { text: "hi" })).status, 401);
    assert.equal((await api(http, "olena")("PUT", "/admin/api/intro", { text: "hi" })).status, 401);

    const r = await boss<{ intro: WorldIntro }>("PUT", "/admin/api/intro", { text: "  AIChat: люди й агенти разом.  " });
    assert.equal(r.status, 200);
    assert.equal(r.data.intro.text, "AIChat: люди й агенти разом.");
    assert.equal(r.data.intro.by, "boss");
    assert.equal(r.data.intro.draft, undefined);
    assert.equal((await bot<{ intro: WorldIntro }>("GET", "/api/intro")).data.intro.text, "AIChat: люди й агенти разом.");

    assert.equal((await boss("PUT", "/admin/api/intro", { text: "x".repeat(4001) })).status, 400);
    assert.equal((await boss("PUT", "/admin/api/intro", { text: 5 })).status, 400);
    // clearing the saved intro brings the draft back
    assert.equal((await boss<{ intro: WorldIntro }>("PUT", "/admin/api/intro", { text: "" })).data.intro.draft, true);
    assert.equal((await bot<{ intro: WorldIntro }>("GET", "/api/intro")).data.intro.draft, true);
  } finally {
    await broker.close();
  }
});

test("notebook: remember, recall, change and forget keep only the current state", async () => {
  const { broker, http } = await startBroker([{ name: "bot" }]);
  try {
    const bot = api(http, "bot");
    let me = await bot<{ notes: { count: number; last_ts: string | null } }>("GET", "/api/me");
    assert.deepEqual(me.data.notes, { count: 0, last_ts: null });

    const a = await bot<{ note: AgentNote }>("POST", "/api/notes", { text: " Олена любить короткі відповіді ", topic: " люди " });
    assert.equal(a.status, 201);
    assert.equal(a.data.note.text, "Олена любить короткі відповіді");
    assert.equal(a.data.note.topic, "люди");
    const b = await bot<{ note: AgentNote }>("POST", "/api/notes", { text: "npm test зависає без тайм-ауту" });
    assert.equal(b.data.note.topic, undefined);

    // recall: text or topic, any case
    const recall = async (q: string) =>
      (await bot<{ notes: AgentNote[] }>("GET", `/api/notes?${q}`)).data.notes.map((n) => n.id);
    assert.deepEqual(await recall("q=ОЛЕНА"), [a.data.note.id]);
    assert.deepEqual(await recall("q=Люди"), [a.data.note.id]);
    assert.deepEqual(await recall("topic=ЛЮДИ"), [a.data.note.id]);
    assert.deepEqual(await recall("q=tests"), []);
    const all = await bot<{ notes: AgentNote[]; count: number; max: number }>("GET", "/api/notes");
    assert.deepEqual(all.data.notes.map((n) => n.id), [a.data.note.id, b.data.note.id]);
    assert.equal(all.data.count, 2);
    assert.equal(all.data.max, 200);

    // change overwrites: a missing field keeps its value, an empty topic removes it
    let c = await bot<{ note: AgentNote }>("PUT", `/api/notes/${a.data.note.id}`, { text: "Олена любить довгі відповіді" });
    assert.equal(c.data.note.topic, "люди");
    c = await bot<{ note: AgentNote }>("PUT", `/api/notes/${a.data.note.id}`, { topic: "" });
    assert.equal(c.data.note.text, "Олена любить довгі відповіді");
    assert.equal(c.data.note.topic, undefined);
    assert.deepEqual(await recall("q=короткі"), []);

    assert.equal((await bot("DELETE", `/api/notes/${b.data.note.id}`)).status, 200);
    assert.equal((await bot("DELETE", `/api/notes/${b.data.note.id}`)).status, 404);
    me = await bot("GET", "/api/me");
    assert.equal(me.data.notes.count, 1);
    assert.equal(me.data.notes.last_ts, c.data.note.ts);

    // bad input
    assert.equal((await bot("POST", "/api/notes", { text: "   " })).status, 400);
    assert.equal((await bot("POST", "/api/notes", { text: "x".repeat(2001) })).status, 400);
    assert.equal((await bot("POST", "/api/notes", { text: "ok", topic: "t".repeat(101) })).status, 400);
    assert.equal((await bot("PUT", "/api/notes/999", { text: "x" })).status, 404);

    // the database keeps no earlier versions
    const rows = (broker.store as unknown as { db: { prepare(s: string): { all(): unknown[] } } }).db
      .prepare("SELECT text FROM notes")
      .all() as { text: string }[];
    assert.deepEqual(rows.map((r) => r.text), ["Олена любить довгі відповіді"]);
  } finally {
    await broker.close();
  }
});

test("notebook: limits come from the settings", async () => {
  const { broker, http } = await startBroker([{ name: "bot" }, BOSS], { maxNotes: 2, maxNoteLength: 100 });
  try {
    const bot = api(http, "bot");
    assert.equal((await bot("POST", "/api/notes", { text: "x".repeat(101) })).status, 400);
    assert.equal((await bot("POST", "/api/notes", { text: "one" })).status, 201);
    assert.equal((await bot("POST", "/api/notes", { text: "two" })).status, 201);
    const full = await bot<{ error: string }>("POST", "/api/notes", { text: "three" });
    assert.equal(full.status, 409);
    assert.match(full.data.error, /full/);
    const boss = api(http, "boss");
    assert.equal((await boss("PATCH", "/admin/api/settings", { maxNotes: 3 })).status, 200);
    assert.equal((await bot("POST", "/api/notes", { text: "three" })).status, 201);
  } finally {
    await broker.close();
  }
});

test("notebook: people read anyone's notes, agents only their own", async () => {
  const { broker, http } = await startBroker([{ name: "bot" }, { name: "spy" }, { name: "olena", kind: "human" }, BOSS]);
  try {
    const bot = api(http, "bot");
    const spy = api(http, "spy");
    const { data } = await bot<{ note: AgentNote }>("POST", "/api/notes", { text: "моя нотатка" });

    const seen = await api(http, "olena")<{ notes: AgentNote[] }>("GET", "/api/agents/bot/notes");
    assert.equal(seen.status, 200);
    assert.deepEqual(seen.data.notes, [data.note]);
    assert.equal((await api(http, "boss")("GET", "/api/agents/bot/notes")).status, 200);
    assert.equal((await bot("GET", "/api/agents/bot/notes")).status, 200);
    assert.equal((await api(http, "olena")("GET", "/api/agents/nobody/notes")).status, 404);

    // another agent: refused, and its own notebook does not reach bot's notes
    assert.equal((await spy("GET", "/api/agents/bot/notes")).status, 403);
    assert.deepEqual((await spy<{ notes: AgentNote[] }>("GET", "/api/notes")).data.notes, []);
    assert.equal((await spy("PUT", `/api/notes/${data.note.id}`, { text: "hacked" })).status, 404);
    assert.equal((await spy("DELETE", `/api/notes/${data.note.id}`)).status, 404);
    assert.equal((await bot<{ notes: AgentNote[] }>("GET", "/api/notes")).data.notes[0].text, "моя нотатка");
  } finally {
    await broker.close();
  }
});

test("removing an agent removes its notebook", async () => {
  const { broker, http } = await startBroker([{ name: "bot" }, { name: "olena", kind: "human" }, BOSS]);
  try {
    await api(http, "bot")("POST", "/api/notes", { text: "x" });
    assert.equal((await api(http, "boss")("DELETE", "/admin/api/agents/bot")).status, 200);
    assert.equal(broker.store.noteStats("bot").count, 0);
  } finally {
    await broker.close();
  }
});

test("customization: admins change an agent's description after it was created", async () => {
  const { broker, http, cfg } = await startBroker([{ name: "bot", description: "old" }, BOSS]);
  try {
    const boss = api(http, "boss");
    const r = await boss<{ agent: { description?: string } }>("PATCH", "/admin/api/agents/bot", { description: "  Пише серверну частину.  " });
    assert.equal(r.status, 200);
    assert.equal(r.data.agent.description, "Пише серверну частину.");
    assert.equal(cfg().agents.find((a) => a.name === "bot")?.description, "Пише серверну частину.");
    const me = await api(http, "bot")<{ description?: string }>("GET", "/api/me");
    assert.equal(me.data.description, "Пише серверну частину.");

    assert.equal((await boss("PATCH", "/admin/api/agents/bot", { description: "x".repeat(301) })).status, 400);
    assert.equal((await boss("PATCH", "/admin/api/agents/bot", { description: 1 })).status, 400);
    assert.equal((await boss("PATCH", "/admin/api/agents/bot", { token: "x" })).status, 400);
    assert.equal((await boss("POST", "/admin/api/agents", { name: "long", kind: "claude", description: "x".repeat(301) })).status, 400);

    // empty removes it; admin and description can change together
    await boss("PATCH", "/admin/api/agents/bot", { description: "" });
    assert.equal(cfg().agents.find((a) => a.name === "bot")?.description, undefined);
    assert.equal((await api(http, "bot")("GET", "/api/me")).data.description, undefined);
    const both = await boss<{ agent: { admin: boolean; description?: string } }>("PATCH", "/admin/api/agents/boss", {
      admin: true,
      description: "Адмін",
    });
    assert.equal(both.status, 200);
    assert.equal(both.data.agent.description, "Адмін");
    assert.equal(both.data.agent.admin, true);
    // other people do not get to change it
    assert.equal((await api(http, "bot")("PATCH", "/admin/api/agents/bot", { description: "me" })).status, 401);
  } finally {
    await broker.close();
  }
});

test("changing the intro tells every agent online by a direct message from aichat; offline agents and people are not queued", async () => {
  const { broker, url, http } = await startBroker([{ name: "bot" }, { name: "sleeper" }, { name: "olena", kind: "human" }, BOSS]);
  try {
    const bot = await connect(url, "bot");
    const olena = await connect(url, "olena");
    const frames: unknown[] = [];
    olena.on("message", (m) => frames.push(m));
    const got = nextMessage(bot);
    await api(http, "boss")("PUT", "/admin/api/intro", { text: "Нова вводна." });
    const m = await got;
    assert.equal(m.from, "aichat");
    assert.equal(m.to, "bot");
    assert.equal(m.room, undefined);
    assert.equal(m.text, "boss змінив вводну AIChat. Нова вводна:\n\nНова вводна.");

    // the same text again: nothing is sent
    await api(http, "boss")("PUT", "/admin/api/intro", { text: "Нова вводна." });
    const cleared = nextMessage(bot);
    await api(http, "boss")("PUT", "/admin/api/intro", { text: "" });
    assert.match((await cleared).text, /^boss прибрав збережену вводну AIChat, тепер діє вбудована чернетка:\n\n# AIChat/);

    // an agent that was offline gets nothing queued: it reads the intro when its session starts
    const sleeper = await connect(url, "sleeper");
    assert.deepEqual(await sleeper.history({ with: "aichat" }), []);
    await assert.rejects(nextMessage(sleeper, 300));
    // people see the intro in the web, not as messages
    assert.deepEqual(frames, []);
    bot.close();
    olena.close();
    sleeper.close();
  } finally {
    await broker.close();
  }
});
