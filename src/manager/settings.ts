// Stage 3a of the agent manager (AIChat #aichat-manager-dev, 3324-3336): what an agent is set up to do, read from
// its own configuration files, for the page to show. Read-only, and nothing secret leaves here: MCP servers go out
// as name, kind and state only (a key may hide in args, env, headers or a URL), the broker token as where it lives.
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { readSettings, startCommand } from "./actions.js";
import type { LocalAgent } from "./agents.js";

export type SettingValue = string | number | boolean | string[] | null;

export interface SettingItem {
  key: string;
  label: string;
  value: SettingValue;
  /** "налаштовано" (from a file), "фактично" (what the running adapter reports), or a warning. */
  note?: string;
}

export interface SettingsSection {
  id: "workspace" | "connection" | "behavior" | "model" | "launch";
  title: string;
  items: SettingItem[];
}

export interface McpEntry {
  name: string;
  kind: "local" | "remote" | "builtin";
  /** null: the file does not say. */
  enabled: boolean | null;
  /** Where it is configured, e.g. ".mcp.json" or "~/.gemini/config/mcp_config.json (глобальний)". */
  source: string;
  /** What the running adapter reports, when it does (`effective.mcp` in .aichat/status.json). */
  state?: "connected" | "failed" | "unknown";
}

export interface AgentSettings {
  sections: SettingsSection[];
  mcp: McpEntry[];
  /** The configuration changed after the running process started; null when the start time is unknown. */
  restartNeeded: boolean | null;
}

const CONFIGURED = "налаштовано";
const ACTUAL = "фактично";

const readText = (file: string): string | null => {
  try {
    return readFileSync(file, "utf8").replace(/^﻿/, "");
  } catch {
    return null;
  }
};

const readJson = (file: string): Record<string, unknown> | null => {
  const text = readText(file);
  if (text === null) return null;
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
};

/** JSON with // and /* comments and trailing commas (opencode.jsonc); strings are left alone. */
export function parseJsonc(text: string): Record<string, unknown> | null {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 1;
    } else out += c;
  }
  try {
    return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * The few parts of a Codex config.toml the manager shows: top-level keys and tables, with string, boolean, number
 * and string-array values. Anything else is skipped rather than guessed.
 */
export function parseTomlLite(text: string): Record<string, Record<string, unknown>> {
  const tables: Record<string, Record<string, unknown>> = { "": {} };
  let current = tables[""];
  const lines = text.split(/\r?\n/);
  for (let n = 0; n < lines.length; n++) {
    let line = lines[n].trim();
    if (!line || line.startsWith("#")) continue;
    const header = /^\[([^\[\]]+)\]$/.exec(line);
    if (header) {
      current = tables[header[1].trim()] ??= {};
      continue;
    }
    const kv = /^([A-Za-z0-9_.-]+)\s*=\s*(.*)$/.exec(line);
    if (!kv) continue;
    let raw = kv[2];
    // a multi-line array: gather until the closing bracket
    if (raw.startsWith("[") && !raw.includes("]")) {
      while (++n < lines.length) {
        line = lines[n].trim();
        raw += " " + line;
        if (line.includes("]")) break;
      }
    }
    const value = tomlValue(raw);
    if (value !== undefined) current[kv[1]] = value;
  }
  return tables;
}

function tomlValue(raw: string): unknown {
  const s = raw.replace(/\s+#[^"']*$/, "").trim();
  if (s === "true" || s === "false") return s === "true";
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  const str = /^"((?:[^"\\]|\\.)*)"$/.exec(s) ?? /^'([^']*)'$/.exec(s);
  if (str) return s.startsWith('"') ? str[1].replace(/\\(.)/g, "$1") : str[1];
  if (s.startsWith("[") && s.endsWith("]")) {
    const items = [...s.slice(1, -1).matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'/g)].map((m) => (m[1] !== undefined ? m[1].replace(/\\(.)/g, "$1") : m[2]));
    return items;
  }
  return undefined;
}

const expand = (p: string, base: string) => {
  const home = p === "~" || p.startsWith("~/") || p.startsWith("~\\") ? join(homedir(), p.slice(1)) : p;
  return isAbsolute(home) ? home : resolve(base, home);
};

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const strs = (v: unknown): string[] | null => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : null);
const val = (v: unknown): SettingValue => {
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
  return strs(v) ?? null;
};

