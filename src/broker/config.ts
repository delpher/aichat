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
  /** Bearer token for the web UI and /admin/api: sees every message, may post as `human` agents. */
  adminToken?: string;
  /** Broker address as agents on other machines see it (http://host:port); used in setup instructions. */
  publicUrl?: string;
  /** Folder of the AIChat project on agents' machines; used in setup instructions. */
  projectDir?: string;
  agents: AgentConfig[];
}

export const DEFAULTS: Omit<BrokerConfig, "agents"> = {
  host: "127.0.0.1",
  port: 8787,
  db: "data/aichat.db",
  maxHops: 8,
  ratePerMinute: 30,
  maxTextLength: 20000,
  maxFileSizeMB: 20,
};

/** Settings the admin may change at runtime from the web UI, with their allowed ranges. */
export const SETTING_LIMITS = {
  maxHops: { min: 1, max: 100 },
  ratePerMinute: { min: 1, max: 10_000 },
  maxTextLength: { min: 100, max: 1_000_000 },
  maxFileSizeMB: { min: 1, max: 500 },
} as const;
export type SettingName = keyof typeof SETTING_LIMITS;
/** Free-text settings; an empty string means "not set". */
export const TEXT_SETTINGS = ["publicUrl", "projectDir"] as const;
export type TextSettingName = (typeof TEXT_SETTINGS)[number];
export type Settings = Pick<BrokerConfig, SettingName> & Record<TextSettingName, string>;

export function settingsOf(cfg: BrokerConfig): Settings {
  return {
    maxHops: cfg.maxHops,
    ratePerMinute: cfg.ratePerMinute,
    maxTextLength: cfg.maxTextLength,
    maxFileSizeMB: cfg.maxFileSizeMB,
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

/** Checks a partial settings object from an untrusted source; returns it typed or throws with a readable message. */
export function checkSettingsPatch(patch: unknown): Partial<Settings> {
  if (typeof patch !== "object" || patch === null || Array.isArray(patch)) throw new Error("settings must be an object");
  const entries = Object.entries(patch);
  if (!entries.length) throw new Error("nothing to change");
  const out: Partial<Settings> = {};
  for (const [k, v] of entries) {
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
  const names = new Set<string>();
  const tokens = new Set<string>();
  for (const a of cfg.agents) {
    if (!NAME_RE.test(a.name)) throw new Error(`invalid agent name: ${a.name}`);
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
  if (cfg.adminToken != null) {
    if (cfg.adminToken.length < 16) throw new Error("adminToken must be at least 16 characters");
    if (tokens.has(cfg.adminToken)) throw new Error("adminToken is shared with an agent");
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

/** Returns the admin token from the config file, creating one if it is missing (or if `rotate`). */
export function ensureAdminToken(path: string, rotate = false): { token: string; created: boolean } {
  const raw: Partial<BrokerConfig> = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { ...DEFAULTS, agents: [] };
  if (raw.adminToken && !rotate) return { token: raw.adminToken, created: false };
  raw.adminToken = newToken();
  validate(structuredClone(raw));
  writeFileSync(path, JSON.stringify(raw, null, 2) + "\n");
  return { token: raw.adminToken, created: true };
}
