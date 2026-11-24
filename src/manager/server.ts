// The local agent manager's web page (alexey, AIChat 3145-3149). Listens only on 127.0.0.1 and asks for a key that
// it prints at start, so other sites open in the same browser cannot read it. Actions (update, start, stop, session, remove)
// are POSTs that also need the header x-aichat-manager, which a page on another site cannot send here.
//   npm run manager -- [--root <folder of agents>] [--port 8790]
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Actions, ActionError, type Runner } from "./actions.js";
import { discover, tail, type LocalAgent } from "./agents.js";
import { PAGE } from "./page.js";
import { readAgentSettings, SettingError, writeAgentSettings } from "./settings.js";
import { replaceToken } from "./token.js";
import { toggleMcp } from "./mcp.js";
import { changeDirs } from "./dirs.js";
import { installAgent, installInfo, type NodeRunner } from "./wizard.js";
import { fetchBytes, install, installedFile, openInBrowser, pageKey, updateInfo, updateSelf, type Fetch } from "./self.js";
import { spawn } from "node:child_process";
import type { AdapterInfo } from "../protocol.js";

export interface ManagerOptions {
  root: string;
  port: number;
  /** Fixed key for tests; a random one otherwise. */
  key?: string;
  /** Time limit for each request to a broker. */
  brokerTimeoutMs?: number;
  /** For tests: how terminals and adapter commands run, and how adapters are downloaded. */
  runner?: Runner;
  fetchText?: (url: string) => Promise<string>;
  /** For tests: how the manager downloads itself, which file it runs from, and how it restarts after an update. */
  fetchBytes?: Fetch;
  self?: string | null;
  onRestart?: () => void;
  /** For tests: how the agent wizard runs adapter installers and where it keeps tokens. */
  runNode?: NodeRunner;
  secretsDir?: string;
  /** For tests: who a token belongs to at the broker. */
  whoIs?: (broker: string, token: string) => Promise<string | null>;
}

/** What the broker says about one agent (GET /api/agents), by its AIChat name. */
interface BrokerAgent {
  name: string;
  online: boolean;
  activity?: { state?: string; topic?: string; since?: string };
  adapter?: Partial<AdapterInfo>;
}

export interface AgentView extends LocalAgent {
  /** The AIChat name the agent's token belongs to (GET /api/me). */
  name?: string;
  broker?: { version?: string; online?: boolean; activity?: BrokerAgent["activity"]; adapter?: BrokerAgent["adapter"]; error?: string };
}

