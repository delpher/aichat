// Stage 3c.3 of the agent manager (AIChat #aichat-manager-dev, 3350-3352, 3484): the extra folders an agent may work
// in. A danger zone (alexey, 3352): the manager does not decide for the person which folders are allowed, but adding
// one needs the path typed a second time; removing one (less access) does not. Each kind in its own file:
// - agy: addDirs in aichat.config.json;
// - Codex: writable_roots in [sandbox_workspace_write] of its own CODEX_HOME config.toml;
// - Claude Code: permissions.additionalDirectories in .claude/settings.local.json;
// - OpenCode: none — its server has no sandbox, so a list would only pretend (opencode-alexey, 3473).
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, normalize, resolve } from "node:path";
import type { LocalAgent } from "./agents.js";
import { SettingError } from "./settings.js";

const readJson = (file: string): Record<string, unknown> | null => {
  try {
    return JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, "")) as Record<string, unknown>;
  } catch {
    return null;
  }
};

const expand = (p: string, base: string) => {
  const home = p === "~" || p.startsWith("~/") || p.startsWith("~\\") ? join(homedir(), p.slice(1)) : p;
  return isAbsolute(home) ? home : resolve(base, home);
};

function writeAtomic(file: string, text: string) {
  if (existsSync(file)) copyFileSync(file, `${file}.bak`);
  mkdirSync(join(file, ".."), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
/** Two paths name the same folder (Windows: any case, either slash, no trailing slash). */
const same = (a: string, b: string) => {
  const n = (p: string) => normalize(p).replace(/[\\/]+$/, "").toLowerCase();
  return n(a) === n(b);
};

/**
 * An array key of a TOML table set to `values` (one line), or removed when `values` is empty; the table is added at
 * the end when missing. Other lines stay as they are.
 */
export function withTomlTableArray(text: string, table: string, key: string, values: string[]): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.length ? text.split(/\r?\n/) : [];
  const line = `${key} = [${values.map((v) => JSON.stringify(v)).join(", ")}]`;
  const header = lines.findIndex((l) => new RegExp(`^\\s*\\[\\s*${table}\\s*\\]\\s*(#.*)?$`).test(l));
  if (header < 0) {
    if (!values.length) return text;
    while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
    lines.push("", `[${table}]`, line, "");
    return lines.join(eol);
  }
  let end = lines.findIndex((l, i) => i > header && /^\s*\[/.test(l));
  if (end < 0) end = lines.length;
  const at = lines.findIndex((l, i) => i > header && i < end && new RegExp(`^\\s*${key}\\s*=`).test(l));
  if (at >= 0) {
    // the old value may run over several lines, up to its closing bracket
    let last = at;
    while (last < end - 1 && !lines[last].includes("]")) last++;
    lines.splice(at, last - at + 1, ...(values.length ? [line] : []));
  } else if (values.length) lines.splice(header + 1, 0, line);
  return lines.join(eol);
}

export interface DirsChange {
  add?: unknown;
  /** The path typed a second time; must be the same as `add`. */
  confirm?: unknown;
  remove?: unknown;
}

/** Where the agent's extra folders live and how to write them, or why it has none. */
function storeOf(agent: LocalAgent): { read: () => string[]; write: (dirs: string[]) => void } {
  const at = (...p: string[]) => join(agent.dir, ...p);
  if (agent.type === "opencode") throw new SettingError("OpenCode не має пісочниці: тут теки ні на що не впливають", "dirs");
  if (agent.type === "agy") {
    const file = at("aichat.config.json");
    const config = () => {
      const c = readJson(file);
      if (!c) throw new SettingError("aichat.config.json не читається як JSON: виправте його вручну", "dirs");
      return c;
    };
    return {
      read: () => strings(config().addDirs),
      write: (dirs) => writeAtomic(file, JSON.stringify({ ...config(), addDirs: dirs }, null, 2) + "\n"),
    };
  }
  if (agent.type === "codex") {
    const config = readJson(at("aichat.config.json")) ?? {};
    if (typeof config.codexHome !== "string" || !config.codexHome)
      throw new SettingError("у цього агента немає окремого codexHome: теки Codex тут не змінюються", "dirs");
    const file = join(expand(config.codexHome, agent.dir), "config.toml");
    const text = () => (existsSync(file) ? readFileSync(file, "utf8") : "");
    return {
      read: () => {
        const m = /^\s*\[\s*sandbox_workspace_write\s*\][^\n]*\n([\s\S]*?)(?=^\s*\[|$(?![\s\S]))/m.exec(text());
        const body = m?.[1] ?? "";
        const value = /^\s*writable_roots\s*=\s*\[([\s\S]*?)\]/m.exec(body)?.[1] ?? "";
        return [...value.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'/g)].map((x) => (x[1] !== undefined ? (JSON.parse(`"${x[1]}"`) as string) : x[2]));
      },
      write: (dirs) => writeAtomic(file, withTomlTableArray(text(), "sandbox_workspace_write", "writable_roots", dirs)),
    };
  }
  const file = at(".claude", "settings.local.json");
  const settings = () => {
    const s = existsSync(file) ? readJson(file) : {};
    if (!s) throw new SettingError(".claude/settings.local.json не читається як JSON: виправте його вручну", "dirs");
    return s;
  };
  return {
    read: () => strings((settings().permissions as Record<string, unknown> | undefined)?.additionalDirectories),
    write: (dirs) => {
      const s = settings();
      const permissions = { ...((s.permissions as Record<string, unknown>) ?? {}), additionalDirectories: dirs };
      writeAtomic(file, JSON.stringify({ ...s, permissions }, null, 2) + "\n");
    },
  };
}

/** Adds or removes one extra folder of `agent`. */
export function changeDirs(agent: LocalAgent, change: DirsChange): string {
  const store = storeOf(agent);
  const dirs = store.read();
  if (typeof change.remove === "string" && change.remove) {
    const kept = dirs.filter((d) => !same(d, change.remove as string));
    if (kept.length === dirs.length) throw new SettingError(`теки ${change.remove} у списку немає`, "dirs");
    store.write(kept);
    return `Теку ${change.remove} прибрано. Перезапустіть агента.`;
  }
  const add = typeof change.add === "string" ? change.add.trim() : "";
  if (!add) throw new SettingError("вкажіть теку", "dirs");
  if (!isAbsolute(add)) throw new SettingError("потрібен повний шлях, наприклад D:\\Projects\\repo", "dirs");
  let isDir = false;
  try {
    isDir = statSync(add).isDirectory();
  } catch {
    // no such folder
  }
  if (!isDir) throw new SettingError(`теки ${add} немає`, "dirs");
  // the danger zone: the person types the path once more (alexey, 3352)
  if (typeof change.confirm !== "string" || change.confirm.trim() !== add)
    throw new SettingError("щоб дати агенту доступ, введіть шлях іще раз точно так само", "confirm");
  if (dirs.some((d) => same(d, add))) throw new SettingError(`тека ${add} уже у списку`, "dirs");
  store.write([...dirs, normalize(add)]);
  return `Агент отримав доступ до ${normalize(add)}. Перезапустіть агента.${codexModeWarning(agent)}`;
}

/** Codex's writable_roots count only in workspace-write mode (opencode-alexey, 3485): say so when the mode is other. */
function codexModeWarning(agent: LocalAgent): string {
  if (agent.type !== "codex") return "";
  const config = readJson(join(agent.dir, "aichat.config.json")) ?? {};
  if (typeof config.codexHome !== "string") return "";
  const file = join(expand(config.codexHome, agent.dir), "config.toml");
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  const top = text.split(/^\s*\[/m)[0];
  const mode = /^\s*sandbox_mode\s*=\s*["']([^"']+)["']/m.exec(top)?.[1] ?? "типовий";
  return mode === "workspace-write" ? "" : ` Увага: пісочниця Codex зараз «${mode}», а цей список діє лише в режимі workspace-write.`;
}
