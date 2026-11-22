import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { EventEmitter } from "node:events";

import {
  AICHAT_TOOL_ALLOWLIST,
  BrokerHttp,
  CapacityError,
  Channel,
  DeliveryEngine,
  RpcError,
  State,
  UncertainError,
  callTool,
  install,
  loadConfig,
  main,
  safeUploadPath,
  validateMode,
  validateProfileName,
} from "./agy-channel.mjs";

function makeTempEnv(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-channel-test-"));
  const agentDir = path.join(root, "agent");
  const tokenFile = path.join(root, "token.txt");
  fs.mkdirSync(path.join(agentDir, "outbox"), { recursive: true });
  fs.mkdirSync(path.join(agentDir, ".aichat"), { recursive: true });
  fs.writeFileSync(tokenFile, "secret-test-token-" + Math.random().toString(36).slice(2), "utf8");
  const configFile = path.join(agentDir, "aichat.config.json");
  fs.writeFileSync(
    configFile,
    JSON.stringify({
      url: "http://aichat.home",
      tokenFile,
      appDataDir: "antigravity-aichat-unit-test",
      owners: ["alexey"],
      rooms: ["lobby"],
      delivery: "steer",
      wake: "always",
      paused: true,
      approveAichatTools: true,
    })
  );
  t.after(() => {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {}
  });
  return { root, agentDir, tokenFile, configFile, cfg: loadConfig(configFile) };
}

class FakeRpc extends EventEmitter {
  constructor() {
    super();
    this.requests = [];
    this.sent = [];
    this.handlers = new Map();
    this.closed = false;
  }
  onRequest(method, fn) {
    this.handlers.set(method, fn);
  }
  async initialize() {
    return this.request("initialize", { protocolVersion: 1 });
  }
  send(frame) {
    this.sent.push(frame);
  }
  request(method, params) {
    const entry = { method, params };
    this.requests.push(entry);
    const handler = this.handlers.get(method);
    if (handler) return Promise.resolve(handler(params, entry));
    return Promise.resolve({});
  }
  close() {
    this.closed = true;
  }
}

class FakeHttp {
  constructor(token = "secret-token") {
    this.token = token;
    this.tokenHash = "test-" + Math.random().toString(36).slice(2, 10);
    this.calls = [];
    this.responses = new Map();
  }
  redact(v) {
    return String(v).split(this.token).join("[REDACTED]");
  }
  async request(route, opts = {}) {
    this.calls.push({ route, opts });
    const handler = this.responses.get(route);
    if (handler) return typeof handler === "function" ? handler(opts) : handler;
    if (route === "/api/me") return { name: "antigravity-alexey", rooms: ["lobby"] };
    if (route === "/api/intro") return { intro: { ts: "2026-11-19T13:48:05.875Z", text: "hi" } };
    if (route === "/api/agents") return { agents: [{ name: "alexey", kind: "human" }] };
    if (route === "/health") return { ok: true, version: "0.13.0" };
    return {};
  }
  async send(body, key) {
    this.calls.push({ route: "/api/messages", opts: { method: "POST", body, key } });
    return { message: { id: 999 } };
  }
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitFor(fn, timeoutMs = 2000) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 15));
  }
}

test("validateProfileName & loadConfig enforce isolated profile", (t) => {
  assert.throws(() => validateProfileName("antigravity-cli"), /dedicated profile/);
  assert.throws(() => validateProfileName("../escape"), /simple directory name/);
  assert.throws(() => validateProfileName("a/b"), /simple directory name/);
  validateProfileName("antigravity-aichat-alexey");

  const { cfg } = makeTempEnv(t);
  assert.equal(cfg.appDataDir, "antigravity-aichat-unit-test");
  assert.equal(cfg.wsUrl, "ws://aichat.home/ws");
  assert.equal(cfg.sandbox, true);
  assert.equal(cfg.approveAichatTools, true);
});

test("safeUploadPath permits outbox and blocks secrets/profile/escapes", (t) => {
  const { root, agentDir, cfg } = makeTempEnv(t);
  const okFile = path.join(agentDir, "outbox", "report.txt");
  fs.writeFileSync(okFile, "hello", "utf8");
  assert.equal(safeUploadPath(cfg, okFile).real, fs.realpathSync(okFile));

  const secretInOutbox = path.join(agentDir, "outbox", "my-token.txt");
  fs.writeFileSync(secretInOutbox, "nope", "utf8");
  assert.throws(() => safeUploadPath(cfg, secretInOutbox), /private\/profile/);

  const outsideFile = path.join(root, "outside.txt");
  fs.writeFileSync(outsideFile, "nope", "utf8");
  assert.throws(() => safeUploadPath(cfg, outsideFile), /only permits outbox/);

  const stateFile = path.join(agentDir, ".aichat", "state.json");
  fs.writeFileSync(stateFile, "{}", "utf8");
  assert.throws(() => safeUploadPath(cfg, stateFile), /private\/profile/);
});

test("State handles enqueue, dedupe, TTL, capacity, and receipt compaction", (t) => {
  const { agentDir, cfg } = makeTempEnv(t);
  const smallCfg = { ...cfg, maxQueue: 2, maxRecords: 3, maxQueueAgeMs: 1000 };
  const store = new State(path.join(agentDir, ".aichat", "state.json"));

  assert.equal(store.enqueue({ id: 1, from: "alexey", room: "lobby", text: "first" }, smallCfg, 1000), true);
  assert.equal(store.enqueue({ id: 1, from: "alexey", room: "lobby", text: "first" }, smallCfg, 1000), false);
  assert.equal(store.enqueue({ id: 2, from: "alexey", room: "lobby", text: "second" }, smallCfg, 1000), true);
  // 3rd exceeds maxQueue=2 -> failed
  assert.equal(store.enqueue({ id: 3, from: "alexey", room: "lobby", text: "third" }, smallCfg, 1000), true);
  assert.equal(store.value.messages["3"].status, "failed");

  // Compact receipt on processed
  store.update([1], { status: "delivered", processed: true });
  assert.equal(store.value.messages["1"].message.text, undefined);
  assert.equal(store.value.messages["1"].message.id, 1);

  // TTL expiry for id=2
  assert.equal(store.queued(smallCfg, 5000).length, 0);
  assert.equal(store.value.messages["2"].status, "failed");
});

