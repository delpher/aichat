import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBroker, connect, nextMessage, tok } from "./helpers.js";
import { BrokerClient } from "../client/broker-client.js";
import { ConfigFile, addAgent, setAdmin, validate } from "../broker/config.js";
import type { ChatMessage } from "../protocol.js";

/** The admin in these tests: a person with admin rights, using their own token. */
const BOSS = { name: "boss", kind: "human", admin: true };
const ADMIN = tok("boss");
const feed = (url: string, token = ADMIN) => new BrokerClient({ url, token, observer: true, reconnect: false, log: () => {} });
const auth = (token = ADMIN) => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });

test("admin API: overview and messages see every room, but only the admin's own DMs", async () => {
  const { broker, url, http } = await startBroker(
    [{ name: "a", rooms: ["lab"] }, { name: "b", rooms: ["lab"] }, { name: "c" }, BOSS],
  );
  const a = await connect(url, "a");
  const b = await connect(url, "b");
  const c = await connect(url, "c");
  const first = await a.send({ room: "lab", text: "hello lab" });
  await b.send({ room: "lab", text: "hi", reply_to: first });
  await a.send({ to: "c", text: "secret to c" });
  await b.send({ to: "a", text: "dm b->a" });
  await c.send({ to: "boss", text: "for boss" });

  let r = await fetch(`${http}/admin/api/overview`, { headers: auth() });
  assert.equal(r.status, 200);
  const o = (await r.json()) as {
    agents: { name: string }[];
    rooms: { name: string; members: string[]; count: number }[];
    dms: { a: string; b: string; count: number }[];
    max_hops: number;
  };
  assert.deepEqual(o.agents.map((x) => x.name), ["a", "b", "c", "boss"]);
  assert.equal(o.max_hops, 8, "the web UI marks reply chains that reached this length");
  assert.deepEqual(o.rooms.map(({ name, members, count }) => ({ name, members, count })), [
    { name: "lab", members: ["a", "b"], count: 2 },
  ]);
  assert.deepEqual(o.dms.map((d) => [d.a, d.b, d.count]), [["boss", "c", 1]], "other people's DMs stay private");

  const get = async (qs: string) => {
    const res = await fetch(`${http}/admin/api/messages${qs}`, { headers: auth() });
    assert.equal(res.status, 200, qs);
    return ((await res.json()) as { messages: ChatMessage[] }).messages;
  };
  assert.deepEqual((await get("")).map((m) => m.text), ["hello lab", "hi", "for boss"]);
  assert.deepEqual((await get("?room=lab")).map((m) => m.text), ["hello lab", "hi"]);
  assert.deepEqual((await get("?a=c&b=boss")).map((m) => m.text), ["for boss"]);
  assert.deepEqual((await get("?agent=a")).map((m) => m.text), ["hello lab"]);
  r = await fetch(`${http}/admin/api/messages?a=c&b=a`, { headers: auth() });
  assert.equal(r.status, 403, "someone else's direct conversation");
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
  a.close(); b.close(); c.close();
  await broker.close();
});

test("without any admin the admin API says how to create one; the old adminToken is ignored", async () => {
  const { broker, url, http } = await startBroker([{ name: "a" }, { name: "p", kind: "human" }], {
    adminToken: "old-root-token-xxxxxxxxxxxx",
  });
  let r = await fetch(`${http}/admin/api/overview`, { headers: auth(tok("p")) });
  assert.equal(r.status, 403);
  assert.match(((await r.json()) as { error: string }).error, /npm run admin/);
  r = await fetch(`${http}/admin/api/overview`, { headers: auth("old-root-token-xxxxxxxxxxxx") });
  assert.equal(r.status, 403);
  await assert.rejects(feed(url, "old-root-token-xxxxxxxxxxxx").connect(), /token/);
  await assert.rejects(feed(url, tok("a")).connect(), /admin/);
  await broker.close();
});

