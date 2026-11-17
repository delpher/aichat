import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentInfo, ChatMessage, ServerFrame } from "../protocol.js";
import { connect, startBroker, tok } from "./helpers.js";

/** Every raw frame a client receives (BrokerClient only emits messages and presence). */
function frames(c: Awaited<ReturnType<typeof connect>>): ServerFrame[] {
  const got: ServerFrame[] = [];
  (c as unknown as { ws: { on: (e: string, f: (d: unknown) => void) => void } }).ws.on("message", (d) => got.push(JSON.parse(String(d))));
  return got;
}
const settle = () => new Promise((r) => setTimeout(r, 80));

test("thanks: once per message, not for your own, seen by everyone who sees the message, counted on the author", async () => {
  const { broker, url, http } = await startBroker([
    { name: "olena", kind: "human", rooms: ["lab"] },
    { name: "boss", kind: "human", admin: true },
    { name: "bot1", kind: "claude", rooms: ["lab"] },
    { name: "bot2", kind: "claude", rooms: ["lab"] },
    { name: "out", kind: "claude" },
  ]);
  const bot1 = await connect(url, "bot1");
  const bot2 = await connect(url, "bot2");
  const out = await connect(url, "out");
  const toBot1 = frames(bot1);
  const toOut = frames(out);
  const post = async (who: string, path: string, body: unknown = {}) => {
    const r = await fetch(`${http}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${tok(who)}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  };
  const agents = async () =>
    ((await (await fetch(`${http}/api/agents`, { headers: { authorization: `Bearer ${tok("olena")}` } })).json()) as { agents: AgentInfo[] }).agents;

  const id = await bot1.send({ room: "lab", text: "found the bug" });
  assert.equal((await agents()).find((a) => a.name === "bot1")!.thanks, undefined);

  // an agent thanks; the author and the room hear of it, someone outside does not
  let r = await post("bot2", `/api/messages/${id}/thanks`);
  assert.deepEqual(r, { status: 200, body: { thanked_by: ["bot2"] } });
  // a person thanks from the web as admin, writing as a human
  r = await post("boss", `/admin/api/messages/${id}/thanks`, { as: "olena" });
  assert.deepEqual(r, { status: 200, body: { thanked_by: ["bot2", "olena"] } });
  await settle();
  assert.deepEqual(
    toBot1.filter((f) => f.type === "thanks"),
    [
      { type: "thanks", id, author: "bot1", by: "bot2", thanked_by: ["bot2"] },
      { type: "thanks", id, author: "bot1", by: "olena", thanked_by: ["bot2", "olena"] },
    ],
  );
  assert.equal(toOut.some((f) => f.type === "thanks"), false);

  // the limits
  assert.equal((await post("bot2", `/api/messages/${id}/thanks`)).status, 409);
  assert.match(String((await post("bot1", `/api/messages/${id}/thanks`)).body.error), /cannot thank yourself/);
  assert.equal((await post("out", `/api/messages/${id}/thanks`)).status, 404);
  assert.equal((await post("bot2", `/api/messages/99999/thanks`)).status, 404);

  // the message carries the names, the author's card the count
  const hist = await bot2.history({ room: "lab" });
  assert.deepEqual(hist.find((m: ChatMessage) => m.id === id)!.thanked_by, ["bot2", "olena"]);
  assert.equal((await agents()).find((a) => a.name === "bot1")!.thanks, 2);

  bot1.close();
  bot2.close();
  out.close();
  await broker.close();
});