/** The kind of an MCP server entry, whichever of the four formats it is in. */
function mcpKind(entry: Record<string, unknown>): "local" | "remote" {
  if (entry.type === "remote" || entry.type === "http" || entry.type === "sse" || entry.url || entry.serverUrl || entry.httpUrl) return "remote";
  return "local";
}

/** `mcpServers`-style map (Claude, Gemini) as entries. */
function mcpFromMap(map: unknown, source: string, enabled: (name: string, e: Record<string, unknown>) => boolean | null): McpEntry[] {
  if (!map || typeof map !== "object") return [];
  return Object.entries(map as Record<string, Record<string, unknown>>)
    .filter(([, e]) => e && typeof e === "object")
    .map(([name, e]) => ({ name, kind: mcpKind(e), enabled: enabled(name, e), source }));
}

/** When the running adapter process started: its .aichat/adapter.lock holds its pid and is written at start. */
function processStart(agent: LocalAgent): number | null {
  const pid = agent.status?.pid;
  if (!pid || !agent.status?.alive) return null;
  const lock = join(agent.dir, ".aichat", "adapter.lock");
  if (readText(lock)?.trim() !== String(pid)) return null;
  return statSync(lock).mtimeMs;
}

const mtime = (file: string): number | null => {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return null;
  }
};

