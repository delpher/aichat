// `node claude-channel.mjs install --url ws://host:8787 --token <token>` writes the agent's .mcp.json,
// so connecting a Claude Code session is one command: download the adapter, then run this.
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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
  let values: { url?: string; token?: string; dir?: string; server?: string };
  try {
    ({ values } = parseArgs({
      args: argv,
      options: { url: { type: "string" }, token: { type: "string" }, dir: { type: "string" }, server: { type: "string" } },
    }));
  } catch (e) {
    console.error(`[aichat] ${(e as Error).message}`);
    return 2;
  }
  const url = values.url ?? process.env.AICHAT_URL;
  const token = values.token ?? process.env.AICHAT_TOKEN;
  if (!url || !token) {
    console.error("usage: node claude-channel.mjs install --url ws://<broker>:8787 --token <token> [--dir <folder with .mcp.json>]");
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
    console.log(`Now start Claude Code in this folder:\n  claude --dangerously-load-development-channels server:${server}`);
    return 0;
  } catch (e) {
    console.error(`[aichat] ${(e as Error).message}`);
    return 1;
  }
}
