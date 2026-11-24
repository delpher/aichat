import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { Actions, readSettings, startCommand, type Runner } from "../manager/actions.js";
import { adapterVersion, brokerOrigin, discover, tail } from "../manager/agents.js";
import { overview, startManager } from "../manager/server.js";
import { flagValue, joinCommand, parseJsonc, parseTomlLite, readAgentSettings, splitCommand, withFlag, withTomlTop, writeAgentSettings } from "../manager/settings.js";
import { MANAGER_VERSION, fileVersion, install, installedFile, pageKey, sha256, updateInfo, updateSelf } from "../manager/self.js";
import { installAgent, installInfo } from "../manager/wizard.js";
import { replaceToken } from "../manager/token.js";
import { changeDirs, withTomlTableArray } from "../manager/dirs.js";
import { toggleMcp, withDisabledFlag, withJsoncServerDisabled, withTomlServerEnabled } from "../manager/mcp.js";

/** A broker that knows two tokens and answers /health, /api/me and /api/agents. */
async function fakeBroker(): Promise<{ server: Server; url: string }> {
  const tokens: Record<string, string> = { "tok-agy": "agy-bot", "tok-claude": "claude-bot" };
  const server = createServer((req, res) => {
    const me = tokens[(req.headers.authorization ?? "").replace(/^Bearer /, "")];
    const send = (s: number, b: unknown) => {
      res.writeHead(s, { "content-type": "application/json" });
      res.end(JSON.stringify(b));
    };
    if (req.url === "/health") return send(200, { ok: true, version: "0.20.0" });
    if (!me) return send(401, { error: "unauthorized" });
    if (req.url === "/api/me") return send(200, { name: me });
    if (req.url === "/api/agents")
      return send(200, {
        agents: [
          { name: "agy-bot", online: true, activity: { state: "working", topic: "PR" }, adapter: { name: "agy-channel", version: "0.19.0" } },
          { name: "claude-bot", online: false },
        ],
      });
    send(404, {});
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}` };
}

/** A folder with one agent of each kind, as the adapters install them. */
function agentsFolder(t: { after: (fn: () => void) => void }, broker: string): string {
  const root = mkdtempSync(join(tmpdir(), "aichat-manager-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (rel: string, text: string) => {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), text);
  };
  put("agy/agy-channel.mjs", 'var VERSION = true ? "0.19.0" : "0.0.0-dev";');
  put("agy/token.txt", "tok-agy\n");
  put("agy/aichat.config.json", JSON.stringify({ url: broker, tokenFile: "token.txt" }));
  put("agy/.aichat/adapter.log", "one\ntwo\nthree\n");
  put("agy/.aichat/status.json", JSON.stringify({ pid: process.pid, phase: "waiting", connected: true, version: "0.19.0" }));
  put("codex/codex-channel.mjs", 'const VERSION = "0.17.1";');
  put("codex/aichat.config.json", JSON.stringify({ url: broker.replace("http", "ws") + "/ws", tokenFile: "missing.txt" }));
  put("claude/claude-channel.mjs", 'var VERSION = "2.0"; var VERSION3 = process.env.X || (true ? "0.20.0" : VERSION2);');
  put(
    "claude/.mcp.json",
    JSON.stringify({ mcpServers: { aichat: { command: "node", args: [join(root, "claude", "claude-channel.mjs")], env: { AICHAT_URL: broker, AICHAT_TOKEN: "tok-claude" } } } }),
  );
  put("opencode/.opencode/plugins/aichat-channel/index.js", 'var VERSION = true ? "0.18.0" : "0.0.0-dev";');
  put("opencode/aichat.config.json", JSON.stringify({ url: broker, tokenFile: "nope.txt" }));
  put("notes/readme.md", "not an agent");
  return root;
}

test("manager: finds the agents of every kind, their adapter versions, logs and adapter status", async (t) => {
  const broker = await fakeBroker();
  t.after(() => broker.server.close());
  const root = agentsFolder(t, broker.url);
  const found = discover(root);
  assert.deepEqual(
    found.map(({ agent: a }) => [a.folder, a.type, a.version, a.brokerUrl]),
    [
      ["agy", "agy", "0.19.0", broker.url],
      ["claude", "claude", "0.20.0", broker.url],
      ["codex", "codex", "0.17.1", broker.url],
      ["opencode", "opencode", "0.18.0", broker.url],
    ],
  );
  const agy = found[0];
  assert.deepEqual(agy.agent.logs, ["adapter.log"]);
  assert.equal(agy.secrets.token, "tok-agy");
  assert.deepEqual([agy.agent.status?.phase, agy.agent.status?.alive], ["waiting", true]);
  assert.equal(found[1].secrets.token, "tok-claude");
  assert.equal(found[2].secrets.token, undefined, "a token file that is not there");
  assert.equal(tail(join(root, "agy", ".aichat", "adapter.log"), 2), "two\nthree");
  assert.equal(brokerOrigin("wss://x.org/ws"), "https://x.org");
  assert.equal(adapterVersion(join(root, "nothing.mjs")), null);
});

test("manager: asks the broker who each agent is and how it is doing, and never passes a token on", async (t) => {
  const broker = await fakeBroker();
  t.after(() => broker.server.close());
  const root = agentsFolder(t, broker.url);
  const views = await overview(root);
  const by = Object.fromEntries(views.map((v) => [v.folder, v]));
  assert.equal(by.agy.name, "agy-bot");
  assert.deepEqual(by.agy.broker, {
    version: "0.20.0",
    online: true,
    activity: { state: "working", topic: "PR" },
    adapter: { name: "agy-channel", version: "0.19.0" },
  });
  assert.deepEqual([by.claude.name, by.claude.broker?.online], ["claude-bot", false]);
  assert.equal(by.codex.name, undefined, "no token: the broker is still asked for its version");
  assert.equal(by.codex.broker?.version, "0.20.0");
  assert.doesNotMatch(JSON.stringify(views), /tok-/);
});

test("manager: the page needs the printed key and its own host name; logs only from the list", async (t) => {
  const broker = await fakeBroker();
  t.after(() => broker.server.close());
  const root = agentsFolder(t, broker.url);
  const { server, url, key } = await startManager({ root, port: 0, key: "abc123" });
  t.after(() => server.close());
  const port = (server.address() as { port: number }).port;
  const get = (path: string, headers: Record<string, string> = {}) =>
    new Promise<{ status: number; headers: Record<string, unknown>; body: string }>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, path, headers }, (res) => {
        let body = "";
        res.on("data", (c) => (body += c)).on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body }));
      });
      req.on("error", reject).end();
    });
  assert.equal(url, `http://127.0.0.1:${port}/?key=${key}`);
  assert.equal((await get("/api/agents")).status, 401);
  assert.equal((await get("/?key=wrong")).status, 401);
  const login = await get(`/?key=${key}`);
  assert.equal(login.status, 302);
  assert.match(String(login.headers["set-cookie"]), /aichat_manager=abc123; HttpOnly; SameSite=Strict/);
  const cookie = { cookie: "aichat_manager=abc123" };
  assert.equal((await get("/api/agents", { ...cookie, host: `evil.example:${port}` })).status, 421);
  const page = await get("/", cookie);
  assert.equal(page.status, 200);
  assert.match(page.body, /Агенти AIChat/);
  const list = JSON.parse((await get("/api/agents", cookie)).body);
  assert.deepEqual(list.agents.map((a: { folder: string }) => a.folder), ["agy", "claude", "codex", "opencode"]);
  assert.deepEqual(JSON.parse((await get("/api/agents/agy/logs/adapter.log?lines=1", cookie)).body), { file: "adapter.log", text: "three" });
  assert.equal((await get("/api/agents/agy/logs/status.json", cookie)).status, 404);
  assert.equal((await get("/api/agents/agy/logs/..%2F..%2Fagy%2Ftoken.txt", cookie)).status, 404);
});

/**
 * A runner that only records what it was asked; `stop` makes the agent's process "exit", and an agent started in
 * the background "comes up" as this test process (or, with `dies`, exits at once).
 */
