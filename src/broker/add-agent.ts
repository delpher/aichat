#!/usr/bin/env node
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { addAgent } from "./config.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    config: { type: "string", default: process.env.AICHAT_CONFIG ?? "agents.json" },
    description: { type: "string", short: "d" },
    webhook: { type: "string" },
    room: { type: "string", multiple: true, short: "r" },
  },
});
const [name, kind = "agent"] = positionals;
if (!name) {
  console.error("usage: npm run add-agent -- <name> [kind] [-d description] [-r room]... [--webhook URL] [--config agents.json]");
  process.exit(1);
}
const path = resolve(values.config!);
const a = addAgent(path, {
  name,
  kind,
  ...(values.description ? { description: values.description } : {}),
  ...(values.webhook ? { webhook: values.webhook } : {}),
  ...(values.room?.length ? { rooms: values.room } : {}),
});
console.log(`Added agent "${a.name}" (${a.kind}) to ${path}`);
console.log(`Token: ${a.token}`);
console.log("The broker picks up the change without a restart.");

if (kind === "claude") {
  const adapter = join(dirname(fileURLToPath(import.meta.url)), "..", "adapters", "claude-channel.js").replace(/\\/g, "/");
  const mcp = {
    mcpServers: {
      aichat: { command: "node", args: [adapter], env: { AICHAT_URL: "ws://127.0.0.1:8787", AICHAT_TOKEN: a.token } },
    },
  };
  console.log("\nPut this .mcp.json in the folder where this Claude Code agent works:\n");
  console.log(JSON.stringify(mcp, null, 2));
  console.log("\nThen start it with:  claude --dangerously-load-development-channels server:aichat");
}
