import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { findConfig, reportFor } from "../adapters/aichat-hook.js";
import { hookSettings } from "../broker/setup.js";
import type { AgentInfo, ChatMessage, ServerFrame } from "../protocol.js";
import { connect, startBroker, tok } from "./helpers.js";

/** Every raw frame a client receives (BrokerClient only emits messages and presence). */
function frames(c: Awaited<ReturnType<typeof connect>>): ServerFrame[] {
  const got: ServerFrame[] = [];
  (c as unknown as { ws: { on: (e: string, f: (d: unknown) => void) => void } }).ws.on("message", (d) => got.push(JSON.parse(String(d))));
  return got;
}

const settle = () => new Promise((r) => setTimeout(r, 80));

async function setup() {
  const b = await startBroker([{ name: "olena", kind: "human" }, { name: "bot1", kind: "claude" }, { name: "bot2", kind: "claude" }]);
  const post = async (who: string, path: string, body: unknown) => {
    const r = await fetch(`${b.http}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${tok(who)}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  };
  const agents = async () => {
    const r = await fetch(`${b.http}/api/agents`, { headers: { authorization: `Bearer ${tok("olena")}` } });
    return ((await r.json()) as { agents: AgentInfo[] }).agents;
  };
  return { ...b, post, agents };
}

test("hooks report activity; every client hears changes, not repeats; the agent list shows it", async () => {
  const { broker, url, post, agents } = await setup();
  const bot1 = await connect(url, "bot1");
  const bot2 = await connect(url, "bot2");
  const seen = frames(bot2);

  let r = await post("bot1", "/api/activity", { state: "busy", detail: "Bash" });
  assert.equal(r.status, 200);
  assert.deepEqual([(r.body.activity as { state: string }).state, (r.body.activity as { detail: string }).detail], ["busy", "Bash"]);
  await post("bot1", "/api/activity", { state: "busy", detail: "Bash" }); // the same again: no new frame
  await post("bot1", "/api/activity", { state: "waiting", detail: "Claude needs your permission to use Bash" });
  assert.equal((await post("bot1", "/api/activity", { state: "sleeping" })).status, 400);
  assert.equal((await post("bot1", "/api/activity", { state: "busy", detail: 5 })).status, 400);
  await settle();
  const acts = seen.filter((f): f is Extract<ServerFrame, { type: "activity" }> => f.type === "activity");
  assert.deepEqual(acts.map((f) => [f.agent, f.activity.state, f.activity.detail]), [
    ["bot1", "busy", "Bash"],
    ["bot1", "waiting", "Claude needs your permission to use Bash"],
  ]);
  const me = (await agents()).find((a) => a.name === "bot1")!;
  assert.equal(me.activity?.state, "waiting");
  assert.equal((await agents()).find((a) => a.name === "bot2")!.activity, undefined);

  // going offline resets it
  bot1.close();
  await settle();
  assert.deepEqual(seen.filter((f) => f.type === "activity").map((f) => (f as { activity: { state: string } }).activity.state).at(-1), "idle");
  assert.equal((await agents()).find((a) => a.name === "bot1")!.activity?.state, "idle");
  bot2.close();
  await broker.close();
});

test("delivery receipts reach the sender and stay in the history; a hooked agent turns busy", async () => {
  const { broker, url, post } = await setup();
  const bot1 = await connect(url, "bot1");
  const bot2 = await connect(url, "bot2");
  const toBot2 = frames(bot2);
  const toBot1 = frames(bot1);

  const id = await bot2.send({ to: "bot1", text: "are you there?" });
  await bot1.delivered(id);
  await bot1.delivered(id); // twice: one receipt
  await settle();
  assert.deepEqual(toBot2.filter((f) => f.type === "delivered"), [{ type: "delivered", id, to: "bot1" }]);
  const hist = await bot2.history({ with: "bot1" });
  assert.deepEqual(hist.find((m: ChatMessage) => m.id === id)!.delivered_to, ["bot1"]);
  // only a recipient can confirm, and only a real message
  await assert.rejects(bot2.delivered(id), /not sent to you/);
  await assert.rejects(bot1.delivered(99999), /unknown message/);
  // no hooks yet: delivery says nothing about activity
  assert.equal(toBot1.filter((f) => f.type === "activity").length, 0);

  // once its hooks have reported, a delivery means the session is reading
  await post("bot1", "/api/activity", { state: "idle" });
  const id2 = await bot2.send({ to: "bot1", text: "and now?" });
  await bot1.delivered(id2);
  await settle();
  const act = toBot2.filter((f) => f.type === "activity").at(-1) as Extract<ServerFrame, { type: "activity" }>;
  assert.deepEqual([act.agent, act.activity.state, act.activity.detail], ["bot1", "busy", "читає повідомлення"]);
  bot1.close(); bot2.close();
  await broker.close();
});

test("hook script: events map to states; config comes from the nearest .mcp.json", () => {
  assert.deepEqual(reportFor({ hook_event_name: "UserPromptSubmit" }), { state: "busy", detail: "думає" });
  assert.deepEqual(reportFor({ hook_event_name: "PreToolUse", tool_name: "Edit" }), { state: "busy", detail: "Edit" });
  assert.deepEqual(reportFor({ hook_event_name: "PreToolUse", tool_name: "mcp__aichat__send_message" }), { state: "busy", detail: "send_message" });
  assert.deepEqual(reportFor({ hook_event_name: "PreToolUse", tool_name: "mcp__claude_ai_Gmail__search_threads" }), { state: "busy", detail: "search_threads" });
  assert.deepEqual(reportFor({ hook_event_name: "Notification", message: "Claude needs your permission to use Bash" }), {
    state: "waiting",
    detail: "Claude needs your permission to use Bash",
  });
  assert.deepEqual(reportFor({ hook_event_name: "Notification", message: "Claude is waiting for your input" }), { state: "idle" });
  assert.deepEqual(reportFor({ hook_event_name: "Notification", notification_type: "idle_prompt", message: "x" }), { state: "idle" });
  assert.deepEqual(reportFor({ hook_event_name: "Stop" }), { state: "idle" });
  assert.equal(reportFor({ hook_event_name: "PostToolUse" }), null);

  const dir = mkdtempSync(join(tmpdir(), "aichat-hook-"));
  try {
    mkdirSync(join(dir, "sub", "deeper"), { recursive: true });
    writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { aichat: { env: { AICHAT_URL: "ws://h:1", AICHAT_TOKEN: "t" } } } }));
    assert.deepEqual(findConfig(join(dir, "sub", "deeper")), { url: "ws://h:1", token: "t" });
    // a server under another name is found by its adapter file
    writeFileSync(join(dir, "sub", ".mcp.json"), JSON.stringify({ mcpServers: { chat: { args: ["/x/claude-channel.mjs"], env: { AICHAT_TOKEN: "u" } } } }));
    assert.deepEqual(findConfig(join(dir, "sub", "deeper")), { url: "ws://127.0.0.1:8787", token: "u" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // the settings block shown in the setup instructions runs the hook on exactly these events
  assert.deepEqual(Object.keys(hookSettings("/a/aichat-hook.mjs").hooks), ["UserPromptSubmit", "PreToolUse", "Notification", "Stop"]);
});

test("hook script end to end: Claude Code runs it, the broker hears it, it prints nothing", async () => {
  const { broker, url, http, agents } = await setup();
  const dir = mkdtempSync(join(tmpdir(), "aichat-hook-"));
  writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { aichat: { env: { AICHAT_URL: url, AICHAT_TOKEN: tok("bot1") } } } }));
  const run = (input: unknown) =>
    new Promise<{ code: number | null; out: string }>((resolve) => {
      const p = spawn(process.execPath, [fileURLToPath(new URL("../adapters/aichat-hook.js", import.meta.url))], { cwd: dir });
      let out = "";
      p.stdout.on("data", (d) => (out += d));
      p.on("close", (code) => resolve({ code, out }));
      p.stdin.end(JSON.stringify(input));
    });
  try {
    let r = await run({ hook_event_name: "PreToolUse", tool_name: "Bash", cwd: dir });
    assert.deepEqual(r, { code: 0, out: "" });
    assert.deepEqual((await agents()).find((a) => a.name === "bot1")!.activity?.detail, "Bash");
    r = await run({ hook_event_name: "Stop", cwd: dir });
    assert.equal((await agents()).find((a) => a.name === "bot1")!.activity?.state, "idle");
    // a broken input or a broker that is gone never fails the hook
    assert.equal((await run("not json")).code, 0);
    await broker.close();
    assert.deepEqual(await run({ hook_event_name: "Stop", cwd: dir }), { code: 0, out: "" });
    void http;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
