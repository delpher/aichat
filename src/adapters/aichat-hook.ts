#!/usr/bin/env node
// Claude Code hook that tells AIChat what the agent is doing, so people see "working… (Bash)" or
// "waiting: permission for Bash" next to its name. Claude Code runs it with the event as JSON on stdin:
//   UserPromptSubmit -> busy;  PreToolUse -> busy (detail: the tool);  Notification -> waiting;  Stop -> idle.
// The broker address and token come from the aichat server in .mcp.json (searched from the session's folder
// upwards), or from AICHAT_URL / AICHAT_TOKEN. It never fails the hook and never prints anything: some hook
// output would otherwise end up in Claude's context.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const TIMEOUT_MS = 2000;

interface HookInput {
  hook_event_name?: string;
  tool_name?: string;
  message?: string;
  notification_type?: string;
  cwd?: string;
}

type Report = { state: "idle" | "busy" | "waiting"; detail?: string } | null;

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
    case "PreToolUse":
      return { state: "busy", ...(e.tool_name ? { detail: toolLabel(e.tool_name) } : {}) };
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
  const cfg =
    process.env.AICHAT_TOKEN
      ? { url: process.env.AICHAT_URL ?? "ws://127.0.0.1:8787", token: process.env.AICHAT_TOKEN }
      : findConfig(input.cwd ?? process.cwd());
  if (!cfg) return;
  const http = cfg.url.replace(/\/?$/, "").replace(/\/ws$/, "").replace(/^ws(s?):/, "http$1:");
  await fetch(`${http}/api/activity`, {
    method: "POST",
    headers: { authorization: `Bearer ${cfg.token}`, "content-type": "application/json" },
    body: JSON.stringify(report),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

// run only as a script, not when a test imports it
if (process.argv[1] && /aichat-hook\.m?[jt]s$/.test(process.argv[1]))
  main()
    .catch(() => {})
    .finally(() => process.exit(0));