async function getJson<T>(url: string, token: string | undefined, timeoutMs: number): Promise<T> {
  const res = await fetch(url, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

/** Every agent in `root` with what its broker says about it; one /health and one /api/agents per broker. */
export async function overview(root: string, timeoutMs = 3000): Promise<AgentView[]> {
  const found = discover(root);
  const brokers = new Map<string, Promise<{ version?: string; agents?: BrokerAgent[]; error?: string }>>();
  const brokerInfo = (url: string, token: string | undefined) => {
    if (!brokers.has(url))
      brokers.set(
        url,
        (async () => {
          try {
            const { version } = await getJson<{ version?: string }>(`${url}/health`, undefined, timeoutMs);
            const agents = token ? (await getJson<{ agents: BrokerAgent[] }>(`${url}/api/agents`, token, timeoutMs)).agents : undefined;
            return { version, agents };
          } catch (e) {
            return { error: (e as Error).message };
          }
        })(),
      );
    return brokers.get(url)!;
  };
  return Promise.all(
    found.map(async ({ agent, secrets }): Promise<AgentView> => {
      const view: AgentView = { ...agent };
      if (!agent.brokerUrl) return view;
      const info = await brokerInfo(agent.brokerUrl, secrets.token);
      if (info.error) return { ...view, broker: { error: info.error } };
      if (secrets.token) {
        try {
          view.name = (await getJson<{ name: string }>(`${agent.brokerUrl}/api/me`, secrets.token, timeoutMs)).name;
        } catch (e) {
          return { ...view, broker: { version: info.version, error: `токен: ${(e as Error).message}` } };
        }
      }
      const b = info.agents?.find((a) => a.name === view.name);
      view.broker = { version: info.version, online: b?.online, activity: b?.activity, adapter: b?.adapter };
      return view;
    }),
  );
}

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function startManager(opts: ManagerOptions): Promise<{ server: Server; url: string; key: string }> {
  const key = opts.key ?? randomBytes(16).toString("hex");
  const timeout = opts.brokerTimeoutMs ?? 3000;
  const actions = new Actions(opts.root, opts.runner, opts.fetchText);
  const get = opts.fetchBytes ?? fetchBytes;
  const self = opts.self === undefined ? installedFile() : opts.self;
  // the broker to update from when the manager was not installed with --broker: the one its agents use
  const firstBroker = () => discover(opts.root).find((a) => a.agent.brokerUrl)?.agent.brokerUrl ?? null;
  const readBody = (req: IncomingMessage) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      let raw = "";
      req.on("data", (c) => {
        raw += c;
        if (raw.length > 4096) req.destroy(new Error("body too large"));
      });
      req.on("end", () => {
        try {
          resolve(raw ? (JSON.parse(raw) as Record<string, unknown>) : {});
        } catch {
          reject(new ActionError("bad JSON", 400));
        }
      });
      req.on("error", reject);
    });
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const send = (status: number, body: unknown, type = "application/json; charset=utf-8", headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff", ...headers });
      res.end(typeof body === "string" ? body : JSON.stringify(body));
    };
    try {
      // another site's page cannot reach 127.0.0.1 under its own name (DNS rebinding)
      const port = (server.address() as { port: number }).port;
      if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host ?? "")) return send(421, { error: "wrong host" });
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
      const cookie = /(?:^|;\s*)aichat_manager=([0-9a-f]+)/.exec(req.headers.cookie ?? "")?.[1] ?? "";
      const given = url.searchParams.get("key") ?? "";
      if (req.method === "GET" && url.pathname === "/" && given && same(given, key))
        // the key moves into a cookie and out of the address bar
        return send(302, "", "text/plain", {
          location: "/",
          "set-cookie": `aichat_manager=${key}; HttpOnly; SameSite=Strict; Path=/`,
        });
      if (!same(cookie, key)) return send(401, "Відкрийте посилання з ключем, яке менеджер надрукував при запуску.", "text/plain; charset=utf-8");
      if (req.method === "POST") {
        // a page on another site may post a form here, but cannot add this header without our consent (CORS)
        if (req.headers["x-aichat-manager"] !== "1") return send(403, { error: "missing x-aichat-manager header" });
        const body = await readBody(req);
        if (url.pathname === "/api/install") {
          const done = await installAgent(opts.root, body, { get, run: opts.runNode, secretsDir: opts.secretsDir });
          return send(200, { ok: true, ...done });
        }
        if (url.pathname === "/api/manager/update") {
          const version = await updateSelf(opts.root, firstBroker(), self, get).catch((e: Error) => {
            throw new ActionError(e.message, 502);
          });
          // answer first, then hand over to the new file
          res.once("finish", () => setTimeout(() => opts.onRestart?.(), 100));
          return send(200, { ok: true, message: `Менеджер оновлено до ${version}, стара версія збережена поруч (.bak). Перезапускаюсь…` });
        }
        const folders = /^\/api\/agents\/([^/]+)\/dirs$/.exec(url.pathname);
        if (folders) {
          const agent = discover(opts.root).find((a) => a.agent.folder === decodeURIComponent(folders[1]))?.agent;
          if (!agent) return send(404, { error: "немає такого агента" });
          const message = changeDirs(agent, body);
          return send(200, { ok: true, message, settings: readAgentSettings(agent, opts.root) });
        }
        const switchMcp = /^\/api\/agents\/([^/]+)\/mcp$/.exec(url.pathname);
        if (switchMcp) {
          const agent = discover(opts.root).find((a) => a.agent.folder === decodeURIComponent(switchMcp[1]))?.agent;
          if (!agent) return send(404, { error: "немає такого агента" });
          const message = toggleMcp(agent, opts.root, body.name, body.enabled);
          return send(200, { ok: true, message, settings: readAgentSettings(agent, opts.root) });
        }
        const replace = /^\/api\/agents\/([^/]+)\/token$/.exec(url.pathname);
        if (replace) {
          const found = discover(opts.root).find((a) => a.agent.folder === decodeURIComponent(replace[1]));
          if (!found) return send(404, { error: "немає такого агента" });
          const message = await replaceToken(found.agent, found.secrets, body.token, { whoIs: opts.whoIs, secretsDir: opts.secretsDir });
          // the token itself never goes back: only what was done
          return send(200, { ok: true, message });
        }
        const save = /^\/api\/agents\/([^/]+)\/settings$/.exec(url.pathname);
        if (save) {
          const all = discover(opts.root).map((a) => a.agent);
          const agent = all.find((a) => a.folder === decodeURIComponent(save[1]));
          if (!agent) return send(404, { error: "немає такого агента" });
          let message = writeAgentSettings(agent, opts.root, body.set, all);
          // codex and agy run in the background, so the manager can restart them; the others restart in their terminal
          if (body.restart === true && (agent.type === "codex" || agent.type === "agy") && agent.status?.alive) {
            await actions.stop(agent.folder);
            message += " " + (await actions.start(agent.folder));
          } else if (body.restart === true) message += " Перезапустіть агента там, де він працює.";
          const fresh = discover(opts.root).find((a) => a.agent.folder === agent.folder)!.agent;
          return send(200, { ok: true, message, settings: readAgentSettings(fresh, opts.root) });
        }
        const act =/^\/api\/agents\/([^/]+)\/(start|stop|session|update|remove)$/.exec(url.pathname);
        if (act) {
          const folder = decodeURIComponent(act[1]);
          const view = (await overview(opts.root, timeout)).find((a) => a.folder === folder);
          if (!view) return send(404, { error: "немає такого агента" });
          const online = view.broker?.online;
          const done =
            act[2] === "start"
              ? await actions.start(folder, online)
              : act[2] === "stop"
                ? await actions.stop(folder, online)
                : act[2] === "session"
                  ? await actions.session(folder, online)
                  : act[2] === "update"
                  ? await actions.update(folder, view.broker?.version)
                  : actions.remove(folder, String(body.confirm ?? ""), online);
          return send(200, { ok: true, message: done });
        }
        const restore = /^\/api\/removed\/([^/]+)\/restore$/.exec(url.pathname);
        if (restore) return send(200, { ok: true, message: actions.restore(decodeURIComponent(restore[1])) });
        return send(404, { error: "not found" });
      }
      if (req.method !== "GET") return send(405, { error: "method not allowed" });
      if (url.pathname === "/api/removed") return send(200, { removed: actions.removed() });
      if (url.pathname === "/") return send(200, PAGE, "text/html; charset=utf-8", { "content-security-policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'" });
      if (url.pathname === "/api/install") return send(200, installInfo(opts.root));
      if (url.pathname === "/api/manager") return send(200, await updateInfo(opts.root, firstBroker(), get, self));
      if (url.pathname === "/api/agents") return send(200, { root: opts.root, agents: await overview(opts.root, timeout) });
      const settings = /^\/api\/agents\/([^/]+)\/settings$/.exec(url.pathname);
      if (settings) {
        const agent = discover(opts.root).find((a) => a.agent.folder === decodeURIComponent(settings[1]))?.agent;
        if (!agent) return send(404, { error: "немає такого агента" });
        return send(200, readAgentSettings(agent, opts.root));
      }
      const log = /^\/api\/agents\/([^/]+)\/logs\/([^/]+)$/.exec(url.pathname);
      if (log) {
        const [folder, file] = [decodeURIComponent(log[1]), decodeURIComponent(log[2])];
        const agent = discover(opts.root).find((a) => a.agent.folder === folder)?.agent;
        // only a log the overview listed: never a path of the caller's choosing
        if (!agent || !agent.logs.includes(file)) return send(404, { error: "no such log" });
        const lines = Math.min(Math.max(Number(url.searchParams.get("lines")) || 200, 1), 2000);
        return send(200, { file, text: tail(join(agent.dir, ".aichat", file), lines) });
      }
      return send(404, { error: "not found" });
    } catch (e) {
      return send(e instanceof ActionError ? e.status : 500, { error: (e as Error).message, ...(e instanceof SettingError && e.field ? { field: e.field } : {}) });
    }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolve({ server, url: `http://127.0.0.1:${port}/?key=${key}`, key });
    });
  });
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

