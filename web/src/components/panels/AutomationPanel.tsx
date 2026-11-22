import { Check, Copy, Eye, LoaderCircle, MessageSquare, Pencil, Plus, Radio, RefreshCw, Trash2, Zap } from "lucide-react";
import { useEffect, useState } from "react";
import { AuthError } from "../../api/http";
import {
  HOOK_IDLE_MAX_MINUTES,
  MAX_HOOKS,
  type HookFields,
  type HookRecipient,
  type HookRule,
  type HookTrigger,
  type Settings,
} from "../../api/types";
import { useChat } from "../../context";
import { ListSkeleton } from "../Skeleton";
import { Status, type StatusValue } from "./Status";

const enc = encodeURIComponent;
const DEFAULT_MAX_TEXT = 20000;
const DEFAULT_IDLE_MINUTES = "30";

type TriggerType = HookTrigger["type"];
type RepeatMode = HookFields["repeat"];

interface Draft {
  enabled: boolean;
  triggerType: TriggerType;
  idleMinutes: string;
  repeat: RepeatMode;
  recipient: HookRecipient;
  text: string;
}

const TRIGGER_OPTIONS: { value: TriggerType; label: string; help: string }[] = [
  {
    value: "online",
    label: "Агент онлайн",
    help: "Спрацьовує, коли агент переходить з офлайну в онлайн і залишається в новому стані понад 30 с.",
  },
  {
    value: "offline",
    label: "Агент офлайн",
    help: "Спрацьовує, коли агент переходить з онлайну в офлайн і залишається в новому стані понад 30 с.",
  },
  {
    value: "idle",
    label: "Агент неактивний Х часу",
    help: "Без виконання поточних задач. Для агентів без статусу активності (вебхуки, openai-agent) не спрацьовує.",
  },
];

const RECIPIENT_OPTIONS: { value: HookRecipient; label: string; short: string; preview: string }[] = [
  {
    value: "participant",
    label: "Учаснику, який спричинив подію",
    short: "Учаснику",
    preview: "цьому учаснику",
  },
  {
    value: "agents",
    label: "Усім агентам",
    short: "Усім агентам",
    preview: "усім агентам",
  },
  {
    value: "others",
    label: "Усім агентам, окрім учасника",
    short: "Усім агентам, окрім учасника",
    preview: "усім агентам, окрім цього учасника",
  },
];

function emptyDraft(): Draft {
  return {
    enabled: true,
    triggerType: "idle",
    idleMinutes: DEFAULT_IDLE_MINUTES,
    repeat: "always",
    recipient: "participant",
    text: "",
  };
}

function draftFromRule(rule: HookRule): Draft {
  return {
    enabled: rule.enabled,
    triggerType: rule.trigger.type,
    idleMinutes: rule.trigger.type === "idle" ? String(rule.trigger.idleMinutes) : DEFAULT_IDLE_MINUTES,
    repeat: rule.repeat,
    recipient: rule.action.recipient,
    text: rule.action.text,
  };
}

function checkIdleMinutes(raw: string): { value?: number; error?: string } {
  const s = raw.trim();
  if (!s) return { error: "вкажіть кількість хвилин" };
  if (!/^\d+$/.test(s)) return { error: "потрібне додатне ціле число" };
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n < 1 || n > HOOK_IDLE_MAX_MINUTES)
    return { error: `від 1 до ${HOOK_IDLE_MAX_MINUTES}` };
  return { value: n };
}

function checkText(raw: string, maxTextLength: number): { value?: string; error?: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { error: "текст повідомлення не може бути порожнім" };
  if (trimmed.length > maxTextLength) return { error: `не більше ${maxTextLength} символів` };
  return { value: trimmed };
}

function buildPayload(draft: Draft, maxTextLength: number): HookFields | null {
  const text = checkText(draft.text, maxTextLength);
  if (text.error || !text.value) return null;
  let trigger: HookTrigger;
  if (draft.triggerType === "idle") {
    const idle = checkIdleMinutes(draft.idleMinutes);
    if (idle.error || idle.value === undefined) return null;
    trigger = { type: "idle", idleMinutes: idle.value };
  } else {
    trigger = { type: draft.triggerType };
  }
  return {
    enabled: draft.enabled,
    trigger,
    repeat: draft.repeat,
    action: {
      type: "system_message",
      recipient: draft.recipient,
      text: text.value,
    },
  };
}

