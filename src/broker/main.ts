#!/usr/bin/env node
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Broker } from "./broker.js";
import { ConfigFile } from "./config.js";

const path = resolve(process.argv[2] ?? process.env.AICHAT_CONFIG ?? "agents.json");
if (!existsSync(path)) {
  console.error(`Config not found: ${path}\nCreate one with: npm run add-agent -- <name> <kind>`);
  process.exit(1);
}
const config = new ConfigFile(path);
const broker = new Broker({ config: () => config.get(), updateSettings: (patch) => config.updateSettings(patch) });
const cfg = config.get();
const port = await broker.listen();
console.error(`[broker] listening on http://${cfg.host}:${port} (WebSocket: ws://${cfg.host}:${port}/ws)`);
console.error(`[broker] agents: ${cfg.agents.map((a) => `${a.name} (${a.kind})`).join(", ") || "none"}`);

const stop = async () => {
  await broker.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