test("DeliveryEngine native ACP steer handoff: early end_turn of #1 confirms #2 without emitting idle; aichat waits", async (t) => {
  const { agentDir, cfg } = makeTempEnv(t);
  const store = new State(path.join(agentDir, ".aichat", "state.json"));
  store.patch({ sessionId: "sess-1" });

  const rpc = new FakeRpc();
  const promptDeferreds = [];
  rpc.onRequest("session/prompt", () => {
    const d = deferred();
    promptDeferreds.push(d);
    return d.promise;
  });

  const acked = [];
  const lifecycle = [];
  const usages = [];
  const engine = new DeliveryEngine({
    cfg,
    store,
    rpc,
    owners: ["alexey"],
    agent: "antigravity-alexey",
    acknowledge: (id) => {
      acked.push(id);
      return true;
    },
    onTurnStart: (room) => lifecycle.push(["start", room]),
    onTurnComplete: (reason) => lifecycle.push(["complete", reason]),
    onUsage: (u) => usages.push(u),
  });

  // 1. Message #10 arrives -> starts turn #1
  await engine.receive({ id: 10, from: "alexey", room: "lobby", text: "start long task" });
  await waitFor(() => promptDeferreds.length === 1);

  assert.deepEqual(lifecycle, [["start", "lobby"]]);
  assert.equal(store.value.messages["10"].status, "uncertain");

  // First session/update confirms #10 accepted -> delivered
  await engine.notification({
    method: "session/update",
    params: { sessionId: "sess-1", update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "..." } } },
  });
  assert.equal(store.value.messages["10"].status, "delivered");
  assert.deepEqual(acked, [10]);

  // 2. Message #11 arrives mid-turn -> steers via second session/prompt
  await engine.receive({ id: 11, from: "claude-alexey", room: "lobby", text: "mid-turn update" });
  await waitFor(() => promptDeferreds.length === 2);

  assert.equal(store.value.messages["11"].status, "uncertain");

  // 3. Broker notice #12 (`from: "aichat"`) arrives while turn is active -> MUST NOT steer!
  await engine.receive({ id: 12, from: "aichat", to: "antigravity-alexey", text: "broker notice" });
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(promptDeferreds.length, 2);
  assert.equal(store.value.messages["12"].status, "queued");

  // 4. Prompt #1 resolves early (ACP steer handoff, no usage)
  promptDeferreds[0].resolve({ stopReason: "end_turn" });
  await new Promise((r) => setTimeout(r, 80));

  // CRITICAL INVARIANT (#2174): #1 resolving alone MUST NOT falsely ACK #2 yet, and MUST NOT emit idle!
  assert.equal(store.value.messages["11"].status, "uncertain");
  assert.deepEqual(acked, [10]);
  assert.equal(store.value.messages["10"].processed, false);
  assert.equal(store.value.messages["11"].processed, false);
  assert.deepEqual(lifecycle, [["start", "lobby"]]);
  assert.notEqual(engine.active, null);
  assert.equal(promptDeferreds.length, 2); // aichat notice #12 still queued!

  // 4b. Post-handoff session/update arrives while only #2 is in flight -> confirms #2 accepted + delivered!
  await engine.notification({
    method: "session/update",
    params: { sessionId: "sess-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "saw #2" } } },
  });
  assert.equal(store.value.messages["11"].status, "delivered");
  assert.deepEqual(acked, [10, 11]);

  // 5. Prompt #2 completes with stopReason + usage -> BOTH #10 and #11 become processed, idle fires, THEN #12 starts!
  promptDeferreds[1].resolve({
    stopReason: "end_turn",
    usage: { inputTokens: 12857, outputTokens: 304, cachedReadTokens: 8440, thoughtTokens: 205, totalTokens: 21601 },
  });
  await waitFor(() => promptDeferreds.length === 3);

  assert.equal(store.value.messages["10"].processed, true);
  assert.equal(store.value.messages["11"].processed, true);
  assert.equal(usages.length, 1);
  assert.equal(usages[0].inputTokens, 12857);
  // Idle fired after #2 finished, then #12 (aichat) started fresh turn #3!
  assert.equal(lifecycle[1][0], "complete");
  assert.equal(lifecycle[2][0], "start");

  promptDeferreds[2].resolve({ stopReason: "end_turn" });
  await waitFor(() => store.value.messages["12"].processed === true && engine.active === null);

  engine.close();
});

