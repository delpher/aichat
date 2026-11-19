import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentNote, ChatMessage, WorldIntro } from "../protocol.js";
import { WAKE_ADVICE, awayText, greeting, introText, notebookText, plural, type WakeInfo } from "../broker/wake.js";
import { BrokerClient } from "../client/broker-client.js";
import { connect, startBroker, tok } from "./helpers.js";

const settle = () => new Promise((r) => setTimeout(r, 120));

/** The intro a broker serves while no admin has saved one. */
const DRAFT: WorldIntro = { text: "", by: "aichat", ts: "1970-01-01T00:00:00.000Z", draft: true };

/** The whole notice after an absence: what was missed, the notebook, the intro's version, the advice. */
const report = (head: string, notes: AgentNote[] = [], intro = DRAFT) => [head, notebookText(notes), introText(intro), WAKE_ADVICE].join("\n\n");

/** Everything a fresh connection of `name` gets pushed in its first moments; `session` as an adapter sends it. */
async function arrivals(url: string, name: string, session?: string) {
  const got: ChatMessage[] = [];
  const c = new BrokerClient({ url, token: tok(name), reconnect: false, log: () => {}, ...(session ? { session } : {}) });
  c.on("message", (m: ChatMessage) => got.push(m));
  await c.connect();
  await settle();
  return { c, got };
}

async function setup(wakeMode: string, withKeeper = true) {
  let clock = Date.parse("2026-11-17T10:00:00Z");
  const b = await startBroker(
    [
      { name: "bot1", kind: "claude", rooms: ["lab", "design"] },
      { name: "bot2", kind: "claude", rooms: ["lab", "design"] },
      { name: "fresh", kind: "claude", rooms: ["lab"] },
      ...(withKeeper ? [{ name: "keeper", kind: "claude", keeper: true }] : []),
    ],
    { wakeMode, wakeAfterMinutes: 10, wakeAfterMessages: 10 },
    { now: () => clock },
  );
  const wakes: WakeInfo[] = [];
  b.broker.onWake((w) => wakes.push(w));
  return { ...b, wakes, tick: (minutes: number) => (clock += minutes * 60_000) };
}

/** bot1 leaves, bot2 writes three room messages and a DM, half an hour passes. */
async function missSome(url: string, tick: (m: number) => void) {
  const bot1 = await connect(url, "bot1");
  const bot2 = await connect(url, "bot2");
  bot1.close();
  await settle();
  await bot2.send({ room: "lab", text: "перше" });
  await bot2.send({ room: "lab", text: "друге\nз переносом" });
  await bot2.send({ room: "design", text: "ескіз" });
  await bot2.send({ to: "bot1", text: "лише тобі" });
  tick(30);
  return bot2;
}

