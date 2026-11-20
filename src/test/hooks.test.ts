// Global hooks, the scheduler (alexey, AIChat-dev-team 2238; decisions 2250/2252).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatMessage, HookRule } from "../protocol.js";
import { Store } from "../broker/store.js";
import { PRESENCE_SETTLE_MS, STARTUP_GRACE_MS } from "../broker/hooks.js";
import { connect, startBroker, tok } from "./helpers.js";

const BOSS = { name: "boss", kind: "human", admin: true };
const MIN = 60_000;
const TEXT = "У тебе вільний час. Можеш скористатися можливостями AIChat на власний розсуд.";

async function setup(agents = [{ name: "a" }, { name: "b" }, { name: "c", kind: "human" }, { name: "k", keeper: true }, BOSS], store?: Store) {
  const clock = { now: Date.parse("2026-11-20T12:00:00Z") };
  const b = await startBroker(agents, {}, { now: () => clock.now, ...(store ? { store } : {}) } as never);
  const as = (name: string) => ({ authorization: `Bearer ${tok(name)}`, "content-type": "application/json" });
  const call = (method: string, path: string, body?: unknown, who = "boss") =>
    fetch(`${b.http}${path}`, { method, headers: as(who), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const addHook = async (body: unknown) => {
    const r = await call("POST", "/admin/api/hooks", body);
    assert.equal(r.status, 201, await r.clone().text());
    return ((await r.json()) as { hook: HookRule }).hook;
  };
  const activity = async (who: string, state: string) => assert.equal((await call("POST", "/api/activity", { state }, who)).status, 200);
  /** System messages an agent got. */
  const fromSystem = async (who: string) => {
    const r = await call("GET", "/api/history?with=aichat&limit=500", undefined, who);
    return ((await r.json()) as { messages: ChatMessage[] }).messages.filter((m) => m.from === "aichat" && m.text === TEXT);
  };
  const later = (ms: number) => {
    clock.now += ms;
    b.broker.hooks.tick();
  };
  return { ...b, clock, call, addHook, activity, fromSystem, later };
}

const idle = (idleMinutes = 30, repeat = "always", recipient = "participant") => ({
  trigger: { type: "idle", idleMinutes },
  repeat,
  action: { type: "system_message", recipient, text: TEXT },
});

test("admins create, change, switch off and remove hooks; bad rules are refused", async () => {
  const t = await setup();
  const h = await t.addHook(idle());
  assert.match(h.id, /^h[0-9a-f]{12}$/);
  assert.deepEqual({ ...h, id: "", createdAt: "", updatedAt: "" }, {
    id: "",
    enabled: true,
    trigger: { type: "idle", idleMinutes: 30 },
    repeat: "always",
    action: { type: "system_message", recipient: "participant", text: TEXT },
    by: "boss",
    createdAt: "",
    updatedAt: "",
    stats: { fired: 0, agents: 0 },
  });
  // only admins
  assert.equal((await t.call("GET", "/admin/api/hooks", undefined, "a")).status, 401);
  for (const bad of [
    { ...idle(), trigger: { type: "idle", idleMinutes: 0 } },
    { ...idle(), trigger: { type: "idle" } },
    { ...idle(), trigger: { type: "sometimes" } },
    { ...idle(), repeat: "twice" },
    { ...idle(), action: { type: "system_message", recipient: "people", text: TEXT } },
    { ...idle(), action: { type: "system_message", recipient: "participant", text: "   " } },
    { ...idle(), action: { type: "email", recipient: "participant", text: TEXT } },
  ])
    assert.equal((await t.call("POST", "/admin/api/hooks", bad)).status, 400, JSON.stringify(bad));
  let r = await t.call("PUT", `/admin/api/hooks/${h.id}`, { ...idle(45), trigger: { type: "online" } });
  assert.equal(r.status, 200);
  assert.deepEqual(((await r.json()) as { hook: HookRule }).hook.trigger, { type: "online" });
  r = await t.call("PATCH", `/admin/api/hooks/${h.id}`, { enabled: false });
  assert.equal(((await r.json()) as { hook: HookRule }).hook.enabled, false);
  assert.equal((await t.call("PUT", "/admin/api/hooks/nope", idle())).status, 404);
  assert.equal((await t.call("DELETE", `/admin/api/hooks/${h.id}`)).status, 200);
  assert.deepEqual(((await (await t.call("GET", "/admin/api/hooks")).json()) as { hooks: HookRule[] }).hooks, []);
  await t.broker.close();
});

test("idle, always: one message per idle stretch, the next only after real activity", async () => {
  const t = await setup();
  const h = await t.addHook(idle(30));
  const a = await connect(t.url, "a");
  await t.activity("a", "idle");
  t.later(29 * MIN);
  assert.equal((await t.fromSystem("a")).length, 0);
  t.later(1 * MIN);
  assert.equal((await t.fromSystem("a")).length, 1);
  // still idle: no second message
  t.later(60 * MIN);
  assert.equal((await t.fromSystem("a")).length, 1);
  // it only read the message: busy for seconds, then idle again, is not a new cycle
  await t.activity("a", "busy");
  t.later(10_000);
  await t.activity("a", "idle");
  t.later(31 * MIN);
  assert.equal((await t.fromSystem("a")).length, 1);
  // it did something real: the idle stretch starts over, and after it the hook fires again
  await a.send({ room: "lobby", text: "Візьмуся за щось корисне." });
  t.later(29 * MIN);
  assert.equal((await t.fromSystem("a")).length, 1);
  t.later(1 * MIN);
  assert.equal((await t.fromSystem("a")).length, 2);
  // busy for more than two minutes counts as real activity too
  await t.activity("a", "busy");
  t.later(3 * MIN);
  await t.activity("a", "idle");
  t.later(30 * MIN);
  assert.equal((await t.fromSystem("a")).length, 3);
  const after = ((await (await t.call("GET", "/admin/api/hooks")).json()) as { hooks: HookRule[] }).hooks.find((x) => x.id === h.id)!;
  assert.equal(after.stats.fired, 3);
  assert.equal(after.stats.agents, 1);
  a.close();
  await t.broker.close();
});

test("idle needs a reported state: work resets the clock, agents that never report are left alone", async () => {
  const t = await setup();
  await t.addHook(idle(30));
  const a = await connect(t.url, "a");
  const b = await connect(t.url, "b"); // never reports its state, like the openai-agent bot
  await t.activity("a", "idle");
  t.later(20 * MIN);
  await t.activity("a", "busy"); // started working before the threshold
  t.later(20 * MIN);
  await t.activity("a", "idle");
  t.later(29 * MIN);
  assert.equal((await t.fromSystem("a")).length, 0);
  t.later(1 * MIN);
  assert.equal((await t.fromSystem("a")).length, 1);
  assert.equal((await t.fromSystem("b")).length, 0);
  a.close();
  b.close();
  await t.broker.close();
});

test("once: one message for each agent, kept across a broker restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aichat-hooks-"));
  try {
    let t = await setup(undefined, new Store(join(dir, "db.sqlite")));
    await t.addHook(idle(30, "once"));
    let a = await connect(t.url, "a");
    await t.activity("a", "idle");
    t.later(30 * MIN);
    assert.equal((await t.fromSystem("a")).length, 1);
    await a.send({ room: "lobby", text: "щось роблю" });
    t.later(31 * MIN);
    assert.equal((await t.fromSystem("a")).length, 1);
    a.close();
    await t.broker.close();

    t = await setup(undefined, new Store(join(dir, "db.sqlite")));
    a = await connect(t.url, "a");
    await t.activity("a", "idle");
    t.later(31 * MIN);
    assert.equal((await t.fromSystem("a")).length, 1);
    a.close();
    await t.broker.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("always: waiting for real activity is kept across a broker restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aichat-hooks-"));
  try {
    let t = await setup(undefined, new Store(join(dir, "db.sqlite")));
    await t.addHook(idle(30));
    let a = await connect(t.url, "a");
    await t.activity("a", "idle");
    t.later(30 * MIN);
    assert.equal((await t.fromSystem("a")).length, 1);
    a.close();
    await t.broker.close();
    // the broker comes back mid-way through the same idle stretch: no duplicate
    t = await setup(undefined, new Store(join(dir, "db.sqlite")));
    a = await connect(t.url, "a");
    await t.activity("a", "idle");
    t.later(31 * MIN);
    assert.equal((await t.fromSystem("a")).length, 1);
    a.close();
    await t.broker.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("online and offline fire once the change has held 30 s, never in the first two minutes after a restart", async () => {
  const t = await setup();
  const on = await t.addHook({ trigger: { type: "online" }, repeat: "always", action: { type: "system_message", recipient: "others", text: TEXT } });
  const off = await t.addHook({ trigger: { type: "offline" }, repeat: "always", action: { type: "system_message", recipient: "agents", text: TEXT } });
  const b = await connect(t.url, "b");
  // everyone reconnects after a broker restart: not an event
  let a = await connect(t.url, "a");
  t.later(STARTUP_GRACE_MS + PRESENCE_SETTLE_MS);
  assert.equal((await t.fromSystem("b")).length, 0);

  // a dropped connection that comes back within 30 s is not news
  a.close();
  await new Promise((r) => setTimeout(r, 50));
  t.later(10_000);
  a = await connect(t.url, "a");
  t.later(PRESENCE_SETTLE_MS);
  assert.equal((await t.fromSystem("b")).length, 0);

  // a real departure: "agents" means every agent, a person or the keeper get nothing
  a.close();
  await new Promise((r) => setTimeout(r, 50));
  t.later(PRESENCE_SETTLE_MS - 1000);
  assert.equal((await t.fromSystem("b")).length, 0);
  t.later(1000);
  assert.equal((await t.fromSystem("b")).length, 1);
  assert.equal((await t.fromSystem("c")).length, 0);
  assert.equal((await t.fromSystem("k")).length, 0);
  // coming back: "others" means every agent but the one it fired for
  a = await connect(t.url, "a");
  t.later(PRESENCE_SETTLE_MS);
  assert.equal((await t.fromSystem("b")).length, 2);
  assert.equal((await t.fromSystem("a")).length, 1); // only the offline one, "agents" included it
  const hooks = ((await (await t.call("GET", "/admin/api/hooks")).json()) as { hooks: HookRule[] }).hooks;
  assert.deepEqual(hooks.map((h) => [h.id, h.stats.fired]), [
    [on.id, 1],
    [off.id, 1],
  ]);
  a.close();
  b.close();
  await t.broker.close();
});

test("a switched-off hook does nothing; each hook keeps its own history", async () => {
  const t = await setup();
  const h1 = await t.addHook(idle(30, "once"));
  const h2 = await t.addHook(idle(60, "once"));
  await t.call("PATCH", `/admin/api/hooks/${h2.id}`, { enabled: false });
  const a = await connect(t.url, "a");
  await t.activity("a", "idle");
  t.later(90 * MIN);
  assert.equal((await t.fromSystem("a")).length, 1);
  const hooks = ((await (await t.call("GET", "/admin/api/hooks")).json()) as { hooks: HookRule[] }).hooks;
  assert.deepEqual(hooks.map((h) => [h.id, h.stats.fired]), [
    [h1.id, 1],
    [h2.id, 0],
  ]);
  a.close();
  await t.broker.close();
});
