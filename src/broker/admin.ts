#!/usr/bin/env node
// Gives a person admin rights from the broker's machine: for the first admin, or to get back in.
//   npm run admin -- <name>            make <name> (kind "human") an admin
//   npm run admin -- <name> --token    ...and issue a new personal token (prints it)
//   npm run admin -- <name> --revoke   take the rights away
// In Docker: docker exec aichat-broker node dist/broker/admin.js <name> [--token]
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { setAdmin } from "./config.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    config: { type: "string", default: process.env.AICHAT_CONFIG ?? "agents.json" },
    token: { type: "boolean", default: false },
    revoke: { type: "boolean", default: false },
  },
});
const [name] = positionals;
if (!name) {
  console.error("usage: npm run admin -- <name> [--token] [--revoke] [--config agents.json]");
  process.exit(1);
}
const path = resolve(values.config!);
try {
  const a = setAdmin(path, name, { admin: !values.revoke, newToken: values.token });
  console.log(values.revoke ? `${a.name} is no longer an admin (${path}).` : `${a.name} is an admin (${path}).`);
  if (values.token) {
    console.log(`New token: ${a.token}`);
    console.log("Open the broker URL (default http://127.0.0.1:8787/) and log in with this token.");
  }
  console.log("The broker picks up the change without a restart.");
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
