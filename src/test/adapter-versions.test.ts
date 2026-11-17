import { test } from "node:test";
import assert from "node:assert/strict";
import { BrokerClient } from "../client/broker-client.js";
import type { AgentInfo, ServerFrame } from "../protocol.js";
import { VERSION } from "../version.js";
import { connect, startBroker, tok } from "./helpers.js";

/** Every raw frame a client receives (BrokerClient only emits messages and presence). */
function frames(c: BrokerClient): ServerFrame[] {
  const got: ServerFrame[] = [];
  (c as unknown as { ws: { on: (e: string, f: (d: unknown) => void) => void } }).ws.on("message", (d) => got.push(JSON.parse(String(d))));
  return got;
}
const settle = () => new Promise((r) => setTimeout(r, 80));

test("the broker keeps the adapter each connection names, shows it while online, and tells everyone", async () => {
  const { broker, url, http } = await startBroker([{ name: "olena", kind: "human" }, { name: "bot1", kind: "claude" }, { name: "bot2" }]);
  const watcher = await connect(url, "olena");
  const seen = frames(watcher);
  const as = (name: string, client?: unknown) =>
    new BrokerClient({ url, token: tok(name), reconnect: false, log: () => {}, client: client as never });
  const agents = async () =>
    ((await (await fetch(`${http}/api/agents`, { headers: { authorization: `Bearer ${tok("olena")}` } })).json()) as { agents: AgentInfo[] }).agents;
  const of = async (name: string) => (await agents()).find((a) => a.name === name)!;

  const old = as("bot1", { name: "claude-channel", version: "0.3.0" });
  await old.connect();
  await settle();
  assert.deepEqual((await of("bot1")).adapter, { name: "claude-channel", version: "0.3.0" });
  assert.deepEqual(seen.filter((f) => f.type === "presence" && f.agent === "bot1").at(-1), {
    type: "presence",
    agent: "bot1",
    online: true,
    adapter: { name: "claude-channel", version: "0.3.0" },
  });

  // a second session with a newer adapter: the newest connection wins, and everyone hears of the change
  const fresh = as("bot1", { name: "claude-channel", version: "0.4.0" });
  await fresh.connect();
  await settle();
  assert.deepEqual((await of("bot1")).adapter, { name: "claude-channel", version: "0.4.0" });
  assert.equal(seen.filter((f) => f.type === "presence" && f.agent === "bot1").length, 2);
  fresh.close();
  await settle();
  assert.deepEqual((await of("bot1")).adapter, { name: "claude-channel", version: "0.3.0" });

  // offline: no adapter; an adapter that does not say (0.2.1) or says nonsense has none either
  old.close();
  await settle();
  assert.equal((await of("bot1")).adapter, undefined);
  assert.deepEqual(seen.filter((f) => f.type === "presence" && f.agent === "bot1").at(-1), { type: "presence", agent: "bot1", online: false });
  const silent = await connect(url, "bot2");
  const odd = as("bot1", { name: "x".repeat(65), version: 3 });
  await odd.connect();
  await settle();
  assert.equal((await of("bot2")).adapter, undefined);
  assert.equal((await of("bot1")).adapter, undefined);
  assert.equal((await of("bot1")).online, true);

  // the overview says which version the newest adapter has: the broker's own
  const ov = (await (await fetch(`${http}/api/overview`, { headers: { authorization: `Bearer ${tok("olena")}` } })).json()) as { version: string };
  assert.equal(ov.version, VERSION);

  silent.close();
  odd.close();
  watcher.close();
  await broker.close();
});
