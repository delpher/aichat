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

test("aichat_react posts/deletes a fixed emoji and aichat_read renders reactions", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aichat-opencode-"));
  const realFetch = globalThis.fetch;
  try {
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
    const file = join(dir, "index.js");
    writeFileSync(file, out.outputFiles[0].text);
    writeFileSync(join(dir, "package.json"), '{"type":"module"}');
    const mod = await import(pathToFileURL(file).href);
    const plugin = mod.default as { setup: (ctx: unknown) => Promise<() => Promise<void> | void> };

    const tools: { name: string; execute: (input: unknown, context: unknown) => Promise<{ content: string }> }[] = [];
    const calls: { url: string; method: string; body?: string }[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      calls.push({ url, method: init.method ?? "GET", body: typeof init.body === "string" ? init.body : undefined });
      const json = url.includes("/api/history")
        ? { messages: [{ id: 11, ts: "t", room: "lab", from: "alexey", text: "hi", reactions: { "👍": ["claude-alexey"] } }] }
        : { reactions: { "👍": ["opencode-alexey"] } };
      return new Response(JSON.stringify(json), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const ctx = {
      location: { directory: dir },
      options: { paused: true, token: "test-token", url: "ws://127.0.0.1:9/ws", sessionTitle: "T" },
      storage: { get: async () => undefined, set: async () => {} },
      session: {
        create: async () => ({ id: "ses_test", title: "T" }),
        get: async () => {
          throw new Error("none");
        },
        switchModel: async () => {},
      },
      tool: {
        transform: (cb: (editor: unknown) => void) => {
          cb({
            namespace: () => {},
            add: (tool: (typeof tools)[number]) => tools.push(tool),
          });
          return Promise.resolve({ dispose() {} });
        },
      },
      model: { list: async () => [] },
    };
    const dispose = await plugin.setup(ctx);
    try {
      const byName = new Map(tools.map((t) => [t.name, t]));
      const react = byName.get("react");
      const read = byName.get("read");
      assert.ok(react, "react tool registered");
      assert.ok(read, "read tool registered");

      const placed = await react.execute({ id: 11, emoji: "👍" }, {});
      assert.match(placed.content, /поставлено 👍 на #11/);
      assert.equal(calls.at(-1)?.method, "POST");
      assert.equal(calls.at(-1)?.url, "http://127.0.0.1:9/api/messages/11/reactions");
      assert.deepEqual(JSON.parse(calls.at(-1)?.body ?? "{}"), { emoji: "👍" });

      await react.execute({ id: 11, emoji: "👍", remove: true }, {});
      assert.equal(calls.at(-1)?.method, "DELETE");

      const before = calls.length;
      await assert.rejects(() => react.execute({ id: 11, emoji: "🔥" }, {}), /emoji/);
      assert.equal(calls.length, before, "invalid emoji never reaches the broker");
      await assert.rejects(() => react.execute({ id: 0, emoji: "👍" }, {}), /id/);

      const history = await read.execute({ room: "lab" }, {});
      assert.match(history.content, /\[реакції: 👍 claude-alexey\]/);
    } finally {
      await dispose();
    }
  } finally {
    globalThis.fetch = realFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});
