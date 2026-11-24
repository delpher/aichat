import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import {
  AICHAT_TOOL_ALLOWLIST,
  AttachServer,
  BrokerHttp,
  CapacityError,
  Channel,
  ConsoleUI,
  DeliveryEngine,
  REACTIONS,
  RpcError,
  State,
  UncertainError,
  attachTerminal,
  callTool,
  cleanOldAttachFiles,
  formatReactionsSince,
  install,
  loadConfig,
  main,
  parseConsoleCommand,
  safeUploadPath,
  sanitizeTerminal,
  summarizeToolCall,
  validateMode,
  validateProfileName,
  acpArgs,
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

test("addDirs: extra workspace folders go to agy acp as --add-dir, never ones holding secrets", (t) => {
  const { root, agentDir, configFile, cfg } = makeTempEnv(t);
  assert.deepEqual(cfg.addDirs, []);
  assert.ok(!acpArgs(cfg).includes("--add-dir"));
  const write = (extra) => {
    const raw = JSON.parse(fs.readFileSync(configFile, "utf8"));
    fs.writeFileSync(configFile, JSON.stringify({ ...raw, ...extra }));
    return () => loadConfig(configFile);
  };
  const repo = path.join(root, "repo");
  const withRepo = write({ addDirs: [repo] })();
  assert.deepEqual(withRepo.addDirs, [repo]);
  const args = acpArgs(withRepo);
  assert.deepEqual(args.slice(args.indexOf("--add-dir"), args.indexOf("--add-dir") + 2), ["--add-dir", repo]);
  assert.equal(args.at(-1), "--sandbox", "the sandbox stays on");

  assert.throws(write({ addDirs: "repo" }), /array of absolute paths/);
  assert.throws(write({ addDirs: ["repo"] }), /array of absolute paths/);
  // the agent folder's parent holds .aichat and the token; .gemini holds the profile and MCP secrets
  assert.throws(write({ addDirs: [root] }), /must not contain/);
  assert.throws(write({ addDirs: [path.dirname(agentDir)] }), /must not contain/);
  assert.throws(write({ addDirs: [os.homedir()] }), /must not contain/);
  assert.throws(write({ addDirs: [path.join(os.homedir(), ".gemini", "config")] }), /must not contain/);
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
  const startSh = path.join(agentDir, "start.sh");
  const stopSh = path.join(agentDir, "stop.sh");
  assert.ok(fs.existsSync(startSh));
  assert.ok(fs.existsSync(stopSh));
  const startShText = fs.readFileSync(startSh, "utf8");
  const stopShText = fs.readFileSync(stopSh, "utf8");
  assert.ok(startShText.startsWith("#!/usr/bin/env sh\n"));
  assert.ok(!startShText.includes("\r"));
  assert.ok(startShText.includes('exec node "$DIR/agy-channel.mjs" run --config "$DIR/aichat.config.json" "$@"'));
  assert.ok(stopShText.startsWith("#!/usr/bin/env sh\n"));
  assert.ok(!stopShText.includes("\r"));
  assert.ok(stopShText.includes('exec node "$DIR/agy-channel.mjs" stop --config "$DIR/aichat.config.json"'));
  if (process.platform !== "win32") {
    assert.notEqual(fs.statSync(startSh).mode & 0o111, 0);
    assert.notEqual(fs.statSync(stopSh).mode & 0o111, 0);
  }

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
    // Declined tool's status update and service updates must NOT disarm the watchdog
    for (const update of [
      { sessionUpdate: "tool_call_update", toolCallId: "wc-a", status: "failed" },
      { sessionUpdate: "available_commands_update", availableCommands: [] },
      { sessionUpdate: "current_mode_update", currentModeId: "accept-edits" },
      { sessionUpdate: "user_message_chunk", content: { type: "text", text: "echo" } },
    ]) {
      rpc.emit("notification", {
        method: "session/update",
        params: { sessionId: "sess-wd-a", update },
      });
    }

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

test("Watchdog cancel preserves unaccepted steer as uncertain/cancelled and reconciles via session/load (#2302-#2306)", async (t) => {
  const { agentDir, cfg } = makeTempEnv(t);
  const wdCfg = { ...cfg, permissionDeclineTimeoutMs: 50, permissionCancelGraceMs: 150 };
  const storePath = path.join(agentDir, ".aichat", "state-wd-cancel.json");
  const store = new State(storePath);

  const rpc = new FakeRpc();
  const defs = [];
  rpc.onRequest("initialize", () => ({ agentInfo: { name: "Antigravity ACP Server", version: "1.5.13" } }));
  rpc.onRequest("session/new", () => ({ sessionId: "sess-wd-cancel" }));
  rpc.onRequest("session/prompt", () => {
    const d = deferred();
    defs.push(d);
    return d.promise;
  });
  const origSend = rpc.send.bind(rpc);
  rpc.send = (frame) => {
    origSend(frame);
    if (frame.method === "session/cancel" && defs[1]) {
      defs[1].resolve({ stopReason: "cancelled" });
    }
  };

  const ch = new Channel(wdCfg, { rpc, http: new FakeHttp(), store });
  await ch.start({ probe: true });
  const acked = [];
  ch.acknowledge = (id) => {
    acked.push(id);
    return true;
  };

  // 1. Message #220 starts turn 1 and is accepted
  await ch.engine.receive({ id: 220, from: "alexey", room: "lobby", text: "first task" });
  await waitFor(() => defs.length === 1);
  rpc.emit("notification", {
    method: "session/update",
    params: {
      sessionId: "sess-wd-cancel",
      update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "working" } },
    },
  });
  await waitFor(() => store.value.messages["220"].status === "delivered");

  // 2. Steer #221 arrives mid-turn (unaccepted), #1 resolves early (handoff without usage)
  await ch.engine.receive({ id: 221, from: "alexey", room: "lobby", text: "unseen steer" });
  await waitFor(() => defs.length === 2);
  defs[0].resolve({ stopReason: "end_turn" });
  await new Promise((r) => setTimeout(r, 40));

  // 3. Permission declined while #221 is unaccepted -> watchdog cancels -> #221 resolves cancelled
  rpc.emit("request", {
    id: "perm-steer",
    method: "session/request_permission",
    params: {
      sessionId: "sess-wd-cancel",
      toolCall: { name: "write_file", toolCallId: "wc-steer" },
      options: [{ optionId: "deny", kind: "reject_once" }],
    },
  });

  await waitFor(() => ch.engine.active === null);

  // Already-accepted #220 -> processed with turnStatus "cancelled"
  assert.equal(store.value.messages["220"].status, "delivered");
  assert.equal(store.value.messages["220"].processed, true);
  assert.equal(store.value.messages["220"].turnStatus, "cancelled");

  // Unaccepted steer #221 -> stays uncertain (NOT delivered/processed, NOT auto-requeued)
  assert.equal(store.value.messages["221"].status, "uncertain");
  assert.equal(store.value.messages["221"].processed, false);
  assert.equal(store.value.messages["221"].turnStatus, "cancelled");
  assert.deepEqual(acked, [220]);

  const steerRequestId = store.value.messages["221"].requestId;
  assert.ok(steerRequestId);
  await ch.stop();

  // 4. Add a second cancelled-uncertain message #222 that will NOT appear in replay, then reload session
  const store2 = new State(storePath);
  store2.enqueue({ id: 222, from: "alexey", room: "lobby", text: "not in replay" }, wdCfg);
  store2.update([222], {
    status: "uncertain",
    requestId: "aichat-missing-222",
    processed: false,
    turnStatus: "cancelled",
  });

  const rpc2 = new FakeRpc();
  rpc2.onRequest("initialize", () => ({ agentInfo: { name: "Antigravity ACP Server", version: "1.5.13" }, agentCapabilities: { loadSession: true } }));
  rpc2.onRequest("session/list", () => ({ sessions: [{ sessionId: "sess-wd-cancel" }] }));
  rpc2.onRequest("session/load", () => {
    rpc2.emit("notification", {
      method: "session/update",
      params: {
        sessionId: "sess-wd-cancel",
        update: {
          sessionUpdate: "user_message_chunk",
          content: { type: "text", text: `{"requestId":"${steerRequestId}"}` },
        },
      },
    });
    return { sessionId: "sess-wd-cancel" };
  });

  const ch2 = new Channel(wdCfg, { rpc: rpc2, http: new FakeHttp(), store: store2 });
  await ch2.start({ probe: true });

  // #221 found in replay -> accepted, but still processed: false + turnStatus: "cancelled"
  assert.equal(store2.value.messages["221"].status, "accepted");
  assert.equal(store2.value.messages["221"].processed, false);
  assert.equal(store2.value.messages["221"].turnStatus, "cancelled");

  // #222 NOT in replay -> remains uncertain + cancelled
  assert.equal(store2.value.messages["222"].status, "uncertain");
  assert.equal(store2.value.messages["222"].processed, false);
  assert.equal(store2.value.messages["222"].turnStatus, "cancelled");
  await ch2.stop();
});

function makeBufferStream(isTTY = true) {
  const chunks = [];
  const stream = new PassThrough();
  stream.isTTY = isTTY;
  stream.on("data", (d) => chunks.push(String(d)));
  return {
    stream,
    text: () => chunks.join(""),
  };
}

test("Console helpers: sanitizeTerminal strips ANSI/OSC 52/OSC 8, summarizeToolCall truncates & redacts, parseConsoleCommand", () => {
  const dirty =
    "Привіт\tсвіт\n" +
    "\x1b[31mRED\x1b[0m " +
    "\x1b]52;c;c2VjcmV0\x07" +
    "\x1b]8;;https://evil.example\x1b\\click\x1b]8;;\x1b\\ " +
    "\x00\x07\x1b[2Jok";
  const clean = sanitizeTerminal(dirty);
  assert.equal(clean, "Привіт\tсвіт\nRED click ok");
  assert.ok(!clean.includes("\x1b"));

  const redact = (v) => String(v).replaceAll("SECRET_TOK", "[REDACTED]");
  const writeSummary = summarizeToolCall(
    { name: "write_file", rawInput: { Path: "outbox/file.txt", Content: "SECRET_TOK " + "a".repeat(500) } },
    redact
  );
  assert.match(writeSummary, /write_file outbox\/file\.txt \(\d+ chars\)/);
  assert.ok(!writeSummary.includes("SECRET_TOK"));
  assert.ok(!writeSummary.includes("aaaaaaaaaa"));

  const sendSummary = summarizeToolCall(
    { name: "mcp_aichat_aichat_send", rawInput: { room: "lobby", text: "Hello with SECRET_TOK" } },
    redact
  );
  assert.match(sendSummary, /#lobby/);
  assert.ok(!sendSummary.includes("SECRET_TOK"));
  assert.ok(sendSummary.includes("[REDACTED]"));

  assert.deepEqual(parseConsoleCommand("/status"), { kind: "status" });
  assert.deepEqual(parseConsoleCommand("/pause"), { kind: "pause" });
  assert.deepEqual(parseConsoleCommand("/resume"), { kind: "resume" });
  assert.deepEqual(parseConsoleCommand("/cancel"), { kind: "cancel" });
  assert.deepEqual(parseConsoleCommand("/thoughts off"), { kind: "thoughts", value: false });
  assert.deepEqual(parseConsoleCommand("/thoughts on"), { kind: "thoughts", value: true });
  assert.deepEqual(parseConsoleCommand("/steer fix now"), { kind: "steer", text: "fix now" });
  assert.equal(parseConsoleCommand("/steer").kind, "invalid");
  assert.equal(parseConsoleCommand("/nope").kind, "unknown");
  assert.equal(parseConsoleCommand("plain prompt"), null);
});

test("ConsoleUI streams thoughts/messages, redacts tokens, suppresses stdout JSON logs, and disables interactivity on non-TTY (#2330)", async (t) => {
  const { agentDir, cfg } = makeTempEnv(t);
  const store = new State(path.join(agentDir, ".aichat", "state-console-1.json"));
  const out = makeBufferStream(false); // non-TTY
  const input = new PassThrough();
  input.isTTY = false;

  const ui = new ConsoleUI({ input, output: out.stream, isTTY: false, showThoughts: true });
  assert.equal(ui.interactive, false);
  assert.equal(ui.promptPermissionsEnabled, false);
  assert.equal(ui.useColor, false);

  const rpc = new FakeRpc();
  rpc.onRequest("initialize", () => ({ agentInfo: { name: "Antigravity ACP Server", version: "1.5.13" } }));
  rpc.onRequest("session/new", () => ({ sessionId: "sess-ui" }));

  const http = new FakeHttp("super-secret-console-token");
  const ch = new Channel(cfg, { rpc, http, store, consoleUI: ui });
  await ch.start({ probe: true });

  // Non-TTY console must fall back to immediate auto-deny on non-AIChat permission
  rpc.emit("request", {
    id: "p-nontty",
    method: "session/request_permission",
    params: {
      sessionId: "sess-ui",
      toolCall: { name: "run_command", toolCallId: "tc-1" },
      options: [
        { optionId: "allow", kind: "allow_once" },
        { optionId: "deny", kind: "reject_once" },
      ],
    },
  });
  assert.deepEqual(rpc.sent.at(-1), {
    id: "p-nontty",
    result: { outcome: { outcome: "selected", optionId: "deny" } },
  });

  // Stream thought, toggle thoughts off, stream message with secret + OSC injection
  ui.writeChunk("thought", "first thought ");
  ui.handleLine("/thoughts off");
  ui.writeChunk("thought", "hidden thought");
  ui.writeChunk("message", "answer with super-secret-console-token \x1b]52;c;YmFk\x07ok");
  ui.showBrokerMessage({ id: 42, from: "alexey", room: "lobby", text: "hi super-secret-console-token" }, true);

  const rendered = out.text();
  assert.ok(rendered.includes("first thought"));
  assert.ok(!rendered.includes("hidden thought"));
  assert.ok(!rendered.includes("super-secret-console-token"));
  assert.ok(rendered.includes("[REDACTED]"));
  assert.ok(!rendered.includes("\x1b"));
  assert.ok(rendered.includes("#42 alexey [owner]"));

  // adapter.log still received structured JSON logs
  const logText = fs.readFileSync(path.join(agentDir, ".aichat", "adapter.log"), "utf8");
  assert.ok(logText.includes('"event":"permission_declined"'));
  assert.ok(!logText.includes("super-secret-console-token"));

  await ch.stop();
});

test("Console /pause keeps WS open while pausing broker drain, allows local prompts without state.json/ACK, and /resume drains (#2333)", async (t) => {
  const { agentDir, cfg } = makeTempEnv(t);
  const store = new State(path.join(agentDir, ".aichat", "state-pause.json"));
  const out = makeBufferStream(true);
  const input = new PassThrough();
  input.isTTY = true;

  const ui = new ConsoleUI({ input, output: out.stream, isTTY: true });
  const rpc = new FakeRpc();
  const defs = [];
  rpc.onRequest("initialize", () => ({ agentInfo: { name: "Antigravity ACP Server", version: "1.5.13" } }));
  rpc.onRequest("session/new", () => ({ sessionId: "sess-pause" }));
  rpc.onRequest("session/prompt", () => {
    const d = deferred();
    defs.push(d);
    return d.promise;
  });

  const ch = new Channel({ ...cfg, paused: false }, { rpc, http: new FakeHttp(), store, consoleUI: ui });
  await ch.start({ probe: true });
  // Simulate an open WS connection and track close/ack calls
  let wsClosed = false;
  ch.connected = true;
  ch.ready = true;
  ch.socket = { readyState: 1, close: () => (wsClosed = true), send: () => {} };
  const acked = [];
  ch.acknowledge = (id) => {
    acked.push(id);
    return true;
  };

  // 1. /pause -> WS stays open, incoming broker message #300 is queued (not drained)
  ui.handleLine("/pause");
  assert.equal(wsClosed, false);
  assert.equal(ch.runtimePaused, true);
  await ch.engine.receive({ id: 300, from: "alexey", room: "lobby", text: "broker while paused" });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(defs.length, 0);
  assert.equal(store.value.messages["300"].status, "queued");

  // 2. Local prompt runs even while paused, does NOT touch state.json or call acknowledge()
  ui.handleLine("local question from owner");
  await waitFor(() => defs.length === 1);
  assert.ok(rpc.requests.at(-1).params.prompt[0].text.includes('"source":"Local owner console"'));
  assert.equal(Object.keys(store.value.messages).length, 1); // only broker #300
  defs[0].resolve({ stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 5 } });
  await waitFor(() => ch.engine.active === null);
  assert.deepEqual(acked, []);

  // 3. /resume -> drains queued broker message #300 automatically
  ui.handleLine("/resume");
  await waitFor(() => defs.length === 2);
  defs[1].resolve({ stopReason: "end_turn" });
  await waitFor(() => store.value.messages["300"].processed === true);
  assert.deepEqual(acked, [300]);

  await ch.stop();
});

test("Local prompt during unaccepted broker steer queues cleanly; /steer verifies activeTurnId & turnGeneration (#2336/#2338)", async (t) => {
  const { agentDir, cfg } = makeTempEnv(t);
  const store = new State(path.join(agentDir, ".aichat", "state-local-steer.json"));
  store.patch({ sessionId: "sess-lsteer" });

  const rpc = new FakeRpc();
  const defs = [];
  rpc.onRequest("session/prompt", () => {
    const d = deferred();
    defs.push(d);
    return d.promise;
  });

  const localEvents = [];
  const engine = new DeliveryEngine({
    cfg,
    store,
    rpc,
    owners: ["alexey"],
    agent: "antigravity-alexey",
    acknowledge: () => true,
    onLocalComplete: (e) => localEvents.push(e),
  });

  // 1. Broker turn #1 (#310) accepted, then broker steer #2 (#311) in-flight & unaccepted
  await engine.receive({ id: 310, from: "alexey", room: "lobby", text: "turn 1" });
  await waitFor(() => defs.length === 1);
  await engine.notification({
    method: "session/update",
    params: { sessionId: "sess-lsteer", update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "t1" } } },
  });
  await engine.receive({ id: 311, from: "alexey", room: "lobby", text: "broker steer 2" });
  await waitFor(() => defs.length === 2);

  // 2. Plain local prompt while broker steer #2 is unaccepted -> stays queued until turn completes
  const rPlain = engine.enqueueLocal("local queued prompt", { steer: false });
  assert.equal(rPlain.ok, true);
  assert.equal(rPlain.queued, true);
  await new Promise((r) => setTimeout(r, 90));
  assert.equal(defs.length, 2);

  // 3. Explicit /steer while broker steer #2 is unaccepted -> waits for #2 acceptance, then steers!
  const rSteer = engine.enqueueLocal("urgent local steer", { steer: true });
  assert.equal(rSteer.ok, true);
  assert.equal(rSteer.steer, true);
  await new Promise((r) => setTimeout(r, 90));
  assert.equal(defs.length, 2); // still waiting for #2 to be accepted!

  // #1 hands off, #2 gets post-handoff update -> markAccepted triggers drain -> local /steer dispatches as #3!
  defs[0].resolve({ stopReason: "end_turn" });
  await new Promise((r) => setTimeout(r, 40));
  await engine.notification({
    method: "session/update",
    params: { sessionId: "sess-lsteer", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "t2" } } },
  });
  await waitFor(() => defs.length === 3);
  assert.ok(rpc.requests[2].params.prompt[0].text.includes("urgent local steer"));

  // Finish #2 and #3 -> queued plain local prompt now runs as #4!
  defs[1].resolve({ stopReason: "end_turn" });
  defs[2].resolve({ stopReason: "end_turn" });
  await waitFor(() => defs.length === 4);
  assert.ok(rpc.requests[3].params.prompt[0].text.includes("local queued prompt"));

  // 4. Stale /steer (targetGeneration mismatch) is downgraded to queued and not sent as steer on wrong turn
  engine.localQueue.push({
    id: "local-stale",
    text: "stale steer",
    steer: true,
    targetTurnId: "old-turn-id",
    targetGeneration: 0,
  });
  engine.drain();
  assert.equal(defs.length, 4); // NOT steered into turn #4!
  assert.equal(localEvents.some((e) => e.id === "local-stale" && e.status === "deferred"), true);

  // Resolve #4 -> deferred local-stale now runs safely as turn #5
  defs[3].resolve({ stopReason: "end_turn" });
  await waitFor(() => defs.length === 5);
  defs[4].resolve({ stopReason: "end_turn" });
  await waitFor(() => engine.active === null);
  engine.close();
});

