// Stage 3a of the agent manager (AIChat #aichat-manager-dev, 3324-3336): what an agent is set up to do, read from
// its own configuration files, for the page to show. Read-only, and nothing secret leaves here: MCP servers go out
// as name, kind and state only (a key may hide in args, env, headers or a URL), the broker token as where it lives.
import { copyFileSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { ROOM_RE } from "../protocol.js";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { ActionError, readSettings, startCommand } from "./actions.js";
import { CLAUDE_CHANNEL_FLAGS, claudeCommand, hasStartScript } from "./claude-start.js";
import type { LocalAgent } from "./agents.js";

export type SettingValue = string | number | boolean | string[] | null;

/** How the page may change a setting (stage 3b, AIChat 3345); a setting without it is read-only. */
export type EditSpec =
  | { type: "enum"; options: string[]; optional?: boolean }
  | { type: "bool" }
  | { type: "int"; min: number; max: number; optional?: boolean }
  /** `suggestions`: known values to offer; others are allowed (a model's own names and levels, AIChat 3460). */
  | { type: "text"; max: number; optional?: boolean; suggestions?: string[] }
  | { type: "list" }
  /** Write-only: the page sends a new value to POST /api/agents/<folder>/token and never sees the old one (3c.1). */
  | { type: "secret" };

export interface SettingItem {
  key: string;
  label: string;
  value: SettingValue;
  /** "налаштовано" (from a file), "фактично" (what the running adapter reports), or a warning. */
  note?: string;
  edit?: EditSpec;
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
    connection.push({ key: "tokenFile", label: "Токен", value: path, note: existsSync(path) ? "у файлі" : "файлу немає", edit: { type: "secret" } });
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
    if (env.AICHAT_TOKEN)
      connection.push({ key: "token", label: "Токен", value: "у .mcp.json", note: "лежить відкрито в конфігу: заміна перенесе його у файл", edit: { type: "secret" } });
    else tokenFile(env.AICHAT_TOKEN_FILE);
    // other AICHAT_* settings of the channel, never anything that looks like a secret
    for (const [k, v] of Object.entries(env))
      if (k.startsWith("AICHAT_") && !/TOKEN|KEY|SECRET|PASSWORD/i.test(k) && k !== "AICHAT_URL") add(behavior, k, k, v);
    // model and effort: flags of the person's Claude command (AIChat 3447-3459); settings.json's model otherwise
    const words = splitCommand(claudeCommand(readSettings(root).start?.[agent.folder]));
    const flagModel = flagValue(words, "--model");
    model.push({ key: "model", label: "Модель", value: flagModel ?? str(settings.model), note: flagModel ? "команда запуску" : settings.model ? ".claude/settings" : CONFIGURED });
    model.push({ key: "effort", label: "Effort", value: flagValue(words, "--effort"), note: "команда запуску" });
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
    if (!str(config.tokenFile)) connection.push({ key: "tokenFile", label: "Токен", value: null, note: "tokenFile не задано", edit: { type: "secret" } });
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
    add(model, "effort", "Effort", top.model_reasoning_effort ?? null);
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
    // the plugin asks for aichat.config.json's model on every turn, else the agent's own (opencode-channel routedModel)
    const ref = str(config.model) ?? str(oc.model);
    const [base, variant] = ref ? ref.split("#") : [null, null];
    model.push({ key: "model", label: "Модель", value: base ?? null, note: config.model ? CONFIGURED : ref ? "opencode.jsonc (успадковано)" : CONFIGURED });
    model.push({ key: "effort", label: "Effort (варіант)", value: variant ?? null, note: config.model ? CONFIGURED : ref ? "opencode.jsonc (успадковано)" : CONFIGURED });
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
  const own = readSettings(root).start?.[agent.folder];
  if (agent.type === "claude") {
    // the person's Claude command; the start script adds the channel flags and the session (AIChat 3443-3450)
    const mine = own && !/start\.ps1/i.test(own);
    launch.push({ key: "command", label: "Команда запуску", value: claudeCommand(own), note: mine ? ".manager.json" : "типова" });
    launch.push({
      key: "startScript",
      label: "Як запускається",
      value: hasStartScript(agent.dir) ? `start.ps1 → ${claudeCommand(own)} --resume <остання сесія> ${CLAUDE_CHANNEL_FLAGS}` : `${command}`,
      note: hasStartScript(agent.dir) ? "start.ps1" : "без start.ps1: сесія не продовжується",
    });
  } else
    // a background agent has no command by default: null, so saving the form unchanged does not invent one
    launch.push({ key: "command", label: "Команда запуску", value: command, note: own ? ".manager.json" : command ? "типова" : "типова: у фоні, node <адаптер> run" });
  if (agent.type === "codex" || agent.type === "agy") add(launch, "attachPort", "Порт інтерактивної сесії", config.attachPort ?? null);
  if (agent.type !== "claude") add(launch, "session", "Сесія при старті", config.session ?? "resume");
  if (agent.status?.pid) add(launch, "pid", "Процес", agent.status.pid, agent.status.alive ? "працює" : "не працює");
  add(launch, "start", "Як почалась сесія", str(status.start) ?? undefined, ACTUAL);

  // what the page may change (3b): every editable setting is there, set or not, with how to edit it
  const lists = { connection, behavior, launch, model } as const;
  for (const [key, field] of Object.entries(editableFields(agent))) {
    const list = lists[field.section];
    let entry = list.find((i) => i.key === key);
    if (!entry) {
      entry = { key, label: field.label, value: null, note: CONFIGURED };
      list.push(entry);
    }
    entry.edit = field.edit;
  }

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

interface EditableField {
  section: "connection" | "behavior" | "launch" | "model";
  label: string;
  edit: EditSpec;
  /**
   * Where it is written: the agent's aichat.config.json; the manager's .manager.json (the start command); a flag of
   * a Claude agent's command; Codex's config.toml; OpenCode's model reference in aichat.config.json (model#variant).
   */
  file: "config" | "manager" | "claudeFlag" | "codexToml" | "opencodeModel";
}

/** Model levels a Claude command takes (`claude --help`: --effort). */
const CLAUDE_EFFORT = ["low", "medium", "high", "xhigh", "max"];
/** Examples from Codex's reference; the real set depends on the model (codex-alexey, 3460). */
const CODEX_EFFORT = ["low", "medium", "high", "xhigh", "max", "ultra"];

/** The settings the page may change for this agent (AIChat 3343-3345); owners, permissions, token, instructions stay manual. */
export function editableFields(agent: LocalAgent): Record<string, EditableField> {
  const fields: Record<string, EditableField> = {
    command: { section: "launch", label: "Команда запуску", edit: { type: "text", max: 500, optional: true }, file: "manager" },
  };
  // model and effort for every kind (alexey, 3447); they apply after a restart (OpenCode: in a new session)
  const model = (file: EditableField["file"], suggestions?: string[]): EditableField => ({
    section: "model",
    label: "Модель",
    edit: { type: "text", max: 200, optional: true, ...(suggestions ? { suggestions } : {}) },
    file,
  });
  if (agent.type === "claude")
    return Object.assign(fields, {
      model: model("claudeFlag", ["fable", "opus", "sonnet"]),
      effort: { section: "model", label: "Effort", edit: { type: "enum", options: CLAUDE_EFFORT, optional: true }, file: "claudeFlag" },
    } satisfies Record<string, EditableField>);
  if (agent.type === "codex")
    Object.assign(fields, {
      model: model("codexToml"),
      effort: { section: "model", label: "Effort", edit: { type: "text", max: 40, optional: true, suggestions: CODEX_EFFORT }, file: "codexToml" },
    } satisfies Record<string, EditableField>);
  if (agent.type === "opencode")
    Object.assign(fields, {
      model: model("opencodeModel"),
      effort: { section: "model", label: "Effort (варіант)", edit: { type: "text", max: 40, optional: true }, file: "opencodeModel" },
    } satisfies Record<string, EditableField>);
  if (agent.type === "agy") Object.assign(fields, { model: model("config") });
  Object.assign(fields, {
    rooms: { section: "connection", label: "Кімнати (при старті)", edit: { type: "list" }, file: "config" },
    wake: { section: "behavior", label: "Будити", edit: { type: "enum", options: ["always", "mention", "never"] }, file: "config" },
    paused: { section: "behavior", label: "На паузі", edit: { type: "bool" }, file: "config" },
    maxWakesPerMinute: { section: "behavior", label: "Пробуджень за хвилину, не більше", edit: { type: "int", min: 1, max: 600, optional: true }, file: "config" },
    sessionTitle: { section: "behavior", label: "Назва сесії", edit: { type: "text", max: 100, optional: true }, file: "config" },
    session: { section: "launch", label: "Сесія при старті", edit: { type: "enum", options: ["resume", "new"] }, file: "config" },
  } satisfies Record<string, EditableField>);
  if (agent.type === "codex" || agent.type === "agy")
    Object.assign(fields, {
      delivery: { section: "behavior", label: "Доставка", edit: { type: "enum", options: ["steer", "queue"] }, file: "config" },
      attachPort: { section: "launch", label: "Порт інтерактивної сесії", edit: { type: "int", min: 1024, max: 65535, optional: true }, file: "config" },
    } satisfies Record<string, EditableField>);
  return fields;
}

/** A setting the page sent that cannot be saved; `field` lets the form mark it. */
export class SettingError extends ActionError {
  constructor(
    message: string,
    readonly field?: string,
  ) {
    super(message, 400);
  }
}

/** The value checked against its spec: what goes into the file, or undefined to remove the key. */
function checked(key: string, spec: EditSpec, raw: unknown): unknown {
  const fail = (why: string): never => {
    throw new SettingError(`${key}: ${why}`, key);
  };
  const optional = "optional" in spec && spec.optional;
  if (raw === null || raw === "") {
    if (optional) return undefined;
    fail("потрібне значення");
  }
  switch (spec.type) {
    case "enum":
      if (typeof raw !== "string" || !spec.options.includes(raw)) fail(`одне з ${spec.options.join(", ")}`);
      return raw;
    case "bool":
      if (typeof raw !== "boolean") fail("так або ні");
      return raw;
    case "int": {
      const n = typeof raw === "string" ? Number(raw.trim()) : raw;
      if (typeof n !== "number" || !Number.isInteger(n) || n < spec.min || n > spec.max) fail(`ціле число від ${spec.min} до ${spec.max}`);
      return n;
    }
    case "text": {
      if (typeof raw !== "string") return fail("має бути текст");
      if (raw.length > spec.max) fail(`не довше ${spec.max} знаків`);
      if (/[\r\n\0]/.test(raw)) fail("в один рядок");
      return raw.trim() || (optional ? undefined : fail("потрібне значення"));
    }
    case "list": {
      const items = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/[\s,]+/) : fail("список");
      const out = [...new Set(items.map((x) => String(x).trim().replace(/^#/, "")).filter(Boolean))];
      const bad = out.find((r) => !ROOM_RE.test(r));
      if (bad !== undefined) fail(`«${bad}» не схоже на назву кімнати`);
      return out;
    }
  }
}

/** Writes `file` through a temporary file, keeping the previous one as `<file>.bak`. */
function writeAtomic(file: string, text: string) {
  if (existsSync(file)) copyFileSync(file, `${file}.bak`);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

/**
 * Saves the settings the page changed (`set`: key → value, null to remove). Everything is checked before anything
 * is written; other keys of the files stay as they were.
 */
export function writeAgentSettings(agent: LocalAgent, root: string, set: unknown, others: LocalAgent[] = []): string {
  if (!set || typeof set !== "object" || Array.isArray(set) || !Object.keys(set).length) throw new SettingError("немає змін");
  const fields = editableFields(agent);
  const config: Record<string, unknown> = {};
  let command: string | null | undefined;
  const flags: Record<string, string | undefined> = {};
  const toml: Record<string, string | undefined> = {};
  const ocRef: { model?: string | null; effort?: string | null } = {};
  for (const [key, raw] of Object.entries(set as Record<string, unknown>)) {
    const field = fields[key];
    if (!field) throw new SettingError(`${key}: це налаштування тут не змінюється`, key);
    const value = checked(key, field.edit, raw) as string | undefined;
    if (field.section === "model" && typeof value === "string" && !/^[\w.:/@+-]+$/.test(value))
      throw new SettingError(`${key}: лише літери, цифри та . : / @ + - _`, key);
    if (field.file === "manager") command = value ?? null;
    else if (field.file === "claudeFlag") flags[key] = value;
    else if (field.file === "codexToml") toml[key === "effort" ? "model_reasoning_effort" : key] = value;
    else if (field.file === "opencodeModel") ocRef[key as "model" | "effort"] = value ?? null;
    else config[key] = value;
  }
  // OpenCode: model and effort are one reference, provider/model#variant
  if ("model" in ocRef || "effort" in ocRef) {
    const current = String((readJson(join(agent.dir, "aichat.config.json")) ?? {}).model ?? "");
    const [base, variant] = current ? current.split("#") : ["", ""];
    const m = "model" in ocRef ? ocRef.model : base || null;
    const e = "effort" in ocRef ? ocRef.effort : variant || null;
    if (m && !/^[^/#]+\/[^/#]+$/.test(m)) throw new SettingError("model: у вигляді провайдер/модель, наприклад litellm/main-model", "model");
    if (!m && e) throw new SettingError("effort: спершу задайте модель", "effort");
    config.model = m ? (e ? `${m}#${e}` : m) : undefined;
  }
  // Claude: the flags go into the person's command in .manager.json
  if (Object.keys(flags).length) {
    let words = splitCommand(command === undefined ? claudeCommand(readSettings(root).start?.[agent.folder]) : (command ?? "claude"));
    for (const [key, value] of Object.entries(flags)) words = withFlag(words, `--${key}`, value);
    command = joinCommand(words);
  }
  // an attach port another agent here already uses would make one of the two terminals talk to the wrong agent
  const port = config.attachPort;
  if (typeof port === "number") {
    const taken = others.find((o) => o.folder !== agent.folder && o.attachPort === port);
    if (taken) throw new SettingError(`attachPort: порт ${port} уже має ${taken.folder}`, "attachPort");
  }

  if (Object.keys(config).length) {
    const file = join(agent.dir, "aichat.config.json");
    const text = readText(file);
    let current: Record<string, unknown> = {};
    if (text !== null) {
      try {
        current = JSON.parse(text) as Record<string, unknown>;
      } catch {
        throw new SettingError("aichat.config.json не читається як JSON: виправте його вручну");
      }
    }
    for (const [k, v] of Object.entries(config)) {
      if (v === undefined) delete current[k];
      else current[k] = v;
    }
    writeAtomic(file, JSON.stringify(current, null, 2) + "\n");
  }
  if (Object.keys(toml).length) {
    const config = readJson(join(agent.dir, "aichat.config.json")) ?? {};
    // never the person's own ~/.codex: that is Codex Desktop's profile, not this agent's (codex-alexey, 3463)
    if (!str(config.codexHome)) throw new SettingError("у цього агента немає окремого codexHome: модель Codex тут не змінюється", Object.keys(toml)[0] === "model" ? "model" : "effort");
    const file = join(expand(String(config.codexHome), agent.dir), "config.toml");
    let text = readText(file) ?? "";
    for (const [k, v] of Object.entries(toml)) text = withTomlTop(text, k, v);
    writeAtomic(file, text);
  }
  if (command !== undefined) {
    const file = join(root, ".manager.json");
    const settings = readSettings(root) as { start?: Record<string, string> } & Record<string, unknown>;
    const start = { ...(settings.start ?? {}) };
    if (command === null) delete start[agent.folder];
    else start[agent.folder] = command;
    writeAtomic(file, JSON.stringify({ ...settings, start }, null, 2) + "\n");
  }
  const names = Object.keys(set as object).join(", ");
  return `Збережено: ${names}.`;
}

/** A command line as words, the way a shell splits it: quotes keep spaces, and are dropped. */
export function splitCommand(command: string): string[] {
  const words: string[] = [];
  for (const m of command.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) words.push(m[1] ?? m[2] ?? m[3]);
  return words;
}

/** Words back into a command line, quoting the ones with spaces. */
export function joinCommand(words: string[]): string {
  return words.map((w) => (/[\s"]/.test(w) || w === "" ? `"${w.replace(/"/g, "")}"` : w)).join(" ");
}

/** The value after `flag` (`--model opus` or `--model=opus`), if the words have it. */
export function flagValue(words: string[], flag: string): string | null {
  for (let i = 0; i < words.length; i++) {
    if (words[i] === flag) return words[i + 1] ?? null;
    if (words[i].startsWith(`${flag}=`)) return words[i].slice(flag.length + 1);
  }
  return null;
}

/** The words with `flag` set to `value`, or without it when `value` is undefined. */
export function withFlag(words: string[], flag: string, value: string | undefined): string[] {
  const out: string[] = [];
  for (let i = 0; i < words.length; i++) {
    if (words[i] === flag) {
      i++;
      continue;
    }
    if (words[i].startsWith(`${flag}=`)) continue;
    out.push(words[i]);
  }
  if (value !== undefined) out.push(flag, value);
  return out;
}

/**
 * A top-level key of a TOML file set to a string, or removed: only its own line changes, so comments and tables stay
 * as they are (Codex's config.toml, AIChat 3459).
 */
export function withTomlTop(text: string, key: string, value: string | undefined): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.length ? text.split(/\r?\n/) : [];
  const firstTable = lines.findIndex((l) => /^\s*\[/.test(l));
  const end = firstTable < 0 ? lines.length : firstTable;
  // the key bare or quoted ("model" = …, 'model' = …), so a second one is never added next to it (codex-alexey, 3463)
  const at = lines.slice(0, end).findIndex((l) => new RegExp(`^\\s*(?:${key}|"${key}"|'${key}')\\s*=`).test(l));
  const line = value === undefined ? null : `${key} = ${JSON.stringify(value)}`;
  if (at >= 0) {
    if (line === null) lines.splice(at, 1);
    else lines[at] = line;
  } else if (line !== null) {
    // after the leading comments and keys, before the first table
    let pos = end;
    while (pos > 0 && lines[pos - 1].trim() === "") pos--;
    lines.splice(pos, 0, line);
  }
  return lines.join(eol);
}
