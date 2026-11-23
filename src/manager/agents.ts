// The local agent manager (alexey, AIChat 3145-3149): finds the AIChat agents installed in one folder on this
// computer, reads what their adapters say about themselves and asks the broker how they are doing. Read-only.
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export type AgentType = "claude" | "codex" | "agy" | "opencode";

/** What the adapter of a running agent wrote about itself (agy and codex keep .aichat/status.json). */
export interface AdapterStatus {
  pid?: number;
  /** The process is still there. */
  alive?: boolean;
  phase?: string;
  connected?: boolean;
  updatedAt?: string;
  version?: string;
}

/** One agent folder as the manager shows it; never holds the token. */
export interface LocalAgent {
  folder: string;
  dir: string;
  type: AgentType;
  /** The adapter file and the version written in it. */
  adapterFile: string;
  version: string | null;
  /** Broker address from the agent's own configuration (http origin). */
  brokerUrl: string | null;
  /** Log files the page may show (names inside .aichat). */
  logs: string[];
  status?: AdapterStatus;
  /** codex: the App Server port an interactive `codex resume` can attach to (`attachPort` in its config). */
  attachPort?: number;
}

/** Where the agent's token is, kept apart so it never reaches the page. */
export interface AgentSecrets {
  token?: string;
}

const readJson = (file: string): Record<string, unknown> | null => {
  try {
    return JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, "")) as Record<string, unknown>;
  } catch {
    return null;
  }
};

const expand = (p: string, base: string) => {
  const home = p === "~" || p.startsWith("~/") || p.startsWith("~\\") ? join(homedir(), p.slice(1)) : p;
  return isAbsolute(home) ? home : resolve(base, home);
};

/** The version built into an adapter file: bundles carry `true ? "x.y.z"`, plain sources `VERSION = "x.y.z"`. */
export function adapterVersion(file: string): string | null {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  return (/\btrue \? "(\d+\.\d+\.\d+[\w.-]*)"/.exec(text) ?? /\bVERSION = "(\d+\.\d+\.\d+[\w.-]*)"/.exec(text))?.[1] ?? null;
}

/** "http://aichat.home:8787/" or "ws://…" as an http origin. */
export function brokerOrigin(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const u = new URL(raw);
    u.protocol = u.protocol === "https:" || u.protocol === "wss:" ? "https:" : "http:";
    return u.origin;
  } catch {
    return null;
  }
}

/** The adapter and its configuration in `dir`, or null when it holds no agent the manager knows. */
export function readAgent(dir: string): { agent: LocalAgent; secrets: AgentSecrets } | null {
  const folder = dir.split(/[\\/]/).filter(Boolean).at(-1)!;
  const at = (...p: string[]) => join(dir, ...p);
  let type: AgentType;
  let adapterFile: string;
  let url: unknown;
  let token: string | undefined;
  const config = readJson(at("aichat.config.json"));
  const tokenFromFile = (file: unknown) => {
    if (typeof file !== "string" || !file) return undefined;
    try {
      return readFileSync(expand(file, dir), "utf8").trim() || undefined;
    } catch {
      return undefined;
    }
  };
  if (existsSync(at("agy-channel.mjs"))) [type, adapterFile] = ["agy", at("agy-channel.mjs")];
  else if (existsSync(at("codex-channel.mjs"))) [type, adapterFile] = ["codex", at("codex-channel.mjs")];
  else if (existsSync(at(".opencode", "plugins", "aichat-channel", "index.js")))
    [type, adapterFile] = ["opencode", at(".opencode", "plugins", "aichat-channel", "index.js")];
  else {
    // Claude Code: the MCP server in .mcp.json that runs claude-channel
    const servers = (readJson(at(".mcp.json"))?.mcpServers ?? {}) as Record<string, { args?: unknown[]; env?: Record<string, string> }>;
    const server = Object.values(servers).find((s) => s.args?.some((a) => typeof a === "string" && /claude-channel\.m?js$/.test(a)));
    if (!server) return null;
    type = "claude";
    adapterFile = expand(String(server.args!.find((a) => typeof a === "string" && /claude-channel\.m?js$/.test(a))), dir);
    url = server.env?.AICHAT_URL;
    token = server.env?.AICHAT_TOKEN || tokenFromFile(server.env?.AICHAT_TOKEN_FILE);
  }
  if (type !== "claude") {
    url = config?.url;
    token = tokenFromFile(config?.tokenFile);
  }
  const runtime = at(".aichat");
  let logs: string[] = [];
  try {
    logs = readdirSync(runtime).filter((f) => f.endsWith(".log") && statSync(join(runtime, f)).isFile()).sort();
  } catch {
    // no runtime folder: nothing ran yet, or the adapter keeps no logs there
  }
  const agent: LocalAgent = {
    folder,
    dir,
    type,
    adapterFile,
    version: adapterVersion(adapterFile),
    brokerUrl: brokerOrigin(url),
    logs,
  };
  if (type === "codex" && Number.isInteger(config?.attachPort)) agent.attachPort = config!.attachPort as number;
  const status = readJson(join(runtime, "status.json"));
  if (status) {
    const pid = typeof status.pid === "number" ? status.pid : undefined;
    agent.status = {
      pid,
      alive: pid ? isAlive(pid) : undefined,
      phase: typeof status.phase === "string" ? status.phase : undefined,
      connected: typeof status.connected === "boolean" ? status.connected : undefined,
      updatedAt: typeof status.updatedAt === "string" ? status.updatedAt : undefined,
      version: typeof status.version === "string" ? status.version : undefined,
    };
  }
  return { agent, secrets: { token } };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: it exists but belongs to someone else
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Every agent in the subfolders of `root`, by folder name. */
export function discover(root: string): { agent: LocalAgent; secrets: AgentSecrets }[] {
  let names: string[];
  try {
    names = readdirSync(root).filter((n) => !n.startsWith(".") && statSync(join(root, n)).isDirectory());
  } catch {
    return [];
  }
  return names
    .sort()
    .map((n) => readAgent(join(root, n)))
    .filter((a): a is NonNullable<typeof a> => a !== null);
}

/** The last `lines` lines of a text file, read from its end (logs grow large). */
export function tail(file: string, lines = 200, maxBytes = 256 * 1024): string {
  const size = statSync(file).size;
  const start = Math.max(0, size - maxBytes);
  const buf = Buffer.alloc(size - start);
  const fd = openSync(file, "r");
  try {
    readSync(fd, buf, 0, buf.length, start);
  } finally {
    closeSync(fd);
  }
  const text = buf.toString("utf8");
  const all = text.split(/\r?\n/);
  if (start > 0) all.shift(); // the first line was cut
  if (all.at(-1) === "") all.pop();
  return all.slice(-lines).join("\n");
}
