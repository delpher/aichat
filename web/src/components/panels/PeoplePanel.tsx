import { LoaderCircle, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { AuthError } from "../../api/http";
import { ROOM_RE, type Agent, type Setup } from "../../api/types";
import { useChat } from "../../context";
import { kindLabel } from "../../lib/format";
import { Avatar } from "../Avatar";
import { ListSkeleton } from "../Skeleton";
import { SetupBox } from "./SetupBox";
import { Status, type StatusValue } from "./Status";

type Action = "delete" | "rotate" | "grant" | "revoke";

const enc = encodeURIComponent;

const CONFIRM_LABEL: Record<Action, string> = {
  delete: "Видалити",
  rotate: "Перевидати токен",
  grant: "Зробити адміном",
  revoke: "Зняти права",
};

export function PeoplePanel({ onSelfDemoted }: { onSelfDemoted: () => void }) {
  const { api, session, overview, fail, reloadOverview } = useChat();
  const [list, setList] = useState<Agent[] | null>(null);
  const [editable, setEditable] = useState(true);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<{ name: string; action: Action } | null>(null);
  const [status, setStatus] = useState<StatusValue>(null);
  const [setup, setSetup] = useState<{ name: string; title: string; setup: Setup; fresh: boolean } | null>(null);
  const [form, setForm] = useState({ name: "", kind: "human", custom: "bot", webhook: "", description: "", rooms: "" });
  const me = session.mode === "admin" ? session.admin.name : null;
  const adminCount = (list ?? []).filter((a) => a.admin).length;

  const load = useCallback(async () => {
    try {
      const [a, s] = await Promise.all([
        api.get<{ agents: Agent[] }>("/admin/api/agents"),
        api.get<{ editable: boolean }>("/admin/api/settings"),
      ]);
      setList(a.agents ?? []);
      setEditable(s.editable !== false);
      if (s.editable === false) setStatus({ text: "Брокер запущено без файлу конфігурації, тому список змінювати не можна." });
    } catch (err) {
      if (err instanceof AuthError) return fail(err, "");
      setList((cur) => cur ?? []);
      setStatus({ text: `Не вдалося завантажити список: ${(err as Error).message}`, error: true });
    }
  }, [api, fail]);
  useEffect(() => {
    void load();
  }, [load, overview.agents.length, overview.rooms]);

  const run = async (fn: () => Promise<void>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      setStatus({ text: ok, ok: true });
    } catch (err) {
      if (err instanceof AuthError) return fail(err, "");
      setStatus({ text: `Помилка: ${(err as Error).message}`, error: true });
    } finally {
      setBusy(false);
      setConfirm(null);
      await load();
      reloadOverview().catch(() => {});
    }
  };

  const add = () => {
    const name = form.name.trim();
    const kind = form.kind === "other" ? form.custom.trim() : form.kind;
    const rooms = form.rooms
      .split(/[\s,]+/)
      .map((r) => r.replace(/^#/, ""))
      .filter(Boolean);
    const webhook = form.kind === "human" || form.kind === "claude" ? "" : form.webhook.trim();
    if (!ROOM_RE.test(name)) return setStatus({ text: "Ім'я: латиниця, цифри, - і _ (до 64 символів).", error: true });
    if (!ROOM_RE.test(kind)) return setStatus({ text: "Назва типу: латиниця, цифри, - і _.", error: true });
    if (webhook && !/^https?:\/\/\S+$/.test(webhook))
      return setStatus({ text: "Webhook має бути адресою http:// або https://", error: true });
    const bad = rooms.find((r) => !ROOM_RE.test(r));
    if (bad) return setStatus({ text: `Погана назва кімнати: ${bad}`, error: true });
    void run(async () => {
      const d = await api.send<{ agent: Agent; setup: Setup }>("POST", "/admin/api/agents", {
        name,
        kind,
        rooms,
        ...(form.description.trim() ? { description: form.description.trim() } : {}),
        ...(webhook ? { webhook } : {}),
      });
      setForm({ ...form, name: "", webhook: "", description: "", rooms: "" });
      setSetup({
        name: d.agent.name,
        title: kind === "human" ? `Вхід для ${d.agent.name}` : `Як запустити ${d.agent.name}`,
        setup: d.setup,
        fresh: true,
      });
    }, `Додано: ${name}.`);
  };

  const doAction = (name: string, action: Action) => {
    if (action === "delete")
      return run(async () => {
        await api.send("DELETE", `/admin/api/agents/${enc(name)}`);
        setSetup(null);
      }, `Видалено: ${name}.`);
    if (action === "rotate")
      return run(async () => {
        const d = await api.send<{ token: string; setup?: Setup }>("POST", `/admin/api/agents/${enc(name)}/token`);
        setSetup({ name, title: `Новий токен для ${name}`, setup: d.setup ?? { steps: [{ title: "Токен", code: d.token }] }, fresh: true });
      }, `Токен ${name} перевидано.`);
    const admin = action === "grant";
    if (!admin && name === me) {
      // the same token keeps working as a personal one: log in again as a participant
      setBusy(true);
      api
        .send("PATCH", `/admin/api/agents/${enc(name)}`, { admin: false })
        .then(onSelfDemoted)
        .catch((err) => {
          setBusy(false);
          fail(err, "Не вдалося");
        });
      return;
    }
    return run(
      () => api.send("PATCH", `/admin/api/agents/${enc(name)}`, { admin }).then(() => undefined),
      admin ? `${name} тепер адмін.` : `${name} більше не адмін.`,
    );
  };

  const showSetup = async (name: string) => {
    try {
      const d = await api.get<{ setup: Setup }>(`/admin/api/agents/${enc(name)}/setup`);
      setSetup({ name, title: `Як підключити ${name}`, setup: d.setup, fresh: false });
      setStatus({ text: "Токен в інструкції замінено на <TOKEN>. Якщо токен загубився, натисніть «Новий токен»." });
    } catch (err) {
      if (err instanceof AuthError) return fail(err, "");
      setStatus({ text: `Не вдалося отримати інструкцію: ${(err as Error).message}`, error: true });
    }
  };

  const online = new Map(overview.agents.map((a) => [a.name, a.online]));
  const sorted = [...(list ?? [])].sort((x, y) =>
    (x.kind === "human") === (y.kind === "human") ? x.name.localeCompare(y.name) : x.kind === "human" ? -1 : 1,
  );
  const locked = !editable || busy;
  const question = (a: Agent, action: Action) =>
    ({
      delete: `Видалити ${a.name}? Історія лишиться, але підключитися буде неможливо.${a.name === me ? " Це ваш обліковий запис: вас одразу вилогінить." : ""}`,
      rotate: `Перевидати токен ${a.name}? Старий перестане працювати${a.kind === "human" ? "" : ", агента треба буде перезапустити з новим токеном"}.`,
      grant: `Зробити ${a.name} адміном? ${a.name} бачитиме всю переписку, зможе писати від імені будь-якої людини й керувати агентами, кімнатами та налаштуваннями.`,
      revoke: a.name === me ? "Зняти права адміна із себе? Ви одразу перейдете в режим учасника." : `Зняти права адміна з ${a.name}?`,
    })[action];

  return (
    <div className="panel">
      {setup && <SetupBox {...setup} onClose={() => setSetup(null)} />}

      <form
        className="card"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <h2>Додати агента або людину</h2>
        <div className="form-grid">
          <label className="field">
            <span>Ім'я</span>
            <input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="claude-c"
              maxLength={64}
              required
              disabled={locked}
            />
            <small>Латиниця, цифри, - і _</small>
          </label>
          <label className="field">
            <span>Тип</span>
            <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })} disabled={locked}>
              <option value="human">Людина</option>
              <option value="claude">Claude Code</option>
              <option value="openai">OpenAI-сумісна модель</option>
              <option value="other">Інший (REST або webhook)</option>
            </select>
          </label>
          {form.kind === "other" && (
            <label className="field">
              <span>Тип агента</span>
              <input value={form.custom} onChange={(e) => setForm({ ...form, custom: e.target.value })} maxLength={64} disabled={locked} />
            </label>
          )}
          {(form.kind === "openai" || form.kind === "other") && (
            <label className="field">
              <span>Webhook URL</span>
              <input
                value={form.webhook}
                onChange={(e) => setForm({ ...form, webhook: e.target.value })}
                placeholder="https://…"
                disabled={locked}
              />
            </label>
          )}
          <label className="field">
            <span>Опис, необов'язково</span>
            <input
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              maxLength={200}
              placeholder="Пише код"
              disabled={locked}
            />
          </label>
          <label className="field">
            <span>Кімнати</span>
            <input
              value={form.rooms}
              onChange={(e) => setForm({ ...form, rooms: e.target.value })}
              placeholder="lobby, team"
              disabled={locked}
            />
            <small>Через кому</small>
          </label>
        </div>
        <div className="actions">
          <button type="submit" className="btn primary" disabled={locked}>
            {busy && <LoaderCircle className="spin" size={16} />} Додати й отримати токен
          </button>
          <Status value={status} />
        </div>
      </form>

      <section className="section">
        <div className="section-head">
          <h2>Учасники{list && <span className="count">{list.length}</span>}</h2>
        </div>
        {!list && <ListSkeleton label="Завантаження учасників" />}
        <ul className="people">
          {sorted.map((a) => {
            const isOn = online.get(a.name) ?? a.online;
            return (
              <li key={a.name} className="person">
                <Avatar name={a.name} kind={a.kind} online={isOn} />
                <div className="person-info">
                  <div className="person-name">
                    {a.name}
                    {a.name === me && <span className="muted small">ви</span>}
                  </div>
                  <div className="person-meta">
                    {[
                      kindLabel(a.kind),
                      a.admin ? "адміністратор" : "",
                      isOn ? "онлайн" : "офлайн",
                      a.rooms.length ? a.rooms.map((r) => "#" + r).join(", ") : "",
                      a.webhook ? "webhook" : "",
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </div>
                  {a.description && <div className="person-desc">{a.description}</div>}
                </div>
                {confirm?.name === a.name ? (
                  <div className="confirm">
                    <span>{question(a, confirm.action)}</span>
                    <div className="actions">
                      <button
                        type="button"
                        className={`btn sm ${confirm.action === "delete" || confirm.action === "grant" ? "danger" : "primary"}`}
                        onClick={() => void doAction(a.name, confirm.action)}
                        disabled={busy}
                      >
                        {busy && <LoaderCircle className="spin" size={14} />} {CONFIRM_LABEL[confirm.action]}
                      </button>
                      <button type="button" className="btn sm ghost" onClick={() => setConfirm(null)}>
                        Скасувати
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="person-actions">
                    {a.kind === "human" &&
                      (a.admin ? (
                        <button
                          type="button"
                          className="btn sm quiet"
                          disabled={locked || adminCount <= 1}
                          title={adminCount <= 1 ? "Це єдиний адмін: спершу зробіть адміном когось іще" : undefined}
                          onClick={() => setConfirm({ name: a.name, action: "revoke" })}
                        >
                          Зняти адміна
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="btn sm quiet"
                          disabled={locked}
                          onClick={() => setConfirm({ name: a.name, action: "grant" })}
                        >
                          Зробити адміном
                        </button>
                      ))}
                    <button type="button" className="btn sm quiet" onClick={() => void showSetup(a.name)}>
                      Інструкція
                    </button>
                    <button
                      type="button"
                      className="btn sm quiet"
                      disabled={locked}
                      onClick={() => setConfirm({ name: a.name, action: "rotate" })}
                    >
                      Новий токен
                    </button>
                    <button
                      type="button"
                      className="btn sm danger-text icon-only"
                      disabled={locked || (!!a.admin && adminCount <= 1)}
                      onClick={() => setConfirm({ name: a.name, action: "delete" })}
                      title={`Видалити ${a.name}`}
                      aria-label={`Видалити ${a.name}`}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}
