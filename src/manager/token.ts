// Stage 3c.1 of the agent manager (AIChat #aichat-manager-dev, 3350, 3472-3474): replacing an agent's broker token.
// The new token goes in through the page once and never comes back out: the manager checks it with the broker
// (GET /api/me: it must belong to this agent), writes it into the agent's token file (owner-only, through a
// temporary file, no backup copy of a secret), and for a Claude Code agent whose token sits in .mcp.json moves it
// into a file of its own (AICHAT_TOKEN_FILE). The agent picks the new token up when it restarts.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { AgentSecrets, LocalAgent } from "./agents.js";
import { makePrivate } from "./self.js";
import { SettingError } from "./settings.js";

const readJson = (file: string): Record<string, unknown> | null => {
  try {
    return JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, "")) as Record<string, unknown>;
  } catch {
    return null;
  }
};

const expand = (p: string, base: string) => {
  const home = p === "~" || p.startsWith("~/") || p.startsWith("~\\") ? join(homedir(), p.slice(1)) : p;
  return isAbsolute(home) ? home : resolve(base, home);
};

/** A secret into `file`: owner-only, through a temporary file, and no .bak (a copy of an old token is a leak). */
function writeSecret(file: string, token: string) {
  mkdirSync(join(file, ".."), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, token + "\n", { mode: 0o600 });
  makePrivate(tmp);
  renameSync(tmp, file);
  makePrivate(file);
}

/** A JSON file rewritten through a temporary file, without a backup (it held a token). */
function writeJson(file: string, value: unknown) {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  renameSync(tmp, file);
}

/**
 * What is left after a replacement (opencode-alexey, 3477): the agent reads its token when it starts, and the old
 * token stays valid at the broker until the person revokes it there; the manager never does broker admin.
 */
const AFTER = "Перезапустіть агента, щоб він узяв новий токен. Старий токен у брокера ще дійсний: якщо міняли через витік, відкличте його у вебі брокера.";

export interface TokenDeps {
  /** Who a token belongs to at the broker: its name, or null when the broker refuses it. */
  whoIs?: (broker: string, token: string) => Promise<string | null>;
  secretsDir?: string;
}

export const brokerWhoIs = async (broker: string, token: string): Promise<string | null> => {
  const res = await fetch(`${broker}/api/me`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10000) });
  if (res.status === 401 || res.status === 403) return null;
  if (!res.ok) throw new Error(`брокер відповів ${res.status}`);
  return ((await res.json()) as { name?: string }).name ?? null;
};

/**
 * Replaces the agent's token with `raw` once the broker confirms it is this agent's: the name the current token
 * gives, or the folder's name when the current token no longer works (revoked, which is why one replaces it).
 */
export async function replaceToken(agent: LocalAgent, secrets: AgentSecrets, raw: unknown, deps: TokenDeps = {}): Promise<string> {
  const whoIs = deps.whoIs ?? brokerWhoIs;
  const token = typeof raw === "string" ? raw.trim() : "";
  if (!token) throw new SettingError("потрібен новий токен", "token");
  if (/\s/.test(token)) throw new SettingError("токен — один рядок без пробілів", "token");
  if (!agent.brokerUrl) throw new SettingError("невідомо, який брокер у цього агента");
  const broker = agent.brokerUrl;
  let current: string | null = null;
  let given: string | null;
  try {
    if (secrets.token) current = await whoIs(broker, secrets.token);
    given = await whoIs(broker, token);
  } catch (e) {
    throw new SettingError(`брокер ${broker} не відповідає: ${(e as Error).message}`, "token");
  }
  const expected = current ?? agent.folder;
  if (given === null) throw new SettingError("брокер не прийняв цей токен", "token");
  if (given !== expected) throw new SettingError(`це токен агента «${given}», а не «${expected}»`, "token");

  const secretsDir = deps.secretsDir ?? join(homedir(), ".secrets");
  if (agent.type === "claude") {
    const mcpFile = join(agent.dir, ".mcp.json");
    const mcp = readJson(mcpFile);
    const servers = (mcp?.mcpServers ?? {}) as Record<string, { args?: unknown[]; env?: Record<string, string> }>;
    const entry = Object.entries(servers).find(([, s]) => s.args?.some((a) => typeof a === "string" && /claude-channel\.m?js$/.test(a)));
    if (!mcp || !entry) throw new SettingError(".mcp.json агента не читається: виправте його вручну");
    const env = { ...(entry[1].env ?? {}) };
    const file = env.AICHAT_TOKEN_FILE ? expand(env.AICHAT_TOKEN_FILE, agent.dir) : join(secretsDir, `aichat-${agent.folder}.token`);
    writeSecret(file, token);
    if (env.AICHAT_TOKEN !== undefined || !env.AICHAT_TOKEN_FILE) {
      // the token leaves .mcp.json for good: the file names it instead
      delete env.AICHAT_TOKEN;
      env.AICHAT_TOKEN_FILE = file.replace(/\\/g, "/");
      writeJson(mcpFile, { ...mcp, mcpServers: { ...servers, [entry[0]]: { ...entry[1], env } } });
      rmSync(`${mcpFile}.bak`, { force: true }); // an earlier backup may still hold the old token
      return `Токен замінено й перенесено з .mcp.json у ${file} (доступ лише власнику). ${AFTER}`;
    }
    return `Токен у ${file} замінено. ${AFTER}`;
  }

  const configFile = join(agent.dir, "aichat.config.json");
  const config = readJson(configFile);
  if (!config) throw new SettingError("aichat.config.json агента не читається: виправте його вручну");
  if (typeof config.tokenFile === "string" && config.tokenFile) {
    const file = expand(config.tokenFile, agent.dir);
    writeSecret(file, token);
    return `Токен у ${file} замінено. ${AFTER}`;
  }
  const file = join(secretsDir, `aichat-${agent.folder}.token`);
  writeSecret(file, token);
  writeJson(configFile, { ...config, tokenFile: file });
  return `Токен записано в ${file}, aichat.config.json тепер посилається на нього. ${AFTER}`;
}

