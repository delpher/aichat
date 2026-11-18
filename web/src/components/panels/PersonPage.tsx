import { ArrowLeft, LoaderCircle, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { AuthError } from "../../api/http";
import { MAX_DESCRIPTION_LENGTH, type Agent, type Setup } from "../../api/types";
import { useChat } from "../../context";
import { adapterText } from "../../lib/adapter";
import { kindLabel } from "../../lib/format";
import { clearSetup, peekSetup } from "../../lib/handoff";
import { setLeaveGuard } from "../../lib/leave";
import { Avatar } from "../Avatar";
import { ListSkeleton } from "../Skeleton";
import { SetupBox } from "./SetupBox";
import { Status, type StatusValue } from "./Status";
import { useAgents } from "./useAgents";

const enc = encodeURIComponent;

/** What the Save button sends; everything else on the page acts at once. */
type Draft = { description: string; admin: boolean; keeper: boolean };
const draftOf = (a: Agent): Draft => ({ description: a.description ?? "", admin: !!a.admin, keeper: !!a.keeper });
const sameDraft = (x: Draft, y: Draft) =>
  x.description.trim() === y.description.trim() && x.admin === y.admin && x.keeper === y.keeper;

type Confirm = "save" | "rotate" | "delete";

/** One participant: settings saved with a button, access (setup, new token) and deletion. */
export function PersonPage({ name, onSelfDemoted }: { name: string; onSelfDemoted: () => void }) {
  const { api, session, overview, fail, go, openRoom, reloadOverview } = useChat();
  const { list, editable, error, load } = useAgents();
  const agent = list?.find((a) => a.name === name);
  const me = session.mode === "admin" ? session.admin.name : null;
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [status, setStatus] = useState<StatusValue>(null);
  // a participant just added arrives with the setup and the new token
  const [setup, setSetup] = useState<{ title: string; setup: Setup; fresh: boolean } | null>(() => {
    const s = peekSetup(name);
    return s ? { title: `Як підключити ${name}`, setup: s, fresh: true } : null;
  });
  useEffect(() => clearSetup(name), [name]);

  const saved = agent ? draftOf(agent) : null;
  const dirty = !!draft && !!saved && !sameDraft(draft, saved);
  // take the saved values whenever they change while nothing is being edited
  const savedKey = saved ? JSON.stringify(saved) : "";
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;
  useEffect(() => {
    if (saved && !dirtyRef.current) setDraft(saved);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedKey]);

  useEffect(() => {
    setLeaveGuard(() => dirtyRef.current);
    const onUnload = (e: BeforeUnloadEvent) => {
      if (dirtyRef.current) e.preventDefault();
    };
    window.addEventListener("beforeunload", onUnload);
    return () => {
      setLeaveGuard(null);
      window.removeEventListener("beforeunload", onUnload);
    };
  }, []);

  const back = (
    <div>
      <button type="button" className="btn ghost sm" onClick={() => go({ kind: "people" })}>
        <ArrowLeft size={14} /> Агенти й люди
      </button>
    </div>
  );
  if (!list)
    return (
      <div className="panel">
        {back}
        <ListSkeleton label="Завантаження" />
      </div>
    );
  if (!agent || !draft || !saved)
    return (
      <div className="panel">
        {back}
        <div className="empty">
          <strong>Учасника {name} немає</strong>
          {error && <p>{error}</p>}
        </div>
      </div>
    );

  const live = overview.agents.find((a) => a.name === name);
  const isOn = live?.online ?? agent.online;
  const human = agent.kind === "human";
  const adminCount = list.filter((a) => a.admin).length;
  const lastAdmin = saved.admin && adminCount <= 1;
  const otherKeeper = list.find((a) => a.keeper && a.name !== name);
  const locked = !editable || busy;
  const keeperBlocked = saved.keeper
    ? ""
    : otherKeeper
      ? `Keeper уже ${otherKeeper.name}, а він може бути лише один.`
      : agent.rooms.length
        ? `Keeper не буває в кімнатах: спершу приберіть ${name} з ${agent.rooms.map((r) => "#" + r).join(", ")} у «Керуванні кімнатами».`
        : "";
  const adapter = adapterText(live?.adapter ?? agent.adapter, overview.version);

  const act = async (fn: () => Promise<void>, ok: string) => {
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

  const changes = () => {
    const b: Record<string, unknown> = {};
    if (draft.description.trim() !== saved.description.trim()) b.description = draft.description.trim();
    if (draft.admin !== saved.admin) b.admin = draft.admin;
    if (draft.keeper !== saved.keeper) b.keeper = draft.keeper;
    return b;
  };
  const save = () => {
    if (!dirty) return;
    if (draft.admin !== saved.admin) return setConfirm("save");
    void doSave();
  };
  const doSave = async () => {
    const body = changes();
    if (body.admin === false && name === me) {
      // the same token keeps working as a personal one: log in again as a participant
      setBusy(true);
      try {
        await api.send("PATCH", `/admin/api/agents/${enc(name)}`, body);
        setLeaveGuard(null);
        onSelfDemoted();
      } catch (err) {
        setBusy(false);
        setConfirm(null);
        fail(err, "Не вдалося");
      }
      return;
    }
    await act(async () => {
      const d = await api.send<{ agent?: Agent }>("PATCH", `/admin/api/agents/${enc(name)}`, body);
      setDraft(d?.agent ? draftOf(d.agent) : { ...draft, description: draft.description.trim() });
    }, "Збережено.");
  };

  const rotate = () =>
    act(async () => {
      const d = await api.send<{ token: string; setup?: Setup }>("POST", `/admin/api/agents/${enc(name)}/token`);
      setSetup({ title: `Новий токен для ${name}`, setup: d.setup ?? { steps: [{ title: "Токен", code: d.token }] }, fresh: true });
    }, `Токен ${name} перевидано.`);

  const remove = async () => {
    setBusy(true);
    try {
      await api.send("DELETE", `/admin/api/agents/${enc(name)}`);
      setLeaveGuard(null);
      reloadOverview().catch(() => {});
      go({ kind: "people" });
    } catch (err) {
      setBusy(false);
      setConfirm(null);
      if (err instanceof AuthError) return fail(err, "");
      setStatus({ text: `Помилка: ${(err as Error).message}`, error: true });
    }
  };

  const showSetup = async () => {
    try {
      const d = await api.get<{ setup: Setup }>(`/admin/api/agents/${enc(name)}/setup`);
      setSetup({ title: `Як підключити ${name}`, setup: d.setup, fresh: false });
      setStatus({ text: "Токен в інструкції замінено на <TOKEN>. Якщо токен загубився, натисніть «Новий токен»." });
    } catch (err) {
      if (err instanceof AuthError) return fail(err, "");
      setStatus({ text: `Не вдалося отримати інструкцію: ${(err as Error).message}`, error: true });
    }
  };

  const adminQuestion = draft.admin
    ? `Зробити ${name} адміном? ${name} бачитиме всю переписку, зможе писати від імені будь-якої людини й керувати агентами, кімнатами та налаштуваннями.`
    : name === me
      ? "Зняти права адміна із себе? Ви одразу перейдете в режим учасника."
      : `Зняти права адміна з ${name}?`;

  const confirmBox = (question: string, label: string, danger: boolean, onYes: () => void) => (
    <div className="confirm">
      <span>{question}</span>
      <div className="actions">
        <button type="button" className={`btn sm ${danger ? "danger" : "primary"}`} onClick={onYes} disabled={busy}>
          {busy && <LoaderCircle className="spin" size={14} />} {label}
        </button>
        <button type="button" className="btn sm ghost" onClick={() => setConfirm(null)} disabled={busy}>
          Скасувати
        </button>
      </div>
    </div>
  );

  return (
    <div className="panel">
      {back}
      {setup && <SetupBox name={name} {...setup} onClose={() => setSetup(null)} />}

      <section className="person-head">
        <Avatar name={name} kind={agent.kind} online={isOn} />
        <div className="person-info">
          <h2 className="person-name">
            {name}
            {name === me && <span className="muted small">ви</span>}
          </h2>
          <div className="person-meta">
            {[
              kindLabel(agent.kind),
              saved.admin ? "адміністратор" : "",
              saved.keeper ? "keeper" : "",
              isOn ? "онлайн" : "офлайн",
              agent.webhook ? "webhook" : "",
              adapter,
            ]
              .filter(Boolean)
              .join(" · ")}
          </div>
          {agent.rooms.length > 0 && (
            <div className="person-rooms">
              {agent.rooms.map((r) => (
                <button key={r} type="button" className="btn quiet sm" onClick={() => openRoom(r)}>
                  #{r}
                </button>
              ))}
            </div>
          )}
        </div>
      </section>

      <form
        className="card"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <h2>Налаштування</h2>
        <label className="field">
          <span>Опис</span>
          <textarea
            value={draft.description}
            onChange={(e) => setDraft({ ...draft, description: e.target.value })}
            maxLength={MAX_DESCRIPTION_LENGTH}
            rows={3}
            disabled={locked}
            placeholder={human ? "Хто це" : "Пара речень про агента. Порожньо: без кастомізації."}
          />
          <small>
            {draft.description.length}/{MAX_DESCRIPTION_LENGTH}
            {!human && " · Агент бачить цей текст у своїх інструкціях з наступної сесії, інші бачать його в картці."}
          </small>
        </label>
        {human ? (
          <div className="field">
            <label className="check">
              <input
                type="checkbox"
                checked={draft.admin}
                onChange={(e) => setDraft({ ...draft, admin: e.target.checked })}
                disabled={locked || lastAdmin}
              />
              Адміністратор
            </label>
            {lastAdmin && <small>Це єдиний адмін: спершу зробіть адміном когось іще.</small>}
          </div>
        ) : (
          <div className="field">
            <label className="check">
              <input
                type="checkbox"
                checked={draft.keeper}
                onChange={(e) => setDraft({ ...draft, keeper: e.target.checked })}
                disabled={locked || !!keeperBlocked}
              />
              Keeper
            </label>
            <small>
              {keeperBlocked || "Пише агентам бриф після перерви й підказує, що де в AIChat. Не входить у кімнати, не грає й не має рейтингу."}
            </small>
          </div>
        )}
        {confirm === "save" ? (
          confirmBox(adminQuestion, draft.admin ? "Зробити адміном і зберегти" : "Зняти права і зберегти", draft.admin, () => void doSave())
        ) : (
          <div className="actions">
            <button type="submit" className="btn primary" disabled={locked || !dirty}>
              {busy && <LoaderCircle className="spin" size={16} />} Зберегти
            </button>
            <button type="button" className="btn ghost" disabled={busy || !dirty} onClick={() => setDraft(saved)}>
              Скасувати
            </button>
            <Status value={status} />
          </div>
        )}
      </form>

      <section className="section">
        <h2>Доступ</h2>
        {confirm === "rotate" ? (
          confirmBox(
            `Перевидати токен ${name}? Старий перестане працювати${human ? "" : ", агента треба буде перезапустити з новим токеном"}.`,
            "Перевидати токен",
            false,
            () => void rotate(),
          )
        ) : (
          <div className="actions">
            <button type="button" className="btn quiet" onClick={() => void showSetup()}>
              Інструкція
            </button>
            <button type="button" className="btn quiet" disabled={locked} onClick={() => setConfirm("rotate")}>
              Новий токен
            </button>
          </div>
        )}
      </section>

      <section className="section danger-zone">
        <h2>Небезпечна зона</h2>
        {confirm === "delete" ? (
          confirmBox(
            `Видалити ${name}? Історія лишиться, але підключитися буде неможливо.${name === me ? " Це ваш обліковий запис: вас одразу вилогінить." : ""}`,
            "Видалити",
            true,
            () => void remove(),
          )
        ) : (
          <div className="actions">
            <button
              type="button"
              className="btn danger-text"
              disabled={locked || lastAdmin}
              title={lastAdmin ? "Це єдиний адмін: спершу зробіть адміном когось іще" : undefined}
              onClick={() => setConfirm("delete")}
            >
              <Trash2 size={14} /> Видалити {name}
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
