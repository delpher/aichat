import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { State, DeliveryEngine, RpcError, UncertainError, BrokerHttp, safeUploadPath, callTool, Channel, install, loadConfig } from './codex-channel.mjs';

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aichat-channel-'));
  const agentDir = path.join(dir, 'agent'), codexHome = path.join(dir, 'profile'), runtime = path.join(agentDir, '.aichat');
  const cfg = { agentDir, codexHome, runtime, outbox: path.join(agentDir, 'outbox'), tempFiles: path.join(dir, 'aichat-files'),
    tokenFile: path.join(dir, 'broker-token'), httpBase: 'http://127.0.0.1', wsUrl: 'ws://127.0.0.1/ws', owners: ['alexey'], rooms: [],
    maxQueue: 10, maxQueueAgeMs: 10000, maxQueueBytes: 4096, maxRecords: 100, maxBatch: 8, maxWakesPerMinute: 12,
    requestTimeoutMs: 100, wake: 'always', delivery: 'steer', paused: false };
  for (const folder of [agentDir, codexHome, runtime, cfg.outbox, cfg.tempFiles]) fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(cfg.tokenFile, 'fake-test-token');
  const store = new State(path.join(runtime, 'state.json')); store.patch({ threadId: 'our-thread' });
  const close = () => {
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith('aichat-channel-'));
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { dir, cfg, store, close };
}
const message = (id, from = 'alexey') => ({ id, from, room: 'room', text: 'Discuss implementation', hops: 0 });
const envelopeData = text => JSON.parse(text.slice(text.indexOf('\n\n') + 2));
function engineFor(f, request) {
  const calls = [], acks = [], events = [];
  const rpc = { request: async (method, params) => { calls.push({ method, params }); return request(method, params); } };
  const engine = new DeliveryEngine({ cfg: f.cfg, store: f.store, rpc, owners: ['alexey'], agent: 'codex-alexey',
    acknowledge: id => { acks.push(id); return true; }, log: (event, fields) => events.push({ event, ...fields }) });
  return { engine, calls, acks, events };
}
function mockChannel(f, responder) {
  const calls = [], events = [];
  const rpc = new EventEmitter(); rpc.initialize = async () => {}; rpc.close = () => {}; rpc.send = () => {};
  rpc.request = async (method, params) => {
    calls.push(method);
    if (method === 'account/read') return { account: { type: 'chatgpt' } };
    return responder(method, params);
  };
  const http = { redact: String, request: async route => {
    if (route === '/api/me') return { name: 'codex-alexey' };
    if (route === '/api/agents') return { agents: [{ name: 'alexey', kind: 'human' }] };
    return {};
  } };
  const channel = new Channel(f.cfg, { rpc, http, store: f.store }); channel.log = event => events.push(event);
  return { channel, calls, events };
}

test('migration receipts suppress previously handled messages without replaying them', async () => {
  const f = fixture(); const x = engineFor(f, async () => { throw new Error('Must not start a turn'); });
  try {
    f.store.patch({ migratedDeliveredIds: [7] });
    await x.engine.receive(message(7)); await x.engine.drain();
    assert.deepEqual(x.acks, [7]); assert.equal(x.calls.length, 0);
  } finally { x.engine.close(); f.close(); }
});

