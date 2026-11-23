import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { Actions, type Runner } from "../manager/actions.js";
import { adapterVersion, brokerOrigin, discover, tail } from "../manager/agents.js";
import { overview, startManager } from "../manager/server.js";

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

/** A runner that only records what it was asked; `stop` makes the agy agent's process "exit". */
function fakeRunner() {
  const calls: string[] = [];
  const runner: Runner = {
    openTerminal: async (dir, title, command) => void calls.push(`terminal ${basename(dir)} ${title}: ${command}`),
    node: async (dir, args) => {
      calls.push(`node ${basename(dir)} ${basename(args[0])} ${args[1]}`);
      if (args[1] === "stop") writeFileSync(join(dir, ".aichat", "status.json"), JSON.stringify({ pid: 999999, phase: "stopped" }));
    },
    waitExit: async () => true,
  };
  return { calls, runner };
}

test("manager actions: update an adapter from the broker, keep the old one, restart a running agy agent", async (t) => {
  const broker = await fakeBroker();
  t.after(() => broker.server.close());
  const root = agentsFolder(t, broker.url);
  writeFileSync(join(root, "agy", "start.ps1"), "node agy-channel.mjs run");
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
  assert.deepEqual(calls, ["node agy agy-channel.mjs stop", "terminal agy agy: .\\start.ps1"]);

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

test("manager actions: start in a terminal, stop only what can stop, soft removal and restore", async (t) => {
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
  assert.deepEqual(await post("/api/agents/codex/start", {}, h), { status: 200, body: { ok: true, message: "Відкрито термінал з агентом." } });
  assert.deepEqual(calls, ["terminal codex codex: node .\\codex-channel.mjs run --config .\\aichat.config.json"]);
  assert.equal((await post("/api/agents/agy/start", {}, h)).status, 409, "agy-bot is online");
  assert.equal((await post("/api/agents/codex/remove", { confirm: "x" }, h)).status, 400);
  assert.equal((await post("/api/agents/codex/remove", { confirm: "codex" }, h)).status, 200);
  assert.equal((await post("/api/agents/nobody/stop", {}, h)).status, 404);
});