test("Interactive [y/n] permissions: FIFO queue, RPC-id binding, allow_once only, timeout -> deny + watchdog (#2330/#2338)", async (t) => {
  const { agentDir, cfg } = makeTempEnv(t);
  const pCfg = {
    ...cfg,
    permissionPromptTimeoutMs: 70,
    permissionDeclineTimeoutMs: 60,
    permissionCancelGraceMs: 150,
  };
  const store = new State(path.join(agentDir, ".aichat", "state-perm-tty.json"));
  const out = makeBufferStream(true);
  const input = new PassThrough();
  input.isTTY = true;

  const ui = new ConsoleUI({
    input,
    output: out.stream,
    isTTY: true,
    promptPermissions: true,
    permissionTimeoutMs: 70,
  });
  const rpc = new FakeRpc();
  const defs = [];
  rpc.onRequest("initialize", () => ({ agentInfo: { name: "Antigravity ACP Server", version: "1.5.13" } }));
  rpc.onRequest("session/new", () => ({ sessionId: "sess-perm-tty" }));
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

  const ch = new Channel(pCfg, { rpc, http: new FakeHttp(), store, consoleUI: ui });
  await ch.start({ probe: true });
  await ch.engine.receive({ id: 320, from: "alexey", room: "lobby", text: "run two tools" });
  await waitFor(() => defs.length === 1);

  // Two parallel permission requests -> strictly serialized FIFO
  rpc.emit("request", {
    id: "perm-1",
    method: "session/request_permission",
    params: {
      sessionId: "sess-perm-tty",
      toolCall: { name: "run_command", toolCallId: "t1", rawInput: { CommandLine: "echo 1" } },
      options: [
        { optionId: "allow_always", kind: "allow_always" },
        { optionId: "allow_once", kind: "allow_once" },
        { optionId: "deny", kind: "reject_once" },
      ],
    },
  });
  rpc.emit("request", {
    id: "perm-2",
    method: "session/request_permission",
    params: {
      sessionId: "sess-perm-tty",
      toolCall: { name: "run_command", toolCallId: "t2", rawInput: { CommandLine: "echo 2" } },
      options: [
        { optionId: "allow_once", kind: "allow_once" },
        { optionId: "deny", kind: "reject_once" },
      ],
    },
  });

  assert.equal(ui.activePermission.rpcId, "perm-1");
  assert.equal(ui.permissionQueue.length, 1);

  // Stale/wrong token or rpcId cannot resolve perm-1
  assert.equal(ui.resolvePermission(999, "perm-1", "allow"), false);
  assert.equal(ui.resolvePermission(ui.activePermission.token, "perm-2", "allow"), false);

  // Watchdog MUST NOT be armed while waiting for human on perm-1
  assert.equal(ch.permissionWatchdog, null);

  // User approves perm-1 -> must select allow_once (never allow_always), then prompt perm-2
  ui.handleLine("y");
  await waitFor(() => rpc.sent.some((f) => f.id === "perm-1"));
  assert.deepEqual(
    rpc.sent.find((f) => f.id === "perm-1"),
    { id: "perm-1", result: { outcome: { outcome: "selected", optionId: "allow_once" } } }
  );
  assert.equal(ch.permissionWatchdog, null);
  assert.equal(ui.activePermission?.rpcId, "perm-2");

  // Do not answer perm-2 -> times out -> auto-deny AND arms permissionWatchdog -> sends session/cancel!
  await waitFor(() => rpc.sent.some((f) => f.id === "perm-2"));
  assert.deepEqual(
    rpc.sent.find((f) => f.id === "perm-2"),
    { id: "perm-2", result: { outcome: { outcome: "selected", optionId: "deny" } } }
  );
  await waitFor(() => rpc.sent.some((f) => f.method === "session/cancel") && ch.engine.active === null);

  await ch.stop();
});