function fakeRunner(opts: { dies?: boolean } = {}) {
  const calls: string[] = [];
  const runner: Runner = {
    openTerminal: async (dir, title, command) => void calls.push(`terminal ${basename(dir)} ${title}: ${command}`),
    node: async (dir, args) => {
      calls.push(`node ${basename(dir)} ${basename(args[0])} ${args[1]}`);
      if (args[1] === "stop") writeFileSync(join(dir, ".aichat", "status.json"), JSON.stringify({ pid: 999999, phase: "stopped" }));
    },
    waitExit: async () => true,
    background: async (dir, args, logFile) => {
      calls.push(`background ${basename(dir)} ${basename(args[0])} ${args[1]} > ${basename(logFile)}`);
      if (opts.dies) return 999998;
      mkdirSync(join(dir, ".aichat"), { recursive: true });
      writeFileSync(join(dir, ".aichat", "status.json"), JSON.stringify({ pid: process.pid, phase: "starting" }));
      return process.pid;
    },
    alive: (pid) => pid === process.pid,
    sleep: async () => {},
  };
  return { calls, runner };
}

test("manager actions: update an adapter from the broker, keep the old one, restart a running agy agent", async (t) => {
  const broker = await fakeBroker();
  t.after(() => broker.server.close());
  const root = agentsFolder(t, broker.url);
  writeFileSync(join(root, "claude", "aichat-hook.mjs"), "old hook");
  const { calls, runner } = fakeRunner();
  const served: Record<string, string> = {
    "agy-channel.mjs": 'var VERSION = true ? "0.20.0" : "0.0.0-dev";',
    "claude-channel.mjs": 'var V = process.env.X || (true ? "0.20.0" : V2);',
    "aichat-hook.mjs": "new hook",
    "codex-channel.mjs": 'const VERSION = "0.19.0";',
  };
  const fetched: string[] = [];
  const actions = new Actions(root, runner, async (url) => {
    fetched.push(url.replace(broker.url, ""));
    return served[url.split("/").at(-1)!];
  });

  assert.match(await actions.update("agy", "0.20.0"), /0\.20\.0.*перезапущено/);
  assert.equal(adapterVersion(join(root, "agy", "agy-channel.mjs")), "0.20.0");
  assert.equal(adapterVersion(join(root, "agy", "agy-channel.mjs.bak-0.19.0")), "0.19.0");
  assert.deepEqual(calls, ["node agy agy-channel.mjs stop", "background agy agy-channel.mjs run > background.log"], "restarted in the background");

  // Claude Code: the hook goes along; no restart, it runs in a terminal
  assert.match(await actions.update("claude", "0.20.0"), /Перезапустіть агента в його терміналі/);
  assert.deepEqual(fetched.slice(-2), ["/client/claude-channel.mjs", "/client/aichat-hook.mjs"]);
  assert.equal(readFileSync(join(root, "claude", "aichat-hook.mjs"), "utf8"), "new hook");
  assert.equal(readFileSync(join(root, "claude", "aichat-hook.mjs.bak-old"), "utf8"), "old hook");

  // the broker serves another version than it says: nothing changes
  await assert.rejects(actions.update("codex", "0.20.0"), /завантажено 0\.19\.0, а брокер має 0\.20\.0/);
  assert.equal(adapterVersion(join(root, "codex", "codex-channel.mjs")), "0.17.1");
  assert.ok(!existsSync(join(root, "codex", "codex-channel.mjs.download")));
});

test("manager actions: start in a terminal or in the background, stop only what can stop, soft removal and restore", async (t) => {
  const broker = await fakeBroker();
  t.after(() => broker.server.close());
  const root = agentsFolder(t, broker.url);
  const { calls, runner } = fakeRunner();
  const actions = new Actions(root, runner);

  await actions.start("claude");
  await actions.start("opencode");
  writeFileSync(join(root, ".manager.json"), JSON.stringify({ start: { claude: "claude --continue --dangerously-load-development-channels server:aichat" } }));
  await actions.start("claude");
  assert.deepEqual(calls, [
    "terminal claude claude: claude --dangerously-load-development-channels server:aichat",
    "terminal opencode opencode: opencode",
    "terminal claude claude: claude --continue --dangerously-load-development-channels server:aichat",
  ]);
  await assert.rejects(actions.start("claude", true), /уже працює/);
  await assert.rejects(actions.start("agy"), /уже працює/, "its adapter process is alive");
  await assert.rejects(actions.stop("claude"), /закрийте його там/);
  await assert.rejects(actions.stop("codex"), /не запущений/);
  await assert.rejects(actions.start("../agy"), /немає такого агента/);
  calls.length = 0;
  assert.equal(await actions.start("codex"), `Агента запущено у фоні (pid ${process.pid}).`);
  assert.deepEqual(calls, ["background codex codex-channel.mjs run > background.log"]);
  await assert.rejects(actions.start("codex"), /уже працює/);

  // an interactive session: codex and agy attach over loopback when attachPort is set
  await assert.rejects(actions.session("codex"), /додайте attachPort/);
  writeFileSync(join(root, "codex", "aichat.config.json"), JSON.stringify({ url: broker.url, tokenFile: "missing.txt", attachPort: 60610 }));
  assert.match(await actions.session("codex"), /Відкрито сесію/);
  assert.equal(calls.at(-1), "terminal codex codex: сесія: node .\\codex-channel.mjs attach --config .\\aichat.config.json");
  await assert.rejects(actions.session("agy"), /додайте attachPort/);
  writeFileSync(join(root, "agy", "aichat.config.json"), JSON.stringify({ url: broker.url, tokenFile: "token.txt", attachPort: 60611 }));
  assert.match(await actions.session("agy"), /Відкрито сесію/);
  assert.equal(calls.at(-1), "terminal agy agy: сесія: node .\\agy-channel.mjs attach --config .\\aichat.config.json");
  await assert.rejects(actions.session("claude"), /не запущений/);

  await actions.stop("codex");
  await assert.rejects(actions.session("codex"), /не запущений/);
  await assert.rejects(new Actions(root, fakeRunner({ dies: true }).runner).start("codex"), /одразу завершився: дивіться лог background\.log/);

  assert.throws(() => actions.remove("codex", "codx", false), /введіть назву теки/);
  assert.throws(() => actions.remove("agy", "agy", false), /спершу зупиніть/);
  assert.throws(() => actions.remove("codex", "codex", true), /спершу зупиніть/, "the broker sees it online");
  assert.match(actions.remove("codex", "codex", false), /\.removed\\codex-\d{8}-\d{6}/);
  assert.ok(!existsSync(join(root, "codex")));
  const [gone] = actions.removed();
  assert.match(gone, /^codex-\d{8}-\d{6}$/);
  assert.deepEqual(discover(root).map((a) => a.agent.folder), ["agy", "claude", "opencode"], "out of the overview");
  mkdirSync(join(root, "codex"));
  assert.throws(() => actions.restore(gone), /уже є/);
  rmSync(join(root, "codex"), { recursive: true });
  assert.match(actions.restore(gone), /повернуто/);
  assert.equal(adapterVersion(join(root, "codex", "codex-channel.mjs")), "0.17.1");
  assert.deepEqual(actions.removed(), []);
});

test("manager: actions are POSTs with the manager's header", async (t) => {
  const broker = await fakeBroker();
  t.after(() => broker.server.close());
  const root = agentsFolder(t, broker.url);
  const { calls, runner } = fakeRunner();
  const { server } = await startManager({ root, port: 0, key: "ab12", runner });
  t.after(() => server.close());
  const port = (server.address() as { port: number }).port;
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    new Promise<{ status: number; body: { ok?: boolean; message?: string; error?: string } }>((resolve, reject) => {
      const req = request(
        { host: "127.0.0.1", port, path, method: "POST", headers: { cookie: "aichat_manager=ab12", "content-type": "application/json", ...headers } },
        (res) => {
          let text = "";
          res.on("data", (c) => (text += c)).on("end", () => resolve({ status: res.statusCode!, body: JSON.parse(text) }));
        },
      );
      req.on("error", reject).end(JSON.stringify(body));
    });
  assert.equal((await post("/api/agents/codex/start", {})).status, 403, "a form from another site has no such header");
  const h = { "x-aichat-manager": "1" };
  assert.deepEqual(await post("/api/agents/codex/start", {}, h), { status: 200, body: { ok: true, message: `Агента запущено у фоні (pid ${process.pid}).` } });
  assert.deepEqual(calls, ["background codex codex-channel.mjs run > background.log"]);
  assert.deepEqual(await post("/api/agents/codex/session", {}, h), { status: 400, body: { error: "додайте attachPort у aichat.config.json і перезапустіть агента" } });
  await post("/api/agents/codex/stop", {}, h);
  assert.equal((await post("/api/agents/agy/start", {}, h)).status, 409, "agy-bot is online");
  assert.equal((await post("/api/agents/codex/remove", { confirm: "x" }, h)).status, 400);
  assert.equal((await post("/api/agents/codex/remove", { confirm: "codex" }, h)).status, 200);
  assert.equal((await post("/api/agents/nobody/stop", {}, h)).status, 404);
});

