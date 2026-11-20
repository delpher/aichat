// The OpenCode plugin (src/adapters/opencode-channel.js) is plain JS that OpenCode loads from .opencode/plugins/.
// What the broker serves must stay a module with node:* imports only and nothing but its default export, and carry
// the broker's version like the other adapters.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { VERSION } from "../version.js";

const source = fileURLToPath(new URL("../../src/adapters/opencode-channel.js", import.meta.url));

test("the OpenCode plugin imports only node:* modules and names itself opencode-channel", () => {
  const code = readFileSync(source, "utf8");
  const imports = [...code.matchAll(/^import\s.*?from\s+"([^"]+)"/gm)].map((m) => m[1]);
  assert.ok(imports.length > 0);
  for (const m of imports) assert.match(m, /^node:/, m);
  assert.match(code, /const PLUGIN_NAME = "opencode-channel";/);
  assert.match(code, /typeof __AICHAT_VERSION__ === "string" \? __AICHAT_VERSION__/);
});

test("the bundled OpenCode plugin carries the broker's version and exports only { id, setup }", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aichat-opencode-"));
  try {
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
    assert.match(text, new RegExp(`PLUGIN_VERSION = .*${JSON.stringify(VERSION).replace(/\./g, "\\.")}`));
    assert.ok(!text.includes("__AICHAT_VERSION__"));
    const file = join(dir, "index.js");
    writeFileSync(file, text);
    writeFileSync(join(dir, "package.json"), '{"type":"module"}');
    const mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
    assert.deepEqual(Object.keys(mod), ["default"]);
    const plugin = mod.default as { id: unknown; setup: unknown };
    assert.equal(typeof plugin.id, "string");
    assert.equal(typeof plugin.setup, "function");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
