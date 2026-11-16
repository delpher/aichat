import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { startBroker, connect, nextMessage, tok } from "./helpers.js";
import { BrokerClient } from "../client/broker-client.js";

test("direct messages are pushed live", async () => {
  const { broker, url } = await startBroker([{ name: "alice" }, { name: "bob" }]);
  const a = await connect(url, "alice");
  const b = await connect(url, "bob");
  const got = nextMessage(b);
  const id = await a.send({ to: "bob", text: "hi bob" });
  const m = await got;
  assert.equal(m.id, id);
  assert.equal(m.from, "alice");
  assert.equal(m.text, "hi bob");
  assert.equal(m.hops, 0);
  a.close(); b.close();
  await broker.close();
});

test("bad token is rejected", async () => {
  const { broker, url } = await startBroker([{ name: "alice" }]);
  const c = new BrokerClient({ url, token: "nope-nope-nope-nope", reconnect: false, log: () => {} });
  await assert.rejects(c.connect(), /token/);
  await broker.close();
});

test("room messages reach members except the sender", async () => {
  const { broker, url } = await startBroker([{ name: "a", rooms: ["lab"] }, { name: "b", rooms: ["lab"] }, { name: "c" }]);
  const a = await connect(url, "a");
  const b = await connect(url, "b");
  const c = await connect(url, "c");
  let cGot = false;
  c.on("message", () => (cGot = true));
  let aGot = false;
  a.on("message", () => (aGot = true));
  const got = nextMessage(b);
  await a.send({ room: "lab", text: "hello lab" });
  assert.equal((await got).room, "lab");
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(cGot, false);
  assert.equal(aGot, false);
  a.close(); b.close(); c.close();
  await broker.close();
});

test("offline agents get queued messages on connect", async () => {
  const { broker, url } = await startBroker([{ name: "a" }, { name: "b" }]);
  const a = await connect(url, "a");
  await a.send({ to: "b", text: "one" });
  await a.send({ to: "b", text: "two" });
  const b = new BrokerClient({ url, token: tok("b"), reconnect: false, log: () => {} });
  const received: string[] = [];
  b.on("message", (m) => received.push(m.text));
  await b.connect();
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(received, ["one", "two"]);
  b.close();
  // reconnecting does not redeliver
  const b2 = new BrokerClient({ url, token: tok("b"), reconnect: false, log: () => {} });
  const again: string[] = [];
  b2.on("message", (m) => again.push(m.text));
  await b2.connect();
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(again, []);
  a.close(); b2.close();
  await broker.close();
});

test("hop limit stops endless reply chains", async () => {
  const { broker, url } = await startBroker([{ name: "a" }, { name: "b" }], { maxHops: 3 });
  const a = await connect(url, "a");
  const b = await connect(url, "b");
  let last = await a.send({ to: "b", text: "ping" });
  for (let i = 1; i <= 3; i++) {
    const sender = i % 2 ? b : a;
    last = await sender.send({ to: i % 2 ? "a" : "b", text: `reply ${i}`, reply_to: last });
  }
  await assert.rejects(b.send({ to: "a", text: "one too many", reply_to: last }), /hop limit/);
  a.close(); b.close();
  await broker.close();
});

test("cannot reply to a message you cannot see", async () => {
  const { broker, url } = await startBroker([{ name: "a" }, { name: "b" }, { name: "c" }]);
  const a = await connect(url, "a");
  const c = await connect(url, "c");
  const id = await a.send({ to: "b", text: "secret" });
  await assert.rejects(c.send({ to: "a", text: "x", reply_to: id }), /unknown message/);
  assert.equal((await c.history({ with: "b" })).length, 0);
  a.close(); c.close();
  await broker.close();
});

test("rate limit", async () => {
  const { broker, url } = await startBroker([{ name: "a" }, { name: "b" }], { ratePerMinute: 2 });
  const a = await connect(url, "a");
  await a.send({ to: "b", text: "1" });
  await a.send({ to: "b", text: "2" });
  await assert.rejects(a.send({ to: "b", text: "3" }), /rate limit/);
  a.close();
  await broker.close();
});

test("REST API: send, inbox, agents, history", async () => {
  const { broker, http } = await startBroker([{ name: "a" }, { name: "rest" }]);
  const h = (name: string) => ({ authorization: `Bearer ${tok(name)}`, "content-type": "application/json" });
  let r = await fetch(`${http}/api/messages`, { method: "POST", headers: h("a"), body: JSON.stringify({ to: "rest", text: "hey" }) });
  assert.equal(r.status, 201);
  r = await fetch(`${http}/api/inbox`, { headers: h("rest") });
  const inbox = (await r.json()) as { messages: { id: number; text: string }[] };
  assert.equal(inbox.messages[0].text, "hey");
  r = await fetch(`${http}/api/inbox`, { headers: h("rest") });
  assert.equal(((await r.json()) as { messages: unknown[] }).messages.length, 0);
  r = await fetch(`${http}/api/messages`, {
    method: "POST", headers: h("rest"), body: JSON.stringify({ to: "a", text: "back", reply_to: inbox.messages[0].id }),
  });
  assert.equal(((await r.json()) as { message: { hops: number } }).message.hops, 1);
  r = await fetch(`${http}/api/agents`, { headers: h("rest") });
  assert.equal(((await r.json()) as { agents: unknown[] }).agents.length, 2);
  r = await fetch(`${http}/api/history?with=a`, { headers: h("rest") });
  assert.equal(((await r.json()) as { messages: unknown[] }).messages.length, 2);
  r = await fetch(`${http}/api/agents`);
  assert.equal(r.status, 401);
  await broker.close();
});

test("webhook agents receive POSTs", async () => {
  const received: { body: { message: { text: string } }; auth?: string }[] = [];
  const hook = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      received.push({ body: JSON.parse(raw), auth: req.headers.authorization });
      res.end("ok");
    });
  });
  await new Promise<void>((r) => hook.listen(0, "127.0.0.1", () => r()));
  const port = (hook.address() as { port: number }).port;
  const { broker, url } = await startBroker([{ name: "a" }, { name: "hooked", webhook: `http://127.0.0.1:${port}/` }]);
  const a = await connect(url, "a");
  await a.send({ to: "hooked", text: "via webhook" });
  await broker.flushWebhooks();
  assert.equal(received.length, 1);
  assert.equal(received[0].body.message.text, "via webhook");
  assert.equal(received[0].auth, `Bearer ${tok("hooked")}`);
  a.close();
  await broker.close();
  hook.close();
});

test("/health reports the version from package.json", async () => {
  const { broker, http } = await startBroker([{ name: "a" }]);
  const { readFileSync } = await import("node:fs");
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  const r = await fetch(`${http}/health`);
  assert.deepEqual(await r.json(), { ok: true, version: pkg.version });
  await broker.close();
});