test("Interactive [y/n] pending when turn ends on its own is cancelled cleanly without arming watchdog (#2336)", async (t) => {
  const { agentDir, cfg } = makeTempEnv(t);
  const pCfg = { ...cfg, permissionPromptTimeoutMs: 5000, permissionDeclineTimeoutMs: 60 };
  const store = new State(path.join(agentDir, ".aichat", "state-perm-end.json"));
  const out = makeBufferStream(true);
  const input = new PassThrough();
  input.isTTY = true;

  const ui = new ConsoleUI({ input, output: out.stream, isTTY: true, promptPermissions: true, permissionTimeoutMs: 5000 });
  const rpc = new FakeRpc();
  const defs = [];
  rpc.onRequest("initialize", () => ({ agentInfo: { name: "Antigravity ACP Server", version: "1.5.13" } }));
  rpc.onRequest("session/new", () => ({ sessionId: "sess-perm-end" }));
  rpc.onRequest("session/prompt", () => {
    const d = deferred();
    defs.push(d);
    return d.promise;
  });

  const ch = new Channel(pCfg, { rpc, http: new FakeHttp(), store, consoleUI: ui });
  await ch.start({ probe: true });
  await ch.engine.receive({ id: 330, from: "alexey", room: "lobby", text: "task" });
  await waitFor(() => defs.length === 1);

  rpc.emit("request", {
    id: "perm-end",
    method: "session/request_permission",
    params: {
      sessionId: "sess-perm-end",
      toolCall: { name: "run_command", toolCallId: "t-end" },
      options: [{ optionId: "deny", kind: "reject_once" }],
    },
  });
  assert.equal(ui.hasPendingPermission(), true);

  // Turn ends on its own before human responds
  defs[0].resolve({ stopReason: "end_turn" });
  await waitFor(() => ch.engine.active === null && !ui.hasPendingPermission());
  await waitFor(() => rpc.sent.some((f) => f.id === "perm-end"));
  assert.equal(ch.permissionWatchdog, null);
  assert.equal(rpc.sent.some((f) => f.method === "session/cancel"), false);

  await ch.stop();
});

