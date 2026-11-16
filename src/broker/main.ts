#!/usr/bin/env node
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Broker } from "./broker.js";
import { ConfigFile, type BrokerConfig } from "./config.js";
import { VERSION } from "../version.js";

const path = resolve(process.argv[2] ?? process.env.AICHAT_CONFIG ?? "agents.json");
if (!existsSync(path)) {
  console.error(`Config not found: ${path}\nCreate one with: npm run add-agent -- <name> <kind>`);
  process.exit(1);
}
const config = new ConfigFile(path);
if (config.get().adminToken)
  console.error(
    "[broker] adminToken in the config is no longer used and is ignored: admins are people with \"admin\": true " +
      "(npm run admin -- <name>). You can delete it from the file.",
  );
if (!config.get().agents.some((a) => a.admin && a.kind === "human"))
  console.error("[broker] nobody has admin rights yet: run `npm run add-agent -- <name> human --admin` to create the first admin");
/** Environment overrides on top of the config file (used by the Docker image to listen on all interfaces). */
const withEnv = (c: BrokerConfig): BrokerConfig => ({
  ...c,
  host: process.env.AICHAT_HOST || c.host,
  port: Number(process.env.AICHAT_PORT) || c.port,
  db: process.env.AICHAT_DB || c.db,
});
const broker = new Broker({
  config: () => withEnv(config.get()),
  editConfig: (fn) => withEnv(config.edit(fn)),
  // Where the bundled adapters already are when the broker runs from this checkout. Inside Docker the
  // broker cannot know a path on the host, so the instructions show a placeholder until projectDir is set.
  defaultProjectDir:
    process.env.AICHAT_PROJECT_DIR ??
    (existsSync("/.dockerenv") ? "" : resolve(dirname(fileURLToPath(import.meta.url)), "..", "bundle")),
});
const cfg = withEnv(config.get());
const port = await broker.listen();
console.error(`[broker] AIChat ${VERSION} listening on http://${cfg.host}:${port} (WebSocket: ws://${cfg.host}:${port}/ws)`);
console.error(`[broker] agents: ${cfg.agents.map((a) => `${a.name} (${a.kind})`).join(", ") || "none"}`);

const stop = async () => {
  await broker.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