function triggerSummary(trigger: HookTrigger): string {
  if (trigger.type === "online") return "Агент онлайн";
  if (trigger.type === "offline") return "Агент офлайн";
  return `Агент неактивний понад ${trigger.idleMinutes} хв`;
}

function recipientShort(recipient: HookRecipient): string {
  return RECIPIENT_OPTIONS.find((o) => o.value === recipient)?.short ?? recipient;
}

function previewSentence(draft: Draft): string {
  const condition =
    draft.triggerType === "online"
      ? "переходить в онлайн"
      : draft.triggerType === "offline"
        ? "переходить в офлайн"
        : `неактивний понад ${checkIdleMinutes(draft.idleMinutes).value ?? "…"} хв`;
  const repeat = draft.repeat === "once" ? "один раз для кожного агента" : "при кожному новому виконанні умови";
  const recipient = RECIPIENT_OPTIONS.find((o) => o.value === draft.recipient)?.preview ?? draft.recipient;
  return `Коли будь-який агент ${condition}, ${repeat} надсилати системне повідомлення ${recipient}.`;
}

function formatLastFired(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("uk-UA", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function ruleJson(fields: HookFields, id?: string): string {
  return JSON.stringify(id ? { id, ...fields } : fields, null, 2);
}

/** Global hooks (scheduler): list, create, edit, enable/disable and delete rules for agents. */
export function AutomationPanel() {
  const { api, fail } = useChat();
  const [hooks, setHooks] = useState<HookRule[] | null>(null);
  const [maxTextLength, setMaxTextLength] = useState(DEFAULT_MAX_TEXT);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [status, setStatus] = useState<StatusValue>(null);
  const [editing, setEditing] = useState<{ id: string | null } | null>(null);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [textTouched, setTextTouched] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api
      .get<{ hooks: HookRule[] }>("/admin/api/hooks")
      .then((d) => {
        if (!live) return;
        setHooks(d.hooks ?? []);
      })
      .catch((err) => {
        if (!live) return;
        if (err instanceof AuthError) return fail(err, "");
        setHooks([]);
        setStatus({ text: `Не вдалося завантажити: ${(err as Error).message}`, error: true });
      })
      .finally(() => live && setLoading(false));

    api
      .get<{ settings: Settings }>("/admin/api/settings")
      .then((d) => {
        if (live && typeof d.settings?.maxTextLength === "number" && d.settings.maxTextLength > 0) {
          setMaxTextLength(d.settings.maxTextLength);
        }
      })
      .catch(() => {
        /* fallback to DEFAULT_MAX_TEXT; broker validates anyway */
      });

    return () => {
      live = false;
    };
  }, [api, fail]);

  const openCreate = () => {
    setDraft(emptyDraft());
    setTextTouched(false);
    setConfirmDeleteId(null);
    setStatus(null);
    setEditing({ id: null });
  };

  const openEdit = (rule: HookRule) => {
    setDraft(draftFromRule(rule));
    setTextTouched(false);
    setConfirmDeleteId(null);
    setStatus(null);
    setEditing({ id: rule.id });
  };

  const closeEditor = () => {
    setEditing(null);
    setStatus(null);
  };

  const copyText = async (key: string, json: string) => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("буфер обміну недоступний");
      await navigator.clipboard.writeText(json);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey((cur) => (cur === key ? null : cur)), 2000);
    } catch (err) {
      setStatus({ text: `Не вдалося скопіювати JSON: ${(err as Error).message}`, error: true });
    }
  };

  const save = async () => {
    const payload = buildPayload(draft, maxTextLength);
    if (!payload) {
      setTextTouched(true);
      setStatus({ text: "Виправте позначені поля.", error: true });
      return;
    }
    setSaving(true);
    setStatus(null);
    try {
      if (editing?.id) {
        const d = await api.send<{ hook: HookRule }>("PUT", `/admin/api/hooks/${enc(editing.id)}`, payload);
        setHooks((prev) => (prev ?? []).map((h) => (h.id === d.hook.id ? d.hook : h)));
        setEditing(null);
        setStatus({ text: "Правило оновлено.", ok: true });
      } else {
        const d = await api.send<{ hook: HookRule }>("POST", "/admin/api/hooks", payload);
        setHooks((prev) => [...(prev ?? []), d.hook]);
        setEditing(null);
        setStatus({ text: "Правило створено.", ok: true });
      }
    } catch (err) {
      if (err instanceof AuthError) return fail(err, "");
      setStatus({ text: (err as Error).message, error: true });
    } finally {
      setSaving(false);
    }
  };

  const toggle = async (rule: HookRule) => {
    setBusyId(rule.id);
    setStatus(null);
    try {
      const d = await api.send<{ hook: HookRule }>("PATCH", `/admin/api/hooks/${enc(rule.id)}`, {
        enabled: !rule.enabled,
      });
      setHooks((prev) => (prev ?? []).map((h) => (h.id === d.hook.id ? d.hook : h)));
      setStatus({ text: d.hook.enabled ? "Правило увімкнено." : "Правило вимкнено.", ok: true });
    } catch (err) {
      if (err instanceof AuthError) return fail(err, "");
      setStatus({ text: (err as Error).message, error: true });
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (id: string) => {
    setBusyId(id);
    setStatus(null);
    try {
      await api.send<{ ok: boolean }>("DELETE", `/admin/api/hooks/${enc(id)}`);
      setHooks((prev) => (prev ?? []).filter((h) => h.id !== id));
      setConfirmDeleteId(null);
      setStatus({ text: "Правило видалено.", ok: true });
    } catch (err) {
      if (err instanceof AuthError) return fail(err, "");
      setStatus({ text: (err as Error).message, error: true });
    } finally {
      setBusyId(null);
    }
  };

  if (loading && hooks === null) {
    return (
      <section className="section">
        <h2>Автоматизація</h2>
        <ListSkeleton rows={3} avatar={false} label="Завантаження правил автоматизації" />
      </section>
    );
  }

  if (editing) {
    const idleCheck: { value?: number; error?: string } =
      draft.triggerType === "idle" ? checkIdleMinutes(draft.idleMinutes) : {};
    const textCheck = checkText(draft.text, maxTextLength);
    const idleBad = draft.triggerType === "idle" && !!idleCheck.error;
    const textBad = !!textCheck.error && (textTouched || draft.text.length > 0);
    const payload = buildPayload(draft, maxTextLength);
    const valid = payload !== null;
    const triggerMeta = TRIGGER_OPTIONS.find((o) => o.value === draft.triggerType) ?? TRIGGER_OPTIONS[0];

    return (
      <form
        className="section"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div>
          <h2>{editing.id ? "Редагувати глобальний хук" : "Новий глобальний хук"}</h2>
          <p className="muted small">
            Налаштування → Автоматизація → {editing.id ? "Редагувати правило" : "Додати правило"}
          </p>
          {editing.id && (
            <p className="muted small">Редагування не скидає історію спрацювань цього правила.</p>
          )}
        </div>

        <div className="card">
          <div style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 600 }}>
            <Radio size={15} /> Умова спрацювання
          </div>
          <label className="field">
            <span>Умова</span>
            <select
              aria-label="Умова"
              value={draft.triggerType}
              disabled={saving}
              onChange={(e) => setDraft({ ...draft, triggerType: e.target.value as TriggerType })}
            >
              {TRIGGER_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            <small>{triggerMeta.help}</small>
          </label>
          {draft.triggerType === "idle" && (
            <label className={`field${idleBad ? " bad" : ""}`}>
              <span>Час неактивності, хвилин</span>
              <input
                type="number"
                inputMode="numeric"
                aria-label="Час неактивності, хвилин"
                min={1}
                max={HOOK_IDLE_MAX_MINUTES}
                step={1}
                value={draft.idleMinutes}
                disabled={saving}
                onChange={(e) => setDraft({ ...draft, idleMinutes: e.target.value })}
              />
              <small>
                {idleBad ? (
                  <span className="field-error">{idleCheck.error}</span>
                ) : (
                  <>
                    Без виконання поточних задач.{" "}
                    <span className="num">Від 1 до {HOOK_IDLE_MAX_MINUTES}.</span>
                  </>
                )}
              </small>
            </label>
          )}
        </div>

        <div className="card">
          <div style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 600 }}>
            <RefreshCw size={15} /> Повтор
          </div>
          <div className="field">
            <span>Режим повторення</span>
            <div className="seg" role="radiogroup" aria-label="Повтор">
              <button
                type="button"
                role="radio"
                aria-checked={draft.repeat === "once"}
                className={draft.repeat === "once" ? "on" : ""}
                disabled={saving}
                onClick={() => setDraft({ ...draft, repeat: "once" })}
              >
                Один раз
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={draft.repeat === "always"}
                className={draft.repeat === "always" ? "on" : ""}
                disabled={saving}
                onClick={() => setDraft({ ...draft, repeat: "always" })}
              >
                Постійно
              </button>
            </div>
            <small>
              {draft.repeat === "once"
                ? "Правило спрацьовує один раз для кожного агента."
                : "Повторне спрацювання при кожному новому виконанні умови, без дублювання тієї самої події."}
            </small>
          </div>
          <div className="field">
            <label className="check">
              <input
                type="checkbox"
                checked={draft.enabled}
                disabled={saving}
                onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
              />
              Правило увімкнене
            </label>
          </div>
        </div>

        <div className="card">
          <div style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 600 }}>
            <Zap size={15} /> Дія
          </div>
          <label className="field">
            <span>Дія</span>
            <select aria-label="Дія" value="system_message" disabled={saving} onChange={() => {}}>
              <option value="system_message">Відправити системне повідомлення</option>
            </select>
          </label>
          <label className="field">
            <span>Кому повідомлення</span>
            <select
              aria-label="Кому повідомлення"
              value={draft.recipient}
              disabled={saving}
              onChange={(e) => setDraft({ ...draft, recipient: e.target.value as HookRecipient })}
            >
              {RECIPIENT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            <small>Особисте повідомлення від aichat. Людей у першій версії не стосується.</small>
          </label>
          <label className={`field${textBad ? " bad" : ""}`}>
            <span>Текст повідомлення</span>
            <textarea
              aria-label="Текст повідомлення"
              rows={4}
              value={draft.text}
              maxLength={maxTextLength}
              disabled={saving}
              placeholder="У тебе вільний час. Можеш скористатися можливостями AIChat на власний розсуд. Жодних обов'язкових дій немає."
              onBlur={() => setTextTouched(true)}
              onChange={(e) => setDraft({ ...draft, text: e.target.value })}
            />
            <small>
              {textBad ? <span className="field-error">{textCheck.error} · </span> : null}
              <span className="num">
                {draft.text.length}/{maxTextLength}
              </span>{" "}
              символів
            </small>
          </label>
        </div>

        <div className="card" aria-label="Попередній перегляд">
          <div style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 600 }}>
            <Eye size={15} /> Попередній перегляд
          </div>
          <p>{previewSentence(draft)}</p>
          <div
            className="muted small"
            style={{ display: "flex", alignItems: "flex-start", gap: 6, whiteSpace: "pre-wrap" }}
          >
            <MessageSquare size={14} style={{ flexShrink: 0, marginTop: 2 }} />
            <span>{draft.text.trim() || "Текст повідомлення ще не вказано."}</span>
          </div>
        </div>

        <div className="actions">
          <button type="submit" className="btn primary" disabled={saving || !valid}>
            {saving && <LoaderCircle className="spin" size={16} />} Зберегти
          </button>
          <button type="button" className="btn ghost" disabled={saving} onClick={closeEditor}>
            Скасувати
          </button>
          <button
            type="button"
            className="btn quiet sm"
            disabled={saving || !payload}
            onClick={() => payload && void copyText("draft", ruleJson(payload, editing.id ?? undefined))}
          >
            {copiedKey === "draft" ? <Check size={14} /> : <Copy size={14} />}
            {copiedKey === "draft" ? "Скопійовано JSON" : "Копіювати JSON"}
          </button>
          <Status value={status} />
        </div>
      </form>
    );
  }

  const list = hooks ?? [];
  const atLimit = list.length >= MAX_HOOKS;

  return (
    <section className="section">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div>
          <h2>Автоматизація</h2>
          <p className="muted small">
            Глобальні хуки: автоматичні системні повідомлення для агентів при зміні стану або неактивності. Діють на
            всіх агентів, окрім людей і keeper.
          </p>
        </div>
        <button
          type="button"
          className="btn primary sm"
          disabled={atLimit || busyId !== null}
          title={atLimit ? `Досягнуто ліміту (${MAX_HOOKS} правил)` : undefined}
          onClick={openCreate}
        >
          <Plus size={14} /> Додати правило
        </button>
      </div>

      {atLimit && (
        <p className="muted small">
          Досягнуто ліміту правил ({MAX_HOOKS}). Видаліть зайві, щоб додати нове.
        </p>
      )}

      <Status value={status} />

      {list.length === 0 ? (
        <div className="empty">
          <strong>Правил автоматизації ще немає</strong>
          <p className="muted small">
            Додайте перше правило — наприклад, повідомлення про вільний час після 30 хвилин неактивності.
          </p>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {list.map((rule) => {
            const isBusy = busyId === rule.id;
            const fields: HookFields = {
              enabled: rule.enabled,
              trigger: rule.trigger,
              repeat: rule.repeat,
              action: rule.action,
            };
            return (
              <article
                key={rule.id}
                className="card"
                style={rule.enabled ? undefined : { opacity: 0.72 }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "flex-start",
                    justifyContent: "space-between",
                    gap: 12,
                    flexWrap: "wrap",
                  }}
                >
                  <div>
                    <strong>{triggerSummary(rule.trigger)}</strong>
                    <div className="muted small">
                      {rule.repeat === "once" ? "Один раз" : "Постійно"} → {recipientShort(rule.action.recipient)}
                    </div>
                  </div>
                  <label className="check">
                    <input
                      type="checkbox"
                      aria-label={`Увімкнути правило ${rule.id}`}
                      checked={rule.enabled}
                      disabled={isBusy}
                      onChange={() => void toggle(rule)}
                    />
                    {rule.enabled ? "Увімкнено" : "Вимкнено"}
                  </label>
                </div>

                <p style={{ whiteSpace: "pre-wrap", margin: 0 }}>{rule.action.text}</p>

                <div className="muted small num">
                  Спрацювало: {rule.stats.fired}
                  {rule.stats.fired > 0 ? ` · агентів: ${rule.stats.agents}` : ""}
                  {rule.stats.lastFiredAt ? ` · востаннє: ${formatLastFired(rule.stats.lastFiredAt)}` : ""}
                </div>

                {confirmDeleteId === rule.id ? (
                  <div className="confirm">
                    <span>Видалити це правило? Історію його спрацювань також буде видалено.</span>
                    <div className="actions">
                      <button
                        type="button"
                        className="btn sm danger"
                        onClick={() => void remove(rule.id)}
                        disabled={isBusy}
                      >
                        {isBusy && <LoaderCircle className="spin" size={14} />} Видалити
                      </button>
                      <button
                        type="button"
                        className="btn sm ghost"
                        onClick={() => setConfirmDeleteId(null)}
                        disabled={isBusy}
                      >
                        Скасувати
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="actions">
                    <button
                      type="button"
                      className="btn ghost sm"
                      disabled={isBusy}
                      onClick={() => openEdit(rule)}
                    >
                      <Pencil size={14} /> Редагувати
                    </button>
                    <button
                      type="button"
                      className="btn quiet sm"
                      disabled={isBusy}
                      onClick={() => void copyText(rule.id, ruleJson(fields, rule.id))}
                    >
                      {copiedKey === rule.id ? <Check size={14} /> : <Copy size={14} />}
                      {copiedKey === rule.id ? "Скопійовано" : "JSON"}
                    </button>
                    <button
                      type="button"
                      className="btn danger-text sm"
                      disabled={isBusy}
                      onClick={() => setConfirmDeleteId(rule.id)}
                    >
                      <Trash2 size={14} /> Видалити
                    </button>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
