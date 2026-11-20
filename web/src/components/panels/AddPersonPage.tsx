import { ArrowLeft, LoaderCircle } from "lucide-react";
import { useState } from "react";
import { AuthError } from "../../api/http";
import { MAX_DESCRIPTION_LENGTH, ROOM_RE, type Agent, type Setup } from "../../api/types";
import { useChat } from "../../context";
import { handSetup } from "../../lib/handoff";
import { Status, type StatusValue } from "./Status";
import { useAgents } from "./useAgents";

/** Adds an agent or a person, then opens their page with the setup and the new token. */
export function AddPersonPage() {
  const { api, fail, go, reloadOverview } = useChat();
  const { editable } = useAgents();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<StatusValue>(null);
  const [form, setForm] = useState({ name: "", kind: "human", custom: "bot", webhook: "", description: "", rooms: "" });
  const locked = !editable || busy;

  const add = async () => {
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
    setBusy(true);
    try {
      const d = await api.send<{ agent: Agent; setup: Setup }>("POST", "/admin/api/agents", {
        name,
        kind,
        rooms,
        ...(form.description.trim() ? { description: form.description.trim() } : {}),
        ...(webhook ? { webhook } : {}),
      });
      handSetup(d.agent.name, d.setup);
      reloadOverview().catch(() => {});
      go({ kind: "person", name: d.agent.name });
    } catch (err) {
      if (err instanceof AuthError) return fail(err, "");
      setStatus({ text: `Помилка: ${(err as Error).message}`, error: true });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel">
      <div>
        <button type="button" className="btn ghost sm" onClick={() => go({ kind: "people" })}>
          <ArrowLeft size={14} /> Агенти й люди
        </button>
      </div>
      <form
        className="card"
        onSubmit={(e) => {
          e.preventDefault();
          void add();
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
              autoFocus
              disabled={locked}
            />
            <small>Латиниця, цифри, - і _</small>
          </label>
          <label className="field">
            <span>Тип</span>
            <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })} disabled={locked}>
              <option value="human">Людина</option>
              <option value="claude">Claude Code</option>
              <option value="opencode">OpenCode</option>
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
              maxLength={MAX_DESCRIPTION_LENGTH}
              placeholder="Пара речень, необов'язково"
              disabled={locked}
            />
          </label>
          <label className="field">
            <span>Кімнати</span>
            <input value={form.rooms} onChange={(e) => setForm({ ...form, rooms: e.target.value })} placeholder="lobby, team" disabled={locked} />
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
    </div>
  );
}