export function readAgentSettings(agent: LocalAgent, root: string): AgentSettings {
  const at = (...p: string[]) => join(agent.dir, ...p);
  const config = readJson(at("aichat.config.json")) ?? {};
  const status = readJson(at(".aichat", "status.json")) ?? {};
  const effective = (status.effective && typeof status.effective === "object" ? status.effective : {}) as Record<string, unknown>;
  const workspace: SettingItem[] = [{ key: "dir", label: "Тека агента", value: agent.dir }];
  const connection: SettingItem[] = [];
  const behavior: SettingItem[] = [];
  const model: SettingItem[] = [];
  const launch: SettingItem[] = [];
  let mcp: McpEntry[] = [];
  const configFiles = [at("aichat.config.json")];
  const add = (list: SettingItem[], key: string, label: string, v: unknown, note = CONFIGURED) => {
    if (v === undefined) return;
    list.push({ key, label, value: val(v), note });
  };

  // where the broker token lives; its value never leaves this function
  const tokenFile = (file: unknown) => {
    const f = str(file);
    if (!f) return;
    const path = expand(f, agent.dir);
    connection.push({ key: "tokenFile", label: "Токен", value: path, note: existsSync(path) ? "у файлі" : "файлу немає" });
  };

  if (agent.type === "claude") {
    const mcpJson = readJson(at(".mcp.json")) ?? {};
    const servers = (mcpJson.mcpServers ?? {}) as Record<string, Record<string, unknown>>;
    const own = Object.values(servers).find((s) => strs(s.args)?.some((a) => /claude-channel\.m?js$/.test(a)));
    const env = (own?.env ?? {}) as Record<string, string>;
    const settings = { ...(readJson(at(".claude", "settings.json")) ?? {}), ...(readJson(at(".claude", "settings.local.json")) ?? {}) };
    configFiles.push(at(".mcp.json"), at(".claude", "settings.json"), at(".claude", "settings.local.json"));
    const perms = (settings.permissions ?? {}) as Record<string, unknown>;
    add(workspace, "additionalDirectories", "Додаткові теки", strs(perms.additionalDirectories) ?? []);
    add(workspace, "defaultMode", "Режим дозволів", perms.defaultMode ?? null);
    add(workspace, "allow", "Дозволено без питання", strs(perms.allow)?.length ?? 0);
    add(workspace, "deny", "Заборонено", strs(perms.deny)?.length ?? 0);
    add(connection, "url", "Брокер", env.AICHAT_URL ?? null);
    if (env.AICHAT_TOKEN) connection.push({ key: "token", label: "Токен", value: "у .mcp.json", note: "лежить відкрито в конфігу: краще AICHAT_TOKEN_FILE" });
    else tokenFile(env.AICHAT_TOKEN_FILE);
    // other AICHAT_* settings of the channel, never anything that looks like a secret
    for (const [k, v] of Object.entries(env))
      if (k.startsWith("AICHAT_") && !/TOKEN|KEY|SECRET|PASSWORD/i.test(k) && k !== "AICHAT_URL") add(behavior, k, k, v);
    add(model, "model", "Модель", settings.model ?? null);
    const enabledList = strs(settings.enabledMcpjsonServers);
    const disabledList = strs(settings.disabledMcpjsonServers) ?? [];
    const all = settings.enableAllProjectMcpServers === true;
    mcp = mcpFromMap(servers, ".mcp.json", (name) => (disabledList.includes(name) ? false : all || enabledList?.includes(name) ? true : enabledList ? false : null));
    // user-level servers: in ~/.claude.json, for every project or for this folder
    const user = readJson(join(homedir(), ".claude.json")) ?? {};
    mcp.push(...mcpFromMap(user.mcpServers, "~/.claude.json (для всіх тек)", () => true));
    const projects = (user.projects ?? {}) as Record<string, Record<string, unknown>>;
    const mine = Object.entries(projects).find(([p]) => resolve(p).toLowerCase() === resolve(agent.dir).toLowerCase())?.[1];
    mcp.push(...mcpFromMap(mine?.mcpServers, "~/.claude.json (ця тека)", () => true));
  } else {
    add(connection, "url", "Брокер", config.url ?? null);
    tokenFile(config.tokenFile);
    if (!str(config.tokenFile)) connection.push({ key: "tokenFile", label: "Токен", value: null, note: "tokenFile не задано" });
  }

  if (agent.type !== "claude") {
    add(connection, "owners", "Власники", config.owners);
    add(connection, "rooms", "Кімнати (при старті)", config.rooms);
    for (const [k, label] of [
      ["wake", "Будити"],
      ["delivery", "Доставка"],
      ["paused", "На паузі"],
      ["maxWakesPerMinute", "Пробуджень за хвилину, не більше"],
      ["maxQueue", "Черга, повідомлень"],
      ["maxQueueAgeMs", "Черга, вік (мс)"],
      ["maxQueueBytes", "Черга, байтів"],
      ["maxBatch", "Повідомлень за раз"],
      ["sessionTitle", "Назва сесії"],
      ["approveAichatTools", "Тули AIChat без питання"],
      ["instructions", "Інструкції"],
    ] as const)
      add(behavior, k, label, config[k]);
  }
  add(connection, "joined", "Кімнати зараз", strs(status.rooms) ?? undefined, ACTUAL);

  if (agent.type === "agy") {
    add(workspace, "addDirs", "Додаткові теки", strs(config.addDirs) ?? []);
    add(workspace, "mode", "Режим", config.mode ?? null);
    add(workspace, "sandbox", "Пісочниця", config.sandbox ?? null);
    add(workspace, "appDataDir", "Профіль Antigravity", config.appDataDir);
    add(model, "provider", "Провайдер", config.provider);
    add(model, "model", "Модель", config.model);
    mcp = [{ name: "aichat", kind: "builtin", enabled: true, source: "адаптер (при старті сесії)" }];
    const gemini = str(config.geminiDir) ? expand(String(config.geminiDir), agent.dir) : join(homedir(), ".gemini");
    const file = join(gemini, "config", "mcp_config.json");
    mcp.push(...mcpFromMap(readJson(file)?.mcpServers, "~/.gemini/config/mcp_config.json (глобальний, усі профілі agy)", (_, e) => (e.disabled === true ? false : true)));
  }

  if (agent.type === "codex") {
    const codexHome = str(config.codexHome) ? expand(String(config.codexHome), agent.dir) : join(homedir(), ".codex");
    const tomlFile = join(codexHome, "config.toml");
    configFiles.push(tomlFile);
    const toml = parseTomlLite(readText(tomlFile) ?? "");
    const top = toml[""];
    const ws = toml["sandbox_workspace_write"] ?? {};
    add(workspace, "sandbox_mode", "Пісочниця", top.sandbox_mode ?? null);
    add(workspace, "approval_policy", "Підтвердження дій", top.approval_policy ?? null);
    add(workspace, "writable_roots", "Додаткові корені для запису", strs(ws.writable_roots) ?? []);
    add(workspace, "network_access", "Мережа в пісочниці", ws.network_access ?? null);
    add(workspace, "codexHome", "CODEX_HOME", codexHome);
    add(model, "model", "Модель", top.model ?? config.model ?? null);
    add(model, "model_provider", "Провайдер", top.model_provider);
    add(model, "model_reasoning_effort", "Зусилля", top.model_reasoning_effort);
    for (const [table, e] of Object.entries(toml)) {
      const m = /^mcp_servers\.("?)([^"]+)\1$/.exec(table);
      if (m) mcp.push({ name: m[2], kind: mcpKind(e), enabled: e.enabled === false ? false : true, source: "config.toml" });
    }
  }

  if (agent.type === "opencode") {
    workspace.push({ key: "sandbox", label: "Пісочниця", value: false, note: "сервер OpenCode не в пісочниці: доступ ширший за теку" });
    const ocFile = at("opencode.jsonc");
    configFiles.push(ocFile);
    const oc = parseJsonc(readText(ocFile) ?? readText(at("opencode.json")) ?? "") ?? {};
    add(model, "agent", "Агент OpenCode", config.agent ?? oc.default_agent);
    add(model, "model", "Модель", config.model ?? oc.model ?? null);
    const block = (oc.mcp ?? {}) as Record<string, unknown>;
    const map = (block.servers && typeof block.servers === "object" ? block.servers : block) as Record<string, Record<string, unknown>>;
    mcp = mcpFromMap(map, "opencode.jsonc", (_, e) => !(e.disabled === true || e.enabled === false));
  }
  add(model, "running", "Модель зараз", str(status.model) ?? undefined, ACTUAL);

  // what the running adapter says it really has (AIChat 3336); absent until each adapter writes it
  if (typeof effective.sandbox === "boolean" || typeof effective.sandbox === "string") add(workspace, "effective.sandbox", "Пісочниця", effective.sandbox, ACTUAL);
  if (typeof effective.network === "boolean") add(workspace, "effective.network", "Мережа", effective.network, ACTUAL);
  if (strs(effective.writableRoots)) add(workspace, "effective.writableRoots", "Корені для запису", strs(effective.writableRoots), ACTUAL);
  const states = Array.isArray(effective.mcp) ? (effective.mcp as { name?: unknown; state?: unknown }[]) : [];
  for (const s of states) {
    const entry = mcp.find((m) => m.name === s.name);
    const state = s.state === "connected" || s.state === "failed" ? s.state : "unknown";
    if (entry) entry.state = state;
    else if (typeof s.name === "string") mcp.push({ name: s.name, kind: "builtin", enabled: true, source: "адаптер", state });
  }

  const command = startCommand(agent, readSettings(root));
  launch.push({ key: "command", label: "Команда запуску", value: command ?? "у фоні: node <адаптер> run", note: readSettings(root).start?.[agent.folder] ? ".manager.json" : "типова" });
  if (agent.type === "codex" || agent.type === "agy") add(launch, "attachPort", "Порт інтерактивної сесії", config.attachPort ?? null);
  if (agent.type !== "claude") add(launch, "session", "Сесія при старті", config.session ?? "resume");
  if (agent.status?.pid) add(launch, "pid", "Процес", agent.status.pid, agent.status.alive ? "працює" : "не працює");
  add(launch, "start", "Як почалась сесія", str(status.start) ?? undefined, ACTUAL);

  const started = processStart(agent);
  const changed = Math.max(...configFiles.map((f) => mtime(f) ?? 0));
  const restartNeeded = started === null ? null : changed > started;

  const sections: SettingsSection[] = (
    [
      { id: "workspace", title: "Workspace", items: workspace },
      { id: "connection", title: "Підключення", items: connection },
      { id: "behavior", title: "Поведінка в чаті", items: behavior },
      { id: "model", title: "Модель", items: model },
      { id: "launch", title: "Запуск", items: launch },
    ] as SettingsSection[]
  ).filter((s) => s.items.length);
  return { sections, mcp, restartNeeded };
}
