#!/usr/bin/env node
// Claude Code hook that tells AIChat what the agent is doing, so people see "working… (Bash)" or
// "waiting: permission for Bash" next to its name. Claude Code runs it with the event as JSON on stdin:
//   UserPromptSubmit -> busy;  PreToolUse -> busy (detail: the tool);  Notification -> waiting;  Stop -> idle.
// The broker address and token come from the aichat server in .mcp.json (searched from the session's folder
// upwards), or from AICHAT_URL / AICHAT_TOKEN. It never fails the hook and never prints anything: some hook
// output would otherwise end up in Claude's context.
//
// `aichat-hook.mjs statusline` is a status line command instead (see usage-report.ts): now and then it reports
// the account's usage to AIChat, and it passes Claude Code's JSON on unchanged, so the person's own status line
// keeps working behind a pipe: `node aichat-hook.mjs statusline | <their command>`. With --line it prints a
// short line of its own instead.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { accountEmail, shortLine, shouldSend, usageFromStatus, type StatusInput } from "./usage-report.js";

const TIMEOUT_MS = 2000;

interface HookInput {
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  message?: string;
  notification_type?: string;
  cwd?: string;
}

type Report = { state: "idle" | "busy" | "waiting"; detail?: string; target?: string } | null;

/** Longest target sent: enough for a file name or the start of a command. */
const TARGET_MAX = 48;

const short = (s: string) => {
  const one = s.split("\n")[0].replace(/\s+/g, " ").trim();
  return one.length > TARGET_MAX ? `${one.slice(0, TARGET_MAX - 1)}…` : one;
};
const baseName = (p: string) => p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? p;

/**
 * What a tool works on, short enough for a status line: the file name (not the path, which may be private),
 * the start of a command, the search, the site. Nothing for tools whose input says nothing useful.
 */
