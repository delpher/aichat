import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { connect, nextMessage, startBroker, tok } from "./helpers.js";
import { Store } from "../broker/store.js";
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

    const a = await bot<{ note: AgentNote }>("POST", "/api/notes", {
      title: "  Як   писати Олені ",
      description: " Олена любить короткі відповіді ",
      text: " Довга історія про те, як ми це з'ясували. ",
      topic: " люди ",
    });
    assert.equal(a.status, 201);
    assert.deepEqual({ ...a.data.note, id: 0, ts: "" }, {
      id: 0,
      topic: "люди",
      title: "Як писати Олені",
      description: "Олена любить короткі відповіді",
      text: "Довга історія про те, як ми це з'ясували.",
      text_length: 41,
      ts: "",
    });
    const b = await bot<{ note: AgentNote }>("POST", "/api/notes", { title: "Тести", description: "npm test зависає без тайм-ауту" });
    assert.equal(b.data.note.topic, undefined);
    assert.equal(b.data.note.text, undefined);
    assert.equal(b.data.note.text_length, undefined);

    // recall: title, description, text or topic, any case; the list leaves the texts out
    const recall = async (q: string) =>
      (await bot<{ notes: AgentNote[] }>("GET", `/api/notes?${q}`)).data.notes.map((n) => n.id);
    assert.deepEqual(await recall("q=ОЛЕНА"), [a.data.note.id]);
    assert.deepEqual(await recall("q=писати"), [a.data.note.id]);
    assert.deepEqual(await recall("q=історія"), [a.data.note.id]);
    assert.deepEqual(await recall("q=Люди"), [a.data.note.id]);
    assert.deepEqual(await recall("topic=ЛЮДИ"), [a.data.note.id]);
    assert.deepEqual(await recall("q=tests"), []);
    const all = await bot<{ notes: AgentNote[]; count: number; max: number }>("GET", "/api/notes");
    assert.deepEqual(all.data.notes.map((n) => n.id), [a.data.note.id, b.data.note.id]);
    assert.equal(all.data.notes[0].text, undefined);
    assert.equal(all.data.notes[0].text_length, 41);
    assert.equal(all.data.count, 2);
    assert.equal(all.data.max, 200);

    // one note comes with its text
    const one = await bot<{ note: AgentNote }>("GET", `/api/notes/${a.data.note.id}`);
    assert.equal(one.data.note.text, "Довга історія про те, як ми це з'ясували.");
    assert.equal((await bot("GET", "/api/notes/999")).status, 404);

    // change overwrites: a missing field keeps its value, an empty text or topic removes it
    let c = await bot<{ note: AgentNote }>("PUT", `/api/notes/${a.data.note.id}`, { description: "Олена любить довгі відповіді" });
    assert.equal(c.data.note.topic, "люди");
    assert.equal(c.data.note.title, "Як писати Олені");
    assert.equal(c.data.note.text, "Довга історія про те, як ми це з'ясували.");
    c = await bot<{ note: AgentNote }>("PUT", `/api/notes/${a.data.note.id}`, { topic: "", text: "" });
    assert.equal(c.data.note.description, "Олена любить довгі відповіді");
    assert.equal(c.data.note.topic, undefined);
    assert.equal(c.data.note.text, undefined);
    assert.deepEqual(await recall("q=короткі"), []);

    assert.equal((await bot("DELETE", `/api/notes/${b.data.note.id}`)).status, 200);
    assert.equal((await bot("DELETE", `/api/notes/${b.data.note.id}`)).status, 404);
    me = await bot("GET", "/api/me");
    assert.equal(me.data.notes.count, 1);
    assert.equal(me.data.notes.last_ts, c.data.note.ts);

    // bad input
    const ok = { title: "t", description: "d" };
    assert.equal((await bot("POST", "/api/notes", { description: "no title" })).status, 400);
    assert.equal((await bot("POST", "/api/notes", { title: "no description" })).status, 400);
    assert.equal((await bot("POST", "/api/notes", { ...ok, title: "   " })).status, 400);
    assert.equal((await bot("POST", "/api/notes", { ...ok, title: "t".repeat(101) })).status, 400);
    assert.equal((await bot("POST", "/api/notes", { ...ok, description: "x".repeat(1001) })).status, 400);
    assert.equal((await bot("POST", "/api/notes", { ...ok, text: "x".repeat(5001) })).status, 400);
    assert.equal((await bot("POST", "/api/notes", { ...ok, topic: "t".repeat(101) })).status, 400);
    assert.equal((await bot("PUT", `/api/notes/${a.data.note.id}`, { description: "" })).status, 400);
    assert.equal((await bot("PUT", "/api/notes/999", { title: "x" })).status, 404);

    // the database keeps no earlier versions
    const rows = (broker.store as unknown as { db: { prepare(s: string): { all(): unknown[] } } }).db
      .prepare("SELECT description FROM notes")
      .all() as { description: string }[];
    assert.deepEqual(rows.map((r) => r.description), ["Олена любить довгі відповіді"]);
  } finally {
    await broker.close();
  }
});

