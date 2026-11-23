import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
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
