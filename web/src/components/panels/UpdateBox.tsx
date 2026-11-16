import { Download, ExternalLink, LoaderCircle, RefreshCw, Save, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { AuthError } from "../../api/http";
import type { UpdateStatus } from "../../api/types";
import { useChat } from "../../context";
import { Markdown } from "../Markdown";
import { Status, type StatusValue } from "./Status";

const fmtDate = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString("uk-UA", { dateStyle: "medium", timeStyle: "short" }) : "");

/** Waits until /health reports `version` (the broker restarted into it), up to `ms`. */
async function waitForVersion(version: string, ms: number, sleep = 2000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    await new Promise((r) => setTimeout(r, sleep));
    try {
      const h = (await (await fetch("/health", { cache: "no-store" })).json()) as { version?: string };
      if (h.version === version) return true;
    } catch {
      /* restarting */
    }
  }
  return false;
}

/** Settings → Version: the running version, new releases on GitHub and the "Update" button. */
export function UpdateBox({ reload = () => window.location.reload(), pollMs }: { reload?: () => void; pollMs?: number }) {
  const { api, fail } = useChat();
  const [s, setS] = useState<UpdateStatus | null>(null);
  const [busy, setBusy] = useState<"" | "check" | "install" | "save">("");
  const [confirm, setConfirm] = useState(false);
  const [status, setStatus] = useState<StatusValue>(null);
  const [form, setForm] = useState({ repo: "", token: "", prerelease: false });
  const live = useRef(true);

  const apply = useCallback((d: UpdateStatus) => {
    setS(d);
    setForm({ repo: d.repo, token: "", prerelease: d.prerelease });
  }, []);
  const oops = useCallback(
    (err: unknown, what: string) => (err instanceof AuthError ? fail(err, "") : setStatus({ text: `${what}: ${(err as Error).message}`, error: true })),
    [fail],
  );

  useEffect(() => {
    live.current = true;
    api
      .get<UpdateStatus>("/admin/api/update")
      .then((d) => live.current && apply(d))
      .catch((err) => oops(err, "Не вдалося завантажити"));
    return () => {
      live.current = false;
    };
  }, [api, apply, oops]);

  const check = async () => {
    setBusy("check");
    setStatus(null);
    try {
      const d = await api.send<UpdateStatus>("POST", "/admin/api/update/check");
      apply(d);
      if (!d.error && !d.updateAvailable) setStatus({ text: "Встановлено найновішу версію.", ok: true });
    } catch (err) {
      oops(err, "Не вдалося перевірити");
    } finally {
      setBusy("");
    }
  };

  const install = async (version: string) => {
    setConfirm(false);
    setBusy("install");
    setStatus({ text: `Завантажую й встановлюю ${version}…` });
    try {
      await api.send("POST", "/admin/api/update/install", { version });
      setStatus({ text: `Версію ${version} встановлено. Брокер перезапускається…` });
      if (await waitForVersion(version, 3 * 60_000, pollMs)) {
        setStatus({ text: `Готово, працює ${version}. Оновлюю сторінку…`, ok: true });
        reload();
        return;
      }
      const d = await api.get<UpdateStatus>("/admin/api/update").catch(() => null);
      if (d) apply(d);
      setStatus({ text: `Брокер не запустився з версією ${version}. Подивіться журнал брокера.`, error: true });
    } catch (err) {
      oops(err, "Не вдалося оновити");
    } finally {
      if (live.current) setBusy("");
    }
  };

  const save = async (patch: Record<string, string | boolean>) => {
    setBusy("save");
    try {
      apply(await api.send<UpdateStatus>("PATCH", "/admin/api/update/settings", patch));
      setStatus({ text: "Збережено. Натисніть «Перевірити», щоб звернутися до GitHub з новими налаштуваннями.", ok: true });
    } catch (err) {
      oops(err, "Не збережено");
    } finally {
      setBusy("");
    }
  };

  const dismiss = async () => {
    try {
      apply(await api.send<UpdateStatus>("DELETE", "/admin/api/update/failed"));
    } catch (err) {
      oops(err, "Не вдалося");
    }
  };

  if (!s)
    return (
      <section className="card update" aria-label="Версія">
        <h2>Версія</h2>
        {status ? <Status value={status} /> : <LoaderCircle className="spin" />}
      </section>
    );

  const l = s.latest;
  const blocker = !s.launcher
    ? s.docker
      ? "Цей контейнер зібрано зі старого образу без запускача, тому сам оновитися він не може. Оновіть образ один раз (docker compose pull або docker compose up -d --build), далі оновлення ставитимуться звідси."
      : "Брокер запущено напряму (npm run broker), тому сам оновитися він не може. Запускайте його через npm start (node dist/launcher.js), тоді оновлення ставитимуться звідси."
    : l && !l.nodeOk
      ? `Версії ${l.version} потрібен Node.js ${l.node}, а брокер працює на старішому. ${s.docker ? "Оновіть Docker-образ." : "Оновіть Node.js."}`
      : l && !l.installable
        ? `У релізі ${l.tag} немає архіву для встановлення.`
        : "";
  const changedSettings = form.repo.trim() !== s.repo || form.prerelease !== s.prerelease || form.token.trim() !== "";

  return (
    <section className="card update" aria-label="Версія">
      <div className="card-head">
        <h2>Версія</h2>
        <button type="button" className="btn ghost sm" disabled={!!busy} onClick={() => void check()}>
          {busy === "check" ? <LoaderCircle size={15} className="spin" /> : <RefreshCw size={15} />} Перевірити
        </button>
      </div>
      <p>
        Працює версія <b>{s.current}</b>.
        {s.checkedAt && <span className="muted"> Перевірено {fmtDate(s.checkedAt)}.</span>}
      </p>
      {s.failed && (
        <div className="warn actions">
          <span>
            Оновлення до {s.failed.version} не вдалося ({s.failed.reason}), тому повернуто версію {s.failed.previous}.
          </span>
          <button type="button" className="btn ghost sm" onClick={() => void dismiss()} aria-label="Сховати">
            <X size={14} />
          </button>
        </div>
      )}
      {s.error && <p className="status error">Не вдалося перевірити оновлення: {s.error}</p>}
      {l && s.updateAvailable && (
        <div className="update-new">
          <h3>
            Доступна версія {l.version}
            {l.prerelease ? " (пре-реліз)" : ""}
            {l.publishedAt && <span className="muted"> від {fmtDate(l.publishedAt)}</span>}{" "}
            <a href={l.url} target="_blank" rel="noopener noreferrer" title="Реліз на GitHub">
              <ExternalLink size={14} />
            </a>
          </h3>
          {l.notes && (
            <div className="update-notes">
              <Markdown text={l.notes} />
            </div>
          )}
          {blocker && <p className="warn">{blocker}</p>}
          <div className="actions">
            {!confirm ? (
              <button type="button" className="btn primary" disabled={!!busy || !!blocker} onClick={() => setConfirm(true)}>
                {busy === "install" ? <LoaderCircle size={16} className="spin" /> : <Download size={16} />} Оновити до {l.version}
              </button>
            ) : (
              <>
                <span>Брокер перезапуститься, агенти перепідключаться самі. Оновити?</span>
                <button type="button" className="btn primary" onClick={() => void install(l.version)}>
                  Так, оновити
                </button>
                <button type="button" className="btn ghost" onClick={() => setConfirm(false)}>
                  Скасувати
                </button>
              </>
            )}
          </div>
        </div>
      )}
      {!s.updateAvailable && !s.launcher && <p className="muted small">{blocker}</p>}
      <Status value={status} />

      <details className="update-settings">
        <summary>Звідки брати оновлення</summary>
        <form
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            const patch: Record<string, string | boolean> = {};
            if (form.repo.trim() !== s.repo) patch.repo = form.repo.trim();
            if (form.prerelease !== s.prerelease) patch.prerelease = form.prerelease;
            if (form.token.trim()) patch.token = form.token.trim();
            if (Object.keys(patch).length) void save(patch);
          }}
        >
          <div className="settings-grid">
            <label className="field">
              <span>
                Репозиторій GitHub <code>owner/name</code>
              </span>
              <input value={form.repo} onChange={(e) => setForm({ ...form, repo: e.target.value })} placeholder="delpher/aichat" />
            </label>
            <label className="field">
              <span>Токен GitHub</span>
              <input
                type="password"
                autoComplete="off"
                value={form.token}
                disabled={s.tokenFromEnv}
                placeholder={s.tokenFromEnv ? "задано в AICHAT_UPDATE_TOKEN" : s.hasToken ? "токен збережено" : "github_pat_…"}
                onChange={(e) => setForm({ ...form, token: e.target.value })}
              />
              <small>
                Потрібен, поки репозиторій приватний: fine-grained токен з правом Contents: Read-only на цей репозиторій. Зберігається в agents.json і
                назад не показується.
              </small>
            </label>
          </div>
          <label className="check">
            <input type="checkbox" checked={form.prerelease} onChange={(e) => setForm({ ...form, prerelease: e.target.checked })} /> Пропонувати
            пре-релізи (v1.2.3-rc.1)
          </label>
          <div className="actions">
            <button type="submit" className="btn" disabled={!!busy || !changedSettings}>
              <Save size={16} /> Зберегти
            </button>
            {s.hasToken && !s.tokenFromEnv && (
              <button type="button" className="btn ghost danger-text" disabled={!!busy} onClick={() => void save({ token: "" })}>
                Видалити токен
              </button>
            )}
          </div>
        </form>
      </details>
    </section>
  );
}