test("manager settings: what each agent is set up for, from its own files, with no secret in the answer", async (t) => {
  const broker = await fakeBroker();
  t.after(() => broker.server.close());
  const root = agentsFolder(t, broker.url);
  const put = (rel: string, text: string) => {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), text);
  };
  put(
    "agy/aichat.config.json",
    JSON.stringify({ url: broker.url, tokenFile: "token.txt", addDirs: ["D:\\work"], mode: "accept-edits", sandbox: true, rooms: ["dev"], attachPort: 60620 }),
  );
  put("agy/.aichat/status.json", JSON.stringify({ pid: process.pid, start: "resumed", model: "gemini-x", effective: { network: false, mcp: [{ name: "aichat", state: "connected" }] } }));
  put("codex-home/config.toml", [
    'sandbox_mode = "workspace-write"',
    'model = "gpt-x" # the default',
    "[sandbox_workspace_write]",
    'writable_roots = [',
    '  "D:\\\\repo",',
    "]",
    "network_access = true",
    "[mcp_servers.github]",
    'command = "npx"',
    'env = { GITHUB_TOKEN = "ghp-secret-1" }',
    "[mcp_servers.docs]",
    'url = "https://docs.example/mcp?key=url-secret-2"',
    "enabled = false",
  ].join("\n"));
  put("codex/aichat.config.json", JSON.stringify({ url: broker.url, tokenFile: "missing.txt", codexHome: join(root, "codex-home"), maxBatch: 5 }));
  put("opencode/opencode.jsonc", [
    "{",
    '  "model": "litellm/main", // a comment',
    "  /* block */",
    '  "mcp": { "grafana": { "type": "remote", "url": "https://grafana.example//mcp", "headers": { "Authorization": "Bearer hdr-secret-3" } },',
    '           "gitlab": { "type": "local", "command": ["npx"], "disabled": true }, },',
    "}",
  ].join("\n"));

  const settingsOf = (folder: string) => readAgentSettings(discover(root).find((a) => a.agent.folder === folder)!.agent, root);
  const item = (s: ReturnType<typeof settingsOf>, section: string, key: string) =>
    s.sections.find((x) => x.id === section)?.items.find((i) => i.key === key);

  const agy = settingsOf("agy");
  assert.deepEqual(item(agy, "workspace", "addDirs")?.value, ["D:\\work"]);
  assert.equal(item(agy, "workspace", "effective.network")?.note, "фактично");
  assert.equal(item(agy, "connection", "tokenFile")?.note, "у файлі");
  assert.equal(item(agy, "launch", "attachPort")?.value, 60620);
  assert.equal(item(agy, "launch", "start")?.value, "resumed");
  assert.deepEqual(agy.mcp.find((m) => m.name === "aichat"), { name: "aichat", kind: "builtin", enabled: true, source: "адаптер (при старті сесії)", state: "connected", toggle: false });
  assert.equal(agy.restartNeeded, null, "no adapter.lock: the start time is unknown");

  const codex = settingsOf("codex");
  assert.equal(item(codex, "workspace", "sandbox_mode")?.value, "workspace-write");
  assert.deepEqual(item(codex, "workspace", "writable_roots")?.value, ["D:\\repo"]);
  assert.equal(item(codex, "workspace", "network_access")?.value, true);
  assert.equal(item(codex, "model", "model")?.value, "gpt-x");
  assert.equal(item(codex, "behavior", "maxBatch")?.value, 5);
  assert.equal(item(codex, "connection", "tokenFile")?.note, "файлу немає");
  assert.deepEqual(codex.mcp, [
    { name: "github", kind: "local", enabled: true, source: "config.toml", toggle: true },
    { name: "docs", kind: "remote", enabled: false, source: "config.toml", toggle: true },
  ]);

  const claude = settingsOf("claude");
  assert.equal(item(claude, "connection", "token")?.value, "у .mcp.json");
  assert.deepEqual(claude.mcp.filter((m) => m.source === ".mcp.json").map((m) => m.name), ["aichat"]);

  const opencode = settingsOf("opencode");
  assert.equal(item(opencode, "model", "model")?.value, "litellm/main");
  assert.deepEqual(opencode.mcp.map((m) => `${m.name}:${m.kind}:${m.enabled}`), ["grafana:remote:true", "gitlab:local:false"]);

  const everything = JSON.stringify([agy, codex, claude, opencode]);
  for (const secret of ["tok-agy", "tok-claude", "ghp-secret-1", "url-secret-2", "hdr-secret-3"]) assert.ok(!everything.includes(secret), secret);

  const { server } = await startManager({ root, port: 0, key: "abc456" });
  t.after(() => server.close());
  const port = (server.address() as { port: number }).port;
  const get = (path: string) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, path, headers: { cookie: "aichat_manager=abc456" } }, (res) => {
        let body = "";
        res.on("data", (c) => (body += c)).on("end", () => resolve({ status: res.statusCode!, body }));
      });
      req.on("error", reject).end();
    });
  const viaApi = await get("/api/agents/codex/settings");
  assert.equal(viaApi.status, 200);
  assert.equal(JSON.parse(viaApi.body).sections[0].id, "workspace");
  assert.equal((await get("/api/agents/nobody/settings")).status, 404);
});

test("manager settings: JSON with comments and a little TOML", () => {
  assert.deepEqual(parseJsonc('{ "a": "http://x//y", /* c */ "b": [1, 2,], // end\n }'), { a: "http://x//y", b: [1, 2] });
  assert.deepEqual(parseTomlLite('top = 1\n[t.x]\nk = "v" # c\narr = ["a", \'b\']\nbad = { x = 1 }\n'), { "": { top: 1 }, "t.x": { k: "v", arr: ["a", "b"] } });
});