test("В1 (brief): the keeper gets the diff to write the brief, and the woken agent the whole stream and the broker's notice", async () => {
  const { broker, url, wakes, tick } = await setup("brief");
  const keeper = await arrivals(url, "keeper");
  const bot2 = await missSome(url, tick);
  const bot1 = await arrivals(url, "bot1");
  try {
    assert.equal(wakes.length, 1);
    // the stream as before: three room messages and the DM; then the broker's notice, which names the keeper
    assert.deepEqual(bot1.got.filter((m) => m.from === "bot2").map((m) => m.text), ["перше", "друге\nз переносом", "ескіз", "лише тобі"]);
    const notice = bot1.got.filter((m) => m.from === "aichat");
    assert.equal(notice.length, 1);
    assert.equal(
      notice[0].text,
      report("Тебе не було 30 хв. За цей час у твоїх кімнатах 3 нові повідомлення (#design: 1, #lab: 2).\nkeeper зараз напише тобі, що там було."),
    );
    // the keeper's diff, by contract: first line, rooms newest first, one line per message
    const diff = keeper.got.filter((m) => m.from === "aichat");
    assert.equal(diff.length, 1);
    assert.equal(diff[0].to, "keeper");
    const lines = diff[0].text.split("\n");
    assert.equal(lines[0], "[wake] agent=bot1 away=1800 missed=3");
    assert.equal(lines[1], "#design: 1");
    assert.match(lines[2], /^\[#\d+ .+\] bot2: ескіз$/);
    assert.equal(lines[3], "#lab: 2");
    assert.match(lines[5], /bot2: друге↵з переносом$/);
    // the DM is not in it
    assert.doesNotMatch(diff[0].text, /лише тобі/);
  } finally {
    keeper.c.close();
    bot1.c.close();
    bot2.close();
    await broker.close();
  }
});

test("В2 (on), keeper offline: the broker itself tells the agent what it missed, and sends no room stream", async () => {
  const { broker, url, wakes, tick } = await setup("on");
  const bot2 = await missSome(url, tick);
  const bot1 = await arrivals(url, "bot1");
  try {
    assert.equal(wakes.length, 1);
    assert.deepEqual(bot1.got.filter((m) => m.from === "bot2").map((m) => m.text), ["лише тобі"]);
    const notice = bot1.got.filter((m) => m.from === "aichat");
    assert.equal(notice.length, 1);
    assert.equal(notice[0].to, "bot1");
    assert.equal(
      notice[0].text,
      report(
        "Тебе не було 30 хв. За цей час у твоїх кімнатах 3 нові повідомлення (#design: 1, #lab: 2).\n" +
          "Самих повідомлень не надіслано, їх можна прочитати через read_history.",
      ),
    );
    // read_history has them all
    assert.equal((await bot1.c.history({ room: "lab" })).length, 2);
  } finally {
    bot1.c.close();
    bot2.close();
    await broker.close();
  }
});

test("В: nothing missed still wakes after a long absence, with the advice and without the keeper; a short one does not", async () => {
  const { broker, url, wakes, tick } = await setup("brief");
  const keeper = await arrivals(url, "keeper");
  const bot1 = await connect(url, "bot1");
  bot1.close();
  await settle();
  tick(5);
  let back = await arrivals(url, "bot1");
  try {
    // five minutes, nothing missed: below wakeAfterMinutes, so nothing at all
    assert.equal(wakes.length, 0);
    assert.equal(back.got.length, 0);
    back.c.close();
    await settle();
    tick(45);
    back = await arrivals(url, "bot1");
    assert.equal(wakes.length, 1);
    assert.equal(wakes[0].missed, 0);
    assert.deepEqual(back.got.map((m) => [m.from, m.text]), [
      ["aichat", report("Тебе не було 45 хв. У твоїх кімнатах за цей час нічого нового.")],
    ]);
    // nothing to retell: the keeper gets no diff
    assert.ok(!keeper.got.some((m) => m.from === "aichat"));
  } finally {
    back.c.close();
    keeper.c.close();
    await broker.close();
  }
});

test("В: no brief on a first connection, or without wake mode", async () => {
  const { broker, url, wakes, tick } = await setup("on", false);
  const bot2 = await connect(url, "bot2");
  try {
    for (let i = 0; i < 12; i++) await bot2.send({ room: "lab", text: `m${i}` });
    tick(60);
    // "fresh" never connected before: it gets the intro (adapter) and the stream, no brief
    const fresh = await arrivals(url, "fresh");
    assert.equal(wakes.length, 0);
    assert.equal(fresh.got.length, 12);
    assert.ok(!fresh.got.some((m) => m.from === "aichat"));
    fresh.c.close();
  } finally {
    bot2.close();
    await broker.close();
  }
  const off = await setup("off");
  try {
    const bot2b = await missSome(off.url, off.tick);
    const bot1 = await arrivals(off.url, "bot1");
    assert.equal(off.wakes.length, 0);
    assert.equal(bot1.got.length, 4);
    bot1.c.close();
    bot2b.close();
  } finally {
    await off.broker.close();
  }
});

test("a new adapter session is greeted; a reconnect of the same session is not; an adapter without a session is not (alexey, 1703)", async () => {
  // wake mode off: greeting does not depend on it
  const { broker, url, tick } = await setup("off", false);
  try {
    // a first connection of a new session: the greeting, and nothing else from the broker
    let s = await arrivals(url, "bot1", "session-a");
    assert.deepEqual(s.got.map((m) => [m.from, m.to, m.text]), [["aichat", "bot1", greeting("bot1")]]);
    assert.match(greeting("bot1"), /^Привіт, ти в AIChat як bot1\. .*recall.*read_history/);
    s.c.close();
    await settle();

    // the same session comes back (a dropped connection): nothing
    tick(30);
    s = await arrivals(url, "bot1", "session-a");
    assert.equal(s.got.length, 0);
    s.c.close();
    await settle();

    // a new session: greeted again
    s = await arrivals(url, "bot1", "session-b");
    assert.deepEqual(s.got.map((m) => m.text), [greeting("bot1")]);
    s.c.close();

    // an older adapter sends no session: no greeting
    const old = await arrivals(url, "bot2");
    assert.equal(old.got.length, 0);
    old.c.close();
  } finally {
    await broker.close();
  }
});

test("a woken new session gets only the report: notes most recently changed first and the intro's version", async () => {
  const { broker, url, http, wakes, tick } = await setup("brief", false);
  try {
    let s = await arrivals(url, "bot1", "one");
    s.c.close();
    await settle();
    const remember = (body: object) =>
      fetch(`${http}/api/notes`, {
        method: "POST",
        headers: { authorization: `Bearer ${tok("bot1")}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    assert.equal((await remember({ title: "Olena", description: "prefers short answers", text: "said so", topic: "people" })).status, 201);
    tick(45);
    s = await arrivals(url, "bot1", "two");
    assert.equal(wakes.length, 1);
    const notes = (await (await fetch(`${http}/api/notes`, { headers: { authorization: `Bearer ${tok("bot1")}` } })).json()) as { notes: AgentNote[] };
    assert.deepEqual(s.got.map((m) => m.text), [report("Тебе не було 45 хв. У твоїх кімнатах за цей час нічого нового.", notes.notes)]);
    assert.match(s.got[0].text, /\n\nТвій нотатник: 1 нотатка, свіжі першими; recall\(id\) покаже нотатку з текстом:\n#\d+ \[people\] Olena \(.+\): prefers short answers \(text: 7 characters\)\n\n/);
    assert.match(s.got[0].text, /\n\nВводна AIChat: версія 1970-01-01T00:00:00\.000Z \(вбудована чернетка\)\. Якщо в тебе збережена саме ця версія, нічого робити не треба\. Інакше прочитай world_info/);
    assert.doesNotMatch(s.got[0].text, /said so/);
    s.c.close();
  } finally {
    await broker.close();
  }
});

test("the intro's version in the report: who saved it and when", () => {
  assert.equal(
    introText({ text: "x", by: "alexey", ts: "2026-11-19T12:00:00.000Z" }),
    "Вводна AIChat: версія 2026-11-19T12:00:00.000Z від alexey. Якщо в тебе збережена саме ця версія, нічого робити не треба. " +
      "Інакше прочитай world_info і збережи вводну собі (наприклад, у локальну пам'ять), щоб наступного разу лише звірити версію.",
  );
});

test("Ukrainian number agreement in the broker's notice", () => {
  const forms: [string, string, string] = ["нове повідомлення", "нові повідомлення", "нових повідомлень"];
  assert.deepEqual(
    [1, 2, 4, 5, 11, 12, 14, 21, 22, 25, 101, 111].map((n) => `${n} ${plural(n, forms)}`),
    [
      "1 нове повідомлення",
      "2 нові повідомлення",
      "4 нові повідомлення",
      "5 нових повідомлень",
      "11 нових повідомлень",
      "12 нових повідомлень",
      "14 нових повідомлень",
      "21 нове повідомлення",
      "22 нові повідомлення",
      "25 нових повідомлень",
      "101 нове повідомлення",
      "111 нових повідомлень",
    ],
  );
});

test("absence in plain words", () => {
  assert.equal(awayText(20), "1 хв");
  assert.equal(awayText(5 * 60), "5 хв");
  assert.equal(awayText(90 * 60), "1 год 30 хв");
  assert.equal(awayText(3 * 3600), "3 год");
  assert.equal(awayText(51 * 3600), "2 дн 3 год");
});
