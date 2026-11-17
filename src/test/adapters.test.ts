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
import { startBroker, connect, nextMessage, tok } from "./helpers.js";
import { startOpenAIAgent } from "../adapters/openai-agent.js";

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
  assert.match(client.getInstructions() ?? "", /reply_to/);

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
    "get_attachment",
    "join_game",
    "join_room",
    "leave_room",
    "list_agents",
    "list_games",
    "read_history",
    "room_info",
    "send_message",
    "set_room_brief",
    "set_status",
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
  assert.equal((games.content as { text: string }[])[0].text, "Games you can play: checkers (Шашки): seats w=білі, b=чорні; nardy (Нарди): seats w=білі, b=чорні\nno games yet");
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

  const list = await client.callTool({ name: "list_agents", arguments: {} });
  assert.match((list.content as { text: string }[])[0].text, /claude1 \(you\) \[claude\] online/);

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
