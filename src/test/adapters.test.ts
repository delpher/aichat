import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { WebSocket, WebSocketServer } from "ws";
import { BrokerClient } from "../client/broker-client.js";
import { startBroker, connect, nextMessage, tok } from "./helpers.js";
import { startOpenAIAgent } from "../adapters/openai-agent.js";
import { LEGACY_INSTRUCTIONS, PEER_RULE } from "../adapters/instructions.js";
import { ADAPTER_VERSION, compareVersions } from "../adapters/version.js";
import { VERSION } from "../version.js";

/** Starts the Claude channel adapter the way Claude Code does, as an MCP client over stdio. */
async function startChannel(url: string, name: string, env: Record<string, string> = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../adapters/claude-channel.js", import.meta.url))],
    env: { ...process.env, AICHAT_URL: url, AICHAT_TOKEN: tok(name), ...env } as Record<string, string>,
    stderr: "pipe",
  });
  const client = new Client({ name: "fake-claude-code", version: "0.0.0" });
  const notes: { method: string; params?: { content: string; meta: Record<string, string> } }[] = [];
  client.fallbackNotificationHandler = async (n) => void notes.push(n as never);
  await client.connect(transport);
  const call = async (tool: string, args: Record<string, unknown> = {}) =>
    ((await client.callTool({ name: tool, arguments: args })).content as { text: string }[])[0].text;
  return { client, call, notes };
}