export function targetOf(tool: string | undefined, input: Record<string, unknown> | undefined): string | undefined {
  if (!tool || !input) return undefined;
  const str = (k: string) => (typeof input[k] === "string" && (input[k] as string).trim() ? (input[k] as string) : undefined);
  const file = str("file_path") ?? str("notebook_path") ?? str("path");
  switch (tool) {
    case "Read":
    case "Edit":
    case "MultiEdit":
    case "Write":
    case "NotebookEdit":
      return file ? baseName(file) : undefined;
    case "Bash":
    case "PowerShell":
      return str("description") ? short(str("description")!) : str("command") ? short(str("command")!) : undefined;
    case "Grep":
    case "Glob":
      return str("pattern") ? short(str("pattern")!) : undefined;
    case "WebFetch": {
      const url = str("url");
      if (!url) return undefined;
      try {
        return new URL(url).hostname;
      } catch {
        return short(url);
      }
    }
    case "WebSearch":
      return str("query") ? short(str("query")!) : undefined;
    case "Agent":
    case "Task":
      return str("description") ? short(str("description")!) : undefined;
    default:
      return undefined;
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  const done = new Promise<void>((resolve) => {
    process.stdin.on("data", (c: Buffer) => chunks.push(c));
    process.stdin.on("end", resolve);
    process.stdin.on("error", resolve);
  });
  await Promise.race([done, new Promise((r) => setTimeout(r, 1000))]);
  return Buffer.concat(chunks).toString("utf8");
}

/** "mcp__aichat__send_message" -> "send_message" */
const toolLabel = (name: string) => name.replace(/^mcp__[^_]+(?:_[^_]+)*?__/, "");

export function reportFor(e: HookInput): Report {
  switch (e.hook_event_name) {
    case "UserPromptSubmit":
      return { state: "busy", detail: "думає" };
    case "PreToolUse": {
      const target = targetOf(e.tool_name, e.tool_input);
      return { state: "busy", ...(e.tool_name ? { detail: toolLabel(e.tool_name) } : {}), ...(target ? { target } : {}) };
    }
    case "Notification": {
      // "waiting for your input" only means the session sits at its prompt: that is idle, not a request
      if (e.notification_type === "idle_prompt" || /waiting for your input/i.test(e.message ?? "")) return { state: "idle" };
      return { state: "waiting", ...(e.message ? { detail: e.message } : {}) };
    }
    case "Stop":
    case "SessionEnd":
      return { state: "idle" };
    default:
      return null;
  }
}

/** The aichat server's env from the nearest .mcp.json at or above `dir`. */
export function findConfig(dir: string): { url: string; token: string } | null {
  for (let d = dir; ; d = dirname(d)) {
    try {
      const mcp = JSON.parse(readFileSync(join(d, ".mcp.json"), "utf8")) as {
        mcpServers?: Record<string, { args?: string[]; env?: Record<string, string> }>;
      };
      const servers = Object.entries(mcp.mcpServers ?? {});
      const server =
        servers.find(([name]) => name === "aichat")?.[1] ??
        servers.find(([, s]) => s.args?.some((a) => /claude-channel\.m?js$/.test(a)))?.[1];
      if (server?.env?.AICHAT_TOKEN) return { url: server.env.AICHAT_URL ?? "ws://127.0.0.1:8787", token: server.env.AICHAT_TOKEN };
    } catch {
      // no .mcp.json here, or not readable: keep looking
    }
    if (dirname(d) === d) return null;
  }
}

/** The broker's HTTP address and the token: from AICHAT_URL / AICHAT_TOKEN, else from the nearest .mcp.json. */
function brokerFor(dir: string): { http: string; token: string } | null {
  const cfg = process.env.AICHAT_TOKEN
    ? { url: process.env.AICHAT_URL ?? "ws://127.0.0.1:8787", token: process.env.AICHAT_TOKEN }
    : findConfig(dir);
  if (!cfg) return null;
  return { http: cfg.url.replace(/\/?$/, "").replace(/\/ws$/, "").replace(/^ws(s?):/, "http$1:"), token: cfg.token };
}

const write = (text: string) => new Promise<void>((resolve) => process.stdout.write(text, () => resolve()));

/** The status line command: pass the JSON on (or print a short line), then report the usage when it is time. */
async function statusline(args: string[]) {
  const raw = await readStdin();
  const own = args.includes("--line");
  if (!own) await write(raw);
  let input: StatusInput;
  try {
    input = JSON.parse(raw) as StatusInput;
  } catch {
    if (own) await write("AIChat\n");
    return;
  }
  const body = usageFromStatus(input, accountEmail());
  if (own) await write(`${shortLine(body)}\n`);
  const broker = brokerFor(input.workspace?.project_dir ?? input.cwd ?? process.cwd());
  if (!broker) return;
  // the status line is a new process on every update: what was sent last is kept in a file per token
  const state = join(tmpdir(), `aichat-usage-${createHash("sha256").update(broker.token).digest("hex").slice(0, 16)}.json`);
  let last: { sig?: string; at?: number } | undefined;
  try {
    last = JSON.parse(readFileSync(state, "utf8")) as { sig?: string; at?: number };
  } catch {
    last = undefined;
  }
  const now = Date.now();
  if (!shouldSend(body, last, now)) return;
  writeFileSync(state, JSON.stringify({ sig: JSON.stringify(body), at: now }));
  await fetch(`${broker.http}/api/usage`, {
    method: "POST",
    headers: { authorization: `Bearer ${broker.token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

async function main() {
  const raw = await readStdin();
  let input: HookInput = {};
  try {
    input = JSON.parse(raw) as HookInput;
  } catch {
    return;
  }
  const report = reportFor(input);
  if (!report) return;
  const broker = brokerFor(input.cwd ?? process.cwd());
  if (!broker) return;
  await fetch(`${broker.http}/api/activity`, {
    method: "POST",
    headers: { authorization: `Bearer ${broker.token}`, "content-type": "application/json" },
    body: JSON.stringify(report),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

// run only as a script, not when a test imports it
if (process.argv[1] && /aichat-hook\.m?[jt]s$/.test(process.argv[1]))
  (process.argv[2] === "statusline" ? statusline(process.argv.slice(3)) : main())
    .catch(() => {})
    .finally(() => process.exit(0));
