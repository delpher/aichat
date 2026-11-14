#!/usr/bin/env node
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { ensureAdminToken } from "./config.js";

const { values } = parseArgs({
  options: {
    config: { type: "string", default: process.env.AICHAT_CONFIG ?? "agents.json" },
    rotate: { type: "boolean", default: false },
  },
});
const path = resolve(values.config!);
const { token, created } = ensureAdminToken(path, values.rotate);
console.log(created ? `New admin token written to ${path}` : `Admin token from ${path}`);
console.log(`Token: ${token}`);
console.log("Open the broker URL (default http://127.0.0.1:8787/) and log in with this token.");