test("DeliveryEngine falls back to queue if steer is explicitly rejected", async (t) => {
  const { agentDir, cfg } = makeTempEnv(t);
  const store = new State(path.join(agentDir, ".aichat", "state.json"));
  store.patch({ sessionId: "sess-2" });

  const rpc = new FakeRpc();
  const d1 = deferred();
  let call = 0;
  rpc.onRequest("session/prompt", () => {
    call++;
    if (call === 1) return d1.promise;
    if (call === 2) return Promise.reject(new RpcError({ code: -32600, message: "turn busy" }));
    return Promise.resolve({ stopReason: "end_turn" });
  });

  const engine = new DeliveryEngine({
    cfg,
    store,
    rpc,
    owners: ["alexey"],
    agent: "antigravity-alexey",
    acknowledge: () => true,
  });

  await engine.receive({ id: 20, from: "alexey", room: "lobby", text: "turn 1" });
  await waitFor(() => call === 1);
  await engine.receive({ id: 21, from: "alexey", room: "lobby", text: "steer rejected" });
  await waitFor(() => call === 2 && store.value.messages["21"].status === "queued");

  // Rejected steer must be re-queued with blockedTurn set, and turn 1 stays active
  assert.ok(store.value.messages["21"].blockedTurn);
  assert.notEqual(engine.active, null);

  // When turn 1 finishes, #21 drains on next turn
  d1.resolve({ stopReason: "end_turn" });
  await waitFor(() => call === 3 && store.value.messages["21"].processed === true);
  engine.close();
});

test("Channel reconciles uncertain messages from session/load replay and falls back on missing session", async (t) => {
  const { agentDir, cfg } = makeTempEnv(t);
  const store = new State(path.join(agentDir, ".aichat", "state.json"));
  store.patch({ sessionId: "sess-existing" });
  store.enqueue({ id: 30, from: "alexey", room: "lobby", text: "was accepted before crash" }, cfg);
  store.update([30], { status: "uncertain", requestId: "aichat-req-30" });
  store.enqueue({ id: 31, from: "alexey", room: "lobby", text: "never reached acp" }, cfg);
  store.update([31], { status: "uncertain", requestId: "aichat-req-31" });

  const rpc = new FakeRpc();
  rpc.onRequest("initialize", () => ({ agentInfo: { name: "Antigravity ACP Server", version: "1.5.13" }, agentCapabilities: { loadSession: true } }));
  rpc.onRequest("session/list", () => ({ sessions: [{ sessionId: "sess-existing" }] }));
  rpc.onRequest("session/load", () => {
    // Replay user_message_chunk containing req-30 only
    rpc.emit("notification", {
      method: "session/update",
      params: {
        sessionId: "sess-existing",
        update: {
          sessionUpdate: "user_message_chunk",
          content: { type: "text", text: 'Process updates...\n\n{"requestId":"aichat-req-30"}' },
        },
      },
    });
    return { sessionId: "sess-existing", models: { currentModelId: "gemini-4-neon-high" } };
  });

  const http = new FakeHttp();
  const channel = new Channel(cfg, { rpc, http, store });
  await channel.start({ probe: true });

  // #30 reconciled via replay -> accepted (and marked interrupted since process ended); #31 stays uncertain!
  assert.equal(store.value.messages["30"].status, "accepted");
  assert.equal(store.value.messages["30"].processed, true);
  assert.equal(store.value.messages["31"].status, "uncertain");
  await channel.stop();

  // Now test missing session fallback (session/list does NOT contain saved sessionId)
  const store2 = new State(path.join(agentDir, ".aichat", "state-missing.json"));
  store2.patch({ sessionId: "sess-deleted" });
  store2.enqueue({ id: 40, from: "alexey", room: "lobby", text: "in deleted session" }, cfg);
  store2.update([40], { status: "delivered", processed: false });

  const rpc2 = new FakeRpc();
  rpc2.onRequest("initialize", () => ({ agentInfo: { name: "Antigravity ACP Server", version: "1.5.13" }, agentCapabilities: { loadSession: true } }));
  rpc2.onRequest("session/list", () => ({ sessions: [] }));
  rpc2.onRequest("session/new", () => ({ sessionId: "sess-brand-new", models: { currentModelId: "gemini-4-neon-high" } }));

  const ch2 = new Channel(cfg, { rpc: rpc2, http: new FakeHttp(), store: store2 });
  await ch2.start({ probe: true });
  assert.equal(store2.value.sessionId, "sess-brand-new");
  assert.deepEqual(store2.value.previousSessionIds, ["sess-deleted"]);
  assert.equal(store2.value.messages["40"].status, "failed");
  await ch2.stop();
});

test("Channel permission policy approves only mcp_aichat_* when enabled and reports usage per #2165", async (t) => {
  const { agentDir, cfg } = makeTempEnv(t);
  const store = new State(path.join(agentDir, ".aichat", "state.json"));
  const rpc = new FakeRpc();
  rpc.onRequest("initialize", () => ({ agentInfo: { name: "Antigravity ACP Server", version: "1.5.13" } }));
  rpc.onRequest("session/new", () => ({ sessionId: "sess-perm" }));

  const http = new FakeHttp();
  const channel = new Channel(cfg, { rpc, http, store });
  await channel.start({ probe: true });

  // 1. AIChat tool -> approved
  rpc.emit("request", {
    id: "p1",
    method: "session/request_permission",
    params: {
      sessionId: "sess-perm",
      toolCall: { name: "mcp_aichat_aichat_send", toolCallId: "c1" },
      options: [
        { optionId: "allow", kind: "allow_once" },
        { optionId: "deny", kind: "reject_once" },
      ],
    },
  });
  assert.deepEqual(rpc.sent.at(-1), { id: "p1", result: { outcome: { outcome: "selected", optionId: "allow" } } });

  // 2. Non-AIChat shell tool -> declined
  rpc.emit("request", {
    id: "p2",
    method: "session/request_permission",
    params: {
      sessionId: "sess-perm",
      toolCall: { name: "run_command", toolCallId: "c2" },
      options: [
        { optionId: "allow", kind: "allow_once" },
        { optionId: "deny", kind: "reject_once" },
      ],
    },
  });
  assert.deepEqual(rpc.sent.at(-1), { id: "p2", result: { outcome: { outcome: "selected", optionId: "deny" } } });

  // 3. Usage reporting (#2165): tokensIn = inputTokens (no cachedReadTokens), tokensOut = outputTokens (no double thoughtTokens), context.usedPct
  channel.recordContext({ used: 11607, size: 1048576 });
  channel.recordTurnUsage({
    inputTokens: 12857,
    outputTokens: 304,
    cachedReadTokens: 8440,
    thoughtTokens: 205,
    totalTokens: 21601,
  });
  await new Promise((r) => setTimeout(r, 30));

  const usageCall = http.calls.find((c) => c.route === "/api/usage");
  assert.ok(usageCall);
  assert.deepEqual(usageCall.opts.body, {
    provider: "google",
    windows: [],
    session: { tokensIn: 12857, tokensOut: 304 },
    context: { usedPct: 1 },
  });

  await channel.stop();
});

