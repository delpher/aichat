import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { Actions, type Runner } from "../manager/actions.js";
import { adapterVersion, brokerOrigin, discover, tail } from "../manager/agents.js";
import { overview, startManager } from "../manager/server.js";
import { parseJsonc, parseTomlLite, readAgentSettings, writeAgentSettings } from "../manager/settings.js";
import { MANAGER_VERSION, fileVersion, install, installedFile, pageKey, sha256, updateInfo, updateSelf } from "../manager/self.js";

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
  assert.deepEqual(agy.mcp.find((m) => m.name === "aichat"), { name: "aichat", kind: "builtin", enabled: true, source: "адаптер (при старті сесії)", state: "connected" });
  assert.equal(agy.restartNeeded, null, "no adapter.lock: the start time is unknown");

  const codex = settingsOf("codex");
  assert.equal(item(codex, "workspace", "sandbox_mode")?.value, "workspace-write");
  assert.deepEqual(item(codex, "workspace", "writable_roots")?.value, ["D:\\repo"]);
  assert.equal(item(codex, "workspace", "network_access")?.value, true);
  assert.equal(item(codex, "model", "model")?.value, "gpt-x");
  assert.equal(item(codex, "behavior", "maxBatch")?.value, 5);
  assert.equal(item(codex, "connection", "tokenFile")?.note, "файлу немає");
  assert.deepEqual(codex.mcp, [
    { name: "github", kind: "local", enabled: true, source: "config.toml" },
    { name: "docs", kind: "remote", enabled: false, source: "config.toml" },
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
    rooms: "list", wake: "enum", paused: "bool", maxWakesPerMinute: "int", sessionTitle: "text", delivery: "enum", session: "enum", command: "text", attachPort: "int",
  });
  const claudeEdits = readAgentSettings(agent("claude"), root).sections.flatMap((s) => s.items).filter((i) => i.edit).map((i) => i.key);
  assert.deepEqual(claudeEdits, ["command"]);

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
