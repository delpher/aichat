import { useState } from "react";
import { AuthError } from "../../api/http";
import { useChat } from "../../context";
import { plural } from "../../lib/format";
import { ListSkeleton } from "../Skeleton";
import { UsageList } from "../usage/UsageList";
import { useUsage } from "../usage/useUsage";
import { Status, type StatusValue } from "./Status";

const MAX_ACCOUNTS = 5;

/**
 * A person's own page of usage: the accounts they name (by e-mail; the broker keeps only hashes) and the limits
 * and sessions of the agents working on them. An admin also sees every other agent that reports.
 */
export function UsagePanel() {
  const { api, session, fail } = useChat();
  const { reports, accounts, error, load } = useUsage();
  const admin = session.mode === "admin";
  const [emails, setEmails] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<StatusValue>(null);

  const save = async (list: string[]) => {
    setBusy(true);
    setStatus(null);
    try {
      const d = await api.send<{ accounts: number }>("PUT", "/api/me/accounts", { emails: list });
      setEmails("");
      setStatus({ text: d.accounts ? "Збережено." : "Акаунти прибрано.", ok: true });
      await load();
    } catch (err) {
      if (err instanceof AuthError) return fail(err, "");
      setStatus({ text: (err as Error).message, error: true });
    } finally {
      setBusy(false);
    }
  };
  const typed = emails
    .split(/[\s,;]+/)
    .map((e) => e.trim())
    .filter(Boolean);

  if (!reports)
    return (
      <div className="panel">
        <ListSkeleton rows={3} />
      </div>
    );

  const mine = reports.filter((r) => r.account && accounts.includes(r.account));
  const others = reports.filter((r) => !mine.includes(r));
  const own = (account: string) => {
    const i = accounts.indexOf(account);
    return accounts.length > 1 ? `Ваш акаунт ${i + 1}` : "Ваш акаунт";
  };

  return (
    <div className="panel">
      <section className="section">
        <h2>Ваші акаунти</h2>
        <p className="muted small">
          Вкажіть email, яким ви входите в Claude. Агенти, що працюють на цьому акаунті, надсилають свої ліміти й витрати, і вони з'являться тут.
          Брокер зберігає не адресу, а лише її хеш, тож показати її потім не зможе.
        </p>
        <p className="num">
          {accounts.length
            ? `Задано ${accounts.length} ${plural(accounts.length, ["акаунт", "акаунти", "акаунтів"])}.`
            : "Акаунтів ще не задано."}
        </p>
        <form
          className="card"
          onSubmit={(e) => {
            e.preventDefault();
            if (typed.length) void save(typed);
          }}
        >
          <label className="field">
            <span>
              Email акаунтів <small>до {MAX_ACCOUNTS}, через пробіл або з нового рядка</small>
            </span>
            <textarea value={emails} onChange={(e) => setEmails(e.target.value)} rows={2} disabled={busy} autoComplete="email" />
          </label>
          <p className="muted small">Збереження замінює весь список, тож вкажіть усі свої акаунти разом.</p>
          <div className="actions">
            <button type="submit" className="btn primary" disabled={busy || !typed.length}>
              Зберегти
            </button>
            {accounts.length > 0 && (
              <button type="button" className="btn quiet" disabled={busy} onClick={() => void save([])}>
                Прибрати всі
              </button>
            )}
            <Status value={status} />
          </div>
        </form>
      </section>

      <section className="section">
        <h2>Ваші агенти</h2>
        {error && <p className="status error">{error}</p>}
        {mine.length ? (
          <UsageList reports={mine} label={own} />
        ) : (
          <p className="muted small">
            {accounts.length
              ? "Жоден агент на ваших акаунтах ще не надіслав даних. Їх надсилає рядок статусу Claude Code агента: команда підключення з «Інструкції» налаштовує його сама (--statusline)."
              : "Коли ви задасте акаунт, тут з'являться агенти, що на ньому працюють."}
          </p>
        )}
      </section>

      {admin && (
        <section className="section">
          <h2>Інші агенти</h2>
          {others.length ? (
            <UsageList reports={others} label={(account) => `Акаунт ${account.slice(0, 6)}`} />
          ) : (
            <p className="muted small">Інші агенти даних про використання не надсилали.</p>
          )}
        </section>
      )}
    </div>
  );
}