test("install creates config paused=true and refuses overwrite; callTool appends pause notice", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-install-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const agentDir = path.join(root, "my-agent");
  const tokenFile = path.join(root, "tok");
  fs.writeFileSync(tokenFile, "t0k3n", "utf8");

  // Missing --url must be rejected
  assert.throws(
    () =>
      install({
        agentDir,
        appDataDir: "antigravity-aichat-install-test",
        tokenFile,
      }),
    /--url/
  );

  const res = install({
    agentDir,
    appDataDir: "antigravity-aichat-install-test",
    tokenFile,
    url: "http://aichat.home",
    owners: ["alexey"],
    rooms: ["lobby"],
    approveTools: true,
  });
  assert.equal(res.paused, true);
  assert.equal(res.mode, "accept-edits");
  assert.ok(fs.existsSync(path.join(agentDir, "agy-channel.mjs")));
  assert.ok(fs.existsSync(path.join(agentDir, "aichat.config.json")));
  assert.ok(fs.existsSync(path.join(agentDir, "start.ps1")));
  assert.ok(fs.existsSync(path.join(agentDir, "stop.ps1")));

  // Refuses overwrite
  assert.throws(
    () =>
      install({
        agentDir,
        appDataDir: "antigravity-aichat-install-test",
        tokenFile,
        url: "http://aichat.home",
      }),
    /Existing configuration/
  );

  // Paused notice on aichat_send & default mode
  const cfg = loadConfig(path.join(agentDir, "aichat.config.json"));
  assert.equal(cfg.mode, "accept-edits");
  assert.equal(cfg.sandbox, true);
  const out = await callTool(cfg, "aichat_send", { room: "lobby", text: "hello" }, new FakeHttp("t0k3n"));
  assert.match(out, /\(пауза: вхідні не приходять\)/);
  assert.ok(AICHAT_TOOL_ALLOWLIST.test("mcp_aichat_aichat_send"));
  assert.ok(!AICHAT_TOOL_ALLOWLIST.test("mcp_other_aichat_send"));
});

test("BrokerHttp.send journals intents, prevents blind resend on uncertain, redacts token", async (t) => {
  const { cfg } = makeTempEnv(t);
  const http = new BrokerHttp(cfg);
  let attempts = 0;
  http.request = async () => {
    attempts++;
    if (attempts === 1) throw new UncertainError("network reset with " + http.token);
    return { message: { id: 55 } };
  };

  await assert.rejects(
    () => http.send({ room: "lobby", text: "hi" }, "intent-1"),
    (err) => err instanceof UncertainError && !err.message.includes(http.token)
  );
  // Same intent key must refuse blind resend while uncertain
  await assert.rejects(() => http.send({ room: "lobby", text: "hi" }, "intent-1"), /uncertain/);
  // Different intent key with same text IS allowed (no content dedupe!)
  const ok = await http.send({ room: "lobby", text: "hi" }, "intent-2");
  assert.equal(ok.message.id, 55);
  // Repeating already-sent intent key returns cached result without re-POSTing
  const cached = await http.send({ room: "lobby", text: "hi" }, "intent-2");
  assert.equal(cached.message.id, 55);
  assert.equal(attempts, 2);
});

test("DeliveryEngine respects delivery=queue and wake=mention", async (t) => {
  const { agentDir, cfg } = makeTempEnv(t);
  const qCfg = { ...cfg, delivery: "queue", wake: "mention" };
  const store = new State(path.join(agentDir, ".aichat", "state-q.json"));
  store.patch({ sessionId: "sess-q" });

  const rpc = new FakeRpc();
  const deferreds = [];
  rpc.onRequest("session/prompt", () => {
    const d = deferred();
    deferreds.push(d);
    return d.promise;
  });

  const engine = new DeliveryEngine({
    cfg: qCfg,
    store,
    rpc,
    owners: ["alexey"],
    agent: "antigravity-alexey",
    acknowledge: () => true,
  });

  // Unmentioned room message does NOT wake
  await engine.receive({ id: 50, from: "alexey", room: "lobby", text: "general chatter" });
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(deferreds.length, 0);

  // Mention wakes (batches #50 + #51)
  await engine.receive({ id: 51, from: "alexey", room: "lobby", text: "hey antigravity-alexey look" });
  await waitFor(() => deferreds.length === 1);

  // Mid-turn message in delivery=queue MUST wait until turn completes
  await engine.receive({ id: 52, from: "alexey", to: "antigravity-alexey", text: "dm while busy" });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(deferreds.length, 1);

  deferreds[0].resolve({ stopReason: "end_turn" });
  await waitFor(() => deferreds.length === 2);
  deferreds[1].resolve({ stopReason: "end_turn" });
  await waitFor(() => store.value.messages["52"].processed === true);
  engine.close();
});

