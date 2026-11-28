// The OpenCode plugin (src/adapters/opencode-channel.js) is plain JS that OpenCode loads from .opencode/plugins/.
// What the broker serves must stay a module with node:* imports only and nothing but its default export, and carry
// the broker's version like the other adapters.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { WebSocketServer } from "ws";
import { VERSION } from "../version.js";

const source = fileURLToPath(new URL("../../src/adapters/opencode-channel.js", import.meta.url));

const buildBundle = async (dir: string) => {
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
  return (await import(pathToFileURL(file).href)).default as {
    setup: (ctx: unknown) => Promise<() => Promise<void> | void>;
  };
};

const makeCtx = (
  dir: string,
  storage: Record<string, unknown>,
  sessionModel: unknown = null,
  sessionDir: string = dir,
) => {
  const created: string[] = [];
  const got: string[] = [];
  const saved: Record<string, unknown> = {};
  const ctx = {
    location: { directory: dir },
    options: {
      paused: true,
      token: "test-token",
      url: "ws://127.0.0.1:9/ws",
      sessionTitle: "T",
      requestTimeoutMs: 300,
    },
    storage: {
      get: async (key: string) => storage[key],
      set: async (key: string, value: unknown) => {
        storage[key] = value;
        saved[key] = value;
      },
    },
    session: {
      create: async () => {
        created.push("new");
        return { id: "ses_new", title: "T" };
      },
      get: async ({ sessionID }: { sessionID: string }) => {
        got.push(sessionID);
        return { id: sessionID, title: "T", model: sessionModel, location: { directory: sessionDir } };
      },
      switchModel: async () => {},
    },
    tool: {
      transform: (cb: (editor: unknown) => void) => {
        cb({ namespace: () => {}, add: () => {} });
        return Promise.resolve({ dispose() {} });
      },
    },
    model: { list: async () => [] },
  };
  return { ctx, created, got, saved };
};