test("/steer is blocked during [y/n], and /cancel during [y/n] denies permission + cancels turn safely (#2336/#2337)", async (t) => {
  const { agentDir, cfg } = makeTempEnv(t);
  const pCfg = { ...cfg, permissionPromptTimeoutMs: 5000, permissionDeclineTimeoutMs: 200 };
  const store = new State(path.join(agentDir, ".aichat", "state-perm-cancel.json"));
  const out = makeBufferStream(true);
  const input = new PassThrough();
  input.isTTY = true;

  const ui = new ConsoleUI({ input, output: out.stream, isTTY: true, promptPermissions: true, permissionTimeoutMs: 5000 });
  const rpc = new FakeRpc();
  const defs = [];
  rpc.onRequest("initialize", () => ({ agentInfo: { name: "Antigravity ACP Server", version: "1.5.13" } }));
  rpc.onRequest("session/new", () => ({ sessionId: "sess-perm-cancel" }));
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

  const ch = new Channel(pCfg, { rpc, http: new FakeHttp(), store, consoleUI: ui });
  await ch.start({ probe: true });
  await ch.engine.receive({ id: 340, from: "alexey", room: "lobby", text: "unaccepted turn" });
  await waitFor(() => defs.length === 1);

  rpc.emit("request", {
    id: "perm-cancel",
    method: "session/request_permission",
    params: {
      sessionId: "sess-perm-cancel",
      toolCall: { name: "run_command", toolCallId: "t-cancel" },
      options: [{ optionId: "deny", kind: "reject_once" }],
    },
  });
  assert.equal(ui.hasPendingPermission(), true);

  // Direct enqueueLocal({ steer: true }) must be refused while [y/n] is pending
  const blocked = ch.engine.enqueueLocal("try steer", { steer: true });
  assert.deepEqual(blocked, { ok: false, reason: "permission_pending" });
  assert.equal(defs.length, 1);

  // Typing /cancel while [y/n] is open denies permission AND sends session/cancel
  ui.handleLine("/cancel");
  await waitFor(
    () =>
      !ui.hasPendingPermission() &&
      rpc.sent.some((f) => f.id === "perm-cancel") &&
      rpc.sent.some((f) => f.method === "session/cancel") &&
      ch.engine.active === null
  );
  // Unaccepted broker #340 stays uncertain + cancelled (no false delivered!)
  assert.equal(store.value.messages["340"].status, "uncertain");
  assert.equal(store.value.messages["340"].turnStatus, "cancelled");

  await ch.stop();
});