test("Channel denies aichat tools when approveAichatTools=false and rejects wrong sessionId", async (t) => {
  const { agentDir, cfg } = makeTempEnv(t);
  const strictCfg = { ...cfg, approveAichatTools: false };
  const store = new State(path.join(agentDir, ".aichat", "state-strict.json"));
  const rpc = new FakeRpc();
  rpc.onRequest("initialize", () => ({ agentInfo: { name: "Antigravity ACP Server", version: "1.5.13" } }));
  rpc.onRequest("session/new", () => ({ sessionId: "sess-strict" }));

  const channel = new Channel(strictCfg, { rpc, http: new FakeHttp(), store });
  await channel.start({ probe: true });

  rpc.emit("request", {
    id: "s1",
    method: "session/request_permission",
    params: {
      sessionId: "sess-strict",
      toolCall: { name: "mcp_aichat_aichat_send", toolCallId: "c1" },
      options: [
        { optionId: "allow", kind: "allow_once" },
        { optionId: "deny", kind: "reject_once" },
      ],
    },
  });
  assert.deepEqual(rpc.sent.at(-1), { id: "s1", result: { outcome: { outcome: "selected", optionId: "deny" } } });

  rpc.emit("request", {
    id: "s2",
    method: "session/request_permission",
    params: {
      sessionId: "other-session",
      toolCall: { name: "mcp_aichat_aichat_send", toolCallId: "c2" },
      options: [],
    },
  });
  assert.equal(rpc.sent.at(-1).id, "s2");
  assert.equal(rpc.sent.at(-1).error.code, -32602);
  await channel.stop();
});

test("Channel blocks second concurrent instance sharing the same token", async (t) => {
  const { agentDir, cfg } = makeTempEnv(t);
  const rpc1 = new FakeRpc();
  rpc1.onRequest("initialize", () => ({ agentInfo: { name: "Antigravity ACP Server", version: "1.5.13" } }));
  rpc1.onRequest("session/new", () => ({ sessionId: "sess-lock-1" }));

  const http = new FakeHttp("shared-secret-token");
  const ch1 = new Channel(cfg, { rpc: rpc1, http, store: new State(path.join(agentDir, ".aichat", "s1.json")) });
  await ch1.start({ probe: true });

  // Second instance in a different runtime dir with the same tokenHash must fail on token lock
  const root2 = fs.mkdtempSync(path.join(os.tmpdir(), "agy-lock2-"));
  t.after(() => fs.rmSync(root2, { recursive: true, force: true }));
  const cfg2 = { ...cfg, runtime: path.join(root2, ".aichat") };
  const ch2 = new Channel(cfg2, { rpc: new FakeRpc(), http, store: new State(path.join(cfg2.runtime, "s2.json")) });
  await assert.rejects(() => ch2.start({ probe: true }), /already running/);
  await ch1.stop();
});

test("DeliveryEngine race (#2174): #1 ends naturally after #2 sent, then #2 gets RpcError or UncertainError without false ACK", async (t) => {
  const { agentDir, cfg } = makeTempEnv(t);

  // Sub-case A: #1 finishes naturally (with usage), then #2 receives explicit RpcError -> #2 re-queues without false delivered!
  const storeA = new State(path.join(agentDir, ".aichat", "state-race-a.json"));
  storeA.patch({ sessionId: "sess-race-a" });
  const rpcA = new FakeRpc();
  const defsA = [];
  rpcA.onRequest("session/prompt", () => {
    const d = deferred();
    defsA.push(d);
    return d.promise;
  });
  const ackedA = [];
  const engA = new DeliveryEngine({
    cfg,
    store: storeA,
    rpc: rpcA,
    owners: ["alexey"],
    agent: "antigravity-alexey",
    acknowledge: (id) => {
      ackedA.push(id);
      return true;
    },
  });

  await engA.receive({ id: 70, from: "alexey", room: "lobby", text: "turn 1" });
  await waitFor(() => defsA.length === 1);
  await engA.receive({ id: 71, from: "alexey", room: "lobby", text: "turn 2 race" });
  await waitFor(() => defsA.length === 2);

  // #1 finishes naturally with usage
  defsA[0].resolve({ stopReason: "end_turn", usage: { inputTokens: 100, outputTokens: 10 } });
  await waitFor(() => storeA.value.messages["70"].processed === true);
  // #2 must STILL be uncertain and NOT acked!
  assert.equal(storeA.value.messages["71"].status, "uncertain");
  assert.deepEqual(ackedA, [70]);

  // Now #2 gets explicit RpcError -> falls back to queued and runs cleanly as turn 3!
  defsA[1].reject(new RpcError({ code: -32600, message: "rejected" }));
  await waitFor(() => defsA.length === 3);
  defsA[2].resolve({ stopReason: "end_turn", usage: { inputTokens: 50, outputTokens: 5 } });
  await waitFor(() => storeA.value.messages["71"].processed === true);
  assert.deepEqual(ackedA, [70, 71]);
  engA.close();

  // Sub-case B: #1 finishes, then ACP drops before #2 produces any update -> #2 stays uncertain (never falsely delivered!)
  const storeB = new State(path.join(agentDir, ".aichat", "state-race-b.json"));
  storeB.patch({ sessionId: "sess-race-b" });
  const rpcB = new FakeRpc();
  const defsB = [];
  rpcB.onRequest("session/prompt", () => {
    const d = deferred();
    defsB.push(d);
    return d.promise;
  });
  const ackedB = [];
  const engB = new DeliveryEngine({
    cfg,
    store: storeB,
    rpc: rpcB,
    owners: ["alexey"],
    agent: "antigravity-alexey",
    acknowledge: (id) => {
      ackedB.push(id);
      return true;
    },
  });

  await engB.receive({ id: 80, from: "alexey", room: "lobby", text: "turn 1" });
  await waitFor(() => defsB.length === 1);
  await engB.receive({ id: 81, from: "alexey", room: "lobby", text: "turn 2 drop" });
  await waitFor(() => defsB.length === 2);

  defsB[0].resolve({ stopReason: "end_turn", usage: { inputTokens: 100, outputTokens: 10 } });
  await waitFor(() => storeB.value.messages["80"].processed === true);
  defsB[1].reject(new UncertainError("ACP server exited (1)"));
  await waitFor(() => engB.active === null);

  assert.equal(storeB.value.messages["81"].status, "uncertain");
  assert.deepEqual(ackedB, [80]);
  engB.close();
});