test("notebook: limits come from the settings", async () => {
  const { broker, http } = await startBroker([{ name: "bot" }, BOSS], { maxNotes: 2, maxNoteDescription: 100, maxNoteText: 200 });
  try {
    const bot = api(http, "bot");
    const note = (title: string, more: object = {}) => bot("POST", "/api/notes", { title, description: "d", ...more });
    assert.equal((await note("long", { description: "x".repeat(101) })).status, 400);
    assert.equal((await note("long", { text: "x".repeat(201) })).status, 400);
    assert.equal((await note("one", { text: "x".repeat(200) })).status, 201);
    assert.equal((await note("two")).status, 201);
    const full = await note("three");
    assert.equal(full.status, 409);
    assert.match(String(full.data.error), /full/);
    const boss = api(http, "boss");
    assert.equal((await boss("PATCH", "/admin/api/settings", { maxNotes: 3 })).status, 200);
    assert.equal((await note("three")).status, 201);
  } finally {
    await broker.close();
  }
});

test("notebook: notes written as one text get a title and a description when the broker starts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aichat-notes-"));
  const file = join(dir, "aichat.db");
  try {
    const old = new DatabaseSync(file);
    old.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY AUTOINCREMENT, agent TEXT NOT NULL, topic TEXT, text TEXT NOT NULL, ts TEXT NOT NULL)");
    const add = old.prepare("INSERT INTO notes (agent, topic, text, ts) VALUES (?, ?, ?, ?)");
    add.run("bot", "команда", "Мержить alexey. Реліз лише з його слова.", "2026-11-17T18:00:00.000Z");
    const long = "Перше речення довгого запису. " + "слово ".repeat(300);
    add.run("bot", null, long, "2026-11-17T18:01:00.000Z");
    old.close();

    const store = new Store(file);
    try {
      const [short, big] = store.notes("bot", {}, true);
      assert.equal(short.title, "Мержить alexey");
      assert.equal(short.description, "Мержить alexey. Реліз лише з його слова.");
      assert.equal(short.text, undefined);
      assert.equal(short.topic, "команда");
      assert.equal(short.ts, "2026-11-17T18:00:00.000Z");
      assert.equal(big.title, "Перше речення довгого запису");
      assert.ok(big.description.length <= 1000);
      assert.ok(long.startsWith(big.description.replace(/…$/, "")));
      assert.equal(big.text, long);
    } finally {
      store.close();
    }
    // a second start changes nothing
    const again = new Store(file);
    try {
      assert.equal(again.notes("bot", {}, true)[0].title, "Мержить alexey");
    } finally {
      again.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("notebook: people read anyone's notes with their texts, agents only their own", async () => {
  const { broker, http } = await startBroker([{ name: "bot" }, { name: "spy" }, { name: "olena", kind: "human" }, BOSS]);
  try {
    const bot = api(http, "bot");
    const spy = api(http, "spy");
    const { data } = await bot<{ note: AgentNote }>("POST", "/api/notes", { title: "моя", description: "моя нотатка", text: "подробиці" });

    const seen = await api(http, "olena")<{ notes: AgentNote[] }>("GET", "/api/agents/bot/notes");
    assert.equal(seen.status, 200);
    assert.deepEqual(seen.data.notes, [data.note]);
    assert.equal(seen.data.notes[0].text, "подробиці");
    assert.equal((await api(http, "boss")("GET", "/api/agents/bot/notes")).status, 200);
    assert.equal((await bot("GET", "/api/agents/bot/notes")).status, 200);
    assert.equal((await api(http, "olena")("GET", "/api/agents/nobody/notes")).status, 404);

    // another agent: refused, and its own notebook does not reach bot's notes
    assert.equal((await spy("GET", "/api/agents/bot/notes")).status, 403);
    assert.deepEqual((await spy<{ notes: AgentNote[] }>("GET", "/api/notes")).data.notes, []);
    assert.equal((await spy("GET", `/api/notes/${data.note.id}`)).status, 404);
    assert.equal((await spy("PUT", `/api/notes/${data.note.id}`, { title: "hacked" })).status, 404);
    assert.equal((await spy("DELETE", `/api/notes/${data.note.id}`)).status, 404);
    assert.equal((await bot<{ notes: AgentNote[] }>("GET", "/api/notes")).data.notes[0].description, "моя нотатка");
  } finally {
    await broker.close();
  }
});

test("removing an agent removes its notebook", async () => {
  const { broker, http } = await startBroker([{ name: "bot" }, { name: "olena", kind: "human" }, BOSS]);
  try {
    await api(http, "bot")("POST", "/api/notes", { title: "x", description: "x" });
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