test("ConsoleUI redacts secrets (split across chunks or obfuscated with ANSI) and strips split OSC sequences (#2360/#2361/#2362)", () => {
  const token = "secret-split-token-987654321";
  const out = makeBufferStream(false);
  const ui = new ConsoleUI({
    input: new PassThrough(),
    output: out.stream,
    isTTY: false,
    redact: (v) => String(v).split(token).join("[REDACTED]"),
  });

  // 1. Split token across two agent_message_chunk frames
  ui.writeChunk("message", "prefix secret-split-");
  ui.writeChunk("message", "token-987654321 suffix\n");

  // 2. Token obfuscated with embedded ANSI CSI inside the token (#2362)
  ui.writeChunk("message", "ansi-wrapped secret-split-\x1b[31mtoken-987654321\x1b[0m end\n");

  // 3. Split OSC 52 sequence AND split token across agent_thought_chunk frames (flushed on close)
  ui.writeChunk("thought", "thinking \x1b]52;c;c2Vj");
  ui.writeChunk("thought", "cmV0\x07 secret-split-");
  ui.writeChunk("thought", "token-987654321 end");
  ui.close();

  const rendered = out.text();
  assert.ok(!rendered.includes(token));
  assert.ok(!rendered.includes("secret-split-"));
  assert.ok(!rendered.includes("token-987654321"));
  assert.ok(!rendered.includes("\x1b"));
  assert.ok(rendered.includes("prefix [REDACTED] suffix"));
  assert.ok(rendered.includes("ansi-wrapped [REDACTED] end"));
  assert.ok(rendered.includes("thinking  [REDACTED] end"));

  // 4. Broker message & tool summary also redact tokens obfuscated with ANSI (#2362)
  const toolSum = summarizeToolCall(
    { name: "run_command", rawInput: { CommandLine: "echo secret-split-\x1b[31mtoken-987654321" } },
    (v) => String(v).split(token).join("[REDACTED]")
  );
  assert.ok(!toolSum.includes(token));
  assert.ok(toolSum.includes("[REDACTED]"));
});

test("Runtime /pause allows WebSocket reconnect after disconnect while keeping broker drain paused (#2361)", async (t) => {
  const { agentDir, cfg } = makeTempEnv(t);
  const store = new State(path.join(agentDir, ".aichat", "state-pause-reconn.json"));
  const out = makeBufferStream(true);
  const ui = new ConsoleUI({ input: new PassThrough(), output: out.stream, isTTY: true });

  const rpc = new FakeRpc();
  rpc.onRequest("initialize", () => ({ agentInfo: { name: "Antigravity ACP Server", version: "1.5.13" } }));
  rpc.onRequest("session/new", () => ({ sessionId: "sess-reconn" }));

  const ch = new Channel({ ...cfg, paused: false }, { rpc, http: new FakeHttp(), store, consoleUI: ui });
  await ch.start({ probe: true });

  // Fake WebSocket class to observe reconnect during /pause
  const sockets = [];
  const origWs = globalThis.WebSocket;
  class FakeWS extends EventEmitter {
    constructor(url) {
      super();
      this.url = url;
      this.readyState = 1;
      this.sent = [];
      sockets.push(this);
    }
    addEventListener(ev, fn) {
      this.on(ev, fn);
    }
    send(data) {
      this.sent.push(data);
    }
    close() {
      this.readyState = 3;
    }
  }
  FakeWS.OPEN = 1;
  globalThis.WebSocket = FakeWS;
  t.after(() => {
    globalThis.WebSocket = origWs;
  });

  // Initial connect (wsAllowed = true because cfg.paused = false)
  ch.reconnectDelay = 30;
  ch.connect();
  assert.equal(sockets.length, 1);

  // User runs /pause -> wsAllowed stays true, runtimePaused = true
  ui.handleLine("/pause");
  assert.equal(ch.runtimePaused, true);
  assert.equal(ch.wsAllowed, true);

  // Simulate sudden WebSocket drop while paused -> reconnect timer MUST open a second socket!
  sockets[0].emit("close", { code: 1006 });
  assert.equal(ch.socket, null);
  await waitFor(() => sockets.length === 2);
  assert.equal(ch.runtimePaused, true);

  // Drop again with long backoff, then /resume -> clears backoff timer and connects immediately!
  ch.reconnectDelay = 30000;
  sockets[1].emit("close", { code: 1006 });
  assert.equal(ch.socket, null);
  ui.handleLine("/resume");
  assert.equal(sockets.length, 3);
  assert.equal(ch.runtimePaused, false);

  await ch.stop();
});

test("ConsoleUI redacts a secret straddling the 4096-char soft buffer cut (#2365/#2366)", () => {
  const token = "secret-straddle-token-1234567890";
  const out = makeBufferStream(false);
  const ui = new ConsoleUI({
    input: new PassThrough(),
    output: out.stream,
    isTTY: false,
    redact: (v) => String(v).split(token).join("[REDACTED]"),
  });

  ui.writeChunk("message", "x".repeat(3900) + token + "y".repeat(240));
  ui.close();

  const rendered = out.text();
  assert.ok(!rendered.includes(token));
  assert.ok(rendered.includes("[REDACTED]"));
});