test("Channel paginates session/list, concatenates split user_message_chunk, and preserves session on session/list error (#2175)", async (t) => {
  const { agentDir, cfg } = makeTempEnv(t);

  // 1. Paginated session/list + split requestId marker across two user_message_chunk frames
  const store1 = new State(path.join(agentDir, ".aichat", "state-page.json"));
  store1.patch({ sessionId: "sess-page-2" });
  store1.enqueue({ id: 90, from: "alexey", room: "lobby", text: "split marker" }, cfg);
  store1.update([90], { status: "uncertain", requestId: "aichat-req-split-90" });

  const rpc1 = new FakeRpc();
  rpc1.onRequest("initialize", () => ({ agentInfo: { name: "Antigravity ACP Server", version: "1.5.13" }, agentCapabilities: { loadSession: true } }));
  rpc1.onRequest("session/list", (params) => {
    if (!params?.cursor) return { sessions: [{ sessionId: "other-1" }], nextCursor: "cur-2" };
    if (params.cursor === "cur-2") return { sessions: [{ sessionId: "sess-page-2" }] };
    return { sessions: [] };
  });
  rpc1.onRequest("session/load", () => {
    rpc1.emit("notification", {
      method: "session/update",
      params: {
        sessionId: "sess-page-2",
        update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: 'prefix {"requestId":"aichat-req-' } },
      },
    });
    rpc1.emit("notification", {
      method: "session/update",
      params: {
        sessionId: "sess-page-2",
        update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: 'split-90"} suffix' } },
      },
    });
    return { sessionId: "sess-page-2" };
  });

  const ch1 = new Channel(cfg, { rpc: rpc1, http: new FakeHttp(), store: store1 });
  await ch1.start({ probe: true });
  assert.equal(store1.value.sessionId, "sess-page-2");
  assert.equal(store1.value.messages["90"].status, "accepted");
  await ch1.stop();

  // 2. session/list fails -> falls back to session/load with saved id (does NOT wipe session!)
  const store2 = new State(path.join(agentDir, ".aichat", "state-list-err.json"));
  store2.patch({ sessionId: "sess-keep" });
  const rpc2 = new FakeRpc();
  rpc2.onRequest("initialize", () => ({ agentInfo: { name: "Antigravity ACP Server", version: "1.5.13" } }));
  rpc2.onRequest("session/list", () => Promise.reject(new RpcError({ code: -32603, message: "transient list failure" })));
  rpc2.onRequest("session/load", (p) => ({ sessionId: p.sessionId }));

  const ch2 = new Channel(cfg, { rpc: rpc2, http: new FakeHttp(), store: store2 });
  await ch2.start({ probe: true });
  assert.equal(store2.value.sessionId, "sess-keep");
  await ch2.stop();

  // 3. Both session/list AND session/load fail -> stop with error without creating a new session or wiping sessionId!
  const store3 = new State(path.join(agentDir, ".aichat", "state-both-err.json"));
  store3.patch({ sessionId: "sess-keep-2" });
  const rpc3 = new FakeRpc();
  rpc3.onRequest("initialize", () => ({ agentInfo: { name: "Antigravity ACP Server", version: "1.5.13" } }));
  rpc3.onRequest("session/list", () => Promise.reject(new RpcError({ code: -32603, message: "list down" })));
  rpc3.onRequest("session/load", () => Promise.reject(new RpcError({ code: -32603, message: "load down" })));

  const ch3 = new Channel(cfg, { rpc: rpc3, http: new FakeHttp(), store: store3 });
  await assert.rejects(() => ch3.start({ probe: true }), /load down/);
  assert.equal(store3.value.sessionId, "sess-keep-2");
  await ch3.stop();
});

test("DeliveryEngine (#2180): early handoff of #1 (no usage) followed by #2 error marks #1 processed/error without stranding", async (t) => {
  const { agentDir, cfg } = makeTempEnv(t);
  const store = new State(path.join(agentDir, ".aichat", "state-2180.json"));
  store.patch({ sessionId: "sess-2180" });
  const rpc = new FakeRpc();
  const defs = [];
  rpc.onRequest("session/prompt", () => {
    const d = deferred();
    defs.push(d);
    return d.promise;
  });

  const engine = new DeliveryEngine({
    cfg,
    store,
    rpc,
    owners: ["alexey"],
    agent: "antigravity-alexey",
    acknowledge: () => true,
  });

  await engine.receive({ id: 95, from: "alexey", room: "lobby", text: "turn 1" });
  await waitFor(() => defs.length === 1);
  await engine.receive({ id: 96, from: "alexey", room: "lobby", text: "steer 2" });
  await waitFor(() => defs.length === 2);

  // #1 ends early with NO usage (handoff), then #2 drops with UncertainError
  defs[0].resolve({ stopReason: "end_turn" });
  await waitFor(() => store.value.messages["95"].status === "delivered");
  assert.equal(store.value.messages["95"].processed, false);

  defs[1].reject(new UncertainError("ACP server exited"));
  await waitFor(() => engine.active === null);

  assert.equal(store.value.messages["95"].processed, true);
  assert.equal(store.value.messages["95"].turnStatus, "error");
  assert.equal(store.value.messages["96"].status, "uncertain");
  engine.close();
});