test("Claude channel adapter pushes channel notifications and sends via tool", async () => {
  const { broker, url } = await startBroker([{ name: "claude1", kind: "claude" }, { name: "peer" }]);
  const peer = await connect(url, "peer");
  // a message sent while Claude is offline must still arrive
  const firstId = await peer.send({ to: "claude1", text: "are you there?" });

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../adapters/claude-channel.js", import.meta.url))],
    env: { ...process.env, AICHAT_URL: url, AICHAT_TOKEN: tok("claude1") } as Record<string, string>,
    stderr: "pipe",
  });
  const client = new Client({ name: "fake-claude-code", version: "0.0.0" });
  const notes: { method: string; params?: { content: string; meta: Record<string, string> } }[] = [];
  client.fallbackNotificationHandler = async (n) => void notes.push(n as never);
  await client.connect(transport);

  const caps = client.getServerCapabilities();
  assert.deepEqual(caps?.experimental?.["claude/channel"], {});
  // instructions: mechanics from the adapter, the world from the broker, the rule about peers last
  const instructions = client.getInstructions() ?? "";
  assert.match(instructions, /reply_to/);
  assert.match(instructions, /--- AIChat intro \(from the broker\) ---\n# AIChat\n/);
  assert.match(instructions, /Limits now: a reply chain stops after 8 replies; up to 30 messages per minute/);
  assert.ok(instructions.endsWith(PEER_RULE));
  assert.doesNotMatch(instructions, /chat network where AI agents talk to each other/);

  const deadline = Date.now() + 5000;
  while (!notes.length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  assert.equal(notes[0]?.method, "notifications/claude/channel");
  assert.equal(notes[0].params!.content, "are you there?");
  assert.deepEqual(notes[0].params!.meta, { from: "peer", msg_id: String(firstId), hops: "0" });
  // once the session has the message, the adapter confirms it, and the sender's history shows it delivered
  let delivered: string[] | undefined;
  for (const until = Date.now() + 3000; !delivered && Date.now() < until; await new Promise((r) => setTimeout(r, 50)))
    delivered = (await peer.history({ with: "claude1" })).find((m) => m.id === firstId)?.delivered_to;
  assert.deepEqual(delivered, ["claude1"]);

  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((t) => t.name).sort(), [
    "create_game",
    "forget",
    "get_attachment",
    "join_game",
    "join_room",
    "leave_room",
    "list_agents",
    "list_games",
    "read_history",
    "recall",
    "remember",
    "room_info",
    "send_message",
    "set_room_brief",
    "set_status",
    "thank",
    "world_info",
  ]);

  // briefs: joining a room shows its brief
  const call = async (name: string, args: Record<string, unknown>) =>
    ((await client.callTool({ name, arguments: args })).content as { text: string }[])[0].text;
  assert.match(await call("join_room", { room: "lab" }), /joined #lab[\s\S]*No brief\./);
  assert.equal(await call("set_room_brief", { room: "lab", text: "Ship the validator." }), "brief of #lab updated");
  const info = await call("room_info", { room: "lab" });
  assert.match(info, /Brief \(by claude1\):\nShip the validator\./);
  // the agent says what it works on; the place defaults to its latest conversation
  assert.equal(await call("set_status", { topic: "validator", room: "lab" }), "status: validator in #lab");
  assert.equal(await call("set_status", { topic: "" }), "status cleared");
  const games = await client.callTool({ name: "list_games", arguments: {} });
  assert.equal((games.content as { text: string }[])[0].text, "Games you can play: checkers (Шашки): seats w=білі, b=чорні; nardy (Нарди): seats w=білі, b=чорні; reversi (Реверсі): seats b=чорні, w=білі; balda (Балда): seats p1=гравець 1, p2=гравець 2, p3=гравець 3, p4=гравець 4 (2-4 players)\nno games yet");
  // the agent sits where it asks; the seat names come from the game type
  const created = await client.callTool({ name: "create_game", arguments: { game: "checkers", seat: "b" } });
  assert.match((created.content as { text: string }[])[0].text, /^created #\d+ checkers \[open\] білі: \(free\), чорні: claude1, moves: 0 - room game-\d+$/);
  const badSeat = await client.callTool({ name: "create_game", arguments: { seat: "x" } });
  assert.match((badSeat.content as { text: string }[])[0].text, /unknown seat x; seats: w, b/);
  // once a game is decided, list_games shows each player's rating in that kind of game
  const gid = Number((created.content as { text: string }[])[0].text.match(/#(\d+)/)![1]);
  await peer.api("POST", `/api/games/${gid}/join`, {});
  await call("send_message", { room: `game-${gid}`, text: "resign" });
  for (let i = 0; i < 40 && !/rating/.test(await call("list_games", {})); i++) await new Promise((r) => setTimeout(r, 50));
  assert.match(await call("list_games", { status: "finished" }), /білі: peer \(rating 1016\), чорні: claude1 \(rating 984\)/);
  const joinBad = await client.callTool({ name: "join_game", arguments: { game_id: 99 } });
  assert.equal(joinBad.isError, true);
  assert.match((joinBad.content as { text: string }[])[0].text, /unknown game/);

  // an image from the peer: announced in the channel text, fetched with get_attachment
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
    "base64",
  );
  const pic = await peer.upload(png, "dot.png", "image/png");
  notes.length = 0;
  await peer.send({ to: "claude1", text: "look", attachments: [pic.id] });
  const until = Date.now() + 5000;
  while (!notes.length && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
  assert.match(notes[0].params!.content, new RegExp(`^look\\n\\[attachment file_id=${pic.id} name="dot.png" type=image/png`));
  assert.equal((notes[0].params!.meta as Record<string, string>).attachments, "1");
  const filesDir = mkdtempSync(join(tmpdir(), "aichat-test-"));
  const att = await client.callTool({ name: "get_attachment", arguments: { file_id: pic.id } });
  const parts = att.content as { type: string; data?: string; mimeType?: string; text?: string }[];
  assert.equal(parts[0].type, "image");
  assert.equal(parts[0].mimeType, "image/png");
  assert.equal(Buffer.from(parts[0].data!, "base64").equals(png), true);
  const saved = parts[1].text!.match(/to (.+)$/)![1];
  assert.equal(readFileSync(saved).equals(png), true);

  // sending a local file
  const local = join(filesDir, "report.txt");
  writeFileSync(local, "numbers");
  const withFile = nextMessage(peer);
  const sent = await client.callTool({ name: "send_message", arguments: { to: "peer", text: "here", files: [local] } });
  assert.match((sent.content as { text: string }[])[0].text, /1 file/);
  const fm = await withFile;
  assert.equal(fm.attachments?.[0].name, "report.txt");
  assert.equal(fm.attachments?.[0].mime, "text/plain");
  assert.equal(Buffer.from(await peer.download(fm.attachments![0].id)).toString(), "numbers");
  rmSync(filesDir, { recursive: true, force: true });

  const got = nextMessage(peer);
  const res = await client.callTool({ name: "send_message", arguments: { to: "peer", text: "yes!", reply_to: firstId } });
  assert.match((res.content as { text: string }[])[0].text, /sent/);
  const m = await got;
  assert.equal(m.text, "yes!");
  assert.equal(m.hops, 1);

  // thanks: once per message, never for its own; the peer's count shows in list_agents, the names in history
  assert.match(await call("thank", { msg_id: firstId }), new RegExp(`^thanked for #${firstId} \\(thanked by: claude1\\)$`));
  assert.match(await call("thank", { msg_id: firstId }), /already thanked/);
  assert.match(await call("thank", { msg_id: m.id }), /cannot thank yourself/);
  assert.match(await call("read_history", { with: "peer" }), /are you there\? \[thanked by claude1\]/);

  const list = await client.callTool({ name: "list_agents", arguments: {} });
  assert.match((list.content as { text: string }[])[0].text, /claude1 \(you\) \[claude\] online/);
  assert.match((list.content as { text: string }[])[0].text, /peer \[test\] online, thanks: 1 rooms:/);

  const bad = await client.callTool({ name: "send_message", arguments: { to: "nobody", text: "x" } });
  assert.equal(bad.isError, true);

  await client.close();
  peer.close();
  await broker.close();
});

test("OpenAI-compatible agent answers through the model and can call tools", async () => {
  const calls: { messages: { role: string; content: string }[] }[] = [];
  const api = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw);
      calls.push(body);
      const last = body.messages[body.messages.length - 1];
      let message;
      if (last.role === "user" && last.content.includes("ask carol"))
        message = { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "send_message", arguments: JSON.stringify({ to: "carol", text: "question from gpt" }) } }] };
      else if (last.role === "tool") message = { role: "assistant", content: "I asked carol." };
      else if (last.content.includes("thanks")) message = { role: "assistant", content: "NO_REPLY" };
      else message = { role: "assistant", content: `echo: ${last.content}` };
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message }] }));
    });
  });
  await new Promise<void>((r) => api.listen(0, "127.0.0.1", () => r()));
  const apiPort = (api.address() as { port: number }).port;

  const { broker, url } = await startBroker([{ name: "gpt", kind: "openai" }, { name: "alice" }, { name: "carol" }]);
  const agent = startOpenAIAgent({ brokerUrl: url, token: tok("gpt"), baseUrl: `http://127.0.0.1:${apiPort}/v1`, model: "fake", log: () => {} });
  await agent.ready;
  const alice = await connect(url, "alice");
  const carol = await connect(url, "carol");

  let got = nextMessage(alice);
  const id = await alice.send({ to: "gpt", text: "hello" });
  let m = await got;
  assert.match(m.text, /^echo: \[alice \(direct\), msg \d+\] hello$/);
  assert.equal(m.reply_to, id);
  assert.match(calls[0].messages[0].content, /You are "gpt"/);

  const carolGot = nextMessage(carol);
  got = nextMessage(alice);
  await alice.send({ to: "gpt", text: "please ask carol" });
  assert.equal((await carolGot).text, "question from gpt");
  assert.equal((await got).text, "I asked carol.");

  let extra = false;
  alice.on("message", () => (extra = true));
  await alice.send({ to: "gpt", text: "thanks" });
  await new Promise((r) => setTimeout(r, 300));
  await agent.idle();
  assert.equal(extra, false);

  agent.stop();
  alice.close(); carol.close();
  await broker.close();
  api.close();
});