test("the OpenCode plugin imports only node:* modules and names itself opencode-channel", () => {
  const code = readFileSync(source, "utf8");
  const imports = [...code.matchAll(/^import\s.*?from\s+"([^"]+)"/gm)].map((m) => m[1]);
  assert.ok(imports.length > 0);
  // the plugin is bundled into one file: the source may import the shared core, but nothing from npm.
  // `src/test/channel-bundles.test.ts` checks the built bundle itself for anything but node:*.
  for (const m of imports) assert.ok(m.startsWith("node:") || m.startsWith("./core/"), m);
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

test("the plugin's own tools are only upload_file and get_attachment: the server tools live on the broker", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aichat-opencode-"));
  const realFetch = globalThis.fetch;
  try {
    const plugin = await buildBundle(dir);
    const tools: { name: string; execute: (input: Record<string, unknown>, context: unknown) => Promise<{ content: string }> }[] = [];
    const calls: { url: string; method: string }[] = [];
    const outbox = join(dir, "outbox");
    mkdirSync(outbox, { recursive: true });
    writeFileSync(join(outbox, "note.txt"), "hello");
    writeFileSync(join(dir, "outside.txt"), "no");
    globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      calls.push({ url, method: init.method ?? "GET" });
      if (url.endsWith("/api/files") && (init.method ?? "GET") === "POST") {
        return new Response(JSON.stringify({ file: { id: "f1" } }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.includes("/api/instructions")) {
        return new Response(JSON.stringify({ rules: { text: "BROKER RULES", by: "admin", ts: "t" }, self: { name: "test-oc" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/api/files/f1")) {
        return new Response(new TextEncoder().encode("image-bytes"), {
          status: 200,
          headers: { "content-type": "image/png", "content-disposition": 'attachment; filename="pic.png"' },
        });
      }
      return new Response(JSON.stringify({ tools: [] }), { status: 200, headers: { "content-type": "application/json" } });
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
      assert.deepEqual(
        tools.map((t) => t.name).sort(),
        ["get_attachment", "upload_file"],
        "no server tools are defined in the adapter any more",
      );
      // the broker's rules reach OpenCode as an ambient instructions file, with this runtime's block after them
      const rules = readFileSync(join(dir, ".aichat", "instructions.md"), "utf8");
      assert.match(rules, /BROKER RULES/);
      assert.match(rules, /You are test-oc on AIChat\./);
      assert.match(rules, /aichat_files/);

      const byName = new Map(tools.map((t) => [t.name, t]));

      const up = await byName.get("upload_file")!.execute({ path: join(outbox, "note.txt") }, {});
      const uploaded = JSON.parse(up.content) as { file_id: string; name: string; size: number };
      assert.deepEqual(uploaded, { file_id: "f1", name: "note.txt", size: 5 });
      assert.equal(calls.at(-1)?.url, "http://127.0.0.1:9/api/files");
      assert.equal(calls.at(-1)?.method, "POST");

      await assert.rejects(() => byName.get("upload_file")!.execute({ path: join(dir, "outside.txt") }, {}), /outside the upload folders/);

      const got = await byName.get("get_attachment")!.execute({ file_id: "f1" }, {});
      const saved = JSON.parse(got.content) as { path: string; name: string; size: number };
      assert.equal(saved.name, "pic.png");
      // the shared core writes <id>-<name>, so two attachments with the same name do not clash
      assert.match(saved.path, /[\\/]f1-pic\.png$/);
      assert.equal(saved.size, 11);
      assert.equal(readFileSync(saved.path, "utf8"), "image-bytes");
      rmSync(saved.path, { force: true });
    } finally {
      await dispose();
    }
  } finally {
    globalThis.fetch = realFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the OpenCode plugin starts a new session on .aichat/fresh and resumes it otherwise", async () => {
  // A fresh start: the marker forces a new session, the old id is kept in previousSessionIds, and the marker
  // is spent only after the new session exists.
  const freshDir = mkdtempSync(join(tmpdir(), "aichat-opencode-"));
  try {
    const plugin = await buildBundle(freshDir);
    mkdirSync(join(freshDir, ".aichat"), { recursive: true });
    writeFileSync(join(freshDir, ".aichat", "fresh"), "");
    const { ctx, created, got, saved } = makeCtx(freshDir, {
      "aichat/session": { id: "ses_old" },
    });
    const dispose = await plugin.setup(ctx);
    try {
      const status = JSON.parse(readFileSync(join(freshDir, ".aichat", "status.json"), "utf8"));
      assert.equal(status.surface, "server");
      assert.equal(status.start, "new");
      assert.equal(status.sessionID, "ses_new");
      // a session whose model is unknown says nothing rather than inventing one
      assert.equal(status.model, undefined);
      assert.equal(status.effective.sandbox, false);
      assert.deepEqual(status.effective.writableRoots, ["*"]);
      assert.equal(created.length, 1, "created a new session");
      assert.equal(got.length, 0, "did not resume the old one");
      const sessionKeyDir = (dir: string) => {
        const value = String(dir).replace(/\\/g, "/").replace(/\/+$/, "");
        // the adapter lowercases the folder only on Windows (POSIX paths are case-sensitive)
        return process.platform === "win32" ? value.toLowerCase() : value;
      };
      assert.deepEqual(saved["aichat/session:".concat(sessionKeyDir(freshDir))], {
        id: "ses_new",
        title: "T",
      });
      assert.ok((saved["aichat/previousSessionIds"] as string[]).includes("ses_old"));
      assert.equal(existsSync(join(freshDir, ".aichat", "fresh")), false, "marker spent");
    } finally {
      await dispose();
    }
  } finally {
    rmSync(freshDir, { recursive: true, force: true });
  }

  // A normal start resumes the saved session.
  const resumeDir = mkdtempSync(join(tmpdir(), "aichat-opencode-"));
  try {
    const plugin = await buildBundle(resumeDir);
    const { ctx, created, got } = makeCtx(
      resumeDir,
      {
        "aichat/session": { id: "ses_old" },
      },
      { providerID: "litellm", id: "main-model", variant: "high" },
    );
    const dispose = await plugin.setup(ctx);
    try {
      const status = JSON.parse(readFileSync(join(resumeDir, ".aichat", "status.json"), "utf8"));
      assert.equal(status.start, "resumed");
      assert.equal(status.sessionID, "ses_old");
      // the running model, in the same provider/model#variant form the manager's setting uses
      assert.equal(status.model, "litellm/main-model#high");
      assert.deepEqual(got, ["ses_old"], "resumed the saved session");
      assert.equal(created.length, 0, "did not create a session");
    } finally {
      await dispose();
    }
  } finally {
    rmSync(resumeDir, { recursive: true, force: true });
  }

  // A saved session of /tmp/aichat-ABC is not the session of /tmp/aichat-abc on POSIX; Windows paths are
  // case-insensitive, so there it is the same folder (AIChat #aichat-manager-dev, Linux support).
  const caseDir = mkdtempSync(join(tmpdir(), "aichat-opencode-"));
  try {
    const plugin = await buildBundle(caseDir);
    const otherCase = caseDir.toUpperCase();
    const { ctx, created, got } = makeCtx(
      caseDir,
      { "aichat/session": { id: "ses_other" } },
      null,
      otherCase,
    );
    const dispose = await plugin.setup(ctx);
    try {
      const status = JSON.parse(readFileSync(join(caseDir, ".aichat", "status.json"), "utf8"));
      assert.deepEqual(got, ["ses_other"], "looked at the saved session");
      if (process.platform === "win32") {
        assert.equal(status.start, "resumed");
        assert.equal(status.sessionID, "ses_other");
        assert.equal(created.length, 0, "the same folder in another case is still the same session");
      } else {
        assert.equal(status.start, "new");
        assert.equal(status.sessionID, "ses_new");
        assert.equal(created.length, 1, "a path that differs in case is another folder on POSIX");
      }
    } finally {
      await dispose();
    }
  } finally {
    rmSync(caseDir, { recursive: true, force: true });
  }
});

test("the OpenCode plugin drops the channel on .aichat/stop and brings it back on .aichat/start", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aichat-opencode-"));
  const wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => wss.once("listening", resolve));
  const port = (wss.address() as { port: number }).port;
  let connections = 0;
  wss.on("connection", (socket) => {
    connections += 1;
    socket.send(JSON.stringify({ type: "welcome", agent: "opencode-test", rooms: [] }));
  });
  const waits = async (what: () => boolean, ms = 8000) => {
    const started = Date.now();
    while (Date.now() - started < ms) {
      if (what()) return true;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return false;
  };
  try {
    const plugin = await buildBundle(dir);
    const { ctx } = makeCtx(dir, {});
    ctx.options.paused = false;
    ctx.options.url = `ws://127.0.0.1:${port}/ws`;
    const dispose = await plugin.setup(ctx);
    try {
      assert.ok(await waits(() => connections === 1), "connected to the broker");
      writeFileSync(join(dir, ".aichat", "stop"), "");
      // the channel closes without the shared OpenCode server being touched
      assert.ok(await waits(() => wss.clients.size === 0), "the channel closed");
      assert.equal(existsSync(join(dir, ".aichat", "stop")), false, "the stop marker is spent");
      const stopped = JSON.parse(readFileSync(join(dir, ".aichat", "status.json"), "utf8"));
      assert.equal(stopped.connected, false);
      writeFileSync(join(dir, ".aichat", "start"), "");
      const backConnected = () => {
        try {
          return JSON.parse(readFileSync(join(dir, ".aichat", "status.json"), "utf8")).connected === true;
        } catch {
          return false;
        }
      };
      assert.ok(await waits(() => connections === 2 && backConnected()), "connected again on .aichat/start");
      assert.equal(existsSync(join(dir, ".aichat", "start")), false, "the start marker is spent");
      const back = JSON.parse(readFileSync(join(dir, ".aichat", "status.json"), "utf8"));
      assert.equal(back.connected, true);
    } finally {
      await dispose();
    }
  } finally {
    wss.close();
    rmSync(dir, { recursive: true, force: true });
  }
});