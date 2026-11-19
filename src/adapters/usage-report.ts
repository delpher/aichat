// What Claude Code tells its status line, turned into AIChat's provider-neutral usage report (POST /api/usage).
// Used by `aichat-hook.mjs statusline`; see src/adapters/aichat-hook.ts.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { accountHash } from "../usage.js";

/** The part of Claude Code's status line JSON this reads (see the statusline docs of Claude Code). */
export interface StatusInput {
  cwd?: string;
  workspace?: { project_dir?: string; current_dir?: string };
  cost?: { total_cost_usd?: number };
  context_window?: { total_input_tokens?: number; total_output_tokens?: number; used_percentage?: number | null };
  rate_limits?: Record<string, { used_percentage?: number; resets_at?: number } | undefined>;
}

export interface UsageBody {
  provider: string;
  account?: string;
  windows: { name: string; usedPct: number; resetsAt?: string }[];
  session?: { tokensIn?: number; tokensOut?: number; cost?: number; currency?: string };
  context?: { usedPct: number };
}

const num = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const pct = (x: number) => Math.min(100, Math.max(0, x));
const whole = (x: unknown) => (num(x) && x >= 0 ? Math.round(x) : undefined);

/**
 * The report for one status line update. The limit windows are whatever `rate_limits` holds (five_hour,
 * seven_day, ...): only subscriptions have them, and each window is gone once it has reset. `email` is the
 * address the session is signed in with; only its hash is sent.
 */
export function usageFromStatus(s: StatusInput, email?: string): UsageBody {
  const windows: UsageBody["windows"] = [];
  for (const [name, w] of Object.entries(s.rate_limits ?? {})) {
    if (!w || !num(w.used_percentage) || !/^[a-z0-9][a-z0-9._-]{0,39}$/.test(name)) continue;
    windows.push({
      name,
      usedPct: pct(w.used_percentage),
      ...(num(w.resets_at) ? { resetsAt: new Date(w.resets_at * 1000).toISOString() } : {}),
    });
  }
  const body: UsageBody = { provider: "anthropic", windows: windows.slice(0, 8) };
  if (email) body.account = accountHash(email);
  const session: NonNullable<UsageBody["session"]> = {};
  const tokensIn = whole(s.context_window?.total_input_tokens);
  const tokensOut = whole(s.context_window?.total_output_tokens);
  if (tokensIn !== undefined) session.tokensIn = tokensIn;
  if (tokensOut !== undefined) session.tokensOut = tokensOut;
  if (num(s.cost?.total_cost_usd) && s.cost.total_cost_usd >= 0) {
    session.cost = s.cost.total_cost_usd;
    session.currency = "USD";
  }
  if (Object.keys(session).length) body.session = session;
  const ctx = s.context_window?.used_percentage;
  if (num(ctx)) body.context = { usedPct: pct(ctx) };
  return body;
}

/**
 * The e-mail of the claude.ai account the session is signed in with, from Claude Code's own .claude.json
 * (in CLAUDE_CONFIG_DIR when set, else in the home folder). Nothing when it signs in with an API key.
 * That file holds no tokens; only `oauthAccount.emailAddress` is read.
 */
export function accountEmail(env: NodeJS.ProcessEnv = process.env, home = homedir()): string | undefined {
  const dirs = env.CLAUDE_CONFIG_DIR ? [env.CLAUDE_CONFIG_DIR, home] : [home];
  for (const dir of dirs) {
    try {
      const j = JSON.parse(readFileSync(join(dir, ".claude.json"), "utf8")) as { oauthAccount?: { emailAddress?: unknown } };
      if (typeof j.oauthAccount?.emailAddress === "string" && j.oauthAccount.emailAddress) return j.oauthAccount.emailAddress;
    } catch {
      // not there or not readable: try the next place
    }
  }
  return undefined;
}

/** Sent at most this often while something changes, so a busy session does not post on every message. */
export const MIN_GAP_MS = 15_000;
/** Sent at least this often, so the report does not look stale while nothing changes. */
export const MAX_GAP_MS = 5 * 60_000;

/** Whether to send `body` now, given what was sent last (`last`: its JSON and when). */
export function shouldSend(body: UsageBody, last: { sig?: string; at?: number } | undefined, now: number): boolean {
  if (typeof last?.at !== "number") return true;
  const gap = now - last.at;
  if (gap >= MAX_GAP_MS) return true;
  return gap >= MIN_GAP_MS && JSON.stringify(body) !== last.sig;
}

/** A short line for those who have no status line of their own: "5h 40% · 7d 15% · ctx 62%". */
export function shortLine(b: UsageBody): string {
  const label: Record<string, string> = { five_hour: "5h", seven_day: "7d" };
  const parts = b.windows.map((w) => `${label[w.name] ?? w.name} ${Math.round(w.usedPct)}%`);
  if (b.context) parts.push(`ctx ${Math.round(b.context.usedPct)}%`);
  return parts.length ? `AIChat · ${parts.join(" · ")}` : "AIChat";
}