test("claude-channel install writes .mcp.json and keeps other servers", async () => {
  const adapter = fileURLToPath(new URL("../adapters/claude-channel.js", import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), "aichat-install-"));
  const run = (...args: string[]) => spawnSync(process.execPath, [adapter, "install", ...args], { cwd: dir, encoding: "utf8", env: { ...process.env, AICHAT_TOKEN: "" } });
  try {
    writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { other: { command: "x" } } }));
    let r = run("--url", "ws://broker.lan:8787", "--token", "tok-1");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /claude --dangerously-load-development-channels server:aichat/);
    const cfg = JSON.parse(readFileSync(join(dir, ".mcp.json"), "utf8"));
    assert.deepEqual(cfg.mcpServers.other, { command: "x" });
    assert.deepEqual(cfg.mcpServers.aichat, {
      command: "node",
      args: [adapter.replace(/\\/g, "/")],
      env: { AICHAT_URL: "ws://broker.lan:8787", AICHAT_TOKEN: "tok-1" },
    });

    // missing flags and bad URLs fail without touching the file
    assert.equal(run("--url", "ws://x").status, 2);
    assert.equal(run("--url", "http://x", "--token", "t").status, 2);
    // a broken .mcp.json is left alone
    writeFileSync(join(dir, ".mcp.json"), "{ not json");
    r = run("--url", "ws://x:1", "--token", "t");
    assert.equal(r.status, 1);
    assert.match(r.stderr, /not valid JSON/);
    assert.equal(readFileSync(join(dir, ".mcp.json"), "utf8"), "{ not json");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("install registers the status hook and keeps other hooks", async () => {
  const { installHooks } = await import("../adapters/install.js");
  const dir = mkdtempSync(join(tmpdir(), "aichat-hooks-"));
  try {
    const path = join(dir, ".claude", "settings.local.json");
    // a project hook that must stay, and an old aichat hook that must be replaced, not doubled
    mkdirSync(join(dir, ".claude"));
    writeFileSync(
      path,
      JSON.stringify({
        permissions: { allow: ["Bash(ls)"] },
        hooks: { Stop: [{ hooks: [{ type: "command", command: "echo done" }] }, { hooks: [{ type: "command", command: 'node "/old/aichat-hook.mjs"' }] }] },
      }),
    );
    await installHooks({ dir, hook: "C:\\aichat\\aichat-hook.mjs" });
    const s = JSON.parse(readFileSync(path, "utf8"));
    assert.deepEqual(s.permissions, { allow: ["Bash(ls)"] });
    assert.deepEqual(Object.keys(s.hooks).sort(), ["Notification", "PreToolUse", "Stop", "UserPromptSubmit"]);
    const stop = s.hooks.Stop.map((g: { hooks: { command: string }[] }) => g.hooks[0].command);
    assert.deepEqual(stop, ["echo done", 'node "C:/aichat/aichat-hook.mjs"']);
    assert.equal(s.hooks.PreToolUse[0].matcher, "*");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- П3: compatibility with adapter 0.2.1 ----
// Adapters 0.2.1 already live on agents' machines and are updated rarely, so a new broker must keep serving them.
// This client speaks only what 0.2.1 sends, on a bare WebSocket (not BrokerClient, which will grow), and checks
// only the fields 0.2.1 reads. New frames and new optional fields are fine; removing or renaming these is not.

/** A client that knows the 0.2.1 protocol and nothing newer. */
async function v021Client(url: string, token: string) {
  const ws = new WebSocket(url + "/ws");
  const frames: Record<string, unknown>[] = [];
  const waiters: { want: (f: Record<string, unknown>) => boolean; resolve: (f: Record<string, unknown>) => void }[] = [];
  ws.on("message", (data) => {
    const f = JSON.parse(String(data)) as Record<string, unknown>;
    const i = waiters.findIndex((w) => w.want(f));
    if (i >= 0) waiters.splice(i, 1)[0].resolve(f);
    else frames.push(f);
  });
  await new Promise<void>((resolve, reject) => (ws.once("open", () => resolve()), ws.once("error", reject)));
  const next = (want: (f: Record<string, unknown>) => boolean, ms = 3000) => {
    const i = frames.findIndex(want);
    if (i >= 0) return Promise.resolve(frames.splice(i, 1)[0]);
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("no matching frame")), ms);
      waiters.push({ want, resolve: (f) => (clearTimeout(t), resolve(f)) });
    });
  };
  let seq = 0;
  /** Sends a 0.2.1 request frame and returns the reply with the same ref. */
  const request = (frame: Record<string, unknown>) => {
    const ref = `r${++seq}`;
    ws.send(JSON.stringify({ ...frame, ref }));
    return next((f) => f.ref === ref);
  };
  const http = url.replace(/^ws/, "http");
  /** The REST calls 0.2.1 makes, with its headers. */
  const api = async (method: string, path: string, body?: unknown, headers: Record<string, string> = { "content-type": "application/json" }) => {
    const r = await fetch(http + path, {
      method,
      headers: { authorization: `Bearer ${token}`, ...headers },
      ...(body !== undefined ? { body: typeof body === "string" || body instanceof Uint8Array ? (body as BodyInit) : JSON.stringify(body) } : {}),
    });
    return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, any> };
  };
  return { ws, request, next, api, frames };
}

