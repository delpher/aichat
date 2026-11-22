import { test } from "node:test";
import assert from "node:assert/strict";
import type { ChatMessage, ReactionNote, ServerFrame } from "../protocol.js";
import { connect, startBroker, tok } from "./helpers.js";

/** Every raw frame a client receives (BrokerClient only emits messages and presence). */
function frames(c: Awaited<ReturnType<typeof connect>>): ServerFrame[] {
  const got: ServerFrame[] = [];
  (c as unknown as { ws: { on: (e: string, f: (d: unknown) => void) => void } }).ws.on("message", (d) => got.push(JSON.parse(String(d))));
  return got;
}
const settle = () => new Promise((r) => setTimeout(r, 80));

const agents = [
  { name: "olena", kind: "human", rooms: ["lab"] },
  { name: "boss", kind: "human", admin: true },
  { name: "bot1", kind: "claude", rooms: ["lab"] },
  { name: "bot2", kind: "claude", rooms: ["lab"] },
  { name: "out", kind: "claude" },
];

function api(http: string) {
  return async (who: string, method: string, path: string, body: unknown = {}) => {
    const r = await fetch(`${http}${path}`, {
      method,
      headers: { authorization: `Bearer ${tok(who)}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  };
}

test("reactions: a fixed set, put and taken back, not on your own, seen by everyone who sees the message", async () => {
  const { broker, url, http } = await startBroker(agents);
  const call = api(http);
  const bot1 = await connect(url, "bot1");
  const bot2 = await connect(url, "bot2");
  const out = await connect(url, "out");
  const toBot1 = frames(bot1);
  const toOut = frames(out);

  const id = await bot1.send({ room: "lab", text: "found the bug" });

  let r = await call("bot2", "POST", `/api/messages/${id}/reactions`, { emoji: "👍" });
  assert.deepEqual(r, { status: 200, body: { reactions: { "👍": ["bot2"] } } });
  // a person reacts from the web as admin, writing as a human
  r = await call("boss", "POST", `/admin/api/messages/${id}/reactions`, { as: "olena", emoji: "👍" });
  assert.deepEqual(r.body, { reactions: { "👍": ["bot2", "olena"] } });
  r = await call("bot2", "POST", `/api/messages/${id}/reactions`, { emoji: "🎉" });
  assert.deepEqual(r.body, { reactions: { "👍": ["bot2", "olena"], "🎉": ["bot2"] } });
  // twice changes nothing and tells no one
  r = await call("bot2", "POST", `/api/messages/${id}/reactions`, { emoji: "👍" });
  assert.deepEqual(r.body, { reactions: { "👍": ["bot2", "olena"], "🎉": ["bot2"] } });
  // taken back
  r = await call("bot2", "DELETE", `/api/messages/${id}/reactions`, { emoji: "🎉" });
  assert.deepEqual(r.body, { reactions: { "👍": ["bot2", "olena"] } });
  r = await call("bot2", "DELETE", `/api/messages/${id}/reactions`, { emoji: "🎉" });
  assert.deepEqual(r.body, { reactions: { "👍": ["bot2", "olena"] } });
  await settle();

  const seen = toBot1.filter((f) => f.type === "reaction");
  assert.deepEqual(
    seen.map((f) => f.type === "reaction" && [f.by, f.emoji, f.on]),
    [
      ["bot2", "👍", true],
      ["olena", "👍", true],
      ["bot2", "🎉", true],
      ["bot2", "🎉", false],
    ],
  );
  assert.equal(toOut.some((f) => f.type === "reaction"), false);
  // a reaction is not a message: the author got no message frame for it
  assert.equal(toBot1.some((f) => f.type === "message"), false);

  // the limits
  assert.match(String((await call("bot2", "POST", `/api/messages/${id}/reactions`, { emoji: "💩" })).body.error), /emoji must be one of/);
  assert.match(String((await call("bot1", "POST", `/api/messages/${id}/reactions`, { emoji: "👍" })).body.error), /your own message/);
  assert.equal((await call("out", "POST", `/api/messages/${id}/reactions`, { emoji: "👍" })).status, 404);
  assert.equal((await call("bot2", "POST", `/api/messages/99999/reactions`, { emoji: "👍" })).status, 404);

  // history carries them
  const hist = await bot2.history({ room: "lab" });
  assert.deepEqual(hist.find((m: ChatMessage) => m.id === id)!.reactions, { "👍": ["bot2", "olena"] });

  bot1.close();
  bot2.close();
  out.close();
  await broker.close();
});

test("reactions reach the author with its next message, and count as told only once it is delivered", async () => {
  const { broker, url, http } = await startBroker(agents);
  const call = api(http);
  const bot1 = await connect(url, "bot1");
  const bot2 = await connect(url, "bot2");
  const got: { m: ChatMessage; notes: ReactionNote[] }[] = [];
  bot1.on("message", (m: ChatMessage, notes: ReactionNote[]) => got.push({ m, notes }));

  const id = await bot1.send({ room: "lab", text: "release is out" });
  await call("bot2", "POST", `/api/messages/${id}/reactions`, { emoji: "🎉" });
  await call("boss", "POST", `/admin/api/messages/${id}/reactions`, { as: "olena", emoji: "👍" });
  await settle();
  assert.equal(got.length, 0, "a reaction wakes no one");

  // the next message carries both; not confirmed yet, so a later one does not repeat them
  await bot2.send({ to: "bot1", text: "one" });
  await bot2.send({ to: "bot1", text: "two" });
  await settle();
  assert.deepEqual(
    got[0].notes.map((n) => [n.id, n.emoji, n.by, n.room]),
    [
      [id, "🎉", "bot2", "lab"],
      [id, "👍", "olena", "lab"],
    ],
  );
  assert.deepEqual(got[1].notes, []);

  // the first was never confirmed: after reconnecting, the reactions come again
  bot1.close();
  await settle();
  const again = await connect(url, "bot1");
  const later: ReactionNote[][] = [];
  again.on("message", (_m: ChatMessage, notes: ReactionNote[]) => later.push(notes));
  await bot2.send({ to: "bot1", text: "three" });
  await settle();
  assert.equal(later[0].length, 2);

  // confirmed: told for good, also after another reconnect
  const lastId = (await again.history({ with: "bot2" })).at(-1)!.id;
  await again.delivered(lastId);
  await settle();
  again.close();
  await settle();
  const third = await connect(url, "bot1");
  const after: ReactionNote[][] = [];
  third.on("message", (_m: ChatMessage, notes: ReactionNote[]) => after.push(notes));
  await call("bot2", "POST", `/api/messages/${id}/reactions`, { emoji: "👀" });
  await bot2.send({ to: "bot1", text: "four" });
  await settle();
  assert.deepEqual(
    after[0].map((n) => n.emoji),
    ["👀"],
    "only the new one",
  );

  third.close();
  bot2.close();
  await broker.close();
});