test("install defaults mode to accept-edits, supports --mode in CLI, validates mode, and Channel applies it (#2290)", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-mode-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const tokenFile = path.join(root, "tok");
  fs.writeFileSync(tokenFile, "t0k3n-mode", "utf8");

  assert.throws(() => validateMode(""), /Invalid mode/);
  assert.throws(() => validateMode("bad mode"), /Invalid mode/);
  assert.throws(() => validateMode(true), /Invalid mode/);
  validateMode("accept-edits");
  validateMode("default");
  validateMode(null);

  // 1. Default install -> mode = "accept-edits", sandbox = true
  const dirDefault = path.join(root, "agent-default");
  install({
    agentDir: dirDefault,
    appDataDir: "antigravity-aichat-mode-1",
    tokenFile,
    url: "http://aichat.home",
    owners: ["alexey"],
  });
  const cfgDefault = loadConfig(path.join(dirDefault, "aichat.config.json"));
  assert.equal(cfgDefault.mode, "accept-edits");
  assert.equal(cfgDefault.sandbox, true);

  // 2. Explicit CLI --mode default -> mode = "default"
  const dirCustom = path.join(root, "agent-custom");
  await main([
    "install",
    "--dir",
    dirCustom,
    "--profile",
    "antigravity-aichat-mode-2",
    "--token-file",
    tokenFile,
    "--url",
    "http://aichat.home",
    "--mode",
    "default",
  ]);
  const cfgCustom = loadConfig(path.join(dirCustom, "aichat.config.json"));
  assert.equal(cfgCustom.mode, "default");

  // 3. CLI --mode without value -> rejected
  const dirBad = path.join(root, "agent-bad");
  await assert.rejects(
    () =>
      main([
        "install",
        "--dir",
        dirBad,
        "--profile",
        "antigravity-aichat-mode-3",
        "--token-file",
        tokenFile,
        "--url",
        "http://aichat.home",
        "--mode",
      ]),
    /Invalid mode/
  );

  // 4. Channel.start sends session/set_config_option for mode
  const rpc = new FakeRpc();
  rpc.onRequest("initialize", () => ({ agentInfo: { name: "Antigravity ACP Server", version: "1.5.13" } }));
  rpc.onRequest("session/new", () => ({ sessionId: "sess-mode" }));
  const ch = new Channel(cfgDefault, { rpc, http: new FakeHttp("t0k3n-mode") });
  await ch.start({ probe: true });
  const setMode = rpc.requests.find((r) => r.method === "session/set_config_option" && r.params?.configId === "mode");
  assert.deepEqual(setMode?.params, { sessionId: "sess-mode", configId: "mode", value: "accept-edits" });
  await ch.stop();
});

test("DeliveryEngine.markAccepted() calls schedule() so messages queued during unaccepted steer drain automatically (#2290)", async (t) => {
  const { agentDir, cfg } = makeTempEnv(t);
  const store = new State(path.join(agentDir, ".aichat", "state-2290-schedule.json"));
  store.patch({ sessionId: "sess-sched" });

  const rpc = new FakeRpc();
  const defs = [];
  rpc.onRequest("session/prompt", () => {
    const d = deferred();
    defs.push(d);
    return d.promise;
  });

  const engine = new DeliveryEngine({
    cfg,
    store,
    rpc,
    owners: ["alexey"],
    agent: "antigravity-alexey",
    acknowledge: () => true,
  });

  // 1. Turn #1 (#100) starts and is accepted
  await engine.receive({ id: 100, from: "alexey", room: "lobby", text: "turn 1" });
  await waitFor(() => defs.length === 1);
  await engine.notification({
    method: "session/update",
    params: { sessionId: "sess-sched", update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "ok" } } },
  });

  // 2. Steer #2 (#101) sent, still unaccepted
  await engine.receive({ id: 101, from: "alexey", room: "lobby", text: "steer 2" });
  await waitFor(() => defs.length === 2);

  // 3. Message #102 arrives while steer #2 is unaccepted -> must stay queued (cannot overlap unaccepted steer)
  await engine.receive({ id: 102, from: "alexey", room: "lobby", text: "queued behind steer 2" });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(defs.length, 2);
  assert.equal(store.value.messages["102"].status, "queued");

  // 4. Turn #1 resolves (handoff), steer #2 still unaccepted -> #102 still queued
  defs[0].resolve({ stopReason: "end_turn" });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(defs.length, 2);
  assert.equal(store.value.messages["102"].status, "queued");

  // 5. Post-handoff session/update triggers markAccepted(#101) -> MUST schedule drain for #102 with NO new incoming event!
  await engine.notification({
    method: "session/update",
    params: { sessionId: "sess-sched", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "got #101" } } },
  });
  await waitFor(() => defs.length === 3);
  assert.equal(store.value.messages["101"].status, "delivered");
  assert.equal(store.value.messages["102"].status, "uncertain");

  // Clean finish
  defs[1].resolve({ stopReason: "end_turn" });
  defs[2].resolve({ stopReason: "end_turn" });
  await waitFor(() => store.value.messages["102"].processed === true && engine.active === null);
  engine.close();
});