/** The ChatMessage fields 0.2.1 reads (channel meta, read_history lines, delivered confirmation). */
function assertV021Message(m: any) {
  assert.equal(typeof m.id, "number");
  assert.equal(typeof m.from, "string");
  assert.equal(typeof m.text, "string");
  assert.equal(typeof m.ts, "string");
  assert.equal(typeof m.hops, "number");
  assert.ok(typeof m.to === "string" || typeof m.room === "string", "message has to or room");
  if (m.reply_to !== undefined) assert.equal(typeof m.reply_to, "number");
  for (const f of m.attachments ?? []) for (const k of ["id", "name", "mime"]) assert.equal(typeof f[k], "string");
}

test("П3: a 0.2.1 client works with this broker over WebSocket", async (t) => {
  const cleanup: (() => unknown)[] = [];
  // close clients before the broker, or its close() waits for them
  t.after(async () => {
    for (const f of cleanup.reverse()) await f();
  });
  const { broker, url } = await startBroker([{ name: "old", kind: "claude" }, { name: "peer" }]);
  cleanup.push(() => broker.close());
  const peer = await connect(url, "peer");
  cleanup.push(() => peer.close());
  await peer.join("lab");
  const offlineId = await peer.send({ to: "old", text: "while you were away" });

  const old = await v021Client(url, tok("old"));
  cleanup.push(() => old.ws.close());
  // auth -> welcome {agent, rooms}, then what was sent while it was offline
  const welcome = await old.request({ type: "auth", token: tok("old") });
  assert.equal(welcome.type, "welcome");
  assert.equal(welcome.agent, "old");
  assert.ok(Array.isArray(welcome.rooms));
  const missed = (await old.next((f) => f.type === "message")).message as any;
  assertV021Message(missed);
  assert.equal(missed.id, offlineId);
  assert.equal(missed.text, "while you were away");

  // delivered -> ack, and the sender sees it delivered
  assert.equal((await old.request({ type: "delivered", id: offlineId })).type, "ack");
  assert.deepEqual((await peer.history({ with: "old" })).find((m) => m.id === offlineId)?.delivered_to, ["old"]);

  // join / leave -> ack
  assert.equal((await old.request({ type: "join", room: "lab" })).type, "ack");

  // send to a room and directly -> ack {id}; the peer gets them with reply_to and hops
  const toRoom = nextMessage(peer);
  const roomAck = await old.request({ type: "send", room: "lab", text: "hi lab" });
  assert.equal(roomAck.type, "ack");
  assert.equal(typeof roomAck.id, "number");
  assert.equal((await toRoom).room, "lab");
  const direct = nextMessage(peer);
  const dmAck = await old.request({ type: "send", to: "peer", text: "re", reply_to: offlineId });
  const dm = await direct;
  assert.equal(dm.id, dmAck.id);
  assert.equal(dm.reply_to, offlineId);
  assert.equal(dm.hops, 1);

  // a live message arrives as {type: "message", message}
  await peer.send({ room: "lab", text: "live" });
  assertV021Message(((await old.next((f) => f.type === "message")) as any).message);

  // list_agents -> agents [{name, kind, online, rooms, description?, activity?}]
  const agents = (await old.request({ type: "list_agents" })).agents as any[];
  const me = agents.find((a) => a.name === "old");
  assert.equal(me.kind, "claude");
  assert.equal(me.online, true);
  assert.ok(me.rooms.includes("lab"));
  for (const a of agents) {
    assert.equal(typeof a.name, "string");
    assert.equal(typeof a.kind, "string");
    assert.equal(typeof a.online, "boolean");
    assert.ok(Array.isArray(a.rooms));
    if (a.activity) assert.equal(typeof a.activity.state, "string");
  }

  // history -> messages, by room and by peer
  const roomHistory = (await old.request({ type: "history", room: "lab", limit: 20 })).messages as any[];
  assert.deepEqual(roomHistory.map((m) => m.text), ["hi lab", "live"]);
  roomHistory.forEach(assertV021Message);
  const dmHistory = (await old.request({ type: "history", with: "peer", limit: 20 })).messages as any[];
  assert.deepEqual(dmHistory.map((m) => m.text), ["while you were away", "re"]);

  // errors carry the ref and a text; ping -> pong
  const err = await old.request({ type: "send", to: "nobody", text: "x" });
  assert.equal(err.type, "error");
  assert.equal(typeof err.error, "string");
  assert.equal((await old.request({ type: "ping" })).type, "pong");
  assert.equal((await old.request({ type: "leave", room: "lab" })).type, "ack");
});

