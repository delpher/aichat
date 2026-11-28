// Tests of the adapters' shared broker connection (core/broker.mjs) against a small fake broker.
import assert from "node:assert/strict";
import fs from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WebSocketServer } from "ws";
import { BrokerHttp, BrokerSocket, TOKEN_REJECTED, UncertainError, atomicJSON, newerVersion, writeStatus } from "./broker.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (cond, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await sleep(5);
  }
};

/** A WebSocket server playing the broker: records frames, answers auth with welcome unless told otherwise. */
async function fakeBroker(t, { onAuth } = {}) {
  const wss = new WebSocketServer({ port: 0 });
  await new Promise((r) => wss.once("listening", r));
  const b = { frames: [], sockets: [], connections: 0 };
  wss.on("connection", (ws) => {
    b.connections++;
    b.sockets.push(ws);
    ws.on("message", (data) => {
      const f = JSON.parse(String(data));
      b.frames.push(f);
      if (f.type === "auth") (onAuth ?? ((ws) => ws.send(JSON.stringify({ type: "welcome", agent: "bot", rooms: [] }))))(ws, f);
    });
  });
  t.after(() => new Promise((r) => (wss.clients.forEach((c) => c.terminate()), wss.close(() => r()))));
  b.url = `ws://127.0.0.1:${wss.address().port}/ws`;
  b.last = () => b.sockets.at(-1);
  return b;
}

function socketFor(b, t, opts = {}) {
  const phases = [];
  const frames = [];
  const s = new BrokerSocket({
    url: b.url,
    auth: () => ({ token: "tok", client: { name: "test-channel", version: "1.2.3" }, session: "s1" }),
    onFrame: async (f) => void frames.push(f),
    onPhase: (p, d) => phases.push([p, d]),
    firstDelayMs: 20,
    maxDelayMs: 80,
    ...opts,
  });
  t.after(() => s.stop());
  return { s, phases, frames };
}

test("BrokerSocket: auth with the adapter's own payload, welcome makes it ready, then connected", async (t) => {
  const b = await fakeBroker(t);
  const { s, phases, frames } = socketFor(b, t);
  s.start();
  await until(() => phases.some(([p]) => p === "connected"));
  assert.deepEqual(b.frames[0], { type: "auth", token: "tok", client: { name: "test-channel", version: "1.2.3" }, session: "s1" });
  assert.equal(frames[0].type, "welcome");
  assert.equal(s.ready, true);
  assert.equal(phases.at(-1)[1].welcome.agent, "bot");
});

test("BrokerSocket: frames are handled one after another, welcome first; the handler can join and ack", async (t) => {
  const b = await fakeBroker(t, {
    onAuth: (ws) => {
      ws.send(JSON.stringify({ type: "welcome", agent: "bot" }));
      for (let i = 1; i <= 3; i++) ws.send(JSON.stringify({ type: "message", message: { id: i } }));
    },
  });
  const order = [];
  let s;
  ({ s } = socketFor(b, t, {
    onFrame: async (f) => {
      order.push(`start ${f.type} ${f.message?.id ?? ""}`.trim());
      if (f.type === "welcome") {
        assert.equal(s.ready, true, "ready before the welcome handler runs");
        s.send({ type: "join", room: "dev" });
        await sleep(30);
      }
      if (f.type === "message") assert.equal(s.ack(f.message.id), true);
      order.push(`end ${f.type} ${f.message?.id ?? ""}`.trim());
    },
  }));
  s.start();
  await until(() => order.length === 8);
  assert.deepEqual(order, ["start welcome", "end welcome", "start message 1", "end message 1", "start message 2", "end message 2", "start message 3", "end message 3"]);
  await until(() => b.frames.filter((f) => f.type === "delivered").length === 3);
  assert.deepEqual(b.frames.slice(1).map((f) => f.type), ["join", "delivered", "delivered", "delivered"]);
});

test("BrokerSocket: a handler that throws ends it (onFatal), with no reconnect (codex-alexey, 3957)", async (t) => {
  const b = await fakeBroker(t);
  let fatal;
  const { s, phases } = socketFor(b, t, {
    onFrame: async (f) => {
      if (f.type === "welcome") throw new Error("Broker identity mismatch");
    },
    onFatal: (e) => (fatal = e),
  });
  s.start();
  await until(() => fatal);
  assert.match(fatal.message, /identity mismatch/);
  assert.equal(s.halted, true);
  assert.ok(!phases.some(([p]) => p === "connected"));
  await sleep(100);
  assert.equal(b.connections, 1);
});

test("BrokerSocket: a closed socket reconnects with a growing delay; welcome resets it", async (t) => {
  const b = await fakeBroker(t);
  const { s, phases } = socketFor(b, t);
  s.start();
  await until(() => phases.filter(([p]) => p === "connected").length === 1);
  b.last().close(1011);
  await until(() => phases.filter(([p]) => p === "connected").length === 2);
  const reconnects = phases.filter(([p]) => p === "reconnecting");
  assert.equal(reconnects[0][1].delayMs, 20);
  assert.equal(s.delay, 20, "back to the first delay after welcome");
  assert.equal(b.connections, 2);
});

test("BrokerSocket: no welcome in time closes and tries again; delays double up to the maximum", async (t) => {
  const b = await fakeBroker(t, { onAuth: () => {} });
  const { s, phases } = socketFor(b, t, { authTimeoutMs: 15 });
  s.start();
  await until(() => phases.filter(([p]) => p === "reconnecting").length >= 4, 5000);
  assert.deepEqual(phases.filter(([p]) => p === "reconnecting").slice(0, 4).map(([, d]) => d.delayMs), [20, 40, 80, 80]);
});

