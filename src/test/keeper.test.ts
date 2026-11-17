import { test } from "node:test";
import assert from "node:assert/strict";
import { validate } from "../broker/config.js";
import { connect, startBroker, tok } from "./helpers.js";
import type { AgentInfo, ChatMessage } from "../protocol.js";

const BOSS = { name: "boss", kind: "human", admin: true };
const KEEPER = { name: "keeper", kind: "claude", keeper: true };

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

const agent = (name: string, extra: Record<string, unknown> = {}) => ({ name, kind: "claude", token: tok(name), ...extra });

test("config: at most one keeper, an AI agent in no room and without admin rights", () => {
  assert.ok(validate({ agents: [agent("k", { keeper: true }), agent("bot")] }));
  assert.throws(() => validate({ agents: [agent("k1", { keeper: true }), agent("k2", { keeper: true })] }), /only one agent can be the keeper/);
  assert.throws(() => validate({ agents: [agent("k", { keeper: true, kind: "human" })] }), /must be an AI agent/);
  assert.throws(() => validate({ agents: [agent("k", { keeper: true, rooms: ["lobby"] })] }), /in no rooms/);
  assert.throws(() => validate({ agents: [agent("k", { keeper: "yes" })] }), /keeper must be true or false/);
});

test("the keeper reads every ordinary room's brief but changes none, and is shown as the keeper", async () => {
  const { broker, http } = await startBroker([KEEPER, { name: "olena", kind: "human", rooms: ["lab"] }, BOSS]);
  try {
    await api(http, "olena")("PUT", "/api/rooms/lab/brief", { text: "Мета: валідатор." });
    const keeper = api(http, "keeper");
    const r = await keeper<{ brief: { text: string } }>("GET", "/api/rooms/lab/brief");
    assert.equal(r.status, 200);
    assert.equal(r.data.brief.text, "Мета: валідатор.");
    assert.equal((await keeper("PUT", "/api/rooms/lab/brief", { text: "інше" })).status, 403);
    assert.equal((await keeper("GET", "/api/rooms/nope/brief")).status, 404);

    const { agents } = (await keeper<{ agents: AgentInfo[] }>("GET", "/api/agents")).data;
    assert.equal(agents.find((a) => a.name === "keeper")?.keeper, true);
    assert.equal(agents.find((a) => a.name === "olena")?.keeper, undefined);
  } finally {
    await broker.close();
  }
});

test("the keeper is in no room: it cannot join one, write to one or be added to one", async () => {
  const { broker, url, http } = await startBroker([KEEPER, { name: "bot", rooms: ["lab"] }, BOSS]);
  try {
    const keeper = await connect(url, "keeper");
    await assert.rejects(keeper.join("lab"), /keeper: it takes part in no room/);
    await assert.rejects(keeper.send({ room: "lab", text: "hi" }), /keeper: it takes part in no room/);
    assert.equal((await api(http, "keeper")("POST", "/api/rooms/lab/join")).status, 403);
    assert.equal((await keeper.history({ room: "lab" }).catch((e: Error) => e.message)), "you are not in room lab");

    const boss = api(http, "boss");
    assert.equal((await boss("POST", "/admin/api/rooms/lab/members", { name: "keeper" })).status, 400);
    assert.equal((await boss("POST", "/admin/api/rooms", { name: "ops", members: ["keeper"] })).status, 400);
    assert.deepEqual(broker.store.roomsOf("keeper"), []);
    keeper.close();
  } finally {
    await broker.close();
  }
});

test("the keeper writes to agents directly with no rate limit, plays no games and gets no thanks", async () => {
  const { broker, url, http } = await startBroker([KEEPER, { name: "bot" }, BOSS], { ratePerMinute: 2 });
  try {
    const keeper = await connect(url, "keeper");
    const bot = await connect(url, "bot");
    const got: ChatMessage[] = [];
    bot.on("message", (m: ChatMessage) => got.push(m));
    for (let i = 0; i < 5; i++) await keeper.send({ to: "bot", text: `brief ${i}` });
    for (let i = 0; i < 50 && got.length < 5; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(got.length, 5);

    // others keep their limit
    await bot.send({ to: "keeper", text: "1" });
    await bot.send({ to: "keeper", text: "2" });
    await assert.rejects(bot.send({ to: "keeper", text: "3" }), /rate limit/);

    const thanks = await api(http, "bot")<{ error: string }>("POST", `/api/messages/${got[0].id}/thanks`);
    assert.equal(thanks.status, 400);
    assert.match(thanks.data.error, /keeper/);

    const games = api(http, "keeper");
    assert.equal((await games("POST", "/api/games", { game: "checkers" })).status, 403);
    assert.equal((await api(http, "bot")("POST", "/api/games", { game: "checkers", players: ["bot", "keeper"] })).status, 404);
    keeper.close();
    bot.close();
  } finally {
    await broker.close();
  }
});