test("П3: the REST calls of a 0.2.1 client keep working", async (t) => {
  const cleanup: (() => unknown)[] = [];
  // close clients before the broker, or its close() waits for them
  t.after(async () => {
    for (const f of cleanup.reverse()) await f();
  });
  const { broker, url } = await startBroker([{ name: "old", kind: "claude" }, { name: "peer" }]);
  cleanup.push(() => broker.close());
  const old = await v021Client(url, tok("old"));
  cleanup.push(() => old.ws.close());
  await old.request({ type: "auth", token: tok("old") });
  await old.request({ type: "join", room: "lab" });

  // files: upload with x-filename, attach, download
  const up = await old.api("POST", "/api/files", new TextEncoder().encode("numbers"), { "content-type": "text/plain", "x-filename": "r.txt" });
  // 0.2.1 checks only r.ok
  assert.ok(up.status >= 200 && up.status < 300, String(up.status));
  assert.equal(typeof up.body.file.id, "string");
  assert.equal((await old.request({ type: "send", room: "lab", text: "file", attachments: [up.body.file.id] })).type, "ack");
  const dl = await fetch(url.replace(/^ws/, "http") + `/api/files/${up.body.file.id}`, { headers: { authorization: `Bearer ${tok("old")}` } });
  assert.equal(await dl.text(), "numbers");

  // briefs
  const put = await old.api("PUT", "/api/rooms/lab/brief", { text: "Goal." });
  assert.equal(put.body.brief.text, "Goal.");
  const got = await old.api("GET", "/api/rooms/lab/brief");
  assert.equal(got.body.brief.text, "Goal.");
  assert.equal(got.body.brief.by, "old");

  // status
  const st = await old.api("POST", "/api/status", { topic: "compat", room: "lab" });
  assert.equal(st.body.activity.topic, "compat");
  assert.equal(st.body.activity.room, "lab");

  // games: types, create, join, list
  const types = (await old.api("GET", "/api/games/types")).body.types as any[];
  const checkers = types.find((t) => t.id === "checkers");
  for (const k of ["id", "title"]) assert.equal(typeof checkers[k], "string");
  assert.deepEqual(checkers.seats.map((s: any) => typeof s.id + typeof s.name), ["stringstring", "stringstring"]);
  const created = (await old.api("POST", "/api/games", { game: "checkers", players: ["old", null] })).body.game;
  for (const k of ["id", "game", "room", "status"]) assert.ok(created[k] !== undefined, k);
  assert.deepEqual(created.players, ["old", null]);
  assert.ok(Array.isArray(created.moves));
  const peerApi = await v021Client(url, tok("peer"));
  cleanup.push(() => peerApi.ws.close());
  const joined = (await peerApi.api("POST", `/api/games/${created.id}/join`, {})).body.game;
  assert.equal(joined.status, "active");
  const games = (await old.api("GET", "/api/games?status=active")).body.games as any[];
  assert.deepEqual(games.map((g) => g.id), [created.id]);
});

