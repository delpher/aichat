// Stage 3c.2 of the agent manager (AIChat #aichat-manager-dev, 3350, 3472-3474): switching an agent's MCP servers
// on and off, each kind in its own file and only that switch changed:
// - Claude Code: enabledMcpjsonServers / disabledMcpjsonServers in .claude/settings.local.json (for .mcp.json servers);
// - Codex: `enabled = false` in the [mcp_servers.<name>] table of its own CODEX_HOME config.toml;
// - OpenCode: `"disabled": true` on the server in opencode.jsonc, edited in place so comments stay (opencode-alexey, 3473).
// Never: AIChat's own server (the agent would lose the chat), servers in files shared by other profiles or folders
// (~/.claude.json, agy's ~/.gemini/config/mcp_config.json), or an agent without its own CODEX_HOME.
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { LocalAgent } from "./agents.js";
import { readAgentSettings, SettingError } from "./settings.js";

const expand = (p: string, base: string) => {
  const home = p === "~" || p.startsWith("~/") || p.startsWith("~\\") ? join(homedir(), p.slice(1)) : p;
  return isAbsolute(home) ? home : resolve(base, home);
};

const readJson = (file: string): Record<string, unknown> | null => {
  try {
    return JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, "")) as Record<string, unknown>;
  } catch {
    return null;
  }
};

/** `file` replaced through a temporary file, the previous one kept as <file>.bak. */
function writeAtomic(file: string, text: string) {
  if (existsSync(file)) copyFileSync(file, `${file}.bak`);
  mkdirSync(join(file, ".."), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}


/**
 * The [mcp_servers.<name>] table of a TOML text with `enabled = false` in it, or without that line: only lines of that
 * table change.
 */
export function withTomlServerEnabled(text: string, name: string, enabled: boolean): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const header = lines.findIndex((l) => {
    const m = /^\s*\[\s*mcp_servers\.(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))\s*\]\s*(#.*)?$/.exec(l);
    return m !== null && (m[1] ?? m[2] ?? m[3]) === name;
  });
  if (header < 0) throw new SettingError(`у config.toml немає [mcp_servers.${name}]`, "mcp");
  let end = lines.findIndex((l, i) => i > header && /^\s*\[/.test(l));
  if (end < 0) end = lines.length;
  const at = lines.findIndex((l, i) => i > header && i < end && /^\s*(?:enabled|"enabled"|'enabled')\s*=/.test(l));
  if (at >= 0) lines.splice(at, 1);
  if (!enabled) lines.splice(header + 1, 0, "enabled = false");
  return lines.join(eol);
}

/** Index just past the value starting at `i` in a JSONC text (strings, comments and nesting respected). */
function valueEnd(text: string, i: number): number {
  let depth = 0;
  for (let j = i; j < text.length; j++) {
    const c = text[j];
    if (c === '"') {
      j++;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      if (depth === 0) return j + 1;
    } else if (c === "/" && text[j + 1] === "/") {
      while (j < text.length && text[j] !== "\n") j++;
    } else if (c === "/" && text[j + 1] === "*") {
      j = text.indexOf("*/", j + 2) + 1;
      if (j <= 0) return text.length;
    } else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") {
      depth--;
      if (depth === 0) return j + 1;
    } else if (depth === 0 && /[,}\]\s]/.test(c)) return j;
  }
  return text.length;
}

/**
 * The object of key `name` inside the object that spans [from, to) of a JSONC text: where its `{` is and where it
 * ends. Keys are matched at that object's own level only.
 */
function findMember(text: string, from: number, to: number, name: string): { start: number; end: number } | null {
  let j = from + 1; // past the opening brace
  while (j < to) {
    const c = text[j];
    if (c === "/" && text[j + 1] === "/") {
      while (j < to && text[j] !== "\n") j++;
      continue;
    }
    if (c === "/" && text[j + 1] === "*") {
      j = text.indexOf("*/", j + 2) + 2;
      continue;
    }
    if (c === '"') {
      const keyEnd = valueEnd(text, j);
      const key = JSON.parse(text.slice(j, keyEnd)) as string;
      let k = keyEnd;
      while (k < to && /[\s:]/.test(text[k])) k++;
      const end = valueEnd(text, k);
      if (key === name && text[k] === "{") return { start: k, end };
      j = end;
      continue;
    }
    j++;
  }
  return null;
}

/** An OpenCode server object with `"disabled": true`, or without it, edited in place (comments kept). */
export function withJsoncServerDisabled(text: string, name: string, disabled: boolean): string {
  const root = text.indexOf("{");
  if (root < 0) throw new SettingError("opencode.jsonc не читається", "mcp");
  const rootEnd = valueEnd(text, root);
  const mcp = findMember(text, root, rootEnd, "mcp");
  if (!mcp) throw new SettingError("в opencode.jsonc немає блоку mcp", "mcp");
  // OpenCode's own layout is mcp.<name>; some profiles nest them in mcp.servers.<name>
  const servers = findMember(text, mcp.start, mcp.end, "servers");
  const server = (servers && findMember(text, servers.start, servers.end, name)) ?? findMember(text, mcp.start, mcp.end, name);
  if (!server) throw new SettingError(`в opencode.jsonc немає сервера ${name}`, "mcp");
  return text.slice(0, server.start) + withDisabledFlag(text.slice(server.start, server.end), disabled) + text.slice(server.end);
}