test("manager settings: the page changes only what may be changed, checked first, with a backup", async (t) => {
  const broker = await fakeBroker();
  t.after(() => broker.server.close());
  const root = agentsFolder(t, broker.url);
  const configFile = join(root, "agy", "aichat.config.json");
  writeFileSync(configFile, JSON.stringify({ url: broker.url, tokenFile: "token.txt", owners: ["me"], wake: "always", attachPort: 60620 }, null, 2));
  writeFileSync(join(root, "codex", "aichat.config.json"), JSON.stringify({ url: broker.url, attachPort: 60610 }));
  const agents = () => discover(root).map((a) => a.agent);
  const agent = (folder: string) => agents().find((a) => a.folder === folder)!;
  const read = () => JSON.parse(readFileSync(configFile, "utf8"));

  const view = readAgentSettings(agent("agy"), root);
  const edits = Object.fromEntries(view.sections.flatMap((s) => s.items).filter((i) => i.edit).map((i) => [i.key, i.edit!.type]));
  assert.deepEqual(edits, {
    rooms: "list", wake: "enum", paused: "bool", maxWakesPerMinute: "int", sessionTitle: "text", delivery: "enum", session: "enum", command: "text", attachPort: "int", model: "text", tokenFile: "secret", addDirs: "dirs",
  });
  const claudeEdits = readAgentSettings(agent("claude"), root).sections.flatMap((s) => s.items).filter((i) => i.edit).map((i) => i.key);
  assert.deepEqual(claudeEdits.sort(), ["additionalDirectories", "command", "effort", "model", "token"]);

  assert.match(writeAgentSettings(agent("agy"), root, { wake: "mention", rooms: "#dev, lobby dev", attachPort: null, maxWakesPerMinute: "20" }, agents()), /Збережено/);
  assert.deepEqual(read(), { url: broker.url, tokenFile: "token.txt", owners: ["me"], wake: "mention", rooms: ["dev", "lobby"], maxWakesPerMinute: 20 });
  assert.equal(JSON.parse(readFileSync(configFile + ".bak", "utf8")).attachPort, 60620, "the previous file is kept");

  const before = readFileSync(configFile, "utf8");
  const fails = (set: unknown, field: string | undefined, why: RegExp) =>
    assert.throws(() => writeAgentSettings(agent("agy"), root, set, agents()), (e: Error & { field?: string }) => e.field === field && why.test(e.message));
  fails({ wake: "sometimes" }, "wake", /always, mention, never/);
  fails({ owners: ["someone"] }, "owners", /не змінюється/);
  fails({ paused: true, attachPort: 60610 }, "attachPort", /уже має codex/);
  fails({ attachPort: 80 }, "attachPort", /від 1024 до 65535/);
  fails({ rooms: ["ok", "not ok!"] }, "rooms", /назву кімнати/);
  fails({ sessionTitle: "two\nlines" }, "sessionTitle", /один рядок/);
  fails({ session: null }, "session", /потрібне значення/);
  fails({}, undefined, /немає змін/);
  assert.equal(readFileSync(configFile, "utf8"), before, "nothing is written when one value is wrong");

  writeAgentSettings(agent("claude"), root, { command: " .\\start.ps1 " }, agents());
  assert.deepEqual(JSON.parse(readFileSync(join(root, ".manager.json"), "utf8")), { start: { claude: ".\\start.ps1" } });
  writeAgentSettings(agent("claude"), root, { command: "" }, agents());
  assert.deepEqual(JSON.parse(readFileSync(join(root, ".manager.json"), "utf8")), { start: {} });
  assert.throws(() => writeAgentSettings(agent("claude"), root, { wake: "never" }, agents()), /не змінюється/);

  const { calls, runner } = fakeRunner();
  const { server } = await startManager({ root, port: 0, key: "abc789", runner });
  t.after(() => server.close());
  const port = (server.address() as { port: number }).port;
  const post = (path: string, body: unknown, header = true) =>
    new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
      const headers: Record<string, string> = { cookie: "aichat_manager=abc789", "content-type": "application/json" };
      if (header) headers["x-aichat-manager"] = "1";
      const req = request({ host: "127.0.0.1", port, path, method: "POST", headers }, (res) => {
        let text = "";
        res.on("data", (c) => (text += c)).on("end", () => resolve({ status: res.statusCode!, body: JSON.parse(text || "{}") }));
      });
      req.on("error", reject).end(JSON.stringify(body));
    });
  assert.equal((await post("/api/agents/agy/settings", { set: { wake: "never" } }, false)).status, 403);
  const ok = await post("/api/agents/agy/settings", { set: { wake: "never" } });
  assert.equal(ok.status, 200);
  assert.ok((ok.body.settings as { sections: unknown[] }).sections.length);
  assert.equal(read().wake, "never");
  const bad = await post("/api/agents/agy/settings", { set: { delivery: "fast" } });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.field, "delivery");
  // a running agy agent: save, stop, start again in the background
  const restarted = await post("/api/agents/agy/settings", { set: { paused: true }, restart: true });
  assert.equal(restarted.status, 200);
  assert.match(String(restarted.body.message), /Збережено: paused\. .*запущено у фоні/);
  assert.deepEqual(calls, ["node agy agy-channel.mjs stop", "background agy agy-channel.mjs run > background.log"]);
  // Claude Code lives in its terminal: the manager only says so
  const claude = await post("/api/agents/claude/settings", { set: { command: "claude" }, restart: true });
  assert.match(String(claude.body.message), /Перезапустіть агента там, де він працює/);
});

test("manager delivery: install checks the file against the broker's manifest, update replaces it and keeps a .bak", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "aichat-manager-self-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const build = (version: string) => Buffer.from(`var VERSION = true ? "${version}" : "0.0.0-dev"; // manager ${version}`);
  let served = build(MANAGER_VERSION);
  let manifest = () => ({ version: MANAGER_VERSION, files: { "aichat-manager.mjs": { sha256: sha256(served), size: served.length } } });
  const requested: string[] = [];
  const get = async (url: string) => {
    requested.push(url.replace("http://broker.test:8787", ""));
    if (url.endsWith("/client/manifest.json")) return Buffer.from(JSON.stringify(manifest()));
    if (url.endsWith("/client/aichat-manager.mjs")) return served;
    throw new Error("404 " + url);
  };
  // the install command downloads into <root>/.manager first
  mkdirSync(join(root, ".manager"));
  const self = join(root, ".manager", "aichat-manager.mjs");
  writeFileSync(self, served);

  await assert.rejects(install(root, "not a url", self, get), /потрібна адреса брокера/);
  const lines = await install(root, "ws://broker.test:8787/ws", self, get);
  assert.match(lines[0], new RegExp(`Менеджер ${MANAGER_VERSION.replace(/\./g, "\\.")} встановлено з http://broker.test:8787`));
  assert.deepEqual(JSON.parse(readFileSync(join(root, ".manager", "config.json"), "utf8")), { broker: "http://broker.test:8787" });
  assert.match(readFileSync(join(root, "aichat-manager.cmd"), "utf8"), /node "%~dp0\.manager\\aichat-manager\.mjs" %\*/);

  // a file that is not what the manifest names is refused
  writeFileSync(self, build(MANAGER_VERSION).toString() + " tampered");
  await assert.rejects(install(root, "http://broker.test:8787", self, get), /SHA-256 не збігається/);
  writeFileSync(self, served);

  const none = await updateInfo(root, null, get, self);
  assert.deepEqual([none.latest, none.updateAvailable, none.canUpdate], [MANAGER_VERSION, false, true]);

  served = build("99.0.0");
  manifest = () => ({ version: "99.0.0", files: { "aichat-manager.mjs": { sha256: sha256(served), size: served.length } } });
  const info = await updateInfo(root, null, get, self);
  assert.deepEqual([info.broker, info.latest, info.updateAvailable], ["http://broker.test:8787", "99.0.0", true]);
  assert.equal(await updateSelf(root, null, self, get), "99.0.0");
  assert.equal(readFileSync(self, "utf8"), served.toString());
  assert.equal(fileVersion(readFileSync(`${self}.bak-${MANAGER_VERSION}`, "utf8")), MANAGER_VERSION);
  await assert.rejects(updateSelf(root, null, null, get), /не з встановленого файлу/);

  // a broker whose file does not match its own manifest: nothing is replaced
  const before = readFileSync(self, "utf8");
  manifest = () => ({ version: "99.0.1", files: { "aichat-manager.mjs": { sha256: "0".repeat(64), size: 1 } } });
  await assert.rejects(updateSelf(root, null, self, get), /SHA-256/);
  assert.equal(readFileSync(self, "utf8"), before);
  assert.ok(requested.every((u) => u.startsWith("/client/")));

  // the page key outlives a restart
  const key = pageKey(root);
  assert.match(key, /^[0-9a-f]{32}$/);
  assert.equal(pageKey(root), key);
  assert.equal(installedFile("C:\\x\\dist\\manager\\server.js"), null);
});

