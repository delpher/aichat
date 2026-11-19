// `node claude-channel.mjs install --url ws://host:8787 --token <token>` writes the agent's .mcp.json,
// so connecting a Claude Code session is one command: download the adapter, then run this.
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { hookSettings } from "../broker/setup.js";

export interface InstallResult {
  /** The .mcp.json that was written. */
  path: string;
  /** Whether the file existed before (other MCP servers in it were kept). */
  merged: boolean;
}

/**
 * Adds (or replaces) the `aichat` server in .mcp.json of `dir`, keeping every other server in the file.
 * `adapter` is the absolute path of claude-channel.mjs, which Claude Code will start with node.
 */
/** Reads a JSON object file; missing or empty gives {}. Throws on anything else, so a broken file is left alone. */
async function readObject(path: string): Promise<Record<string, unknown>> {
  if (!existsSync(path)) return {};
  const raw = await readFile(path, "utf8");
  let v: unknown;
  try {
    v = raw.trim() ? JSON.parse(raw) : {};
  } catch (e) {
    throw new Error(`${path} is not valid JSON (${(e as Error).message}); fix or remove it and run install again`);
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error(`${path} is not a JSON object`);
  return v as Record<string, unknown>;
}

type HookGroup = { matcher?: string; hooks?: { type?: string; command?: string }[] };

/**
 * Registers aichat-hook.mjs in .claude/settings.local.json of `dir`, so Claude Code reports what the agent is
 * doing. Other settings and hooks stay; an earlier aichat hook entry is replaced, not doubled.
 */
export async function installHooks(opts: { dir: string; hook: string }): Promise<string> {
  const path = resolve(opts.dir, ".claude", "settings.local.json");
  const settings = await readObject(path);
  const hooks = (settings.hooks ?? {}) as Record<string, HookGroup[]>;
  const ours = hookSettings(opts.hook.replace(/\\/g, "/")).hooks as Record<string, HookGroup[]>;
  for (const [event, groups] of Object.entries(ours)) {
    const kept = (hooks[event] ?? []).filter((g) => !g.hooks?.some((h) => /aichat-hook\.m?js/.test(h.command ?? "")));
    hooks[event] = [...kept, ...groups];
  }
  settings.hooks = hooks;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(settings, null, 2)}\n`);
  return path;
}

type StatusLine = { type?: string; command?: string; [k: string]: unknown };

/** `node "<hook>" statusline`, possibly with --line and a pipe to the person's own command, as installStatusLine writes it. */
const OURS_RE = /^node\s+"[^"]*aichat-hook\.m?js"\s+statusline(?:\s+--line)?\s*(?:\|\s*)?/;

/**
 * Sets the status line in .claude/settings.local.json of `dir` to aichat-hook.mjs, which reports the account's
 * usage to AIChat. A status line the person already has (in this folder's settings or in their own,
 * `userSettings`) keeps working: the hook passes Claude Code's JSON on to it through a pipe. Without one, the
 * hook prints a short line of its own. Running it again does not wrap the hook twice.
 * Returns the file written and the person's own command, if any.
 */
export async function installStatusLine(opts: { dir: string; hook: string; userSettings?: string }): Promise<{ path: string; theirs?: string }> {
  const path = resolve(opts.dir, ".claude", "settings.local.json");
  const settings = await readObject(path);
  let existing: StatusLine | undefined;
  for (const p of [path, resolve(opts.dir, ".claude", "settings.json"), ...(opts.userSettings ? [opts.userSettings] : [])]) {
    const s = p === path ? settings : await readObject(p).catch(() => ({}) as Record<string, unknown>);
    const line = s.statusLine as StatusLine | undefined;
    if (line && typeof line.command === "string" && line.command.trim()) {
      existing = line;
      break;
    }
  }
  const theirs = existing?.command?.replace(OURS_RE, "").trim() || undefined;
  const ours = `node "${opts.hook.replace(/\\/g, "/")}" statusline`;
  settings.statusLine = { ...(existing ?? {}), type: "command", command: theirs ? `${ours} | ${theirs}` : `${ours} --line` };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(settings, null, 2)}\n`);
  return { path, ...(theirs ? { theirs } : {}) };
}

/** The person's own Claude Code settings: in CLAUDE_CONFIG_DIR when set, else in ~/.claude. */
export const userSettingsPath = (env: NodeJS.ProcessEnv = process.env) =>
  join(env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "settings.json");

export async function installMcpJson(opts: {
  dir: string;
  adapter: string;
  url: string;
  token: string;
  server?: string;
}): Promise<InstallResult> {
  const path = resolve(opts.dir, ".mcp.json");
  const merged = existsSync(path);
  const config = await readObject(path);
  config.mcpServers = {
    ...((config.mcpServers as Record<string, unknown> | undefined) ?? {}),
    [opts.server ?? "aichat"]: {
      command: "node",
      args: [opts.adapter.replace(/\\/g, "/")],
      env: { AICHAT_URL: opts.url, AICHAT_TOKEN: opts.token },
    },
  };
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`);
  return { path, merged };
}

/** The `install` command line: flags, or AICHAT_URL / AICHAT_TOKEN from the environment. Returns the exit code. */
export async function runInstall(argv: string[], adapter: string): Promise<number> {
  let values: { url?: string; token?: string; dir?: string; server?: string; statusline?: boolean };
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        url: { type: "string" },
        token: { type: "string" },
        dir: { type: "string" },
        server: { type: "string" },
        statusline: { type: "boolean" },
      },
    }));
  } catch (e) {
    console.error(`[aichat] ${(e as Error).message}`);
    return 2;
  }
  const url = values.url ?? process.env.AICHAT_URL;
  const token = values.token ?? process.env.AICHAT_TOKEN;
  if (!url || !token) {
    console.error("usage: node claude-channel.mjs install --url ws://<broker>:8787 --token <token> [--dir <folder with .mcp.json>] [--statusline]");
    return 2;
  }
  if (!/^wss?:\/\//.test(url)) {
    console.error(`[aichat] --url must start with ws:// or wss://, got ${url}`);
    return 2;
  }
  try {
    const r = await installMcpJson({ dir: values.dir ?? process.cwd(), adapter, url, token, server: values.server });
    const server = values.server ?? "aichat";
    console.log(`${r.merged ? "Updated" : "Created"} ${r.path} (MCP server "${server}" → ${url}).`);
    // the status hook, when it was downloaded next to the adapter
    const hook = join(dirname(adapter), "aichat-hook.mjs");
    if (existsSync(hook)) console.log(`Registered the status hook in ${await installHooks({ dir: values.dir ?? process.cwd(), hook })}.`);
    // the status line that reports the account's usage: only when asked for, since it changes how Claude Code looks
    if (values.statusline) {
      if (!existsSync(hook)) console.log("No aichat-hook.mjs next to the adapter: the usage status line was not set up.");
      else {
        const s = await installStatusLine({ dir: values.dir ?? process.cwd(), hook, userSettings: userSettingsPath() });
        console.log(
          `Set the status line in ${s.path}: it reports the account's usage to AIChat` +
            (s.theirs ? ` and passes on to your own status line (${s.theirs}).` : "."),
        );
      }
    }
    console.log(`Now start Claude Code in this folder:\n  claude --dangerously-load-development-channels server:${server}`);
    return 0;
  } catch (e) {
    console.error(`[aichat] ${(e as Error).message}`);
    return 1;
  }
}
