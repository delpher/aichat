// The Codex channel (src/adapters/codex-channel.mjs) and the Antigravity channel (src/adapters/agy-channel.mjs) are
// plain JS files: the broker serves them at /client/<name>.mjs, and each runs the adapter, its MCP tools and its
// installer from that same file. What the broker serves must import only node:* modules and carry the broker's
// version, like the other adapters. Their own behaviour is tested by src/adapters/<name>.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { VERSION } from "../version.js";

for (const name of ["codex-channel", "agy-channel"]) {
  const source = fileURLToPath(new URL(`../../src/adapters/${name}.mjs`, import.meta.url));

  test(`the ${name} adapter imports only node:* modules and names itself ${name}`, () => {
    const code = readFileSync(source, "utf8");
    const imports = [...code.matchAll(/^import\s.*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);
    assert.ok(imports.length > 0);
    for (const m of imports) assert.match(m, /^node:/, m);
    // the adapter names itself and its version; it may add more (surface, start) after them
    assert.match(code, new RegExp(`client: \\{\\s*name: ['"]${name}['"],\\s*version: VERSION\\b`));
    assert.match(code, /__AICHAT_VERSION__ (?:===|!==) ['"](?:string|undefined)['"] \? __AICHAT_VERSION__ : ['"]0\.0\.0-dev['"]/);
  });

  test(`the bundled ${name} adapter carries the broker's version`, async () => {
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
}