test("Channel permission_declined watchdog: cancels & recovers, disarms on model progress, and halts if prompt stays hung (#2290)", async (t) => {
  const { agentDir, cfg } = makeTempEnv(t);
  const prevExitCode = process.exitCode;
  t.after(() => {
    process.exitCode = prevExitCode;
  });

  // Sub-case A: After permission_declined (+ declined tool_call_update failed) with no further updates,
  // watchdog sends session/cancel; when ACP resolves prompt with cancelled, channel stays healthy and drains next message.
  {
    const wdCfg = { ...cfg, permissionDeclineTimeoutMs: 60, permissionCancelGraceMs: 150 };
    const store = new State(path.join(agentDir, ".aichat", "state-wd-a.json"));
    const rpc = new FakeRpc();
    const defs = [];
    rpc.onRequest("initialize", () => ({ agentInfo: { name: "Antigravity ACP Server", version: "1.5.13" } }));
    rpc.onRequest("session/new", () => ({ sessionId: "sess-wd-a" }));
    rpc.onRequest("session/prompt", () => {
      const d = deferred();
      defs.push(d);
      return d.promise;
    });
    const origSend = rpc.send.bind(rpc);
    rpc.send = (frame) => {
      origSend(frame);
      if (frame.method === "session/cancel" && defs[0]) {
        defs[0].resolve({ stopReason: "cancelled" });
      }
    };

    const ch = new Channel(wdCfg, { rpc, http: new FakeHttp(), store });
    await ch.start({ probe: true });
    await ch.engine.receive({ id: 200, from: "alexey", room: "lobby", text: "write something" });
    await waitFor(() => defs.length === 1);

    rpc.emit("request", {
      id: "perm-a",
      method: "session/request_permission",
      params: {
        sessionId: "sess-wd-a",
        toolCall: { name: "write_file", toolCallId: "wc-a" },
        options: [{ optionId: "deny", kind: "reject_once" }],
      },
    });
    // Declined tool's own failed status update must NOT disarm the watchdog
    rpc.emit("notification", {
      method: "session/update",
      params: {
        sessionId: "sess-wd-a",
        update: { sessionUpdate: "tool_call_update", toolCallId: "wc-a", status: "failed" },
      },
    });

    await waitFor(() => rpc.sent.some((f) => f.method === "session/cancel"));
    await waitFor(() => ch.engine.active === null);
    assert.equal(ch.halted, false);
    assert.equal(ch.stopping, false);
    assert.deepEqual(
      rpc.sent.find((f) => f.method === "session/cancel"),
      { method: "session/cancel", params: { sessionId: "sess-wd-a" } }
    );
    await ch.stop();
  }

  // Sub-case B: Genuine post-decline model update disarms watchdog (no session/cancel sent)
  {
    const wdCfg = { ...cfg, permissionDeclineTimeoutMs: 60, permissionCancelGraceMs: 60 };
    const store = new State(path.join(agentDir, ".aichat", "state-wd-b.json"));
    const rpc = new FakeRpc();
    const defs = [];
    rpc.onRequest("initialize", () => ({ agentInfo: { name: "Antigravity ACP Server", version: "1.5.13" } }));
    rpc.onRequest("session/new", () => ({ sessionId: "sess-wd-b" }));
    rpc.onRequest("session/prompt", () => {
      const d = deferred();
      defs.push(d);
      return d.promise;
    });

    const ch = new Channel(wdCfg, { rpc, http: new FakeHttp(), store });
    await ch.start({ probe: true });
    await ch.engine.receive({ id: 205, from: "alexey", room: "lobby", text: "write something" });
    await waitFor(() => defs.length === 1);

    rpc.emit("request", {
      id: "perm-b",
      method: "session/request_permission",
      params: {
        sessionId: "sess-wd-b",
        toolCall: { name: "write_file", toolCallId: "wc-b" },
        options: [{ optionId: "deny", kind: "reject_once" }],
      },
    });
    rpc.emit("notification", {
      method: "session/update",
      params: {
        sessionId: "sess-wd-b",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "continued anyway" } },
      },
    });

    await new Promise((r) => setTimeout(r, 150));
    assert.equal(rpc.sent.some((f) => f.method === "session/cancel"), false);
    assert.equal(ch.halted, false);
    defs[0].resolve({ stopReason: "end_turn" });
    await waitFor(() => ch.engine.active === null);
    await ch.stop();
  }

  // Sub-case C: session/prompt stays hung even after session/cancel (agy acp prompt.go:319) -> halts with error & exitCode=1
  {
    const wdCfg = { ...cfg, permissionDeclineTimeoutMs: 50, permissionCancelGraceMs: 50 };
    const store = new State(path.join(agentDir, ".aichat", "state-wd-c.json"));
    const rpc = new FakeRpc();
    const defs = [];
    rpc.onRequest("initialize", () => ({ agentInfo: { name: "Antigravity ACP Server", version: "1.5.13" } }));
    rpc.onRequest("session/new", () => ({ sessionId: "sess-wd-c" }));
    rpc.onRequest("session/prompt", () => {
      const d = deferred();
      defs.push(d);
      return d.promise;
    });

    const ch = new Channel(wdCfg, { rpc, http: new FakeHttp(), store });
    await ch.start({ probe: true });
    await ch.engine.receive({ id: 210, from: "alexey", room: "lobby", text: "hung turn" });
    await waitFor(() => defs.length === 1);

    rpc.emit("request", {
      id: "perm-c",
      method: "session/request_permission",
      params: {
        sessionId: "sess-wd-c",
        toolCall: { name: "write_file", toolCallId: "wc-c" },
        options: [{ optionId: "deny", kind: "reject_once" }],
      },
    });

    await waitFor(() => ch.halted === true && ch.status.phase === "halted");
    assert.equal(rpc.sent.some((f) => f.method === "session/cancel"), true);
    assert.equal(rpc.closed, true);
    assert.equal(process.exitCode, 1);
    assert.match(ch.status.error, /hung after permission_declined/);
  }
});