test("П3: BrokerClient ignores frames and fields it does not know", async (t) => {
  const cleanup: (() => unknown)[] = [];
  // close clients before the broker, or its close() waits for them
  t.after(async () => {
    for (const f of cleanup.reverse()) await f();
  });
  // a broker from the future: new frame types, new fields in known frames, a message without a ref
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  server.on("connection", (ws) =>
    ws.on("message", (data) => {
      const f = JSON.parse(String(data));
      if (f.type === "auth") {
        ws.send(JSON.stringify({ type: "welcome", agent: "old", rooms: [], ref: f.ref, intro: "new field" }));
        ws.send(JSON.stringify({ type: "wake_brief", away_ms: 1, text: "a frame 0.2.1 never saw" }));
        ws.send(JSON.stringify({ type: "thanks", id: 1, from: "peer", ref: "r999" }));
        ws.send(JSON.stringify({ type: "message", message: { id: 7, from: "peer", to: "old", text: "still here", ts: new Date().toISOString(), hops: 0, thanks: ["x"] } }));
      }
      if (f.type === "ping") ws.send(JSON.stringify({ type: "pong", ref: f.ref }));
    }),
  );
  cleanup.push(() => new Promise<void>((r) => server.close(() => r())));
  await new Promise<void>((r) => server.once("listening", () => r()));
  const port = (server.address() as { port: number }).port;
  const c = new BrokerClient({ url: `ws://127.0.0.1:${port}`, token: "t", reconnect: false, log: () => {} });
  cleanup.push(() => c.close());
  const got = new Promise<any>((r) => c.once("message", r));
  await c.connect();
  assert.equal((await got).text, "still here");
  // the connection still works after the unknown frames
  assert.equal((await c.request({ type: "ping" })).type, "pong");
});

