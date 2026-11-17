import { readFileSync, statSync, writeFileSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { NAME_RE, ROOM_RE } from "../protocol.js";

export interface AgentConfig {
  name: string;
  token: string;
  /** Free-form label shown to other agents: "claude", "openai", "human", ... */
  kind: string;
  description?: string;
  /** If set, the broker POSTs every message for this agent to this URL. */
  webhook?: string;
  /** Rooms this agent is put into automatically. */
  rooms?: string[];
  /** A human whose own token also opens the admin web UI and /admin/api. */
  admin?: boolean;
}

export interface BrokerConfig {
  host: string;
  port: number;
  db: string;
  /** Longest allowed reply chain. Stops two agents from answering each other forever. */
  maxHops: number;
  /** Messages one agent may send per minute. */
  ratePerMinute: number;
  maxTextLength: number;
  /** Largest file one upload may be, in megabytes. */
  maxFileSizeMB: number;
  /** Most notes one agent may keep in its notebook. */
  maxNotes: number;
  /** Longest note, in characters. */
  maxNoteLength: number;
  /**
   * Waking agents: "on" stops sending an agent that comes back the room messages it missed (direct messages
   * and game rooms still arrive) and reports them as a wake instead; "off" (default) delivers everything.
   */
  wakeMode: WakeMode;
  /** An agent away at least this many minutes is woken. */
  wakeAfterMinutes: number;
  /** An agent that missed at least this many room messages is woken, however short its absence. */
  wakeAfterMessages: number;
  /** No longer used: admins are people with `admin: true`. Ignored (with a warning) if still present. */
  adminToken?: string;
  /** Broker address as agents on other machines see it (http://host:port); used in setup instructions. */
  publicUrl?: string;
  /** Folder of the AIChat project on agents' machines; used in setup instructions. */
  projectDir?: string;
  /** Where the broker looks for new releases (web UI → Settings → Version). */
  updates?: UpdateSettings;
  agents: AgentConfig[];
}

export interface UpdateSettings {
  /** GitHub repository "owner/name"; defaults to delpher/aichat. */
  repo?: string;
  /** GitHub token with read access to the repository's contents; needed while it is private. */
  token?: string;
  /** Also offer prereleases (v1.2.3-rc.1). */
  prerelease?: boolean;
}

export const REPO_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;

/** Checks update settings from an untrusted source; an empty repo or token means "remove". */
export function checkUpdateSettings(patch: unknown): Partial<Record<keyof UpdateSettings, string | boolean>> {
  if (typeof patch !== "object" || patch === null || Array.isArray(patch)) throw new Error("update settings must be an object");
  const out: Partial<Record<keyof UpdateSettings, string | boolean>> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (k === "prerelease") {
      if (typeof v !== "boolean") throw new Error("prerelease must be true or false");
      out.prerelease = v;
    } else if (k === "repo" || k === "token") {
      if (typeof v !== "string") throw new Error(`${k} must be a string`);
      const t = v.trim();
      if (k === "repo" && t && !REPO_RE.test(t)) throw new Error("repo must look like owner/name");
      if (k === "token" && (t.length > 400 || /\s/.test(t))) throw new Error("token looks wrong");
      out[k] = t;
    } else throw new Error(`unknown update setting: ${k}`);
  }
  if (!Object.keys(out).length) throw new Error("nothing to change");
  return out;
}

export const DEFAULTS: Omit<BrokerConfig, "agents"> = {
  host: "127.0.0.1",
  port: 8787,
  db: "data/aichat.db",
  maxHops: 8,
  ratePerMinute: 30,
  maxTextLength: 20000,
  maxFileSizeMB: 20,
  maxNotes: 200,
  maxNoteLength: 2000,
  wakeMode: "off",
  wakeAfterMinutes: 10,
  wakeAfterMessages: 10,
};

export const WAKE_MODES = ["off", "on"] as const;
export type WakeMode = (typeof WAKE_MODES)[number];