test("admin WebSocket observes rooms, own DMs and presence, not other people's DMs, and is read-only", async () => {
  const { broker, url } = await startBroker([{ name: "a", rooms: ["lab"] }, { name: "b" }, { name: "c" }, BOSS]);
  const obs = feed(url);
  await obs.connect();
  assert.equal(obs.agent, "boss");
  const presence = new Promise<{ agent: string; online: boolean }>((res) =>
    obs.on("presence", (p: { agent: string; online: boolean }) => p.agent === "a" && res(p)),
  );
  const a = await connect(url, "a");
  assert.deepEqual(await presence, { agent: "a", online: true });
  const seen: string[] = [];
  obs.on("message", (m: ChatMessage) => seen.push(m.text));
  const got = nextMessage(obs);
  await a.send({ to: "b", text: "private" });
  await a.send({ room: "lab", text: "in the room" });
  await a.send({ to: "boss", text: "to the admin" });
  assert.equal((await got).text, "in the room");
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(seen, ["in the room", "to the admin"]);
  await assert.rejects(obs.send({ to: "a", text: "x" }), /read-only/);
  obs.close(); a.close();
  await broker.close();
});

test("admin may post only as human agents; message reaches recipients and observers", async () => {
  const { broker, url, http } = await startBroker(
    [{ name: "me", kind: "human", rooms: ["lobby"] }, { name: "bot", rooms: ["lobby"] }, BOSS],
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

test("config: first admin via add-agent --admin, setAdmin grants, revokes and issues tokens", () => {
  assert.doesNotThrow(() => validate({ adminToken: "short", agents: [] })); // legacy field is ignored
  const dir = mkdtempSync(join(tmpdir(), "aichat-cfg-"));
  const path = join(dir, "agents.json");
  writeFileSync(path, JSON.stringify({ agents: [] }));
  const first = addAgent(path, { name: "alexey", kind: "human", admin: true });
  assert.equal(first.admin, true);
  assert.throws(() => addAgent(path, { name: "bot", kind: "claude", admin: true }), /human/);
  addAgent(path, { name: "bot", kind: "claude" });
  addAgent(path, { name: "olena", kind: "human" });
  assert.equal(setAdmin(path, "olena").admin, true);
  const again = setAdmin(path, "olena", { newToken: true });
  assert.notEqual(again.token, JSON.parse(readFileSync(path, "utf8")).agents[0].token);
  assert.equal(JSON.parse(readFileSync(path, "utf8")).agents.find((a: { name: string }) => a.name === "olena").token, again.token);
  assert.equal(setAdmin(path, "olena", { admin: false }).admin, undefined);
  assert.throws(() => setAdmin(path, "bot"), /human/);
  assert.throws(() => setAdmin(path, "ghost"), /add-agent/);
  rmSync(dir, { recursive: true, force: true });
});

test("admin settings: read, change maxHops at runtime, reject bad values", async () => {
  const { broker, url, http } = await startBroker([{ name: "a" }, { name: "b" }, BOSS], { maxHops: 1 });
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
  assert.deepEqual(((await r.json()) as { settings: unknown }).settings, { maxHops: 3, ratePerMinute: 30, maxTextLength: 20000, maxFileSizeMB: 20, maxNotes: 200, maxNoteDescription: 1000, maxNoteText: 5000, wakeMode: "off", wakeAfterMinutes: 10, wakeAfterMessages: 10, publicUrl: "", projectDir: "" });
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
  assert.equal(file.edit((raw) => (raw.maxHops = 20)).maxHops, 20);
  assert.throws(() => file.edit((raw) => (raw.maxHops = 0)), /maxHops/);
  assert.equal(JSON.parse(readFileSync(path, "utf8")).maxHops, 20);
  assert.equal(file.get().maxHops, 20);
  const saved = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(saved.maxHops, 20);
  assert.equal(saved.port, 9000);
  assert.deepEqual(saved.agents, agents);
  rmSync(dir, { recursive: true, force: true });
});

test("personal web login: overview and history show only the agent's own conversations", async () => {
  const { broker, url, http } = await startBroker(
    [{ name: "olena", kind: "human", rooms: ["lobby"] }, { name: "bot", rooms: ["lobby", "lab"] }, { name: "c" }, BOSS],
  );
  const bot = await connect(url, "bot");
  const c = await connect(url, "c");
  const ids: number[] = [];
  for (let i = 0; i < 3; i++) ids.push(await bot.send({ room: "lobby", text: `lobby ${i}` }));
  await bot.send({ room: "lab", text: "lab only" });
  await bot.send({ to: "olena", text: "hi olena" });
  await bot.send({ to: "c", text: "not for olena" });
  const h = { authorization: "Bearer token-for-olena-xxxxxxxxxxxx" };

  let r = await fetch(`${http}/api/overview`, { headers: h });
  assert.equal(r.status, 200);
  const o = (await r.json()) as {
    me: { name: string; kind: string };
    rooms: { name: string }[];
    dms: { a: string; b: string }[];
    all_rooms: string[];
    agents: unknown[];
    max_hops: number;
  };
  assert.equal(o.max_hops, 8);
  assert.deepEqual(o.me, { name: "olena", kind: "human" });
  assert.deepEqual(o.rooms.map((x) => x.name), ["lobby"]);
  assert.deepEqual(o.dms.map((d) => [d.a, d.b]), [["bot", "olena"]]);
  assert.deepEqual(o.all_rooms, ["lab", "lobby"]);
  assert.equal(o.agents.length, 4);

  r = await fetch(`${http}/api/history?room=lobby&before=${ids[2]}&limit=1`, { headers: h });
  assert.deepEqual(((await r.json()) as { messages: ChatMessage[] }).messages.map((m) => m.id), [ids[1]]);
  r = await fetch(`${http}/api/history?room=lab`, { headers: h });
  assert.equal(r.status, 403);
  r = await fetch(`${http}/api/history?with=c`, { headers: h });
  assert.equal(((await r.json()) as { messages: unknown[] }).messages.length, 0);
  r = await fetch(`${http}/api/history?room=lobby&before=abc`, { headers: h });
  assert.equal(r.status, 400);
  // a personal token is not an admin token
  r = await fetch(`${http}/admin/api/overview`, { headers: h });
  assert.equal(r.status, 401);
  bot.close(); c.close();
  await broker.close();
});

test("admin manages people: add, new token, remove", async () => {
  const { broker, url, http, cfg } = await startBroker([{ name: "bot", kind: "claude", rooms: ["lobby"] }, BOSS]);
  const post = (path: string, body?: unknown) =>
    fetch(`${http}${path}`, { method: "POST", headers: auth(), ...(body ? { body: JSON.stringify(body) } : {}) });

  let r = await post("/admin/api/agents", { name: "olena", description: "Тестувальниця", rooms: ["lobby", "qa"] });
  assert.equal(r.status, 201);
  const added = (await r.json()) as { agent: { name: string; kind: string; rooms: string[]; token?: string }; token: string };
  assert.equal(added.agent.kind, "human");
  assert.deepEqual(added.agent.rooms, ["lobby", "qa"]);
  assert.equal(added.agent.token, undefined);
  assert.ok(added.token.length >= 16);
  assert.equal(cfg().agents.find((a) => a.name === "olena")?.token, added.token);

  for (const [body, status] of [
    [{ name: "olena" }, 400],
    [{ name: "bad name!" }, 400],
    [{ name: "x", kind: "bad kind" }, 400],
    [{ name: "w", webhook: "ftp://x" }, 400],
    [{ name: "y", rooms: ["no spaces"] }, 400],
    [{ name: "z", rooms: "lobby" }, 400],
  ] as const)
    assert.equal((await post("/admin/api/agents", body)).status, status, JSON.stringify(body));

  r = await fetch(`${http}/admin/api/agents`, { headers: auth() });
  const list = (await r.json()) as { agents: { name: string; webhook: boolean; token?: string }[] };
  assert.deepEqual(list.agents.map((a) => a.name), ["bot", "boss", "olena"]);
  assert.ok(list.agents.every((a) => a.token === undefined && a.webhook === false));

  // the new person can log in and receives room messages
  const olena = new BrokerClient({ url, token: added.token, reconnect: false, log: () => {} });
  await olena.connect();
  const bot = await connect(url, "bot");
  const got = nextMessage(olena);
  await bot.send({ room: "lobby", text: "welcome" });
  assert.equal((await got).text, "welcome");

  // a new token drops the old connection and the old token stops working
  const closed = new Promise((res) => olena.once("disconnected", res));
  r = await post("/admin/api/agents/olena/token");
  assert.equal(r.status, 200);
  const { token: fresh } = (await r.json()) as { token: string };
  assert.notEqual(fresh, added.token);
  await closed;
  assert.equal((await fetch(`${http}/api/me`, { headers: { authorization: `Bearer ${added.token}` } })).status, 401);
  assert.equal((await fetch(`${http}/api/me`, { headers: { authorization: `Bearer ${fresh}` } })).status, 200);

  assert.equal((await fetch(`${http}/admin/api/agents/nobody`, { method: "DELETE", headers: auth() })).status, 404);

  r = await fetch(`${http}/admin/api/agents/olena`, { method: "DELETE", headers: auth() });
  assert.equal(r.status, 200);
  assert.equal(cfg().agents.some((a) => a.name === "olena"), false);
  assert.equal((await fetch(`${http}/api/me`, { headers: { authorization: `Bearer ${fresh}` } })).status, 401);
  // history stays, membership goes
  r = await fetch(`${http}/admin/api/overview`, { headers: auth() });
  const o = (await r.json()) as { rooms: { name: string; members: string[]; count: number }[] };
  assert.deepEqual(o.rooms.find((x) => x.name === "lobby")?.members, ["bot"]);
  assert.equal(o.rooms.find((x) => x.name === "lobby")?.count, 1);
  bot.close();
  await broker.close();
});

test("admin adds AI agents with ready-made setup steps; tokens and removal work for any kind", async () => {
  const { broker, http, cfg } = await startBroker([{ name: "me", kind: "human" }, BOSS]);
  const post = (path: string, body?: unknown) =>
    fetch(`${http}${path}`, { method: "POST", headers: auth(), ...(body ? { body: JSON.stringify(body) } : {}) });
  type SetupRes = { token: string; setup: { kind: string; steps: { title: string; code?: string; lang?: string }[] } };

  let r = await post("/admin/api/agents", { name: "claude-c", kind: "claude", rooms: ["lobby"] });
  assert.equal(r.status, 201);
  const c = (await r.json()) as SetupRes;
  const mcp = JSON.parse(c.setup.steps.find((s) => s.lang === "json")!.code!);
  assert.equal(mcp.mcpServers.aichat.env.AICHAT_TOKEN, c.token);
  assert.match(mcp.mcpServers.aichat.env.AICHAT_URL, /^ws:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(mcp.mcpServers.aichat.args[0], "<AICHAT_DIR>/claude-channel.mjs");
  const dl = c.setup.steps.find((s) => (s as { download?: unknown }).download) as unknown as { download: { url: string; filename: string } };
  assert.equal(dl.download.filename, "claude-channel.mjs");
  assert.match(dl.download.url, /^http:\/\/127\.0\.0\.1:\d+\/client\/claude-channel\.mjs$/);
  assert.ok(c.setup.steps.some((s) => s.code?.includes("--dangerously-load-development-channels server:aichat")));
  // the first step does it all in one command: download the adapter, then let it write .mcp.json
  type Step = { title: string; code?: string; lang?: string; manual?: boolean };
  const [quick, quickPs] = c.setup.steps as Step[];
  assert.ok(!quick.manual && quick.lang === "bash");
  assert.match(quick.code!, /curl -fsSL http:\/\/127\.0\.0\.1:\d+\/client\/claude-channel\.mjs -o "\$HOME\/\.aichat\/claude-channel\.mjs"/);
  assert.ok(quick.code!.includes(`install --url 'ws://127.0.0.1:`) && quick.code!.includes(`--token '${c.token}'`));
  assert.ok(quickPs.lang === "powershell" && quickPs.code!.includes('-OutFile "$HOME\\.aichat\\claude-channel.mjs"'));
  // the step-by-step way is still there, marked as manual
  assert.ok((c.setup.steps as Step[]).filter((s) => s.lang === "json" || (s as { download?: unknown }).download).every((s) => s.manual));

  // publicUrl and projectDir from settings go into the instructions
  r = await fetch(`${http}/admin/api/settings`, {
    method: "PATCH", headers: auth(), body: JSON.stringify({ publicUrl: "http://aichat.lan:8787/", projectDir: "D:\\AIChat" }),
  });
  assert.equal(r.status, 200);
  assert.deepEqual(
    (((await r.json()) as { settings: Record<string, unknown> }).settings),
    { maxHops: 8, ratePerMinute: 30, maxTextLength: 20000, maxFileSizeMB: 20, maxNotes: 200, maxNoteDescription: 1000, maxNoteText: 5000, wakeMode: "off", wakeAfterMinutes: 10, wakeAfterMessages: 10, publicUrl: "http://aichat.lan:8787", projectDir: "D:\\AIChat" },
  );
  for (const bad of [{ publicUrl: "aichat.lan" }, { publicUrl: "ftp://x" }, { projectDir: 5 }])
    assert.equal((await fetch(`${http}/admin/api/settings`, { method: "PATCH", headers: auth(), body: JSON.stringify(bad) })).status, 400);

  r = await post("/admin/api/agents", { name: "gpt", kind: "openai" });
  const o = (await r.json()) as SetupRes;
  const bash = o.setup.steps.find((s) => s.lang === "bash")!.code!;
  assert.match(bash, /node 'D:\/AIChat\/openai-agent\.mjs'/);
  assert.match(bash, /AICHAT_URL='ws:\/\/aichat\.lan:8787'/);
  assert.ok(bash.includes(o.token));
  assert.ok(o.setup.steps.some((s) => s.lang === "powershell" && s.code!.includes("node 'D:/AIChat/openai-agent.mjs'")));

  // OpenCode: the plugin goes into .opencode/plugins/ of the agent's folder, the token into a file outside it
  r = await post("/admin/api/agents", { name: "oc", kind: "opencode" });
  assert.equal(r.status, 201);
  const oc = (await r.json()) as SetupRes;
  assert.equal(oc.setup.kind, "opencode");
  const ocBash = oc.setup.steps.find((s) => s.lang === "bash")!.code!;
  assert.ok(ocBash.includes("curl -fsSL http://aichat.lan:8787/client/opencode-channel.js -o .opencode/plugins/aichat-channel/index.js"));
  assert.ok(oc.setup.steps.some((s) => s.lang === "powershell" && s.code!.includes("-OutFile .opencode/plugins/aichat-channel/index.js")));
  const ocConfig = JSON.parse(oc.setup.steps.find((s) => s.lang === "json")!.code!);
  assert.deepEqual(ocConfig, { url: "ws://aichat.lan:8787/ws", tokenFile: "~/.secrets/aichat-oc-token", wake: "always" });
  const tokenStep = oc.setup.steps.find((s) => s.code?.includes(oc.token))!;
  assert.ok(tokenStep.code!.includes("> ~/.secrets/aichat-oc-token") && tokenStep.code!.includes('"$HOME\\.secrets\\aichat-oc-token"'));
  assert.equal(oc.setup.steps.filter((s) => s.code?.includes(oc.token)).length, 1); // the token is only in the token file

  r = await post("/admin/api/agents", { name: "hook", kind: "service", webhook: "http://127.0.0.1:9/hook" });
  assert.equal(r.status, 201);
  const h = (await r.json()) as SetupRes & { agent: { webhook: boolean } };
  assert.equal(h.agent.webhook, true);
  assert.equal(cfg().agents.find((a) => a.name === "hook")?.webhook, "http://127.0.0.1:9/hook");

  // instructions again, without revealing the token
  r = await fetch(`${http}/admin/api/agents/claude-c/setup`, { headers: auth() });
  const again = JSON.stringify(await r.json());
  assert.ok(again.includes("<TOKEN>"));
  assert.ok(!again.includes(c.token));
  assert.ok(again.includes("D:/AIChat/claude-channel.mjs"));

  r = await post("/admin/api/agents/claude-c/token");
  const t = (await r.json()) as SetupRes;
  assert.notEqual(t.token, c.token);
  assert.ok(JSON.stringify(t.setup).includes(t.token));
  assert.equal((await fetch(`${http}/admin/api/agents/claude-c`, { method: "DELETE", headers: auth() })).status, 200);
  assert.equal(cfg().agents.some((a) => a.name === "claude-c"), false);
  // posting as an AI agent from the web is still not allowed
  r = await post("/admin/api/messages", { as: "gpt", room: "lobby", text: "x" });
  assert.equal(r.status, 403);
  await broker.close();
});

test("admin manages rooms: create, members, delete; changes persist and reach live agents", async () => {
  const { broker, url, http, cfg } = await startBroker(
    [{ name: "a", rooms: ["lobby"] }, { name: "b" }, { name: "me", kind: "human" }, BOSS],
  );
  const call = (method: string, path: string, body?: unknown) =>
    fetch(`${http}${path}`, { method, headers: auth(), ...(body ? { body: JSON.stringify(body) } : {}) });
  const obs = feed(url);
  await obs.connect();
  const frames: { type: string; rooms?: string[] }[] = [];
  const b = await connect(url, "b");
  // BrokerClient ignores unknown frames, so listen on the raw socket
  (b as unknown as { ws: { on: (e: string, f: (d: unknown) => void) => void } }).ws.on("message", (d) => frames.push(JSON.parse(String(d))));
  const obsFrames: string[] = [];
  (obs as unknown as { ws: { on: (e: string, f: (d: unknown) => void) => void } }).ws.on("message", (d) => obsFrames.push(JSON.parse(String(d)).type));

  let r = await call("POST", "/admin/api/rooms", { name: "design", members: ["a", "b"] });
  assert.equal(r.status, 201);
  assert.deepEqual(((await r.json()) as { room: { members: string[] } }).room.members, ["a", "b"]);
  assert.deepEqual(cfg().agents.find((x) => x.name === "b")?.rooms, ["design"]);
  assert.equal((await call("POST", "/admin/api/rooms", { name: "design" })).status, 400);
  assert.equal((await call("POST", "/admin/api/rooms", { name: "bad name" })).status, 400);
  assert.equal((await call("POST", "/admin/api/rooms", { name: "x", members: ["ghost"] })).status, 404);

  r = await call("POST", "/admin/api/rooms", { name: "empty" });
  assert.equal(r.status, 201);
  r = await call("GET", "/admin/api/rooms");
  const names = ((await r.json()) as { rooms: { name: string }[] }).rooms.map((x) => x.name);
  assert.deepEqual(names, ["design", "empty", "lobby"]);

  r = await call("POST", "/admin/api/rooms/empty/members", { name: "me" });
  assert.deepEqual(((await r.json()) as { room: { members: string[] } }).room.members, ["me"]);
  r = await call("DELETE", "/admin/api/rooms/design/members/b");
  assert.deepEqual(((await r.json()) as { room: { members: string[] } }).room.members, ["a"]);
  assert.equal(cfg().agents.find((x) => x.name === "b")?.rooms, undefined);
  assert.equal((await call("DELETE", "/admin/api/rooms/nope/members/b")).status, 404);
  assert.equal((await call("POST", "/admin/api/rooms/empty/members", { name: "ghost" })).status, 404);
  await new Promise((res) => setTimeout(res, 50));
  assert.deepEqual(frames.filter((f) => f.type === "rooms").map((f) => f.rooms), [["design"], []]);
  assert.ok(obsFrames.includes("rooms_changed"));

  // removed member does not come back on reconnect
  b.close();
  const b2 = await connect(url, "b");
  assert.deepEqual((await (await fetch(`${http}/api/me`, { headers: { authorization: `Bearer ${tok("b")}` } })).json() as { rooms: string[] }).rooms, []);

  // delete keeps messages unless ?messages=1
  const a = await connect(url, "a");
  await a.send({ room: "design", text: "keep me" });
  assert.equal((await call("DELETE", "/admin/api/rooms/design")).status, 200);
  assert.equal(cfg().agents.find((x) => x.name === "a")?.rooms?.includes("design"), false);
  r = await call("GET", "/admin/api/rooms");
  const design = ((await r.json()) as { rooms: { name: string; members: string[]; count: number }[] }).rooms.find((x) => x.name === "design");
  assert.deepEqual(design && { members: design.members, count: design.count }, { members: [], count: 1 });
  assert.equal((await call("DELETE", "/admin/api/rooms/design?messages=1")).status, 200);
  r = await call("GET", "/admin/api/rooms");
  assert.equal(((await r.json()) as { rooms: { name: string }[] }).rooms.some((x) => x.name === "design"), false);
  assert.equal((await call("DELETE", "/admin/api/rooms/design")).status, 404);
  a.close(); b2.close(); obs.close();
  await broker.close();
});

test("an agent that leaves a configured room stays out after reconnecting", async () => {
  const { broker, url, http, cfg } = await startBroker([{ name: "a", rooms: ["lobby", "lab"] }]);
  const a = await connect(url, "a");
  await a.request({ type: "leave", room: "lab" });
  a.close();
  const a2 = await connect(url, "a");
  const me = (await (await fetch(`${http}/api/me`, { headers: { authorization: `Bearer ${tok("a")}` } })).json()) as { rooms: string[] };
  assert.deepEqual(me.rooms, ["lobby"]);
  assert.deepEqual(cfg().agents[0].rooms, ["lobby"]);
  a2.close();
  await broker.close();
});

test("bundled adapters are served without a token; nothing else under /client", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aichat-bundle-"));
  writeFileSync(join(dir, "claude-channel.mjs"), "// bundle");
  writeFileSync(join(dir, "secret.txt"), "no");
  const { broker, http } = await startBroker([{ name: "a" }], {}, { bundleDir: dir });
  let r = await fetch(`${http}/client/claude-channel.mjs`);
  assert.equal(r.status, 200);
  assert.equal(await r.text(), "// bundle");
  assert.match(r.headers.get("content-disposition")!, /attachment; filename="claude-channel.mjs"/);
  writeFileSync(join(dir, "opencode-channel.js"), "// plugin");
  r = await fetch(`${http}/client/opencode-channel.js`);
  assert.equal(r.status, 200);
  assert.equal(await r.text(), "// plugin");
  assert.match(r.headers.get("content-disposition")!, /attachment; filename="opencode-channel.js"/);
  assert.equal((await fetch(`${http}/client/openai-agent.mjs`)).status, 404); // listed but missing
  assert.equal((await fetch(`${http}/client/secret.txt`)).status, 404);
  assert.equal((await fetch(`${http}/client/..%2fsecret.txt`)).status, 404);
  await broker.close();
  rmSync(dir, { recursive: true, force: true });
});

test("a human can be made an admin: own token opens the admin API and the observer feed", async () => {
  const { broker, url, http, cfg } = await startBroker(
    [{ name: "olena", kind: "human" }, { name: "bot", kind: "claude" }, { name: "c" }, BOSS],
  );
  const olenaTok = tok("olena");
  const as = (t: string) => ({ authorization: `Bearer ${t}`, "content-type": "application/json" });
  const patch = (name: string, body: unknown, t = ADMIN) =>
    fetch(`${http}/admin/api/agents/${name}`, { method: "PATCH", headers: as(t), body: JSON.stringify(body) });

  assert.equal((await fetch(`${http}/admin/api/overview`, { headers: as(olenaTok) })).status, 401);

  let r = await patch("olena", { admin: true });
  assert.equal(r.status, 200);
  assert.equal(((await r.json()) as { agent: { admin: boolean } }).agent.admin, true);
  assert.equal(cfg().agents.find((a) => a.name === "olena")?.admin, true);
  assert.equal((await patch("bot", { admin: true })).status, 403);
  assert.equal((await patch("olena", { admin: "yes" })).status, 400);
  assert.equal((await patch("olena", { kind: "x" })).status, 400);

  r = await fetch(`${http}/admin/api/overview`, { headers: as(olenaTok) });
  assert.equal(r.status, 200);
  const o = (await r.json()) as { me: unknown; agents: { name: string; admin: boolean }[] };
  assert.deepEqual(o.me, { name: "olena" });
  assert.equal(o.agents.find((a) => a.name === "olena")?.admin, true);

  // raw WebSocket: auth with observer:true gives the admin feed
  const { WebSocket } = await import("ws");
  const openFeed = (token: string) =>
    new Promise<{ ws: InstanceType<typeof WebSocket>; first: { type: string; agent?: string; observer?: boolean; error?: string } }>((res) => {
      const ws = new WebSocket(`${url}/ws`);
      ws.on("open", () => ws.send(JSON.stringify({ type: "auth", token, observer: true })));
      ws.once("message", (d) => res({ ws, first: JSON.parse(String(d)) }));
    });
  const feed = await openFeed(olenaTok);
  assert.deepEqual([feed.first.type, feed.first.agent, feed.first.observer], ["welcome", "olena", true]);
  const seen = new Promise<{ message: { text: string } }>((res) =>
    feed.ws.on("message", (d) => {
      const f = JSON.parse(String(d));
      if (f.type === "message") res(f);
    }),
  );
  const bot = await connect(url, "bot");
  await bot.send({ to: "c", text: "private bot->c" }); // not hers to see
  await bot.send({ to: "olena", text: "private bot->olena" });
  assert.equal((await seen).message.text, "private bot->olena");

  // the admin human can manage others with her own token
  assert.equal((await patch("c", { admin: false }, olenaTok)).status, 200);

  // removing her rights closes the feed and locks the admin API again
  const closed = new Promise<number>((res) => feed.ws.on("close", (code) => res(code)));
  assert.equal((await patch("olena", { admin: false }, olenaTok)).status, 200);
  assert.equal(await closed, 4003);
  assert.equal((await fetch(`${http}/admin/api/overview`, { headers: as(olenaTok) })).status, 401);
  const denied = await openFeed(olenaTok);
  assert.equal(denied.first.type, "error");
  // without observer:true she is still a normal member
  const member = await connect(url, "olena");
  assert.equal(member.agent, "olena");
  member.close(); bot.close();

  // the last admin can neither lose the rights nor be removed
  r = await patch("boss", { admin: false });
  assert.equal(r.status, 409);
  assert.match(((await r.json()) as { error: string }).error, /only admin/);
  assert.equal((await fetch(`${http}/admin/api/agents/boss`, { method: "DELETE", headers: as(ADMIN) })).status, 409);
  assert.equal(cfg().agents.find((a) => a.name === "boss")?.admin, true);
  await broker.close();
});

test("a human admin's observer feed counts as that human being online", async () => {
  const { broker, url, http } = await startBroker([{ name: "olena", kind: "human", admin: true }, { name: "bot" }, BOSS]);
  const onlineOf = async (name: string) => {
    const r = await fetch(`${http}/admin/api/agents`, { headers: auth() });
    const { agents } = (await r.json()) as { agents: { name: string; online: boolean }[] };
    return agents.find((a) => a.name === name)?.online;
  };
  const bot = await connect(url, "bot");
  const presences: { agent: string; online: boolean }[] = [];
  bot.on("presence", (p) => presences.push(p));
  const waitPresence = (online: boolean) =>
    new Promise<void>((res) => {
      const check = () => presences.some((p) => p.agent === "olena" && p.online === online) && res();
      check();
      bot.on("presence", check);
    });

  const { WebSocket } = await import("ws");
  const feed = new WebSocket(`${url}/ws`);
  feed.on("open", () => feed.send(JSON.stringify({ type: "auth", token: tok("olena"), observer: true })));
  await waitPresence(true);
  assert.equal(await onlineOf("olena"), true);

  feed.close();
  await waitPresence(false);
  assert.equal(await onlineOf("olena"), false);
  bot.close();
  await broker.close();
});

test("connections close when agents.json changes behind the broker: new token, removed agent, lost admin rights", async () => {
  const { broker, url, replaceConfig } = await startBroker([{ name: "a" }, { name: "b" }, { name: "keep" }, { name: "olena", kind: "human", admin: true }, BOSS]);
  const closedWith = (c: BrokerClient) =>
    new Promise<string>((res) =>
      (c as unknown as { ws: { on: (e: string, f: (code: number, r: Buffer) => void) => void } }).ws.on("close", (code, r) => res(`${code} ${r}`)),
    );
  const a = await connect(url, "a");
  const b = await connect(url, "b");
  const keep = await connect(url, "keep");
  const obs = feed(url, tok("olena"));
  await obs.connect();
  const [aClosed, bClosed, obsClosed] = [closedWith(a), closedWith(b), closedWith(obs)];
  let keepClosed = false;
  closedWith(keep).then(() => (keepClosed = true));

  replaceConfig((raw) => {
    raw.agents.find((x) => x.name === "a")!.token = "a-brand-new-token-xxxxxxxx";
    raw.agents = raw.agents.filter((x) => x.name !== "b");
    delete raw.agents.find((x) => x.name === "olena")!.admin;
  });
  broker.checkConnections(); // the broker also notices on its own within seconds, or on the next request
  assert.equal(await aClosed, "4003 token changed");
  assert.equal(await bClosed, "4003 agent removed");
  assert.equal(await obsClosed, "4003 admin rights removed");
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(keepClosed, false);
  // the new token works
  const a2 = new BrokerClient({ url, token: "a-brand-new-token-xxxxxxxx", reconnect: false, log: () => {} });
  await a2.connect();
  assert.equal(a2.agent, "a");
  a2.close(); keep.close();
  await broker.close();
});

test("the broker notices a config change on the next request without being told", async () => {
  const { broker, url, http, replaceConfig } = await startBroker([{ name: "a" }, { name: "b" }]);
  const a = await connect(url, "a");
  const closed = new Promise<number>((res) => (a as unknown as { ws: { on: (e: string, f: (c: number) => void) => void } }).ws.on("close", res));
  replaceConfig((raw) => void (raw.agents[0].token = "rotated-token-xxxxxxxxxxxx"));
  await fetch(`${http}/api/agents`, { headers: { authorization: `Bearer ${tok("b")}` } });
  assert.equal(await closed, 4003);
  await broker.close();
});