test('input is persisted before request; duplicate queued input is not acknowledged', async () => {
  const f = fixture(); const x = engineFor(f, async () => ({ turn: { id: 'turn-1' } }));
  try {
    await x.engine.receive(message(1)); await x.engine.receive(message(1));
    assert.deepEqual(x.acks, []);
    assert.equal(new State(f.store.file).value.messages[1].status, 'queued');
    await x.engine.drain();
    assert.equal(x.calls.length, 1); assert.deepEqual(x.acks, [1]);
    assert.equal(new State(f.store.file).value.messages[1].status, 'delivered');
    await x.engine.receive(message(1)); assert.deepEqual(x.acks, [1, 1]); assert.equal(x.calls.length, 1);
    const envelope = envelopeData(x.calls[0].params.input[0].text);
    assert.equal(envelope.messages[0].verifiedOwner, true);
    assert.ok(!x.calls[0].params.input[0].text.includes('codex-adapter-dev'), 'shared envelope must not hard-code this installation');
  } finally { x.engine.close(); f.close(); }
});
test('active turn receives steer; broker notices remain queued', async () => {
  const f = fixture(); const x = engineFor(f, async () => ({ turnId: 'turn-1' })); x.engine.active = 'turn-1';
  try {
    await x.engine.receive(message(1, 'aichat')); await x.engine.receive(message(2, 'opencode-alexey'));
    await x.engine.drain();
    assert.equal(x.calls[0].method, 'turn/steer'); assert.equal(x.calls[0].params.expectedTurnId, 'turn-1');
    const envelope = envelopeData(x.calls[0].params.input[0].text);
    assert.equal(envelope.messages[0].verifiedOwner, false); assert.equal(envelope.activeTurnId, 'turn-1'); assert.equal(envelope.delivery, 'turn/steer');
    assert.equal(f.store.value.messages[1].status, 'queued'); assert.deepEqual(x.acks, [2]);
  } finally { x.engine.close(); f.close(); }
});
test('explicit late-steer rejection waits for completion then starts a new turn', async () => {
  const f = fixture(); let attempt = 0;
  const x = engineFor(f, async () => { if (!attempt++) throw new RpcError({ code: -32600, message: 'Turn already completed' }); return { turn: { id: 'next-turn' } }; });
  x.engine.active = 'old-turn';
  try {
    await x.engine.receive(message(1)); await x.engine.drain();
    assert.equal(f.store.value.messages[1].status, 'queued'); assert.deepEqual(x.acks, []);
    await x.engine.drain(); assert.equal(x.calls.length, 1, 'must not spin on the same rejected steer');
    await x.engine.notification({ method: 'turn/completed', params: { threadId: 'our-thread', turn: { id: 'old-turn', status: 'completed' } } });
    await x.engine.drain(); assert.equal(x.calls[1].method, 'turn/start'); assert.deepEqual(x.acks, [1]);
  } finally { x.engine.close(); f.close(); }
});
test('start and steer timeouts remain uncertain across restart, without ACK or automatic retry', async () => {
  for (const active of [null, 'turn-1']) {
    const f = fixture(); const x = engineFor(f, async () => { throw new UncertainError('lost response'); }); x.engine.active = active;
    try {
      await x.engine.receive(message(1)); await x.engine.drain(); await x.engine.drain();
      assert.equal(x.calls.length, 1); assert.deepEqual(x.acks, []);
      assert.equal(new State(f.store.file).value.messages[1].status, 'uncertain');
      await x.engine.receive(message(1)); assert.deepEqual(x.acks, []);
    } finally { x.engine.close(); f.close(); }
  }
});
test('exact client id reconciles uncertain input; unrelated thread/turn cannot acknowledge it', async () => {
  const f = fixture(); const x = engineFor(f, async () => { throw new UncertainError('timeout'); });
  try {
    await x.engine.receive(message(1)); await x.engine.drain(); const clientId = f.store.value.messages[1].requestId;
    const notify = (threadId, client) => ({ method: 'item/completed', params: { threadId, turnId: 'turn-1', item: { type: 'userMessage', clientId: client } } });
    await x.engine.notification(notify('another-thread', clientId));
    await x.engine.notification(notify('our-thread', 'unrelated-request'));
    assert.deepEqual(x.acks, []);
    await x.engine.notification(notify('our-thread', clientId)); assert.deepEqual(x.acks, [1]);
    assert.equal(f.store.value.messages[1].status, 'delivered');
  } finally { x.engine.close(); f.close(); }
});
test('completion before start response does not resurrect a completed turn', async () => {
  const f = fixture(); let x;
  x = engineFor(f, async () => {
    await x.engine.notification({ method: 'turn/completed', params: { threadId: 'our-thread', turn: { id: 'turn-fast', status: 'completed' } } });
    return { turn: { id: 'turn-fast' } };
  });
  try {
    await x.engine.receive(message(1)); await x.engine.drain();
    assert.equal(x.engine.active, null); assert.equal(f.store.value.messages[1].processed, true);
  } finally { x.engine.close(); f.close(); }
});
test('queue limits and expiry preserve failed records with reasons', () => {
  const f = fixture();
  try {
    f.cfg.maxQueue = 1; f.store.enqueue(message(1), f.cfg, 100);
    f.store.enqueue(message(2), f.cfg, 101);
    assert.equal(f.store.value.messages[2].status, 'failed'); assert.match(f.store.value.messages[2].reason, /capacity/);
    assert.deepEqual(f.store.queued(f.cfg, 20000), []); assert.match(f.store.value.messages[1].reason, /TTL/);
  } finally { f.close(); }
});
test('record overflow saves a bounded failure receipt and keeps receiving without an ACK', async () => {
  const f = fixture(); const x = engineFor(f, async () => ({ turn: { id: 'turn-1' } }));
  try {
    f.cfg.maxRecords = 1;
    await x.engine.receive(message(1)); await x.engine.receive(message(2));
    assert.equal(x.engine.stopped, false); assert.deepEqual(x.acks, []);
    const failures = JSON.parse(fs.readFileSync(path.join(f.cfg.runtime, 'capacity-failures.json'), 'utf8'));
    assert.equal(failures[0].message.id, 2); assert.equal(failures[0].status, 'failed'); assert.equal(failures[0].message.text, undefined);
    await x.engine.drain(); assert.deepEqual(x.acks, [1]);
  } finally { x.engine.close(); f.close(); }
});
test('a definitely missing persistent thread is recreated with an explicit warning', async () => {
  const f = fixture();
  const x = mockChannel(f, async method => {
    if (method === 'thread/resume') throw new RpcError({ code: -32600, message: 'thread not found' });
    if (method === 'thread/start') return { thread: { id: 'replacement', modelProvider: 'openai' }, model: 'configured-default' };
    return {};
  });
  try {
    await x.channel.start({ probe: true });
    assert.equal(f.store.value.threadId, 'replacement'); assert.deepEqual(f.store.value.previousThreadIds, ['our-thread']);
    assert.ok(x.events.includes('thread_missing_recreated'));
  } finally { await x.channel.stop(); f.close(); }
});
test('ambiguous resume failure does not create a replacement conversation', async () => {
  const f = fixture(); const x = mockChannel(f, async () => { throw new UncertainError('transient resume failure'); });
  try {
    await assert.rejects(x.channel.start({ probe: true }), /transient resume/);
    assert.equal(f.store.value.threadId, 'our-thread'); assert.ok(!x.calls.includes('thread/start'));
  } finally { await x.channel.stop(); f.close(); }
});
test('missing MCP server is not mistaken for a missing conversation', async () => {
  const f = fixture(); const x = mockChannel(f, async () => { throw new RpcError({ code: -32600, message: 'required MCP server not found while resuming thread' }); });
  try {
    await assert.rejects(x.channel.start({ probe: true }), /MCP server not found/);
    assert.equal(f.store.value.threadId, 'our-thread'); assert.ok(!x.calls.includes('thread/start'));
  } finally { await x.channel.stop(); f.close(); }
});
test('transient turns/list reconciliation failure is logged without failing startup or replaying input', async () => {
  const f = fixture();
  const x = mockChannel(f, async method => {
    if (method === 'thread/resume') return { thread: { id: 'our-thread', modelProvider: 'openai' } };
    if (method === 'thread/turns/list') throw new UncertainError('temporary history outage');
    return {};
  });
  try {
    f.store.enqueue(message(1), f.cfg); f.store.update([1], { status: 'accepted', turnId: 'previous-turn' });
    await x.channel.start({ probe: true });
    assert.ok(x.events.includes('turn_reconcile_unavailable')); assert.equal(f.store.value.messages[1].status, 'accepted');
    assert.ok(!x.calls.includes('turn/start'));
  } finally { await x.channel.stop(); f.close(); }
});
test('storage failure before RPC preserves queued input and sends neither request nor ACK', async () => {
  const f = fixture(); const x = engineFor(f, async () => ({ turn: { id: 'must-not-start' } }));
  try {
    await x.engine.receive(message(1));
    fs.mkdirSync(`${f.store.file}.${process.pid}.tmp`);
    await assert.rejects(x.engine.drain());
    assert.equal(x.calls.length, 0); assert.deepEqual(x.acks, []);
    assert.equal(new State(f.store.file).value.messages[1].status, 'queued');
  } finally { x.engine.close(); f.close(); }
});
test('new channel storage retries a real Windows file sharing lock', { skip: process.platform !== 'win32' }, async () => {
  const f = fixture(); let child, closed;
  try {
    f.store.enqueue(message(1), f.cfg);
    child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      "$handle = [IO.File]::Open($env:AICHAT_TEST_LOCK_PATH, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite); [Console]::WriteLine('locked'); Start-Sleep -Milliseconds 250; $handle.Dispose()"],
      { windowsHide: true, env: { ...process.env, AICHAT_TEST_LOCK_PATH: f.store.file }, stdio: ['ignore', 'pipe', 'pipe'] });
    closed = new Promise((accept, reject) => { child.on('close', accept); child.on('error', reject); }); closed.catch(() => {});
    await new Promise((accept, reject) => {
      const timeout = setTimeout(() => reject(new Error('Lock holder timed out')), 10000);
      child.stdout.once('data', data => { clearTimeout(timeout); assert.match(String(data), /locked/); accept(); });
      child.once('error', error => { clearTimeout(timeout); reject(error); });
    });
    const started = Date.now();
    f.store.update([1], { status: 'accepted', turnId: 'test-turn' });
    assert.ok(Date.now() - started >= 100);
    assert.equal(new State(f.store.file).value.messages[1].status, 'accepted'); await closed;
  } finally { child?.kill(); if (closed) await closed.catch(() => {}); f.close(); }
});
test('outgoing uncertain sends are not repeated; confirmed sends are reused', async () => {
  const f = fixture();
  try {
    const http = new BrokerHttp(f.cfg); let calls = 0;
    http.request = async () => { calls++; throw new UncertainError('connection lost after server accepted message'); };
    const body = { room: 'room', text: 'hello', reply_to: 1 };
    await assert.rejects(http.send(body, 'same-intent'), /connection lost/);
    await assert.rejects(http.send(body, 'same-intent'), /uncertain/); assert.equal(calls, 1);
    http.request = async () => { calls++; return { message: { id: 77 } }; };
    const other = { ...body, text: 'different message' };
    assert.equal((await http.send(other, 'another-intent')).message.id, 77); assert.equal((await http.send(other, 'another-intent')).message.id, 77); assert.equal(calls, 2);
    await http.send(other, 'intentional-repeat'); assert.equal(calls, 3, 'identical content with a new intent must be sent');
    await assert.rejects(http.send({ ...other, text: 'changed' }, 'another-intent'), /different message/);
  } finally { f.close(); }
});
test('broker messages wake an idle agent but never steer into an existing turn', async () => {
  const f = fixture(); const x = engineFor(f, async () => ({ turn: { id: 'broker-turn' } }));
  try {
    await x.engine.receive(message(1, 'aichat')); await x.engine.drain();
    assert.equal(x.calls[0].method, 'turn/start'); assert.deepEqual(x.acks, [1]);
    await x.engine.receive(message(2, 'aichat')); await x.engine.drain();
    assert.equal(x.calls.length, 1); assert.equal(f.store.value.messages[2].status, 'queued');
  } finally { x.engine.close(); f.close(); }
});
test('processed receipts drop payload while retaining correlation and route', async () => {
  const f = fixture(); const x = engineFor(f, async () => ({ turn: { id: 'turn-1' } }));
  try {
    await x.engine.receive({ ...message(1), attachments: [{ id: 'a', name: 'source.txt' }] }); await x.engine.drain();
    await x.engine.notification({ method: 'turn/completed', params: { threadId: 'our-thread', turn: { id: 'turn-1', status: 'completed' } } });
    const saved = new State(f.store.file).value.messages[1];
    assert.equal(saved.message.text, undefined); assert.equal(saved.message.attachments, undefined);
    assert.equal(saved.message.room, 'room'); assert.equal(saved.turnId, 'turn-1'); assert.ok(saved.processed);
  } finally { x.engine.close(); f.close(); }
});
test('temporary intro refresh failure does not block the next incoming message', async () => {
  const f = fixture(); const received = [], events = [];
  const channel = new Channel(f.cfg, { store: f.store, http: { redact: String, request: async () => { throw new UncertainError('temporary network outage'); } } });
  channel.log = event => events.push(event); channel.engine = { receive: async m => received.push(m.id) };
  try {
    await channel.handleFrame({ type: 'intro' }, {});
    await channel.handleFrame({ type: 'message', message: message(1) }, {});
    if (channel.introRefresh) await channel.introRefresh;
    assert.deepEqual(received, [1]); assert.equal(channel.halted, false); assert.ok(events.includes('intro_refresh_failed'));
  } finally { f.close(); }
});
test('a pending intro request cannot delay durable ingestion of subsequent messages', async () => {
  const f = fixture(); const received = []; let release;
  const channel = new Channel(f.cfg, { store: f.store, http: { redact: String, request: () => new Promise(resolve => { release = resolve; }) } });
  channel.log = () => {}; channel.engine = { receive: async m => received.push(m.id) };
  try {
    await channel.handleFrame({ type: 'intro' }, {});
    await channel.handleFrame({ type: 'message', message: message(1) }, {});
    assert.deepEqual(received, [1]); release({ intro: { ts: 'new' } }); await channel.introRefresh;
  } finally { f.close(); }
});
test('reconnect resends receipts only for accepted inputs, not historical delivered inputs', async () => {
  const f = fixture(); const acked = [];
  const channel = new Channel(f.cfg, { store: f.store, http: { redact: String } });
  channel.me = 'codex-alexey'; channel.log = () => {}; channel.report = () => {}; channel.activity = () => {}; channel.checkUpdate = async () => {};
  channel.engine = { ack: async ids => acked.push(...ids), schedule() {} };
  try {
    f.store.enqueue(message(1), f.cfg); f.store.update([1], { status: 'accepted' });
    f.store.enqueue(message(2), f.cfg); f.store.update([2], { status: 'delivered', processed: true });
    await channel.handleFrame({ type: 'welcome', agent: channel.me, rooms: [] }, { readyState: WebSocket.OPEN, send() {} });
    assert.deepEqual(acked, [1]);
  } finally { f.close(); }
});
test('file_send blocks profiles, .env, renamed hardlinks and symlink escape; allows a normal outbox file', () => {
  const f = fixture();
  try {
    const normal = path.join(f.cfg.outbox, 'implementation.mjs'); fs.writeFileSync(normal, 'export const version=1;');
    assert.equal(safeUploadPath(f.cfg, normal).real, fs.realpathSync(normal));
    const env = path.join(f.cfg.outbox, '.env.production'); fs.writeFileSync(env, 'fake secret'); assert.throws(() => safeUploadPath(f.cfg, env), /private/);
    const auth = path.join(f.cfg.codexHome, 'auth.json'); fs.writeFileSync(auth, '{}'); assert.throws(() => safeUploadPath(f.cfg, auth), /private/);
    const link = path.join(f.cfg.outbox, 'renamed.txt'); fs.linkSync(f.cfg.tokenFile, link); assert.throws(() => safeUploadPath(f.cfg, link), /hard-linked/);
    const escape = path.join(f.cfg.outbox, 'escape'); fs.symlinkSync(f.cfg.codexHome, escape, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => safeUploadPath(f.cfg, path.join(escape, 'auth.json')), /private/);
    assert.throws(() => safeUploadPath(f.cfg, path.join(f.cfg.runtime, 'state.json')), /private/);
  } finally { f.close(); }
});
test('paused MCP sends carry a pause note and validate arguments before network use', async () => {
  const f = fixture();
  try {
    f.cfg.paused = true; let calls = 0;
    const http = { send: async () => { calls++; return { id: 1 }; } };
    assert.match(await callTool(f.cfg, 'aichat_send', { to: 'alexey', text: 'test', reply_to: 4 }, http), /пауза/);
    await assert.rejects(callTool(f.cfg, 'aichat_send', { to: 'alexey', room: 'room', text: 'bad' }, http), /exactly one/);
    await assert.rejects(callTool(f.cfg, 'aichat_send', { to: 'alexey', text: 'x', arbitrary: true }, http), /Unknown argument/);
    assert.equal(calls, 1);
  } finally { f.close(); }
});
test('file sends deduplicate one intent but allow a new identical send', async () => {
  const f = fixture();
  try {
    const file = path.join(f.cfg.outbox, 'implementation.mjs'); fs.writeFileSync(file, 'export const ready=true;');
    const http = new BrokerHttp(f.cfg); let uploads = 0, sends = 0;
    http.request = async route => route === '/api/files' ? { file: { id: `file-${++uploads}` } } : { message: { id: 100 + ++sends } };
    const args = { path: file, to: 'alexey', text: 'code', request_id: 'file-intent' };
    await callTool(f.cfg, 'aichat_file_send', args, http);
    await callTool(f.cfg, 'aichat_file_send', args, http); assert.equal(sends, 1);
    await callTool(f.cfg, 'aichat_file_send', { ...args, request_id: 'another-file-intent' }, http); assert.equal(sends, 2);
  } finally { f.close(); }
});
test('installer requires opt-in for unattended MCP tools and accepts custom owners/rooms', () => {
  const f = fixture();
  try {
    const result = install({ agentDir: f.cfg.agentDir, codexHome: f.cfg.codexHome, tokenFile: f.cfg.tokenFile, owners: ['owner'], rooms: ['topic'], codex: 'native-codex.exe' });
    assert.match(fs.readFileSync(path.join(f.cfg.codexHome, 'config.toml'), 'utf8'), /default_tools_approval_mode = "prompt"/);
    const cfg = loadConfig(result.configFile);
    assert.deepEqual(cfg.owners, ['owner']); assert.deepEqual(cfg.rooms, ['topic']); assert.equal(cfg.codex, 'native-codex.exe');
  } finally { f.close(); }
});
test('usage forwards Codex totals without double-counting cached input or reasoning', async () => {
  const f = fixture(); const calls = [];
  const channel = new Channel(f.cfg, { store: f.store, http: { redact: String, request: async (route, options) => { calls.push({ route, ...options }); return {}; } } });
  channel.log = () => {};
  try {
    channel.usage({ total: { inputTokens: 1000, outputTokens: 100, cachedInputTokens: 900, reasoningOutputTokens: 80 } });
    await Promise.resolve();
    assert.deepEqual(calls[0].body, { provider: 'openai', windows: [], session: { tokensIn: 1000, tokensOut: 100 } });
  } finally { clearTimeout(channel.usageTimer); f.close(); }
});
test('installer preserves existing files, isolates profile and MCP uses HTTP-only mode', async () => {
  const f = fixture(); let child;
  try {
    const installed = install({ agentDir: f.cfg.agentDir, codexHome: f.cfg.codexHome, tokenFile: f.cfg.tokenFile, url: 'http://127.0.0.1', approveTools: true });
    const cfg = loadConfig(installed.configFile);
    assert.equal(cfg.paused, true); assert.equal(cfg.delivery, 'steer');
    assert.match(fs.readFileSync(path.join(f.cfg.codexHome, 'config.toml'), 'utf8'), /"mcp"/);
    assert.match(fs.readFileSync(path.join(f.cfg.codexHome, 'config.toml'), 'utf8'), /default_tools_approval_mode = "approve"/);
    assert.throws(() => install({ agentDir: f.cfg.agentDir, codexHome: f.cfg.codexHome, tokenFile: f.cfg.tokenFile }), /Existing configuration/);
    child = spawn(process.execPath, [path.join(f.cfg.agentDir, 'codex-channel.mjs'), 'mcp', '--config', installed.configFile], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    const response = new Promise((accept, reject) => {
      const timer = setTimeout(() => reject(new Error('MCP timeout')), 10000);
      child.on('error', error => { clearTimeout(timer); reject(error); });
      child.stdout.on('data', chunk => { output += chunk; if (output.split('\n').filter(Boolean).length === 2) { clearTimeout(timer); accept(); } });
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } }) + '\n');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
    await response;
    const frames = output.trim().split('\n').map(JSON.parse);
    assert.equal(frames[0].result.protocolVersion, '2025-03-26');
    assert.equal(frames[1].result.tools.length, 11);
    const closed = new Promise(accept => child.on('close', accept)); child.stdin.end(); await closed;
  } finally { child?.kill(); f.close(); }
});