test("BrokerSocket: close code 4003 (token rejected) halts for good", async (t) => {
  const b = await fakeBroker(t, { onAuth: (ws) => ws.close(TOKEN_REJECTED, "bad token") });
  const { s, phases } = socketFor(b, t);
  s.start();
  await until(() => phases.some(([p]) => p === "halted"));
  await sleep(100);
  assert.equal(b.connections, 1);
  assert.equal(s.halted, true);
  s.start();
  await sleep(50);
  assert.equal(b.connections, 1, "start() does not undo a rejected token");
});

test("BrokerSocket: pings while ready, closes a silent socket", async (t) => {
  const b = await fakeBroker(t);
  const { s, phases } = socketFor(b, t, { heartbeatMs: 20, silenceMs: 1000 });
  s.start();
  await until(() => b.frames.filter((f) => f.type === "ping").length >= 2);
  // the broker goes silent: the socket is closed and opened again
  s.silenceMs = 30;
  await until(() => phases.some(([p]) => p === "reconnecting"));
});

test("BrokerSocket: ack and send are false when not connected; stop() closes without reconnecting", async (t) => {
  const b = await fakeBroker(t);
  const { s, phases } = socketFor(b, t);
  assert.equal(s.ack(1), false);
  assert.equal(s.send({ type: "ping" }), false);
  s.start();
  await until(() => s.ready);
  s.stop();
  assert.equal(phases.at(-1)[0], "stopped");
  assert.equal(s.ack(1), false);
  await sleep(80);
  assert.equal(b.connections, 1);
  // start() again after stop()
  s.start();
  await until(() => b.connections === 2 && s.ready);
});

/** A tiny HTTP server for BrokerHttp. */
async function fakeHttp(t, handler) {
  const server = createServer(handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(() => r())));
  return `http://127.0.0.1:${server.address().port}`;
}

test("BrokerHttp: bearer, JSON both ways, 204, and errors sorted into definite / uncertain", async (t) => {
  const seen = [];
  const base = await fakeHttp(t, (req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ url: req.url, auth: req.headers.authorization, type: req.headers["content-type"], body });
      if (req.url === "/ok") return res.writeHead(200, { "content-type": "application/json" }).end('{"a":1}');
      if (req.url === "/empty") return res.writeHead(204).end();
      if (req.url === "/no") return res.writeHead(409).end("conflict: secret-token-123 here");
      if (req.url === "/boom") return res.writeHead(502).end("bad gateway");
      if (req.url === "/slow") return setTimeout(() => res.writeHead(200).end("{}"), 500);
    });
  });
  const http = new BrokerHttp({ httpBase: base + "/", token: "secret-token-123", timeoutMs: 100 });
  assert.deepEqual(await http.request("/ok", { method: "POST", body: { x: 1 } }), { a: 1 });
  assert.deepEqual(seen[0], { url: "/ok", auth: "Bearer secret-token-123", type: "application/json", body: '{"x":1}' });
  assert.deepEqual(await http.request("/empty"), {});
  await assert.rejects(http.request("/no"), (e) => e.status === 409 && e.definite === true && !e.message.includes("secret-token-123"));
  await assert.rejects(http.request("/boom"), (e) => e.status === 502 && e.definite === false);
  await assert.rejects(http.request("/slow"), (e) => e instanceof UncertainError && e.uncertain === true);
  assert.equal(http.redact("x secret-token-123 y"), "x [REDACTED] y");
  assert.equal(http.tokenHash.length, 16);
  assert.throws(() => new BrokerHttp({ httpBase: base, token: "" }), /Empty AIChat token/);
});

test("BrokerHttp: binary downloads with the name, and a limit", async (t) => {
  const base = await fakeHttp(t, (req, res) => {
    if (req.url === "/f") return res.writeHead(200, { "content-disposition": "attachment; filename*=UTF-8''a.txt" }).end("hello");
    res.writeHead(200).end(Buffer.alloc(64));
  });
  const http = new BrokerHttp({ httpBase: base, token: "t" });
  assert.equal((await http.request("/f", { binary: true })).toString(), "hello");
  assert.deepEqual(await http.request("/f", { binary: true, withHeaders: true }), {
    bytes: Buffer.from("hello"),
    contentDisposition: "attachment; filename*=UTF-8''a.txt",
  });
  await assert.rejects(http.request("/big", { binary: true, limit: 10 }), /too large/);
});

test("BrokerHttp.fromTokenFile reads and trims the token", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aichat-core-broker-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "t"), "abc\n");
  assert.equal(BrokerHttp.fromTokenFile(path.join(dir, "t"), { httpBase: "http://x" }).token, "abc");
});

test("newerVersion compares x.y.z only", () => {
  assert.equal(newerVersion("0.30.0", "0.30.1"), true);
  assert.equal(newerVersion("0.30.1", "0.31.0"), true);
  assert.equal(newerVersion("0.9.9", "1.0.0"), true);
  assert.equal(newerVersion("0.30.1", "0.30.1"), false);
  assert.equal(newerVersion("0.31.0", "0.30.9"), false);
  assert.equal(newerVersion("0.0.0-dev", "0.30.1"), false);
  assert.equal(newerVersion("0.30.1", undefined), false);
});

test("atomicJSON / writeStatus leave a whole file and no temporary ones", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aichat-core-status-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const runtime = path.join(dir, ".aichat");
  writeStatus(runtime, { phase: "waiting", connected: true });
  writeStatus(runtime, { phase: "stopped", connected: false });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(runtime, "status.json"), "utf8")), { phase: "stopped", connected: false });
  assert.deepEqual(fs.readdirSync(runtime), ["status.json"]);
  atomicJSON(path.join(dir, "deep", "x.json"), [1]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "deep", "x.json"), "utf8")), [1]);
});
