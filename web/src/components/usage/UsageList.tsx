import { useEffect, useState } from "react";
import type { UsageReport, UsageWindow } from "../../api/types";
import { fmtShort, fmtTime } from "../../lib/format";

const WINDOW_LABEL: Record<string, string> = {
  five_hour: "5 годин",
  seven_day: "7 днів",
  spend_limit: "Ліміт витрат",
  // OpenCode Go and OpenCode Console budgets (opencode-channel)
  rolling: "Ковзне вікно",
  weekly: "Тиждень",
  monthly: "Місяць",
  budget: "Бюджет",
};
export const windowLabel = (name: string) => WINDOW_LABEL[name] ?? name;

/** From this much a window is shown as nearly used up, and from FULL as used up. */
const WARN = 80;
const FULL = 95;

const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();

/** "о 17:00" today, "21 лист. о 09:00" on another day. */
export function resetText(iso: string, now: Date): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return sameDay(d, now) ? `о ${fmtTime(iso)}` : `${fmtShort(iso, now)} о ${fmtTime(iso)}`;
}

/** How long ago a report came: "щойно", "5 хв тому", "2 год тому", else the day. */
export function agoText(iso: string, now: Date): string {
  const s = Math.max(0, (now.getTime() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "щойно";
  if (s < 3600) return `${Math.floor(s / 60)} хв тому`;
  if (s < 86400 && sameDay(new Date(iso), now)) return `${Math.floor(s / 3600)} год тому`;
  return fmtShort(iso, now);
}

const fmtNum = (n: number) => n.toLocaleString("uk-UA");
const fmtCost = (cost: number, currency?: string) => (currency === "USD" || !currency ? `$${cost.toFixed(2)}` : `${cost.toFixed(2)} ${currency}`);

/** A minute clock, so "5 хв тому" stays true while the page is open. */
function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

function Meter({ w }: { w: UsageWindow }) {
  const pct = Math.min(100, Math.max(0, w.usedPct));
  const level = pct >= FULL ? " meter-bad" : pct >= WARN ? " meter-warn" : "";
  return (
    <div className={`meter${level}`} role="meter" aria-label={windowLabel(w.name)} aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
      <span style={{ width: `${pct}%` }} />
    </div>
  );
}

function Windows({ windows, now }: { windows: UsageWindow[]; now: Date }) {
  return (
    <table className="usage-windows">
      <tbody>
        {windows.map((w) => (
          <tr key={w.name}>
            <th scope="row">{windowLabel(w.name)}</th>
            <td className="usage-bar">
              <Meter w={w} />
            </td>
            <td className="num">{Math.round(w.usedPct)}%</td>
            <td className="muted small">{w.resetsAt ? `скидання ${resetText(w.resetsAt, now)}` : ""}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** One agent's session: context, tokens, cost and how fresh the report is. */
function sessionText(r: UsageReport): string[] {
  const parts: string[] = [];
  if (r.context) parts.push(`контекст ${Math.round(r.context.usedPct)}%`);
  const s = r.session;
  if (s?.tokensIn != null || s?.tokensOut != null) parts.push(`токени ${fmtNum(s?.tokensIn ?? 0)} / ${fmtNum(s?.tokensOut ?? 0)}`);
  if (s?.cost != null) parts.push(`${fmtCost(s.cost, s.currency)} за сесію`);
  return parts;
}

/** The newest report with limit windows: the account's limits are the same in every report on it. */
const freshestWindows = (rs: UsageReport[]) =>
  [...rs].sort((a, b) => b.at.localeCompare(a.at)).find((r) => r.windows.length)?.windows ?? [];

/**
 * Usage reports by account: the account's limits once (from its newest report that has them), then each agent
 * on it with its session. `label` names an account (its hash); reports without an account come last.
 */
export function UsageList({ reports, label }: { reports: UsageReport[]; label: (account: string, i: number) => string }) {
  const now = useNow();
  const groups = new Map<string, UsageReport[]>();
  for (const r of reports) groups.set(r.account ?? "", [...(groups.get(r.account ?? "") ?? []), r]);
  const keys = [...groups.keys()].sort((a, b) => (a === "") === (b === "") ? 0 : a === "" ? 1 : -1);
  return (
    <div className="usage-list">
      {keys.map((account, i) => {
        const rs = groups.get(account)!.sort((a, b) => a.agent.localeCompare(b.agent));
        // Without an account nothing says two agents share limits, so each agent shows its own (below).
        const windows = account ? freshestWindows(rs) : [];
        return (
          <section key={account || "unknown"} className="card usage-account">
            <h3>{account ? label(account, i) : "Акаунт невідомий"}</h3>
            {windows.length ? (
              <Windows windows={windows} now={now} />
            ) : account || !rs.some((r) => r.windows.length) ? (
              <p className="muted small">
                {account
                  ? "Лімітів не видно: їх дає лише підписка claude.ai, і лише після першої відповіді моделі в сесії."
                  : "Агент не повідомив, на якому акаунті працює (наприклад, увійшов ключем API чи працює через іншого провайдера), тож його ліміти, якщо вони є, показані окремо при ньому."}
              </p>
            ) : null}
            <ul className="usage-agents">
              {rs.map((r) => (
                <li key={r.agent}>
                  <strong>{r.agent}</strong>
                  {r.provider !== "anthropic" && <span className="muted">{r.provider}</span>}
                  {sessionText(r).map((t) => (
                    <span key={t}>{t}</span>
                  ))}
                  <span className="muted" title={`Дані від ${fmtShort(r.at, now)} ${fmtTime(r.at)}`}>
                    {agoText(r.at, now)}
                  </span>
                  {!account && r.windows.length > 0 && <Windows windows={r.windows} now={now} />}
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