/** Settings the admin may change at runtime from the web UI, with their allowed ranges. */
export const SETTING_LIMITS = {
  maxHops: { min: 1, max: 100 },
  ratePerMinute: { min: 1, max: 10_000 },
  maxTextLength: { min: 100, max: 1_000_000 },
  maxFileSizeMB: { min: 1, max: 500 },
  maxNotes: { min: 1, max: 10_000 },
  maxNoteLength: { min: 100, max: 100_000 },
  wakeAfterMinutes: { min: 1, max: 10_080 },
  wakeAfterMessages: { min: 1, max: 100_000 },
} as const;
export type SettingName = keyof typeof SETTING_LIMITS;
/** Free-text settings; an empty string means "not set". */
export const TEXT_SETTINGS = ["publicUrl", "projectDir"] as const;
export type TextSettingName = (typeof TEXT_SETTINGS)[number];
export type Settings = Pick<BrokerConfig, SettingName | "wakeMode"> & Record<TextSettingName, string>;

export function settingsOf(cfg: BrokerConfig): Settings {
  return {
    maxHops: cfg.maxHops,
    ratePerMinute: cfg.ratePerMinute,
    maxTextLength: cfg.maxTextLength,
    maxFileSizeMB: cfg.maxFileSizeMB,
    maxNotes: cfg.maxNotes,
    maxNoteLength: cfg.maxNoteLength,
    wakeMode: cfg.wakeMode,
    wakeAfterMinutes: cfg.wakeAfterMinutes,
    wakeAfterMessages: cfg.wakeAfterMessages,
    publicUrl: cfg.publicUrl ?? "",
    projectDir: cfg.projectDir ?? "",
  };
}

function checkTextSetting(k: TextSettingName, v: unknown): string {
  if (typeof v !== "string") throw new Error(`${k} must be a string`);
  const t = v.trim();
  if (t.length > 500) throw new Error(`${k} is longer than 500 characters`);
  if (k === "publicUrl" && t) {
    let u: URL;
    try {
      u = new URL(t);
    } catch {
      throw new Error("publicUrl must be an http(s) address like http://aichat.lan:8787");
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("publicUrl must start with http:// or https://");
    return t.replace(/\/+$/, "");
  }
  return t;
}

function checkWakeMode(v: unknown): WakeMode {
  if (!(WAKE_MODES as readonly unknown[]).includes(v)) throw new Error(`wakeMode must be one of: ${WAKE_MODES.join(", ")}`);
  return v as WakeMode;
}

/** Checks a partial settings object from an untrusted source; returns it typed or throws with a readable message. */
export function checkSettingsPatch(patch: unknown): Partial<Settings> {
  if (typeof patch !== "object" || patch === null || Array.isArray(patch)) throw new Error("settings must be an object");
  const entries = Object.entries(patch);
  if (!entries.length) throw new Error("nothing to change");
  const out: Partial<Settings> = {};
  for (const [k, v] of entries) {
    if (k === "wakeMode") {
      out.wakeMode = checkWakeMode(v);
      continue;
    }
    if ((TEXT_SETTINGS as readonly string[]).includes(k)) {
      (out as Record<string, unknown>)[k] = checkTextSetting(k as TextSettingName, v);
      continue;
    }
    if (!(k in SETTING_LIMITS)) throw new Error(`unknown setting: ${k}`);
    const { min, max } = SETTING_LIMITS[k as SettingName];
    if (typeof v !== "number" || !Number.isInteger(v)) throw new Error(`${k} must be an integer`);
    if (v < min || v > max) throw new Error(`${k} must be between ${min} and ${max}`);
    out[k as SettingName] = v;
  }
  return out;
}

export function validate(raw: Partial<BrokerConfig>): BrokerConfig {
  const cfg: BrokerConfig = { ...DEFAULTS, ...raw, agents: raw.agents ?? [] };
  for (const k of Object.keys(SETTING_LIMITS) as SettingName[]) {
    const v = cfg[k];
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1) throw new Error(`${k} must be a positive integer`);
  }
  for (const k of TEXT_SETTINGS) if (cfg[k] != null) checkTextSetting(k, cfg[k]);
  checkWakeMode(cfg.wakeMode);
  if (cfg.updates != null) {
    const u = cfg.updates;
    if (typeof u !== "object" || Array.isArray(u)) throw new Error("updates must be an object");
    if (u.repo != null && (typeof u.repo !== "string" || !REPO_RE.test(u.repo))) throw new Error("updates.repo must look like owner/name");
    if (u.token != null && typeof u.token !== "string") throw new Error("updates.token must be a string");
    if (u.prerelease != null && typeof u.prerelease !== "boolean") throw new Error("updates.prerelease must be true or false");
  }
  const names = new Set<string>();
  const tokens = new Set<string>();
  for (const a of cfg.agents) {
    if (!NAME_RE.test(a.name)) throw new Error(`invalid agent name: ${a.name}`);
    if (a.name === "aichat") throw new Error(`the name "aichat" is reserved for messages from the broker itself`);
    if (names.has(a.name)) throw new Error(`duplicate agent name: ${a.name}`);
    if (!a.token || a.token.length < 16) throw new Error(`agent ${a.name}: token must be at least 16 characters`);
    if (tokens.has(a.token)) throw new Error(`agent ${a.name}: token is shared with another agent`);
    for (const r of a.rooms ?? []) if (!ROOM_RE.test(r)) throw new Error(`agent ${a.name}: invalid room ${r}`);
    if (a.admin != null && typeof a.admin !== "boolean") throw new Error(`agent ${a.name}: admin must be true or false`);
    if (a.admin && a.kind !== "human") throw new Error(`agent ${a.name}: only agents of kind "human" can be admins`);
    names.add(a.name);
    tokens.add(a.token);
    a.kind ??= "agent";
  }
  return cfg;
}

