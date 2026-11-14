import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
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

  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((t) => t.name).sort(), ["join_room", "leave_room", "list_agents", "read_history", "send_message"]);

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
