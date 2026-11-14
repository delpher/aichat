import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBroker, connect, nextMessage } from "./helpers.js";
import { BrokerClient } from "../client/broker-client.js";
import { ConfigFile, ensureAdminToken, validate } from "../broker/config.js";
import type { ChatMessage } from "../protocol.js";

const ADMIN = "admin-token-xxxxxxxxxxxxxxxx";
const auth = (token = ADMIN) => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });

test("admin API: overview and messages see every room and DM", async () => {
  const { broker, url, http } = await startBroker(
    [{ name: "a", rooms: ["lab"] }, { name: "b", rooms: ["lab"] }, { name: "c" }],
    { adminToken: ADMIN },
  );
  const a = await connect(url, "a");
  const b = await connect(url, "b");
  const first = await a.send({ room: "lab", text: "hello lab" });
  await b.send({ room: "lab", text: "hi", reply_to: first });
  await a.send({ to: "c", text: "secret to c" });
  await b.send({ to: "a", text: "dm b->a" });

  let r = await fetch(`${http}/admin/api/overview`, { headers: auth() });
  assert.equal(r.status, 200);
  const o = (await r.json()) as {
    agents: { name: string }[];
    rooms: { name: string; members: string[]; count: number }[];
    dms: { a: string; b: string; count: number }[];
  };
  assert.deepEqual(o.agents.map((x) => x.name), ["a", "b", "c"]);
  assert.deepEqual(o.rooms.map(({ name, members, count }) => ({ name, members, count })), [
    { name: "lab", members: ["a", "b"], count: 2 },
  ]);
  assert.deepEqual(o.dms.map((d) => [d.a, d.b, d.count]).sort(), [["a", "b", 1], ["a", "c", 1]]);

  const get = async (qs: string) => {
    const res = await fetch(`${http}/admin/api/messages${qs}`, { headers: auth() });
    assert.equal(res.status, 200, qs);
    return ((await res.json()) as { messages: ChatMessage[] }).messages;
  };
  assert.equal((await get("")).length, 4);
  assert.deepEqual((await get("?room=lab")).map((m) => m.text), ["hello lab", "hi"]);
  assert.deepEqual((await get("?a=c&b=a")).map((m) => m.text), ["secret to c"]);
  const all = await get("");
  assert.deepEqual(all.map((m) => m.id), [...all.map((m) => m.id)].sort((x, y) => x - y));
  const older = await get(`?before=${all[2].id}&limit=1`);
  assert.deepEqual(older.map((m) => m.id), [all[1].id]);

  r = await fetch(`${http}/admin/api/messages?a=x`, { headers: auth() });
  assert.equal(r.status, 400);
  r = await fetch(`${http}/admin/api/overview`, { headers: auth("wrong-token-xxxxxxxxxxxx") });
  assert.equal(r.status, 401);
  // an agent token is not an admin token
  r = await fetch(`${http}/admin/api/overview`, { headers: auth("token-for-a-xxxxxxxxxxxx") });
  assert.equal(r.status, 401);
  a.close(); b.close();
  await broker.close();
});

test("admin API is off without adminToken", async () => {
  const { broker, http } = await startBroker([{ name: "a" }]);
  const r = await fetch(`${http}/admin/api/overview`, { headers: auth() });
  assert.equal(r.status, 403);
  const c = new BrokerClient({ url: http.replace("http", "ws"), token: ADMIN, reconnect: false, log: () => {} });
  await assert.rejects(c.connect(), /token/);
  await broker.close();
});

test("admin WebSocket observes every message and presence, and is read-only", async () => {
  const { broker, url } = await startBroker([{ name: "a" }, { name: "b" }, { name: "c" }], { adminToken: ADMIN });
  const obs = new BrokerClient({ url, token: ADMIN, reconnect: false, log: () => {} });
  await obs.connect();
  assert.equal(obs.agent, "admin");
  const presence = new Promise<{ agent: string; online: boolean }>((res) => obs.once("presence", res));
  const a = await connect(url, "a");
  assert.deepEqual(await presence, { agent: "a", online: true });
  const got = nextMessage(obs);
  await a.send({ to: "b", text: "private" });
  assert.equal((await got).text, "private");
  await assert.rejects(obs.send({ to: "a", text: "x" }), /read-only/);
  obs.close(); a.close();
  await broker.close();
});

test("admin may post only as human agents; message reaches recipients and observers", async () => {
  const { broker, url, http } = await startBroker(
    [{ name: "me", kind: "human", rooms: ["lobby"] }, { name: "bot", rooms: ["lobby"] }],
    { adminToken: ADMIN },
  );
  const bot = await connect(url, "bot");
  const got = nextMessage(bot);
  let r = await fetch(`${http}/admin/api/messages`, {
    method: "POST", headers: auth(), body: JSON.stringify({ as: "me", room: "lobby", text: "from the web" }),
  });
  assert.equal(r.status, 201);
  const m = await got;
  assert.equal(m.from, "me");
  assert.equal(m.text, "from the web");
  r = await fetch(`${http}/admin/api/messages`, {
    method: "POST", headers: auth(), body: JSON.stringify({ as: "bot", room: "lobby", text: "spoof" }),
  });
  assert.equal(r.status, 403);
  r = await fetch(`${http}/admin/api/messages`, {
    method: "POST", headers: auth(), body: JSON.stringify({ as: "nobody", room: "lobby", text: "x" }),
  });
  assert.equal(r.status, 404);
  r = await fetch(`${http}/admin/api/messages`, { method: "POST", headers: auth(), body: "[1]" });
  assert.equal(r.status, 400);
  bot.close();
  await broker.close();
});

