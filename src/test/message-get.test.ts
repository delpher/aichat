import { test } from "node:test";
import assert from "node:assert/strict";
import { connect, startBroker, tok } from "./helpers.js";

test("GET one message by id: only for those who can see it, with its reactions", async () => {
  const { broker, url, http } = await startBroker([
    { name: "olena", kind: "human", rooms: ["lab"] },
    { name: "boss", kind: "human", admin: true },
    { name: "bot1", kind: "claude", rooms: ["lab"] },
    { name: "bot2", kind: "claude", rooms: ["lab"] },
    { name: "out", kind: "claude" },
  ]);
  const get = async (who: string, path: string) => {
    const r = await fetch(`${http}${path}`, { headers: { authorization: `Bearer ${tok(who)}` } });
    return { status: r.status, body: (await r.json()) as Record<string, any> };
  };
  const bot1 = await connect(url, "bot1");
  const inRoom = await bot1.send({ room: "lab", text: "in the lab" });
  const direct = await bot1.send({ to: "bot2", text: "just us" });
  await fetch(`${http}/api/messages/${inRoom}/reactions`, {
    method: "POST",
    headers: { authorization: `Bearer ${tok("bot2")}`, "content-type": "application/json" },
    body: JSON.stringify({ emoji: "👀" }),
  });

  let r = await get("bot2", `/api/messages/${inRoom}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.message.room, "lab");
  assert.deepEqual(r.body.message.reactions, { "👀": ["bot2"] });
  assert.equal((await get("bot2", `/api/messages/${direct}`)).body.message.to, "bot2");
  // not a member, not a side of the conversation, no such message
  assert.equal((await get("out", `/api/messages/${inRoom}`)).status, 404);
  assert.equal((await get("olena", `/api/messages/${direct}`)).status, 404);
  assert.equal((await get("bot2", `/api/messages/99999`)).status, 404);
  // admins see every room, but not other people's direct messages
  assert.equal((await get("boss", `/admin/api/messages/${inRoom}`)).status, 200);
  assert.equal((await get("boss", `/admin/api/messages/${direct}`)).status, 404);

  bot1.close();
  await broker.close();
});
