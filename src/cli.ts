#!/usr/bin/env node
// Terminal client so a human can join the conversation or watch it.
//   npm run chat -- --token <token> [--url ws://127.0.0.1:8787]
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { BrokerClient } from "./client/broker-client.js";
import type { ChatMessage } from "./protocol.js";

const { values } = parseArgs({
  options: {
    url: { type: "string", default: process.env.AICHAT_URL ?? "ws://127.0.0.1:8787" },
    token: { type: "string", default: process.env.AICHAT_TOKEN },
  },
});
if (!values.token) {
  console.error("usage: npm run chat -- --token <token> [--url ws://host:port]");
  process.exit(1);
}

const HELP = `Commands:
  @agent text          direct message
  #room text           message a room (joins it)
  /reply <id> text     answer message <id> in its conversation
  /agents              who is on the network
  /join room | /leave room
  /history #room | /history agent
  /quit`;

const client = new BrokerClient({ url: values.url!, token: values.token, log: (m) => console.error(`! ${m}`) });
const seen = new Map<number, ChatMessage>();
const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "> " });

const show = (m: ChatMessage) => {
  seen.set(m.id, m);
  const where = m.room ? `#${m.room}` : m.to === client.agent ? "dm" : `@${m.to}`;
  process.stdout.write(`\r[${m.id}] ${where} ${m.from}: ${m.text}\n`);
  rl.prompt(true);
};

client.on("message", show);
client.on("presence", (p: { agent: string; online: boolean }) => {
  process.stdout.write(`\r* ${p.agent} is ${p.online ? "online" : "offline"}\n`);
  rl.prompt(true);
});

await client.connectWithRetry();
console.log(`Connected as ${client.agent}. Type /help for commands.`);
rl.prompt();

rl.on("line", async (line) => {
  const s = line.trim();
  try {
    if (!s) {
      // nothing
    } else if (s === "/help") console.log(HELP);
    else if (s === "/quit") return (client.close(), process.exit(0));
    else if (s === "/agents")
      for (const a of await client.listAgents())
        console.log(`${a.name} [${a.kind}] ${a.online ? "online" : "offline"} ${a.rooms.map((r) => "#" + r).join(" ")}`);
    else if (s.startsWith("/join ")) await client.join(s.slice(6).trim().replace(/^#/, ""));
    else if (s.startsWith("/leave ")) await client.leave(s.slice(7).trim().replace(/^#/, ""));
    else if (s.startsWith("/history ")) {
      const t = s.slice(9).trim();
      const msgs = await client.history(t.startsWith("#") ? { room: t.slice(1) } : { with: t.replace(/^@/, "") });
      for (const m of msgs) console.log(`[${m.id}] ${m.from}: ${m.text}`);
    } else if (s.startsWith("/reply ")) {
      const [, id, ...rest] = s.split(" ");
      const parent = seen.get(Number(id));
      if (!parent) throw new Error(`message ${id} not seen in this session`);
      const target = parent.room ? { room: parent.room } : { to: parent.from === client.agent ? parent.to! : parent.from };
      await client.send({ ...target, text: rest.join(" "), reply_to: parent.id });
    } else if (s.startsWith("@") || s.startsWith("#")) {
      const sp = s.indexOf(" ");
      if (sp < 0) throw new Error("message text is missing");
      const target = s.slice(1, sp);
      const id = await client.send({ ...(s[0] === "@" ? { to: target } : { room: target }), text: s.slice(sp + 1) });
      seen.set(id, { id, from: client.agent!, text: s.slice(sp + 1), ts: "", hops: 0, ...(s[0] === "@" ? { to: target } : { room: target }) });
    } else console.log("Start with @agent or #room, or type /help");
  } catch (e) {
    console.log(`error: ${(e as Error).message}`);
  }
  rl.prompt();
});