test("web UI static files are served without path traversal", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aichat-web-"));
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>t</title>");
  writeFileSync(join(dir, "app.js"), "console.log(1)");
  const { broker, http } = await startBroker([{ name: "a" }], {}, { webDir: dir });
  let r = await fetch(`${http}/`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type")!, /text\/html/);
  assert.match(r.headers.get("content-security-policy")!, /default-src 'self'/);
  r = await fetch(`${http}/web/app.js`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type")!, /javascript/);
  r = await fetch(`${http}/web/missing.js`);
  assert.equal(r.status, 404);
  r = await fetch(`${http}/web/..%2f..%2fpackage.json`);
  assert.equal(r.status, 404);
  r = await fetch(`${http}/web/%E0%A4%A`);
  assert.equal(r.status, 404);
  await broker.close();
  rmSync(dir, { recursive: true, force: true });
});

test("config: adminToken is validated and ensureAdminToken creates it once", () => {
  assert.throws(() => validate({ adminToken: "short", agents: [] }), /adminToken/);
  assert.throws(
    () => validate({ adminToken: "same-token-xxxxxxxxxxxx", agents: [{ name: "a", kind: "x", token: "same-token-xxxxxxxxxxxx" }] }),
    /shared/,
  );
  const dir = mkdtempSync(join(tmpdir(), "aichat-cfg-"));
  const path = join(dir, "agents.json");
  writeFileSync(path, JSON.stringify({ agents: [] }));
  const one = ensureAdminToken(path);
  assert.equal(one.created, true);
  const two = ensureAdminToken(path);
  assert.deepEqual(two, { token: one.token, created: false });
  assert.equal(JSON.parse(readFileSync(path, "utf8")).adminToken, one.token);
  const three = ensureAdminToken(path, true);
  assert.notEqual(three.token, one.token);
  rmSync(dir, { recursive: true, force: true });
});

test("admin settings: read, change maxHops at runtime, reject bad values", async () => {
  const { broker, url, http } = await startBroker([{ name: "a" }, { name: "b" }], { adminToken: ADMIN, maxHops: 1 });
  let r = await fetch(`${http}/admin/api/settings`, { headers: auth() });
  assert.equal(r.status, 200);
  const s = (await r.json()) as { settings: { maxHops: number }; limits: { maxHops: { min: number; max: number } }; editable: boolean };
  assert.equal(s.settings.maxHops, 1);
  assert.deepEqual(s.limits.maxHops, { min: 1, max: 100 });
  assert.equal(s.editable, true);

  const a = await connect(url, "a");
  const b = await connect(url, "b");
  const first = await a.send({ to: "b", text: "0" });
  const second = await b.send({ to: "a", text: "1", reply_to: first });
  await assert.rejects(a.send({ to: "b", text: "2", reply_to: second }), /hop limit reached \(1\)/);

  const patch = (body: unknown) =>
    fetch(`${http}/admin/api/settings`, { method: "PATCH", headers: auth(), body: JSON.stringify(body) });
  r = await patch({ maxHops: 3 });
  assert.equal(r.status, 200);
  assert.deepEqual(((await r.json()) as { settings: unknown }).settings, { maxHops: 3, ratePerMinute: 30, maxTextLength: 20000 });
  await a.send({ to: "b", text: "2", reply_to: second });

  for (const bad of [{}, { maxHops: 0 }, { maxHops: 101 }, { maxHops: 2.5 }, { maxHops: "5" }, { port: 1 }, [1]])
    assert.equal((await patch(bad)).status, 400, JSON.stringify(bad));
  r = await fetch(`${http}/admin/api/settings`, { method: "PATCH", headers: auth("wrong-token-xxxxxxxxxxxx"), body: "{}" });
  assert.equal(r.status, 401);
  a.close(); b.close();
  await broker.close();
});

test("ConfigFile.updateSettings persists settings and keeps the rest of the file", () => {
  const dir = mkdtempSync(join(tmpdir(), "aichat-cfg-"));
  const path = join(dir, "agents.json");
  const agents = [{ name: "a", kind: "x", token: "token-a-xxxxxxxxxxxxxx" }];
  writeFileSync(path, JSON.stringify({ port: 9000, agents }));
  const file = new ConfigFile(path);
  assert.equal(file.get().maxHops, 8);
  assert.equal(file.updateSettings({ maxHops: 20 }).maxHops, 20);
  assert.equal(file.get().maxHops, 20);
  const saved = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(saved.maxHops, 20);
  assert.equal(saved.port, 9000);
  assert.deepEqual(saved.agents, agents);
  rmSync(dir, { recursive: true, force: true });
});