test("aichat_react MCP tool validates emoji, sends POST/DELETE, and is on AICHAT_TOOL_ALLOWLIST (#2443)", async (t) => {
  const { cfg } = makeTempEnv(t);
  const http = new FakeHttp("tok");
  assert.ok(AICHAT_TOOL_ALLOWLIST.test("mcp_aichat_aichat_react"));
  assert.equal(REACTIONS.length, 8);

  await callTool(cfg, "aichat_react", { id: 42, emoji: "👍" }, http);
  assert.deepEqual(http.calls.at(-1), {
    route: "/api/messages/42/reactions",
    opts: { method: "POST", body: { emoji: "👍" } },
  });

  await callTool(cfg, "aichat_react", { id: 42, emoji: "👍", remove: true }, http);
  assert.deepEqual(http.calls.at(-1), {
    route: "/api/messages/42/reactions",
    opts: { method: "DELETE", body: { emoji: "👍" } },
  });

  await assert.rejects(() => callTool(cfg, "aichat_react", { id: 42, emoji: "🚀" }, http), /Invalid emoji/);
  await assert.rejects(() => callTool(cfg, "aichat_react", { id: 0, emoji: "👍" }, http), /Invalid message ID/);
});

test("Channel ignores live reaction frames and forwards reactions_since on incoming messages without empty fields (#2443/#2445)", async (t) => {
  const { agentDir, cfg } = makeTempEnv(t);
  const store = new State(path.join(agentDir, ".aichat", "state-react.json"));
  const rpc = new FakeRpc();
  const defs = [];
  rpc.onRequest("initialize", () => ({ agentInfo: { name: "Antigravity ACP Server", version: "1.5.13" } }));
  rpc.onRequest("session/new", () => ({ sessionId: "sess-react" }));
  rpc.onRequest("session/prompt", () => {
    const d = deferred();
    defs.push(d);
    return d.promise;
  });

  const ch = new Channel(cfg, { rpc, http: new FakeHttp(), store });
  await ch.start({ probe: true });

  // 1. Live `reaction` frame MUST NOT wake or queue
  await ch.handleFrame(
    {
      type: "reaction",
      id: 100,
      author: "antigravity-alexey",
      by: "alexey",
      emoji: "👍",
      on: true,
      reactions: { "👍": ["alexey"] },
    },
    {}
  );
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(defs.length, 0);

  // 2. Message frame WITH reactions_since -> included in envelope and summary line, then compacted on processed
  const notes = [
    { id: 100, emoji: "👍", by: "alexey", ts: "2026-11-22T14:00:00Z", room: "lobby" },
    { id: 101, emoji: "✅", by: "claude-alexey", ts: "2026-11-22T14:01:00Z", with: "claude-alexey" },
  ];
  assert.match(formatReactionsSince(notes), /#100 👍 alexey in #lobby; #101 ✅ claude-alexey in DM with claude-alexey/);
  await ch.handleFrame(
    {
      type: "message",
      message: { id: 400, from: "alexey", room: "lobby", text: "next task" },
      reactions_since: notes,
    },
    {}
  );
  await waitFor(() => defs.length === 1);
  const prompt1 = rpc.requests.find((r) => r.method === "session/prompt").params.prompt[0].text;
  assert.ok(prompt1.includes("[reactions to your messages since last time: #100 👍 alexey in #lobby; #101 ✅ claude-alexey in DM with claude-alexey]"));
  assert.ok(prompt1.includes('"reactions_since":['));

  defs[0].resolve({ stopReason: "end_turn" });
  await waitFor(() => store.value.messages["400"].processed === true);
  assert.equal(store.value.messages["400"].reactions_since, undefined);

  // 3. Message frame WITHOUT reactions_since -> field omitted completely from envelope
  await ch.handleFrame(
    {
      type: "message",
      message: { id: 401, from: "alexey", room: "lobby", text: "plain task" },
    },
    {}
  );
  await waitFor(() => defs.length === 2);
  const prompt2 = rpc.requests.filter((r) => r.method === "session/prompt")[1].params.prompt[0].text;
  assert.ok(!prompt2.includes("reactions_since"));
  assert.ok(!prompt2.includes("[reactions to your messages since last time:"));

  defs[1].resolve({ stopReason: "end_turn" });
  await waitFor(() => ch.engine.active === null);
  await ch.stop();
});

test("Lifecycle contract: session policy, .aichat/fresh, previousSessionIds, delivery journal separation, and auth surface/start", async (t) => {
  const { agentDir, configFile, cfg } = makeTempEnv(t);
  assert.equal(cfg.session, "resume");

  // Invalid session policy is rejected by loadConfig
  const badCfgFile = path.join(agentDir, "bad-session.config.json");
  fs.writeFileSync(badCfgFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(configFile, "utf8")), session: "always" }));
  assert.throws(() => loadConfig(badCfgFile), /Invalid session policy/);

  // 1. Resume existing session -> auth.client reports surface="terminal", start="resumed" (preserved across WS reconnect)
  const storeRes = new State(path.join(agentDir, ".aichat", "state-res.json"));
  storeRes.patch({ sessionId: "sess-old-1" });
  const rpcRes = new FakeRpc();
  rpcRes.onRequest("initialize", () => ({ agentInfo: { name: "Antigravity ACP Server", version: "1.5.13" } }));
  rpcRes.onRequest("session/list", () => ({ sessions: [{ sessionId: "sess-old-1" }] }));
  rpcRes.onRequest("session/load", (p) => ({ sessionId: p.sessionId }));

  const sockets = [];
  const origWs = globalThis.WebSocket;
  class FakeWS extends EventEmitter {
    constructor(url) {
      super();
      this.url = url;
      this.readyState = 1;
      this.sent = [];
      this.closed = false;
      sockets.push(this);
    }
    addEventListener(ev, fn) {
      this.on(ev, fn);
    }
    send(data) {
      this.sent.push(JSON.parse(data));
    }
    close() {
      this.readyState = 3;
      this.closed = true;
    }
  }
  FakeWS.OPEN = 1;
  globalThis.WebSocket = FakeWS;
  t.after(() => {
    globalThis.WebSocket = origWs;
  });

  const chRes = new Channel({ ...cfg, paused: false }, { rpc: rpcRes, http: new FakeHttp(), store: storeRes });
  await chRes.start({ probe: true });
  assert.equal(chRes.sessionStart, "resumed");
  chRes.connect();
  sockets[0].emit("open");
  assert.equal(sockets[0].sent[0].type, "auth");
  assert.equal(sockets[0].sent[0].client.surface, "terminal");
  assert.equal(sockets[0].sent[0].client.start, "resumed");
  // Reconnect preserves start="resumed"
  chRes.reconnectDelay = 20;
  sockets[0].emit("close", { code: 1006 });
  await waitFor(() => sockets.length === 2);
  sockets[1].emit("open");
  assert.equal(sockets[1].sent[0].client.surface, "terminal");
  assert.equal(sockets[1].sent[0].client.start, "resumed");
  await chRes.stop();

  // 2. .aichat/fresh failure safety: if session/new fails, marker and old sessionId MUST remain intact
  const freshFile = path.join(cfg.runtime, "fresh");
  fs.writeFileSync(freshFile, "fresh", "utf8");
  const storeFail = new State(path.join(agentDir, ".aichat", "state-fresh-fail.json"));
  storeFail.patch({ sessionId: "sess-before-fail" });
  const rpcFail = new FakeRpc();
  rpcFail.onRequest("initialize", () => ({ agentInfo: { name: "Antigravity ACP Server", version: "1.5.13" } }));
  rpcFail.onRequest("session/new", () => Promise.reject(new RpcError({ code: -32603, message: "acp down" })));
  const chFail = new Channel(cfg, { rpc: rpcFail, http: new FakeHttp(), store: storeFail });
  await assert.rejects(() => chFail.start(), /acp down/);
  assert.equal(storeFail.value.sessionId, "sess-before-fail");
  assert.equal(fs.existsSync(freshFile), true);
  await chFail.stop();

  // 3. probe ignores fresh policy (.aichat/fresh, session="new", --fresh): keeps saved session and marker intact
  const storeProbe = new State(path.join(agentDir, ".aichat", "state-probe-fresh.json"));
  storeProbe.patch({ sessionId: "sess-probe-keep" });
  const rpcProbe = new FakeRpc();
  rpcProbe.onRequest("initialize", () => ({ agentInfo: { name: "Antigravity ACP Server", version: "1.5.13" } }));
  rpcProbe.onRequest("session/list", () => ({ sessions: [{ sessionId: "sess-probe-keep" }] }));
  rpcProbe.onRequest("session/load", (p) => ({ sessionId: p.sessionId }));
  const chProbe = new Channel({ ...cfg, session: "new" }, { rpc: rpcProbe, http: new FakeHttp(), store: storeProbe, fresh: true });
  await chProbe.start({ probe: true });
  assert.equal(chProbe.sessionStart, "resumed");
  assert.equal(storeProbe.value.sessionId, "sess-probe-keep");
  assert.deepEqual(storeProbe.value.previousSessionIds, []);
  assert.equal(fs.existsSync(freshFile), true);
  assert.ok(!rpcProbe.requests.some((r) => r.method === "session/new"));
  await chProbe.stop();

  // 4. .aichat/fresh success: archives old sessionId in previousSessionIds, removes marker, skips session/load,
  //    keeps queued (undelivered) inputs for the new session, never re-delivers already accepted inputs, reports start="new"
  const storeFresh = new State(path.join(agentDir, ".aichat", "state-fresh-ok.json"));
  storeFresh.patch({ sessionId: "sess-old-2", sessionUsage: { tokensIn: 500, tokensOut: 100 } });
  storeFresh.enqueue({ id: 501, from: "alexey", room: "lobby", text: "already accepted in old session" }, cfg);
  storeFresh.update([501], { status: "delivered", processed: false });
  storeFresh.enqueue({ id: 502, from: "alexey", room: "lobby", text: "undelivered waits for new session" }, cfg);

  const rpcFresh = new FakeRpc();
  rpcFresh.onRequest("initialize", () => ({ agentInfo: { name: "Antigravity ACP Server", version: "1.5.13" } }));
  rpcFresh.onRequest("session/new", () => ({ sessionId: "sess-fresh-2" }));

  const chFresh = new Channel(cfg, { rpc: rpcFresh, http: new FakeHttp(), store: storeFresh });
  await chFresh.start();
  assert.equal(chFresh.sessionStart, "new");
  assert.equal(storeFresh.value.sessionId, "sess-fresh-2");
  assert.deepEqual(storeFresh.value.previousSessionIds, ["sess-old-2"]);
  assert.deepEqual(storeFresh.value.sessionUsage, { tokensIn: 0, tokensOut: 0 });
  assert.equal(fs.existsSync(freshFile), false);
  assert.ok(!rpcFresh.requests.some((r) => r.method === "session/load"));
  assert.equal(storeFresh.value.messages["501"].processed, true);
  assert.equal(storeFresh.value.messages["501"].turnStatus, "interrupted");
  assert.equal(storeFresh.value.messages["502"].status, "queued");
  assert.equal(storeFresh.value.messages["502"].processed, false);

  chFresh.wsAllowed = true;
  chFresh.connect();
  sockets.at(-1).emit("open");
  assert.equal(sockets.at(-1).sent[0].client.surface, "terminal");
  assert.equal(sockets.at(-1).sent[0].client.start, "new");
  await chFresh.stop();

  // 5. cfg.session="new" starts a fresh session and archives previousSessionIds
  const storeOpt = new State(path.join(agentDir, ".aichat", "state-opt-new.json"));
  storeOpt.patch({ sessionId: "sess-old-3" });
  const rpcOpt = new FakeRpc();
  rpcOpt.onRequest("initialize", () => ({ agentInfo: { name: "Antigravity ACP Server", version: "1.5.13" } }));
  rpcOpt.onRequest("session/new", () => ({ sessionId: "sess-opt-3" }));
  const chOpt = new Channel({ ...cfg, session: "new" }, { rpc: rpcOpt, http: new FakeHttp(), store: storeOpt });
  await chOpt.start();
  assert.equal(chOpt.sessionStart, "new");
  assert.equal(storeOpt.value.sessionId, "sess-opt-3");
  assert.deepEqual(storeOpt.value.previousSessionIds, ["sess-old-3"]);
  await chOpt.stop();
});

