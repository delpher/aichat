// The Codex channel (src/adapters/codex-channel.mjs) is one plain JS file: the broker serves it at
// /client/codex-channel.mjs, and it runs the adapter, its MCP tools and its installer from that same file.
// What the broker serves must import only node:* modules and carry the broker's version, like the other adapters.
// The adapter's own behaviour is tested by src/adapters/codex-channel.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { VERSION } from "../version.js";

const source = fileURLToPath(new URL("../../src/adapters/codex-channel.mjs", import.meta.url));

test("the Codex channel imports only node:* modules and names itself codex-channel", () => {
  const code = readFileSync(source, "utf8");
  const imports = [...code.matchAll(/^import\s.*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);
  assert.ok(imports.length > 0);
  for (const m of imports) assert.match(m, /^node:/, m);
  assert.match(code, /client: \{ name: 'codex-channel', version: VERSION \}/);
  assert.match(code, /typeof __AICHAT_VERSION__ === 'string' \? __AICHAT_VERSION__/);
});

test("the bundled Codex channel carries the broker's version", async () => {
  // the same options scripts/bundle.mjs uses for it
  const out = await build({
    entryPoints: [source],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    write: false,
    logLevel: "silent",
    define: { __AICHAT_VERSION__: JSON.stringify(VERSION) },
  });
  const text = out.outputFiles[0].text;
  assert.match(text, new RegExp(`VERSION = .*${JSON.stringify(VERSION).replace(/\./g, "\\.")}`));
  assert.ok(!text.includes("__AICHAT_VERSION__"));
});