test("manager wizard: connects an agent the broker already knows, with its token checked and kept apart", async (t) => {
  const broker = await fakeBroker(); // tok-agy belongs to agy-bot, tok-claude to claude-bot
  t.after(() => broker.server.close());
  const root = mkdtempSync(join(tmpdir(), "aichat-wizard-"));
  const secrets = mkdtempSync(join(tmpdir(), "aichat-secrets-"));
  t.after(() => [root, secrets].forEach((d) => rmSync(d, { recursive: true, force: true })));
  mkdirSync(join(root, ".manager"));
  writeFileSync(join(root, ".manager", "config.json"), JSON.stringify({ broker: broker.url }));
  const files: Record<string, Buffer> = {
    "agy-channel.mjs": Buffer.from("// agy"),
    "opencode-channel.js": Buffer.from("// opencode"),
    "claude-channel.mjs": Buffer.from("// claude"),
    "aichat-hook.mjs": Buffer.from("// hook"),
  };
  const manifest = () => ({ version: "9.9.9", files: Object.fromEntries(Object.entries(files).map(([n, d]) => [n, { sha256: sha256(d), size: d.length }])) });
  const get = async (url: string) => {
    if (url.endsWith("/client/manifest.json")) return Buffer.from(JSON.stringify(manifest()));
    const name = url.split("/client/")[1];
    if (files[name]) return files[name];
    throw new Error("404");
  };
  const runs: string[][] = [];
  let installerFails = false;
  const run = async (args: string[], cwd: string) => {
    runs.push(args.map((a) => a.replace(root, "<root>").replace(secrets, "<secrets>")));
    if (installerFails) return { code: 1, output: "boom" };
    writeFileSync(join(cwd, "aichat.config.json"), JSON.stringify({ url: "x", paused: true }));
    return { code: 0, output: "" };
  };
  const deps = { get, run, secretsDir: secrets };
  const tries = (req: Record<string, unknown>, field: string | undefined, why: RegExp) =>
    assert.rejects(installAgent(root, req, deps), (e: Error & { field?: string }) => e.field === field && why.test(e.message));

  await tries({ type: "gpt", name: "agy-bot", token: "tok-agy" }, "type", /тип/);
  await tries({ type: "agy", name: "bad name", token: "tok-agy" }, "name", /ім'я/);
  await tries({ type: "agy", name: "agy-bot", token: "" }, "token", /потрібен токен/);
  await tries({ type: "agy", name: "agy-bot", token: "nope" }, "token", /не прийняв/);
  await tries({ type: "agy", name: "agy-bot", token: "tok-claude" }, "token", /агента «claude-bot», а не «agy-bot»/);
  await tries({ type: "agy", name: "agy-bot", token: "tok-agy", profile: "antigravity-cli" }, "profile", /не antigravity-cli/);
  // a file that is not what the manifest names: nothing is written
  files["agy-channel.mjs"] = Buffer.from("// agy");
  const real = files["agy-channel.mjs"];
  const tampered = { ...deps, get: async (url: string) => (url.endsWith("agy-channel.mjs") ? Buffer.from("// evil") : get(url)) };
  await assert.rejects(installAgent(root, { type: "agy", name: "agy-bot", token: "tok-agy" }, tampered), /SHA-256/);
  assert.ok(!existsSync(join(root, "agy-bot")) && !existsSync(join(secrets, "aichat-agy-bot.token")));
  // the installer fails: what this run made is taken back
  installerFails = true;
  await assert.rejects(installAgent(root, { type: "agy", name: "agy-bot", token: "tok-agy" }, deps), /кодом 1: boom/);
  assert.ok(!existsSync(join(root, "agy-bot")) && !existsSync(join(secrets, "aichat-agy-bot.token")));
  installerFails = false;

  const agy = await installAgent(root, { type: "agy", name: "agy-bot", token: " tok-agy ", owners: "@alexey", rooms: "#dev lobby", attachPort: 60650 }, deps);
  assert.equal(agy.folder, "agy-bot");
  assert.equal(readFileSync(join(root, "agy-bot", "agy-channel.mjs"), "utf8"), real.toString());
  assert.equal(readFileSync(join(secrets, "aichat-agy-bot.token"), "utf8"), "tok-agy\n");
  assert.deepEqual(runs.at(-1), [
    join("<root>", "agy-bot", "agy-channel.mjs"), "install", "--dir", join("<root>", "agy-bot"), "--profile", "aichat-agy-bot",
    "--token-file", join("<secrets>", "aichat-agy-bot.token"), "--url", broker.url, "--owners", "alexey", "--rooms", "dev,lobby",
  ]);
  assert.equal(JSON.parse(readFileSync(join(root, "agy-bot", "aichat.config.json"), "utf8")).attachPort, 60650);
  assert.match(agy.next.join(" "), /зніміть паузу/i);
  assert.ok(!JSON.stringify(agy).includes("tok-agy"), "the token is not in the answer");
  await tries({ type: "agy", name: "agy-bot", token: "tok-agy" }, "name", /уже є/);

  // OpenCode: no installer; the wizard lays the files out itself
  const oc = await installAgent(root, { type: "opencode", name: "claude-bot", token: "tok-claude" }, deps);
  assert.equal(readFileSync(join(root, "claude-bot", ".opencode", "plugins", "aichat-channel", "index.js"), "utf8"), "// opencode");
  assert.deepEqual(JSON.parse(readFileSync(join(root, "claude-bot", "aichat.config.json"), "utf8")), {
    url: broker.url.replace("http", "ws") + "/ws", tokenFile: join(secrets, "aichat-claude-bot.token"), wake: "always", delivery: "steer", paused: true, session: "resume", rooms: [],
  });
  assert.equal(oc.steps.length, 4);

  const info = installInfo(root);
  assert.equal(info.broker, broker.url);
  assert.deepEqual(info.folders.sort(), ["agy-bot", "claude-bot"]);
  assert.equal(info.defaults.profile, "aichat-{name}");
  assert.equal(info.defaults.attachPort, 60610);
});

test("manager wizard: a failure after the installer also takes back the profile this run made (codex-alexey, 3413)", async (t) => {
  const broker = await fakeBroker(); // tok-agy belongs to agy-bot
  t.after(() => broker.server.close());
  const base = mkdtempSync(join(tmpdir(), "aichat-wizard-rollback-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, "root");
  mkdirSync(join(root, ".manager"), { recursive: true });
  writeFileSync(join(root, ".manager", "config.json"), JSON.stringify({ broker: broker.url }));
  const adapter = Buffer.from("// codex");
  const get = async (url: string) =>
    url.endsWith("manifest.json")
      ? Buffer.from(JSON.stringify({ version: "9.9.9", files: { "codex-channel.mjs": { sha256: sha256(adapter), size: adapter.length } } }))
      : adapter;
  let broken = true;
  // what codex-channel's installer does: a profile in --home and the agent's config; here the config comes out broken
  const run = async (args: string[], cwd: string) => {
    const home = args[args.indexOf("--home") + 1];
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "config.toml"), "# profile");
    writeFileSync(join(cwd, "aichat.config.json"), broken ? "{ not json" : "{}");
    return { code: 0, output: "" };
  };
  const deps = { get, run, secretsDir: join(base, "secrets"), home: base };
  const req = (codexHome: string) => ({ type: "codex", name: "agy-bot", token: "tok-agy", codexHome, attachPort: 60655 });

  // a CODEX_HOME this run made goes away whole
  const fresh = join(base, "codex-new");
  await assert.rejects(installAgent(root, req(fresh), deps));
  assert.ok(!existsSync(fresh) && !existsSync(join(root, "agy-bot")) && !existsSync(join(base, "secrets", "aichat-agy-bot.token")));
  // one that was there keeps everything but the config.toml this run wrote, so the wizard can be run again
  const old = join(base, "codex-old");
  mkdirSync(old);
  writeFileSync(join(old, "auth.json"), "{}");
  await assert.rejects(installAgent(root, req(old), deps));
  assert.deepEqual(readdirSync(old), ["auth.json"]);
  broken = false;
  const done = await installAgent(root, req(join(base, "it's-home")), deps);
  assert.match(done.next[0], /\$env:CODEX_HOME='.*it''s-home'; codex login/);
});

test("manager wizard: one installation at a time (codex-alexey, 3415)", async (t) => {
  const broker = await fakeBroker();
  t.after(() => broker.server.close());
  const root = mkdtempSync(join(tmpdir(), "aichat-wizard-one-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, ".manager"));
  writeFileSync(join(root, ".manager", "config.json"), JSON.stringify({ broker: broker.url }));
  const adapter = Buffer.from("// agy");
  const get = async (url: string) =>
    url.endsWith("manifest.json")
      ? Buffer.from(JSON.stringify({ version: "9.9.9", files: { "agy-channel.mjs": { sha256: sha256(adapter), size: adapter.length } } }))
      : adapter;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const run = async (_args: string[], cwd: string) => {
    await gate; // the first installer is still running
    writeFileSync(join(cwd, "aichat.config.json"), "{}");
    return { code: 0, output: "" };
  };
  const deps = { get, run, secretsDir: join(root, "secrets"), home: root };
  const first = installAgent(root, { type: "agy", name: "agy-bot", token: "tok-agy" }, deps);
  await new Promise((r) => setTimeout(r, 50));
  await assert.rejects(installAgent(root, { type: "agy", name: "claude-bot", token: "tok-claude" }, deps), /уже триває інше встановлення/);
  release();
  assert.equal((await first).folder, "agy-bot");
  // and the next one may go
  assert.equal((await installAgent(root, { type: "agy", name: "claude-bot", token: "tok-claude" }, deps)).folder, "claude-bot");
});

test("manager wizard: a Claude Code agent gets the start script that resumes its session (opencode-alexey, 3434)", async (t) => {
  const broker = await fakeBroker(); // tok-claude belongs to claude-bot
  t.after(() => broker.server.close());
  const root = mkdtempSync(join(tmpdir(), "aichat-wizard-claude-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, ".manager"));
  writeFileSync(join(root, ".manager", "config.json"), JSON.stringify({ broker: broker.url }));
  writeFileSync(join(root, ".manager.json"), JSON.stringify({ start: { other: "x" } }));
  const files: Record<string, Buffer> = { "claude-channel.mjs": Buffer.from("// claude"), "aichat-hook.mjs": Buffer.from("// hook") };
  const get = async (url: string) =>
    url.endsWith("manifest.json")
      ? Buffer.from(JSON.stringify({ version: "9.9.9", files: Object.fromEntries(Object.entries(files).map(([n, d]) => [n, { sha256: sha256(d), size: d.length }])) }))
      : files[url.split("/client/")[1]];
  // what claude-channel's installer does: the agent's .mcp.json naming the adapter
  const run = async (args: string[], cwd: string) => {
    writeFileSync(join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { aichat: { command: "node", args: [args[0]], env: { AICHAT_URL: "ws://x" } } } }));
    return { code: 0, output: "" };
  };
  const done = await installAgent(root, { type: "claude", name: "claude-bot", token: "tok-claude" }, { get, run, secretsDir: join(root, "secrets"), home: root });
  const script = readFileSync(join(root, "claude-bot", "start.ps1"), "utf8");
  assert.match(script, /\$env:AICHAT_START = if \(\$session\) \{ 'resumed' \} elseif \(\$ownSession\) \{ '' \} else \{ 'new' \}/);
  assert.match(script, /@\('--resume', \$session\.BaseName\)/);
  assert.match(script, /'\.aichat\\fresh'/);
  assert.ok(script.includes("\r\n"), "Windows line ends");
  // the command lives in .manager.json only (opencode-alexey, 3448): the script reads it from there, "claude" by default
  assert.match(script, /\$settings\.start\.\$folder/);
  assert.match(script, /\$command = 'claude'/);
  // quoted values stay whole; the channel flag and its value each once; a command's own session is kept (3453-3455)
  assert.match(script, /PSParser\]::Tokenize\(\$command/);
  assert.match(script, /elseif \(-not \$extra\.Contains\('server:aichat'\)\) \{ \$extra\.Insert\(\$flag \+ 1, 'server:aichat'\) \}/);
  assert.match(script, /\$_ -in '--resume', '-r', '--continue', '-c', '--session-id'/);
  assert.match(script, /Could not resume that session: starting a new one/);
  assert.deepEqual(JSON.parse(readFileSync(join(root, ".manager.json"), "utf8")), { start: { other: "x" } }, "the wizard writes no command");
  assert.match(done.steps.join(" "), /start\.ps1/);

  // the manager starts it through the script and shows the person's command, not the script
  const agent = discover(root).find((a) => a.agent.folder === "claude-bot")!.agent;
  assert.equal(startCommand(agent, readSettings(root)), ".\\start.ps1");
  const launch = readAgentSettings(agent, root).sections.find((s) => s.id === "launch")!.items;
  assert.equal(launch.find((i) => i.key === "command")?.value, "claude");
  assert.match(String(launch.find((i) => i.key === "startScript")?.value), /^start\.ps1 → claude --resume/);
  writeAgentSettings(agent, root, { command: "claude --model opus" }, [agent]);
  assert.equal(readAgentSettings(agent, root).sections.find((s) => s.id === "launch")!.items.find((i) => i.key === "command")?.value, "claude --model opus");
  assert.equal(startCommand(agent, readSettings(root)), ".\\start.ps1", "still the script, which reads the new command");
  // an old entry naming the script (claude-alexey's) means the default command
  writeFileSync(join(root, ".manager.json"), JSON.stringify({ start: { "claude-bot": ".\\start.ps1" } }));
  assert.equal(readAgentSettings(agent, root).sections.find((s) => s.id === "launch")!.items.find((i) => i.key === "command")?.value, "claude");
  // without a script: the command with the channel flags, once
  rmSync(join(root, "claude-bot", "start.ps1"));
  writeFileSync(join(root, ".manager.json"), JSON.stringify({ start: { "claude-bot": "claude --model opus" } }));
  assert.equal(startCommand(agent, readSettings(root)), "claude --model opus --dangerously-load-development-channels server:aichat");
});

test("manager settings: model and effort for every kind, each in its own place (alexey, 3447)", async (t) => {
  const broker = await fakeBroker();
  t.after(() => broker.server.close());
  const root = agentsFolder(t, broker.url);
  const codexHome = join(root, "codex-home");
  mkdirSync(codexHome);
  const toml = ['# my profile', 'sandbox_mode = "workspace-write"', "", "[mcp_servers.aichat]", 'command = "node"', ""].join("\n");
  writeFileSync(join(codexHome, "config.toml"), toml);
  writeFileSync(join(root, "codex", "aichat.config.json"), JSON.stringify({ url: broker.url, codexHome }));
  writeFileSync(join(root, "opencode", "aichat.config.json"), JSON.stringify({ url: broker.url, model: "litellm/main-model#high" }));
  const agent = (folder: string) => discover(root).find((a) => a.agent.folder === folder)!.agent;
  const items = (folder: string) => readAgentSettings(agent(folder), root).sections.find((s) => s.id === "model")!.items;
  const item = (folder: string, key: string) => items(folder).find((i) => i.key === key);

  // Claude: flags of the start command
  assert.equal(item("claude", "effort")?.edit?.type, "enum");
  writeAgentSettings(agent("claude"), root, { model: "opus", effort: "high" });
  assert.deepEqual(JSON.parse(readFileSync(join(root, ".manager.json"), "utf8")).start.claude, "claude --model opus --effort high");
  assert.deepEqual([item("claude", "model")?.value, item("claude", "effort")?.value], ["opus", "high"]);
  writeAgentSettings(agent("claude"), root, { model: "sonnet", effort: null });
  assert.equal(JSON.parse(readFileSync(join(root, ".manager.json"), "utf8")).start.claude, "claude --model sonnet");
  assert.throws(() => writeAgentSettings(agent("claude"), root, { effort: "huge" }), /одне з low, medium, high, xhigh, max/);
  assert.throws(() => writeAgentSettings(agent("claude"), root, { model: "opus; rm -rf" }), /лише літери/);

  // Codex: its config.toml, only the model lines change
  writeAgentSettings(agent("codex"), root, { model: "gpt-x", effort: "high" });
  let text = readFileSync(join(codexHome, "config.toml"), "utf8");
  assert.equal(text, ['# my profile', 'sandbox_mode = "workspace-write"', 'model = "gpt-x"', 'model_reasoning_effort = "high"', "", "[mcp_servers.aichat]", 'command = "node"', ""].join("\n"));
  assert.deepEqual([item("codex", "model")?.value, item("codex", "effort")?.value], ["gpt-x", "high"]);
  assert.deepEqual((item("codex", "effort")?.edit as { suggestions?: string[] }).suggestions, ["low", "medium", "high", "xhigh", "max", "ultra"]);
  writeAgentSettings(agent("codex"), root, { effort: null });
  text = readFileSync(join(codexHome, "config.toml"), "utf8");
  assert.ok(!text.includes("model_reasoning_effort") && text.includes('model = "gpt-x"') && text.includes("[mcp_servers.aichat]"));

  // OpenCode: one reference, provider/model#variant, in aichat.config.json (the plugin reads it every turn)
  assert.deepEqual([item("opencode", "model")?.value, item("opencode", "effort")?.value], ["litellm/main-model", "high"]);
  writeAgentSettings(agent("opencode"), root, { effort: "max" });
  assert.equal(JSON.parse(readFileSync(join(root, "opencode", "aichat.config.json"), "utf8")).model, "litellm/main-model#max");
  writeAgentSettings(agent("opencode"), root, { model: "other/m", effort: null });
  assert.equal(JSON.parse(readFileSync(join(root, "opencode", "aichat.config.json"), "utf8")).model, "other/m");
  assert.throws(() => writeAgentSettings(agent("opencode"), root, { model: "no-provider" }), /провайдер\/модель/);
  writeAgentSettings(agent("opencode"), root, { model: null });
  assert.equal(JSON.parse(readFileSync(join(root, "opencode", "aichat.config.json"), "utf8")).model, undefined);

  // agy: model in aichat.config.json
  writeAgentSettings(agent("agy"), root, { model: "gemini-x-high" });
  assert.equal(JSON.parse(readFileSync(join(root, "agy", "aichat.config.json"), "utf8")).model, "gemini-x-high");
  assert.equal(item("agy", "model")?.edit?.type, "text");

  // a Codex agent without its own CODEX_HOME: never the person's ~/.codex (Codex Desktop's profile; codex-alexey, 3463)
  writeFileSync(join(root, "codex", "aichat.config.json"), JSON.stringify({ url: broker.url }));
  assert.throws(() => writeAgentSettings(agent("codex"), root, { model: "gpt-y" }), (e: Error & { field?: string }) => e.field === "model" && /немає окремого codexHome/.test(e.message));
});

test("manager settings: command words and TOML lines", () => {
  assert.deepEqual(splitCommand('claude --add-dir "C:/My Dir" --model=opus'), ["claude", "--add-dir", "C:/My Dir", "--model=opus"]);
  assert.equal(joinCommand(withFlag(splitCommand('claude --add-dir "C:/My Dir" --model=opus'), "--model", "sonnet")), 'claude --add-dir "C:/My Dir" --model sonnet');
  assert.equal(flagValue(["claude", "--effort", "max"], "--effort"), "max");
  assert.equal(withTomlTop("", "model", "x"), 'model = "x"');
  // a quoted key is the same key: replaced, never a second one next to it
  assert.equal(withTomlTop('"model" = "old"\n[t]', "model", "new"), 'model = "new"\n[t]');
  assert.equal(withTomlTop("'model' = 'old'\n", "model", undefined), "");
  assert.equal(withTomlTop('a = 1\r\n[t]\r\nmodel = "in table"', "model", "top"), 'a = 1\r\nmodel = "top"\r\n[t]\r\nmodel = "in table"');
});

test("manager token: replaced only with one the broker gives this agent, written owner-only, never shown back (3c.1)", async (t) => {
  const broker = await fakeBroker();
  t.after(() => broker.server.close());
  const root = agentsFolder(t, broker.url);
  const secretsDir = join(root, "secrets");
  // who each token belongs to; "old-agy" stands for a revoked one
  const owners: Record<string, string> = { "tok-agy": "agy-bot", "new-agy": "agy-bot", "tok-claude": "claude-bot", "new-claude": "claude-bot", "for-codex": "codex" };
  const whoIs = async (_broker: string, token: string) => owners[token] ?? null;
  const found = (folder: string) => discover(root).find((a) => a.agent.folder === folder)!;
  const replace = (folder: string, token: unknown) => replaceToken(found(folder).agent, found(folder).secrets, token, { whoIs, secretsDir });
  const fails = (folder: string, token: unknown, why: RegExp) =>
    assert.rejects(replace(folder, token), (e: Error & { field?: string }) => e.field === "token" && why.test(e.message));

  await fails("agy", "", /потрібен новий токен/);
  await fails("agy", "two words", /без пробілів/);
  await fails("agy", "nobody", /не прийняв/);
  await fails("agy", "new-claude", /агента «claude-bot», а не «agy-bot»/);
  const message = await replace("agy", " new-agy ");
  assert.ok(!message.includes("new-agy"));
  assert.equal(readFileSync(join(root, "agy", "token.txt"), "utf8"), "new-agy\n");
  assert.ok(!existsSync(join(root, "agy", "token.txt.bak")) && !existsSync(join(root, "agy", "token.txt.tmp")), "no copy of a secret");

  // Claude Code with the token inline in .mcp.json: it moves into a file of its own, and a stale backup goes too
  writeFileSync(join(root, "claude", ".mcp.json.bak"), "old copy with tok-claude");
  assert.match(await replace("claude", "new-claude"), /перенесено з \.mcp\.json/);
  const mcpText = readFileSync(join(root, "claude", ".mcp.json"), "utf8");
  assert.ok(!mcpText.includes("tok-claude") && !mcpText.includes("new-claude"));
  const env = JSON.parse(mcpText).mcpServers.aichat.env;
  assert.deepEqual(env, { AICHAT_URL: broker.url, AICHAT_TOKEN_FILE: join(secretsDir, "aichat-claude.token").replace(/\\/g, "/") });
  assert.equal(readFileSync(join(secretsDir, "aichat-claude.token"), "utf8"), "new-claude\n");
  assert.ok(!existsSync(join(root, "claude", ".mcp.json.bak")));

  // the current token no longer works (that is why one replaces it): the folder's name is the agent's name
  writeFileSync(join(root, "codex", "aichat.config.json"), JSON.stringify({ url: broker.url }));
  assert.match(await replace("codex", "for-codex"), /aichat\.config\.json тепер посилається/);
  assert.equal(JSON.parse(readFileSync(join(root, "codex", "aichat.config.json"), "utf8")).tokenFile, join(secretsDir, "aichat-codex.token"));

  // the settings mark the token as write-only
  const tokenItem = readAgentSettings(found("agy").agent, root).sections.find((s) => s.id === "connection")!.items.find((i) => i.key === "tokenFile");
  assert.deepEqual(tokenItem?.edit, { type: "secret" });

  // through the page: the header is needed, and the answer never carries the token
  const { server } = await startManager({ root, port: 0, key: "abc0123", whoIs, secretsDir });
  t.after(() => server.close());
  const port = (server.address() as { port: number }).port;
  const post = (body: unknown, header = true) =>
    new Promise<{ status: number; text: string }>((resolve, reject) => {
      const headers: Record<string, string> = { cookie: "aichat_manager=abc0123", "content-type": "application/json" };
      if (header) headers["x-aichat-manager"] = "1";
      const req = request({ host: "127.0.0.1", port, path: "/api/agents/agy/token", method: "POST", headers }, (res) => {
        let text = "";
        res.on("data", (c) => (text += c)).on("end", () => resolve({ status: res.statusCode!, text }));
      });
      req.on("error", reject).end(JSON.stringify(body));
    });
  assert.equal((await post({ token: "tok-agy" }, false)).status, 403);
  const ok = await post({ token: "tok-agy" });
  assert.equal(ok.status, 200);
  assert.ok(!ok.text.includes("tok-agy"));
  const bad = await post({ token: "new-claude" });
  assert.equal(bad.status, 400);
  assert.equal(JSON.parse(bad.text).field, "token");
});

test("manager MCP: switched on and off in the agent's own file only, never AIChat's own (3c.2)", async (t) => {
  const broker = await fakeBroker();
  t.after(() => broker.server.close());
  const root = agentsFolder(t, broker.url);
  const agent = (folder: string) => discover(root).find((a) => a.agent.folder === folder)!.agent;
  const entry = (folder: string, name: string) => readAgentSettings(agent(folder), root).mcp.find((m) => m.name === name);

  // Claude Code: settings.local.json lists, .mcp.json untouched
  const mcpFile = join(root, "claude", ".mcp.json");
  const mcp = JSON.parse(readFileSync(mcpFile, "utf8"));
  mcp.mcpServers.docs = { command: "npx", args: ["docs-mcp"] };
  writeFileSync(mcpFile, JSON.stringify(mcp));
  mkdirSync(join(root, "claude", ".claude"));
  writeFileSync(join(root, "claude", ".claude", "settings.local.json"), JSON.stringify({ enabledMcpjsonServers: ["aichat", "docs"], hooks: { x: 1 } }));
  assert.equal(entry("claude", "aichat")?.toggle, false);
  assert.equal(entry("claude", "docs")?.toggle, true);
  assert.match(toggleMcp(agent("claude"), root, "docs", false), /docs вимкнено/);
  assert.deepEqual(JSON.parse(readFileSync(join(root, "claude", ".claude", "settings.local.json"), "utf8")), {
    enabledMcpjsonServers: ["aichat"], disabledMcpjsonServers: ["docs"], hooks: { x: 1 },
  });
  assert.equal(entry("claude", "docs")?.enabled, false);
  toggleMcp(agent("claude"), root, "docs", true);
  assert.equal(entry("claude", "docs")?.enabled, true);
  assert.throws(() => toggleMcp(agent("claude"), root, "aichat", false), /канал AIChat/);
  assert.throws(() => toggleMcp(agent("claude"), root, "nope", false), /немає MCP-сервера/);

  // Codex: enabled = false in its table of its own config.toml; other tables and comments as they were
  const home = join(root, "codex-home");
  mkdirSync(home);
  const toml = ["# profile", "[mcp_servers.aichat]", 'command = "node"', "", "[mcp_servers.github] # code", 'command = "npx"', "", "[tui]", "x = 1"].join("\n");
  writeFileSync(join(home, "config.toml"), toml);
  writeFileSync(join(root, "codex", "aichat.config.json"), JSON.stringify({ url: broker.url, codexHome: home }));
  toggleMcp(agent("codex"), root, "github", false);
  assert.equal(readFileSync(join(home, "config.toml"), "utf8"), toml.replace("[mcp_servers.github] # code\n", "[mcp_servers.github] # code\nenabled = false\n"));
  assert.equal(entry("codex", "github")?.enabled, false);
  toggleMcp(agent("codex"), root, "github", true);
  assert.equal(readFileSync(join(home, "config.toml"), "utf8"), toml);
  assert.throws(() => toggleMcp(agent("codex"), root, "aichat", false), /канал AIChat/);

  // OpenCode: "disabled" on the server object, comments kept
  const jsonc = [
    "{",
    '  "model": "litellm/m", // the model',
    '  "mcp": {',
    "    /* off on purpose */",
    '    "gitlab": { "type": "local", "command": ["npx"], "disabled": true },',
    '    "grafana": { "type": "remote", "url": "https://g/mcp" }',
    "  }",
    "}",
  ].join("\n");
  writeFileSync(join(root, "opencode", "opencode.jsonc"), jsonc);
  toggleMcp(agent("opencode"), root, "grafana", false);
  let text = readFileSync(join(root, "opencode", "opencode.jsonc"), "utf8");
  assert.ok(text.includes('"grafana": { "disabled": true, "type": "remote", "url": "https://g/mcp" }') && text.includes("/* off on purpose */") && text.includes("// the model"), text);
  toggleMcp(agent("opencode"), root, "gitlab", true);
  text = readFileSync(join(root, "opencode", "opencode.jsonc"), "utf8");
  assert.ok(text.includes('"gitlab": { "type": "local", "command": ["npx"], }') || text.includes('"gitlab": { "type": "local", "command": ["npx"] }'), text);
  assert.deepEqual(readAgentSettings(agent("opencode"), root).mcp.map((m) => `${m.name}:${m.enabled}`), ["gitlab:true", "grafana:false"]);

  // agy: its MCP file is shared by every agy profile
  assert.throws(() => toggleMcp(agent("agy"), root, "aichat", false), /канал AIChat/);
});

test("manager MCP: TOML table switch and JSONC edits by themselves", () => {
  assert.equal(withTomlServerEnabled('[mcp_servers."my server"]\nenabled = true\nx = 1', "my server", false), '[mcp_servers."my server"]\nenabled = false\nx = 1');
  assert.throws(() => withTomlServerEnabled("[tui]", "x", false), /немає \[mcp_servers\.x\]/);
  assert.equal(withJsoncServerDisabled('{"mcp":{"servers":{"a":{}}}}', "a", true), '{"mcp":{"servers":{"a":{ "disabled": true }}}}');
  assert.equal(withJsoncServerDisabled('{"mcp":{"a":{ "disabled": true }}}', "a", false), '{"mcp":{"a":{}}}');
  // a multi-line object: the flag is a line of its own, and taking it back leaves no stray comma
  const multi = '{\n  "type": "remote",\n  "url": "u",\n  "disabled": true\n}';
  assert.equal(withDisabledFlag(multi, false), '{\n  "type": "remote",\n  "url": "u"\n}');
  assert.equal(withDisabledFlag(withDisabledFlag(multi, false), true), '{\n  "disabled": true,\n  "type": "remote",\n  "url": "u"\n}');
  // OpenCode's older switch, "enabled": false, goes too: on means no flag at all, off means "disabled" only (3481)
  const legacy = '{\n  "type": "local",\n  "enabled": false\n}';
  assert.equal(withDisabledFlag(legacy, false), '{\n  "type": "local"\n}');
  assert.equal(withDisabledFlag(legacy, true), '{\n  "disabled": true,\n  "type": "local"\n}');
  assert.equal(withDisabledFlag('{ "enabled": false, "type": "local" }', false), '{ "type": "local" }');
});

test("manager folders: added only with the path typed twice, removed freely, each kind in its own file (3c.3)", async (t) => {
  const broker = await fakeBroker();
  t.after(() => broker.server.close());
  const root = agentsFolder(t, broker.url);
  const repo = join(root, "repo");
  const other = join(root, "other dir");
  mkdirSync(repo);
  mkdirSync(other);
  const agent = (folder: string) => discover(root).find((a) => a.agent.folder === folder)!.agent;
  const fails = (folder: string, change: Record<string, unknown>, field: string, why: RegExp) =>
    assert.throws(() => changeDirs(agent(folder), change), (e: Error & { field?: string }) => e.field === field && why.test(e.message));

  // agy: addDirs
  fails("agy", { add: "relative/dir", confirm: "relative/dir" }, "dirs", /повний шлях/);
  fails("agy", { add: join(root, "missing"), confirm: join(root, "missing") }, "dirs", /немає/);
  fails("agy", { add: repo }, "confirm", /ще раз|іще раз/);
  fails("agy", { add: repo, confirm: other }, "confirm", /іще раз/);
  assert.match(changeDirs(agent("agy"), { add: repo, confirm: repo }), /отримав доступ/);
  changeDirs(agent("agy"), { add: other, confirm: other });
  assert.deepEqual(JSON.parse(readFileSync(join(root, "agy", "aichat.config.json"), "utf8")).addDirs, [repo, other]);
  // the same folder written with a trailing slash (any OS; Windows also matches any case)
  fails("agy", { add: `${repo}/`, confirm: `${repo}/` }, "dirs", /уже у списку/);
  if (process.platform === "win32") fails("agy", { add: repo.toUpperCase(), confirm: repo.toUpperCase() }, "dirs", /уже у списку/);
  changeDirs(agent("agy"), { remove: repo });
  assert.deepEqual(JSON.parse(readFileSync(join(root, "agy", "aichat.config.json"), "utf8")).addDirs, [other]);
  const agyItem = readAgentSettings(agent("agy"), root).sections.find((s) => s.id === "workspace")!.items.find((i) => i.key === "addDirs");
  assert.deepEqual([agyItem?.value, agyItem?.edit], [[other], { type: "dirs" }]);

  // Codex: writable_roots in [sandbox_workspace_write]; a warning when its mode makes them moot
  const home = join(root, "codex-home");
  mkdirSync(home);
  writeFileSync(join(home, "config.toml"), 'sandbox_mode = "read-only"\n\n[tui]\nx = 1\n');
  writeFileSync(join(root, "codex", "aichat.config.json"), JSON.stringify({ url: broker.url, codexHome: home }));
  assert.match(changeDirs(agent("codex"), { add: other, confirm: other }), /пісочниця Codex зараз «read-only»/);
  let toml = readFileSync(join(home, "config.toml"), "utf8");
  assert.ok(toml.startsWith('sandbox_mode = "read-only"\n\n[tui]\nx = 1\n\n[sandbox_workspace_write]\nwritable_roots = ['), toml);
  assert.deepEqual(parseTomlLite(toml)["sandbox_workspace_write"].writable_roots, [other]);
  changeDirs(agent("codex"), { add: repo, confirm: repo });
  assert.deepEqual(parseTomlLite(readFileSync(join(home, "config.toml"), "utf8"))["sandbox_workspace_write"].writable_roots, [other, repo]);
  changeDirs(agent("codex"), { remove: other });
  changeDirs(agent("codex"), { remove: repo });
  toml = readFileSync(join(home, "config.toml"), "utf8");
  assert.ok(!toml.includes("writable_roots") && toml.includes("[tui]"));

  // Claude Code: permissions.additionalDirectories, other permissions kept
  mkdirSync(join(root, "claude", ".claude"));
  writeFileSync(join(root, "claude", ".claude", "settings.local.json"), JSON.stringify({ permissions: { allow: ["Read"] } }));
  changeDirs(agent("claude"), { add: repo, confirm: repo });
  assert.deepEqual(JSON.parse(readFileSync(join(root, "claude", ".claude", "settings.local.json"), "utf8")).permissions, { allow: ["Read"], additionalDirectories: [repo] });

  // OpenCode: no sandbox, nothing to pretend
  fails("opencode", { add: repo, confirm: repo }, "dirs", /не має пісочниці/);
});

test("manager folders: a TOML table's array, set or removed", () => {
  assert.equal(withTomlTableArray("", "t", "k", ["a"]), '\n[t]\nk = ["a"]\n');
  assert.equal(withTomlTableArray('[t]\nk = [\n  "a",\n]\ny = 1', "t", "k", ["b"]), '[t]\nk = ["b"]\ny = 1');
  assert.equal(withTomlTableArray('[t]\nk = ["a"]\n[u]', "t", "k", []), "[t]\n[u]");
});

test("manager settings: an OpenCode model with its level pasted in says where the level goes", async (t) => {
  const broker = await fakeBroker();
  t.after(() => broker.server.close());
  const root = agentsFolder(t, broker.url);
  const agent = discover(root).find((a) => a.agent.folder === "opencode")!.agent;
  assert.throws(() => writeAgentSettings(agent, root, { model: "litellm/main-model#high" }), (e: Error & { field?: string }) => e.field === "model" && /у полі Effort/.test(e.message));
});
