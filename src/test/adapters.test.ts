import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    "send_message",
  ]);
  const games = await client.callTool({ name: "list_games", arguments: {} });
  assert.equal((games.content as { text: string }[])[0].text, "Games you can play: checkers (Шашки): seats w=білі, b=чорні; nardy (Нарди): seats w=білі, b=чорні\nno games yet");
  // the agent sits where it asks; the seat names come from the game type
  const created = await client.callTool({ name: "create_game", arguments: { game: "checkers", seat: "b" } });
  assert.match((created.content as { text: string }[])[0].text, /^created #\d+ checkers \[open\] білі: \(free\), чорні: claude1, moves: 0 - room game-\d+$/);
  const badSeat = await client.callTool({ name: "create_game", arguments: { seat: "x" } });
  assert.match((badSeat.content as { text: string }[])[0].text, /unknown seat x; seats: w, b/);
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