/** Config file that is re-read when it changes on disk, so new agents work without a restart. */
export class ConfigFile {
  private mtime = 0;
  private cfg: BrokerConfig;

  constructor(private path: string) {
    this.cfg = this.load();
  }

  private load(): BrokerConfig {
    this.mtime = statSync(this.path).mtimeMs;
    return validate(JSON.parse(readFileSync(this.path, "utf8")));
  }

  get(): BrokerConfig {
    try {
      if (statSync(this.path).mtimeMs !== this.mtime) this.cfg = this.load();
    } catch (e) {
      console.error(`[config] keeping previous config: ${(e as Error).message}`);
    }
    return this.cfg;
  }

  /**
   * Changes the file on disk with `fn` (keeping every field it does not touch), validates the result,
   * writes it and applies it at once. Nothing is written if `fn` or validation throws.
   */
  edit(fn: (raw: Partial<BrokerConfig>) => void): BrokerConfig {
    const raw = JSON.parse(readFileSync(this.path, "utf8")) as Partial<BrokerConfig>;
    fn(raw);
    validate(structuredClone(raw));
    writeFileSync(this.path, JSON.stringify(raw, null, 2) + "\n");
    this.cfg = this.load();
    return this.cfg;
  }
}

export function newToken(): string {
  return randomBytes(24).toString("base64url");
}

export function addAgent(path: string, agent: Omit<AgentConfig, "token">): AgentConfig {
  const raw: Partial<BrokerConfig> = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { ...DEFAULTS, agents: [] };
  raw.agents ??= [];
  if (raw.agents.some((a) => a.name === agent.name)) throw new Error(`agent ${agent.name} already exists in ${path}`);
  const full: AgentConfig = { ...agent, token: newToken() };
  raw.agents.push(full);
  validate(structuredClone(raw));
  writeFileSync(path, JSON.stringify(raw, null, 2) + "\n");
  return full;
}

/**
 * Makes an existing person an admin (or takes the rights away), optionally with a new token.
 * Used on the broker's machine to create the first admin or to get back in.
 */
export function setAdmin(path: string, name: string, opts: { admin?: boolean; newToken?: boolean } = {}): AgentConfig {
  const raw: Partial<BrokerConfig> = JSON.parse(readFileSync(path, "utf8"));
  const a = raw.agents?.find((x) => x.name === name);
  if (!a) throw new Error(`no agent ${name} in ${path}; add the person with: npm run add-agent -- ${name} human --admin`);
  if (a.kind !== "human") throw new Error(`only agents of kind "human" can be admins; ${name} is "${a.kind}"`);
  if (opts.admin === false) delete a.admin;
  else a.admin = true;
  if (opts.newToken) a.token = newToken();
  validate(structuredClone(raw));
  writeFileSync(path, JSON.stringify(raw, null, 2) + "\n");
  return a;
}