/**
 * An object's text with `"disabled": true` added or its "disabled" removed, keeping the object's own layout: in a
 * multi-line object the flag is a line of its own (and a removal takes back the comma it leaves), in a one-line
 * object it goes right after the brace. Adding after removing gives the text back as it was.
 */
export function withDisabledFlag(body: string, disabled: boolean): string {
  let next = body;
  const multi = body.includes("\n");
  // both of OpenCode's switches go: "disabled", and the older "enabled" (opencode-alexey, 3481), so they never disagree
  if (multi) {
    const lines = next.split("\n");
    for (let at; (at = lines.findIndex((l) => /^\s*"(disabled|enabled)"\s*:\s*(true|false)\s*,?\s*(\/\/.*)?\r?$/.test(l))) >= 0; ) {
      const hadComma = /(true|false)\s*,/.test(lines[at]);
      lines.splice(at, 1);
      // it was the last member: the one before it now ends the object and must lose its comma
      if (!hadComma)
        for (let i = at - 1; i > 0; i--)
          if (lines[i].trim()) {
            lines[i] = lines[i].replace(/,(\s*(\/\/.*)?\r?)$/, "$1");
            break;
          }
    }
    if (disabled) {
      const indent = /^(\s*)\S/.exec(lines.find((l, i) => i > 0 && l.trim() && !l.trim().startsWith("}")) ?? "")?.[1] ?? "  ";
      const cr = lines[0].endsWith("\r") ? "\r" : "";
      const empty = lines.slice(1).every((l) => !l.trim() || l.trim().startsWith("}"));
      lines.splice(1, 0, `${indent}"disabled": true${empty ? "" : ","}${cr}`);
    }
    next = lines.join("\n");
  } else {
    next = next.replace(/\s*"(disabled|enabled)"\s*:\s*(true|false)\s*,?/g, "").replace(/,\s*\}$/, " }");
    if (disabled) next = next.replace(/^\{\s*(\}?)/, (_, close) => (close ? '{ "disabled": true }' : '{ "disabled": true, '));
  }
  return next;
}

/** Switches MCP server `name` of `agent` on or off. */
export function toggleMcp(agent: LocalAgent, root: string, nameRaw: unknown, enabledRaw: unknown): string {
  const name = typeof nameRaw === "string" ? nameRaw : "";
  if (typeof enabledRaw !== "boolean") throw new SettingError("enabled: так або ні", "mcp");
  const enabled = enabledRaw;
  const entry = readAgentSettings(agent, root).mcp.find((m) => m.name === name);
  if (!entry) throw new SettingError(`немає MCP-сервера ${name}`, "mcp");
  if (!entry.toggle)
    throw new SettingError(
      name === "aichat" || entry.kind === "builtin" ? `${name}: це канал AIChat, без нього агент випаде з чату` : `${name}: налаштований у спільному файлі (${entry.source}), змінюйте вручну`,
      "mcp",
    );
  const word = enabled ? "увімкнено" : "вимкнено";

  if (agent.type === "claude") {
    const file = join(agent.dir, ".claude", "settings.local.json");
    const settings = readJson(file) ?? (existsSync(file) ? null : {});
    if (!settings) throw new SettingError(".claude/settings.local.json не читається як JSON: виправте його вручну", "mcp");
    const list = (k: string) => (Array.isArray(settings[k]) ? (settings[k] as unknown[]).filter((x): x is string => typeof x === "string") : []);
    const on = list("enabledMcpjsonServers").filter((n) => n !== name);
    const off = list("disabledMcpjsonServers").filter((n) => n !== name);
    (enabled ? on : off).push(name);
    writeAtomic(file, JSON.stringify({ ...settings, enabledMcpjsonServers: on, disabledMcpjsonServers: off }, null, 2) + "\n");
    return `${name} ${word}. Перезапустіть агента.`;
  }
  if (agent.type === "codex") {
    const config = readJson(join(agent.dir, "aichat.config.json")) ?? {};
    if (typeof config.codexHome !== "string" || !config.codexHome)
      throw new SettingError("у цього агента немає окремого codexHome: MCP Codex тут не змінюється", "mcp");
    const file = join(expand(config.codexHome, agent.dir), "config.toml");
    writeAtomic(file, withTomlServerEnabled(readFileSync(file, "utf8"), name, enabled));
    return `${name} ${word}. Перезапустіть агента.`;
  }
  if (agent.type === "opencode") {
    const file = join(agent.dir, "opencode.jsonc");
    writeAtomic(file, withJsoncServerDisabled(readFileSync(file, "utf8"), name, !enabled));
    return `${name} ${word}. Перезавантажте OpenCode (opencode reload або перезапуск).`;
  }
  throw new SettingError("MCP цього агента змінюється вручну", "mcp");
}