test("А1: the adapter takes the intro from the broker; world_info shows the current one", async () => {
  const { broker, url, http } = await startBroker([
    { name: "claude1", kind: "claude", description: "Пише серверну частину." },
    { name: "boss", kind: "human", admin: true },
  ]);
  const put = (text: string) =>
    fetch(`${http}/admin/api/intro`, {
      method: "PUT",
      headers: { authorization: `Bearer ${tok("boss")}`, "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
  try {
    assert.equal((await put("Тут живуть люди й агенти.")).status, 200);
    const { client, call } = await startChannel(url, "claude1");
    try {
      assert.match(client.getInstructions() ?? "", /--- AIChat intro \(from the broker\) ---\nТут живуть люди й агенти\.\n\nLimits now/);
      // Б1: the agent knows its name and what the admin wrote about it
      assert.match(client.getInstructions() ?? "", /\n\nYou are claude1 on AIChat\.\nAn AIChat admin wrote about you: Пише серверну частину\.\nYour AIChat notebook \(remember, recall, forget\) is empty\.\n--- end of intro ---/);
      await put("Новий текст вводної.");
      assert.match(await call("world_info"), /^Новий текст вводної\.\n\nLimits now: a reply chain stops after 8 replies/);
    } finally {
      await client.close();
    }
  } finally {
    await broker.close();
  }
});

test("А1: with a broker that has no intro (0.2.1) the adapter keeps the 0.2.1 instructions", async () => {
  // an old broker: /api/intro is unknown to it
  const old = createServer((_req, res) => {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise<void>((r) => old.listen(0, "127.0.0.1", r));
  const port = (old.address() as { port: number }).port;
  const { client, call } = await startChannel(`ws://127.0.0.1:${port}`, "claude1");
  try {
    assert.equal(client.getInstructions(), LEGACY_INSTRUCTIONS);
    assert.match(await call("world_info"), /no intro/);
  } finally {
    await client.close();
    old.closeAllConnections();
    await new Promise((r) => old.close(r));
  }
});

// ---- adapter versions ----

test("adapter versions compare in semver order", () => {
  assert.ok(compareVersions("0.3.0", "0.2.1") > 0);
  assert.ok(compareVersions("0.2.1", "0.10.0") < 0);
  assert.ok(compareVersions("v1.0.0", "1.0.0") === 0);
  assert.ok(compareVersions("1.0.0", "1.0.0-rc.2") > 0);
  assert.ok(compareVersions("1.0.0-rc.10", "1.0.0-rc.2") > 0);
  assert.ok(compareVersions("1.0.0-rc.1", "1.0.0-beta") > 0);
  assert.equal(compareVersions("0.0.0-dev", "garbage"), 0);
  // run from a checkout, the adapter is the version in package.json
  assert.equal(ADAPTER_VERSION, VERSION);
});

test("a session on an older adapter is told to offer the update; on the current one it is not", async () => {
  const { broker, url, http } = await startBroker([{ name: "claude1", kind: "claude" }]);
  try {
    const old = await startChannel(url, "claude1", { AICHAT_ADAPTER_VERSION: "0.0.1" });
    try {
      const text = old.client.getInstructions() ?? "";
      assert.match(
        text,
        new RegExp(
          `this adapter \\(claude-channel\\.mjs\\) is version 0\\.0\\.1, the broker has ${VERSION.replace(/\./g, "\\.")}\\. ` +
            `Suggest to your user that they update it: download ${http}/client/claude-channel\\.mjs`,
        ),
      );
      assert.match(text, /Do not update it yourself\./);
      assert.ok(text.endsWith(PEER_RULE));
    } finally {
      await old.client.close();
    }
    const current = await startChannel(url, "claude1");
    try {
      assert.doesNotMatch(current.client.getInstructions() ?? "", /adapter update/);
    } finally {
      await current.client.close();
    }
  } finally {
    await broker.close();
  }
});

test("the adapter names itself in auth, and tells the session once when the broker it reconnects to is newer", async () => {
  // a minimal broker whose version can change between connections
  let version = "0.3.0";
  const auths: Record<string, unknown>[] = [];
  const http = createServer((req, res) => {
    const body = req.url === "/health" ? { ok: true, version } : { error: "not found" };
    res.writeHead(req.url === "/health" ? 200 : 404, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  const wss = new WebSocketServer({ server: http, path: "/ws" });
  wss.on("connection", (ws) =>
    ws.on("message", (data) => {
      const f = JSON.parse(String(data));
      if (f.type === "auth") {
        auths.push(f);
        ws.send(JSON.stringify({ type: "welcome", agent: "claude1", rooms: [], ref: f.ref }));
      }
    }),
  );
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  const port = (http.address() as { port: number }).port;
  const ch = await startChannel(`ws://127.0.0.1:${port}`, "claude1", { AICHAT_ADAPTER_VERSION: "0.3.0" });
  const waitFor = async (ok: () => boolean) => {
    for (const until = Date.now() + 8000; !ok() && Date.now() < until; ) await new Promise((r) => setTimeout(r, 50));
  };
  try {
    await waitFor(() => auths.length === 1);
    assert.deepEqual(auths[0].client, { name: "claude-channel", version: "0.3.0" });
    assert.doesNotMatch(ch.client.getInstructions() ?? "", /adapter update/);

    // the broker is updated: the adapter reconnects, notices it and says so once
    version = "0.4.0";
    for (const ws of wss.clients) ws.terminate();
    await waitFor(() => ch.notes.length > 0);
    assert.equal(ch.notes.length, 1);
    assert.deepEqual(ch.notes[0].params!.meta, { from: "aichat", notice: "adapter-update" });
    assert.match(ch.notes[0].params!.content, /^\(A note from your AIChat adapter[^\n]*\nAIChat adapter update: .* is version 0\.3\.0, the broker has 0\.4\.0\./);

    // the same version again: no second note
    for (const ws of wss.clients) ws.terminate();
    await waitFor(() => auths.length === 3);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(ch.notes.length, 1);
  } finally {
    await ch.client.close();
    for (const ws of wss.clients) ws.terminate();
    wss.close();
    http.closeAllConnections();
    await new Promise((r) => http.close(r));
  }
});

test("Б2: the notebook tools keep notes across sessions; the session starts with a pointer to the notebook, not the notes", async () => {
  const { broker, url } = await startBroker([{ name: "claude1", kind: "claude" }, { name: "claude2", kind: "claude" }]);
  try {
    const first = await startChannel(url, "claude1");
    try {
      assert.match(first.client.getInstructions() ?? "", /Your AIChat notebook \(remember, recall, forget\) is empty\./);
      assert.match(await first.call("remember", { text: "olena prefers short answers", topic: "people" }), /^remembered #(\d+) \[people\] \(.+\): olena prefers short answers$/);
      const second = await first.call("remember", { text: "npm test hangs without a timeout" });
      const id = Number(second.match(/#(\d+)/)![1]);
      assert.match(await first.call("remember", { id, text: "use --test-timeout" }), new RegExp(`^changed #${id} \(.+\): use --test-timeout$`));
      assert.match(await first.call("recall", { query: "OLENA" }), /^1 of 2 notes \(the notebook holds up to 200\)\n#\d+ \[people\] .*olena prefers short answers$/);
      assert.match(await first.call("recall", { topic: "people" }), /^1 of 2 notes/);
      assert.match(await first.call("recall"), /^2 of 2 notes/);
      assert.equal(await first.call("forget", { id }), `forgot note #${id}`);
      const bad = await first.client.callTool({ name: "forget", arguments: { id } });
      assert.equal(bad.isError, true);
    } finally {
      await first.client.close();
    }

    // a new session: it is told how many notes there are and when they changed, but not what they say
    const next = await startChannel(url, "claude1");
    try {
      const text = next.client.getInstructions() ?? "";
      assert.match(text, /Your AIChat notebook \(remember, recall, forget\) has 1 note, last changed \d{4}-\d\d-\d\dT/);
      assert.doesNotMatch(text, /olena prefers short answers/);
      assert.match(await next.call("recall"), /olena prefers short answers/);
    } finally {
      await next.client.close();
    }

    // another agent sees none of it
    const other = await startChannel(url, "claude2");
    try {
      assert.match(await other.call("recall"), /^0 of 0 notes/);
    } finally {
      await other.client.close();
    }
  } finally {
    await broker.close();
  }
});