/** Listens on `port`; after a self-update the old process may still hold it for a moment. */
async function startWithRetry(opts: ManagerOptions, tries = 20) {
  for (let n = 1; ; n++) {
    try {
      return await startManager(opts);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EADDRINUSE" || n >= tries) throw e;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const root = resolve(arg("root") ?? join(homedir(), "aichat-agents"));
  const port = Number(arg("port") ?? 8790);
  const command = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "run";
  (async () => {
    if (command === "install") {
      const broker = arg("broker");
      if (!broker) throw new Error("потрібно --broker <адреса брокера>");
      for (const line of await install(root, broker, installedFile())) console.log(line);
    } else if (command !== "run") throw new Error(`невідома команда «${command}»: run або install`);
    const key = pageKey(root);
    let server: Server | undefined;
    // after a self-update: the new file takes over in this same console, this process waits for it and leaves with it
    const onRestart = () => {
      server?.close();
      const child = spawn(process.execPath, process.argv.slice(1).filter((a, i, all) => a !== "install" && all[i - 1] !== "--broker" && a !== "--broker"), {
        stdio: "inherit",
      });
      child.on("exit", (code) => process.exit(code ?? 0));
    };
    const started = await startWithRetry({ root, port, key, onRestart });
    server = started.server;
    console.log(`Менеджер агентів AIChat: ${started.url}\nТека агентів: ${root}`);
    // a fresh install opens the page at once, where there is a desktop to open it on
    if (command === "install" && !process.argv.includes("--no-open")) openInBrowser(started.url);
  })().catch((e) => {
    console.error(`Не вдалося запустити менеджер: ${(e as Error).message}`);
    process.exit(1);
  });
}