test("Channel.stop sends idle before closing WebSocket and removes .aichat/stop file", async (t) => {
  const { agentDir, cfg } = makeTempEnv(t);
  const store = new State(path.join(agentDir, ".aichat", "state-stop.json"));
  const rpc = new FakeRpc();
  rpc.onRequest("initialize", () => ({ agentInfo: { name: "Antigravity ACP Server", version: "1.5.13" } }));
  rpc.onRequest("session/new", () => ({ sessionId: "sess-stop" }));

  const events = [];
  const http = new FakeHttp();
  const origReq = http.request.bind(http);
  http.request = async (route, opts) => {
    if (route === "/api/activity" && opts?.body?.state === "idle") events.push("idle");
    return origReq(route, opts);
  };

  const ch = new Channel(cfg, { rpc, http, store });
  await ch.start({ probe: true });
  ch.socket = {
    close() {
      events.push("ws_close");
    },
  };
  const stopFile = path.join(cfg.runtime, "stop");
  fs.writeFileSync(stopFile, "stop", "utf8");

  await ch.stop();
  assert.equal(fs.existsSync(stopFile), false);
  assert.deepEqual(events, ["idle", "ws_close"]);
});

test("attachPort config validation and parseConsoleCommand /detach", (t) => {
  const { agentDir, configFile } = makeTempEnv(t);
  const raw = JSON.parse(fs.readFileSync(configFile, "utf8"));

  const okFile = path.join(agentDir, "attach-ok.config.json");
  fs.writeFileSync(okFile, JSON.stringify({ ...raw, attachPort: 60611 }));
  assert.equal(loadConfig(okFile).attachPort, 60611);

  for (const bad of [80, 70000, "60611", 1023.5]) {
    const badFile = path.join(agentDir, `attach-bad-${String(bad)}.config.json`);
    fs.writeFileSync(badFile, JSON.stringify({ ...raw, attachPort: bad }));
    assert.throws(() => loadConfig(badFile), /attachPort must be an integer/);
  }
  assert.deepEqual(parseConsoleCommand("/detach"), { kind: "detach" });
});

