import type { UsageReport, UsageWindow } from "../protocol.js";
import { ACCOUNT_HASH_RE, accountHash } from "../usage.js";
import { MAX_ACCOUNTS } from "./config.js";

/** A usage report or an account list that cannot be taken as it is: answered with HTTP 400. */
export class UsageError extends Error {
  status = 400;
}

const ID_RE = /^[a-z0-9][a-z0-9._-]{0,39}$/;
const CURRENCY_RE = /^[A-Z]{3}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_WINDOWS = 8;

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

function percent(x: unknown, what: string): number {
  if (typeof x !== "number" || !Number.isFinite(x) || x < 0 || x > 100) throw new UsageError(`${what} must be a number from 0 to 100`);
  return x;
}

function count(x: unknown, what: string): number | undefined {
  if (x == null) return undefined;
  if (!Number.isSafeInteger(x) || (x as number) < 0) throw new UsageError(`${what} must be a whole number, 0 or more`);
  return x as number;
}

/**
 * Checks what an adapter reports (POST /api/usage) and turns it into the report the broker keeps. Fields it does
 * not know are left out rather than refused, so a newer adapter still works with this broker.
 */
export function checkUsage(agent: string, raw: Record<string, unknown>, now: Date): UsageReport {
  const { provider, account, windows = [], session, context } = raw;
  if (typeof provider !== "string" || !ID_RE.test(provider))
    throw new UsageError("provider must be a short lowercase name, e.g. \"anthropic\"");
  if (account != null && (typeof account !== "string" || !ACCOUNT_HASH_RE.test(account)))
    throw new UsageError("account must be an account hash (64 hex digits), never an address");
  if (!Array.isArray(windows)) throw new UsageError("windows must be a list");
  if (windows.length > MAX_WINDOWS) throw new UsageError(`at most ${MAX_WINDOWS} windows`);
  const seen = new Set<string>();
  const ws: UsageWindow[] = windows.map((w: unknown) => {
    if (!isObject(w)) throw new UsageError("each window must be {name, usedPct, resetsAt?}");
    if (typeof w.name !== "string" || !ID_RE.test(w.name)) throw new UsageError("a window's name must be a short lowercase name, e.g. \"five_hour\"");
    if (seen.has(w.name)) throw new UsageError(`window ${w.name} is given twice`);
    seen.add(w.name);
    const out: UsageWindow = { name: w.name, usedPct: percent(w.usedPct, `usedPct of ${w.name}`) };
    if (w.resetsAt != null) {
      const t = typeof w.resetsAt === "string" ? Date.parse(w.resetsAt) : NaN;
      if (Number.isNaN(t)) throw new UsageError(`resetsAt of ${w.name} must be an ISO time`);
      out.resetsAt = new Date(t).toISOString();
    }
    return out;
  });
  const report: UsageReport = { agent, at: now.toISOString(), provider, windows: ws };
  if (typeof account === "string") report.account = account;
  if (session != null) {
    if (!isObject(session)) throw new UsageError("session must be {tokensIn?, tokensOut?, cost?, currency?}");
    const s: NonNullable<UsageReport["session"]> = {};
    const tokensIn = count(session.tokensIn, "tokensIn");
    const tokensOut = count(session.tokensOut, "tokensOut");
    if (tokensIn !== undefined) s.tokensIn = tokensIn;
    if (tokensOut !== undefined) s.tokensOut = tokensOut;
    if (session.cost != null) {
      if (typeof session.cost !== "number" || !Number.isFinite(session.cost) || session.cost < 0)
        throw new UsageError("cost must be a number, 0 or more");
      if (typeof session.currency !== "string" || !CURRENCY_RE.test(session.currency))
        throw new UsageError("a cost needs its currency, e.g. \"USD\"");
      s.cost = session.cost;
      s.currency = session.currency;
    }
    if (Object.keys(s).length) report.session = s;
  }
  if (context != null) {
    if (!isObject(context)) throw new UsageError("context must be {usedPct}");
    report.context = { usedPct: percent(context.usedPct, "context usedPct") };
  }
  return report;
}

/** Checks the e-mails a person names as their accounts (PUT /api/me/accounts) and returns their hashes. */
export function accountHashes(raw: Record<string, unknown>): string[] {
  const { emails } = raw;
  if (!Array.isArray(emails) || !emails.every((e) => typeof e === "string"))
    throw new UsageError("emails must be a list of e-mail addresses");
  if (emails.length > MAX_ACCOUNTS) throw new UsageError(`at most ${MAX_ACCOUNTS} accounts`);
  for (const e of emails as string[])
    if (e.trim().length > 254 || !EMAIL_RE.test(e.trim())) throw new UsageError(`not an e-mail address: ${e}`);
  return [...new Set((emails as string[]).map(accountHash))];
}