test("AttachServer enforces loopback capability token auth and single client, and Channel.stop cleans attach files", async (t) => {
  const { agentDir, cfg } = makeTempEnv(t);
  const store = new State(path.join(agentDir, ".aichat", "state-attach-auth.json"));
  const rpcProbe = new FakeRpc();
  rpcProbe.onRequest("initialize", () => ({ agentInfo: { name: "Antigravity ACP Server", version: "1.5.13" } }));
  rpcProbe.onRequest("session/new", () => ({ sessionId: "sess-attach-probe" }));

  // 1. probe MUST NOT start AttachServer or write attach.json
  const storeProbe = new State(path.join(agentDir, ".aichat", "state-attach-probe.json"));
  const chProbe = new Channel({ ...cfg, attachPort: 0 }, { rpc: rpcProbe, http: new FakeHttp(), store: storeProbe });
  t.after(() => chProbe.stop());
  await chProbe.start({ probe: true });
  assert.equal(chProbe.attachServer, null);
  assert.equal(fs.existsSync(path.join(cfg.runtime, "attach.json")), false);
  await chProbe.stop();

  // 2. Real start writes attach.json + private token and rejects bad token
  const rpc = new FakeRpc();
  rpc.onRequest("initialize", () => ({ agentInfo: { name: "Antigravity ACP Server", version: "1.5.13" } }));
  rpc.onRequest("session/new", () => ({ sessionId: "sess-attach-auth" }));
  const ch = new Channel({ ...cfg, attachPort: 0 }, { rpc, http: new FakeHttp(), store });
  t.after(() => ch.stop());
  await ch.start();
  assert.ok(ch.attachServer && ch.attachServer.port > 0);
  const metaPath = path.join(cfg.runtime, "attach.json");
  assert.equal(fs.existsSync(metaPath), true);
  const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
  assert.equal(meta.host, "127.0.0.1");
  assert.equal(meta.port, ch.attachServer.port);
  const tokenDir = path.join(cfg.runtime, meta.tokenDirectory);
  assert.equal(fs.existsSync(path.join(tokenDir, "token")), true);

  // Raw client with wrong token is rejected with Unauthorized
  const badReply = await new Promise((resolve, reject) => {
    const sock = net.createConnection({ host: "127.0.0.1", port: meta.port });
    let data = "";
    sock.setEncoding("utf8");
    sock.on("data", (c) => {
      data += c;
      if (data.includes("\n")) {
        resolve(JSON.parse(data.split("\n")[0]));
        sock.destroy();
      }
    });
    sock.on("error", reject);
    sock.once("connect", () => sock.write(JSON.stringify({ type: "auth", token: "0".repeat(64) }) + "\n"));
  });
  assert.equal(badReply.type, "error");
  assert.match(badReply.error, /Unauthorized/);

  // 3. Channel.stop cleans up attach.json and private token dir
  await ch.stop();
  assert.equal(fs.existsSync(metaPath), false);
  assert.equal(fs.existsSync(tokenDir), false);
});

test("attachTerminal bridges live stream, /status, local prompts, [y/N] permissions, and detaches without stopping background Channel", async (t) => {
  const { agentDir, cfg } = makeTempEnv(t);
  const store = new State(path.join(agentDir, ".aichat", "state-attach-e2e.json"));
  const rpc = new FakeRpc();
  const promptDefs = [];
  rpc.onRequest("initialize", () => ({ agentInfo: { name: "Antigravity ACP Server", version: "1.5.13" } }));
  rpc.onRequest("session/new", () => ({ sessionId: "sess-attach-e2e" }));
  rpc.onRequest("session/prompt", () => {
    const d = deferred();
    promptDefs.push(d);
    return d.promise;
  });

  const ch = new Channel({ ...cfg, attachPort: 0 }, { rpc, http: new FakeHttp(), store });
  let handle = null;
  t.after(async () => {
    handle?.detach();
    await ch.stop();
  });
  await ch.start();
  ch.setRuntimePaused(true);
  const port = ch.attachServer.port;
  const attachCfg = { ...cfg, attachPort: port };

  // Emit a broker message BEFORE attaching so recent ring buffer replays on connect (broker drain is paused)
  await ch.handleFrame(
    { type: "message", message: { id: 701, from: "alexey", room: "lobby", text: "queued before attach" } },
    {}
  );

  const chunks = [];
  const out = new PassThrough();
  out.on("data", (d) => chunks.push(String(d)));
  const rendered = () => chunks.join("");
  const input = new PassThrough();

  const sessionDone = attachTerminal(attachCfg, {
    input,
    output: out,
    isTTY: true,
    onReady: (h) => {
      handle = h;
    },
  });

  await waitFor(() => handle !== null && rendered().includes("queued before attach"));
  assert.ok(rendered().includes("Підключено до agy-channel"));
  assert.equal(ch.attachServer.hasAttachedClient(), true);

  // 1. /status command returns live snapshot
  handle.ui.handleLine("/status");
  await waitFor(() => rendered().includes("agy-channel status"));

  // 2. Local prompt from attached terminal starts a turn on background Channel and streams assistant chunk back
  handle.ui.handleLine("привіт із attach");
  await waitFor(() => promptDefs.length === 1);
  const sentText = rpc.requests.find((r) => r.method === "session/prompt").params.prompt[0].text;
  assert.ok(sentText.includes("привіт із attach"));

  rpc.emit("notification", {
    method: "session/update",
    params: {
      sessionId: "sess-attach-e2e",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "відповідь у attach\n" } },
    },
  });
  await waitFor(() => rendered().includes("відповідь у attach"));

  // 3. Interactive [y/N] permission prompt routes to attached terminal and approves once
  rpc.emit("request", {
    id: "perm-attach-1",
    method: "session/request_permission",
    params: {
      sessionId: "sess-attach-e2e",
      toolCall: { name: "run_command", toolCallId: "tc-a1", rawInput: { CommandLine: "npm test" } },
      options: [
        { optionId: "allow", kind: "allow_once" },
        { optionId: "deny", kind: "reject_once" },
      ],
    },
  });
  await waitFor(() => rendered().includes("permission #perm-attach-1") && handle.ui.hasPendingPermission());
  handle.ui.handleLine("y");
  await waitFor(() => rpc.sent.some((f) => f.id === "perm-attach-1"));
  assert.deepEqual(
    rpc.sent.find((f) => f.id === "perm-attach-1"),
    { id: "perm-attach-1", result: { outcome: { outcome: "selected", optionId: "allow" } } }
  );

  promptDefs[0].resolve({ stopReason: "end_turn" });
  await waitFor(() => ch.engine.active === null);

  // 4. /detach exits attachTerminal WITHOUT stopping background Channel!
  handle.ui.handleLine("/detach");
  await sessionDone;
  await waitFor(() => !ch.attachServer.hasAttachedClient());
  assert.equal(ch.stopping, false);
  assert.equal(rpc.closed, false);

  await ch.stop();
});
