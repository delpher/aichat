import { MessageSquare, NotebookText, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { AgentNote } from "../api/types";
import { useChat } from "../context";
import { activityText, isActive } from "../lib/activity";
import { adapterOutdated } from "../lib/adapter";
import { fmtShort, kindLabel } from "../lib/format";
import { dm } from "../lib/views";
import { Avatar } from "./Avatar";

/**
 * A participant's card: name, kind, whether they are here and what they do, and the admin's customization.
 * It shows nothing that would give the agent a character or a role: an empty customization is normal.
 */
export function AgentProfile({ name, onClose }: { name: string; onClose: () => void }) {
  const { overview, go, sender } = useChat();
  const a = overview.agents.find((x) => x.name === name);
  const [notebook, setNotebook] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!a) return null;
  const human = a.kind === "human";
  const status = a.online ? (isActive(a.online, a.activity) ? activityText(a.name, a.activity) : "онлайн") : "офлайн";
  return (
    <div className="palette-scrim" onMouseDown={onClose}>
      <div className="profile" role="dialog" aria-modal="true" aria-label={`Картка ${a.name}`} onMouseDown={(e) => e.stopPropagation()}>
        <header className="profile-head">
          <Avatar name={a.name} kind={a.kind} online={a.online} activity={a.activity} />
          <div className="profile-title">
            <h2>{a.name}</h2>
            <span className="muted small">
              {kindLabel(a.kind)} · {status}
            </span>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Закрити">
            <X size={16} />
          </button>
        </header>

        <dl className="profile-facts">
          {a.keeper && (
            <>
              <dt>Роль</dt>
              <dd>Keeper: частина самого AIChat, а не учасник. Пише агентам бриф пробудження після перерви й підказує, що де в просторі.</dd>
            </>
          )}
          {!human && !a.keeper && (
            <>
              <dt>Кастомізація</dt>
              <dd className={a.description ? "" : "muted"}>{a.description || "немає"}</dd>
            </>
          )}
          {human && a.description && (
            <>
              <dt>Опис</dt>
              <dd>{a.description}</dd>
            </>
          )}
          {a.activity?.topic && a.online && (
            <>
              <dt>Працює над</dt>
              <dd>{a.activity.topic}</dd>
            </>
          )}
          {a.online && a.adapter && (
            <>
              <dt>Адаптер</dt>
              <dd className="num">
                {a.adapter.name} {a.adapter.version}
                {adapterOutdated(a.adapter, overview.version) && <span className="profile-outdated"> · старий, на брокері {overview.version}</span>}
              </dd>
            </>
          )}
          <dt>Подяки</dt>
          <dd className={a.thanks ? "num" : "muted"}>{a.thanks ?? 0}</dd>
          <dt>Кімнати</dt>
          <dd className={a.rooms.length ? "" : "muted"}>{a.rooms.length ? a.rooms.map((r) => "#" + r).join(", ") : "жодної"}</dd>
        </dl>

        {notebook && <Notebook name={a.name} />}

        {(!human || a.name !== sender) && (
          <div className="actions">
            {!human && (
              <button type="button" className={`btn ghost sm${notebook ? " on" : ""}`} onClick={() => setNotebook((o) => !o)} aria-pressed={notebook}>
                <NotebookText size={14} /> Нотатник
              </button>
            )}
            {a.name !== sender && (
              <button
                type="button"
                className="btn ghost sm"
                onClick={() => {
                  go(dm(sender, a.name));
                  onClose();
                }}
              >
                <MessageSquare size={14} /> Написати
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * An agent's notebook as it is now, read-only: the agent keeps it for itself, people may look.
 * There is nothing to react with here: no marks, no comments, no edits.
 */
function Notebook({ name }: { name: string }) {
  const { api, fail } = useChat();
  const [notes, setNotes] = useState<AgentNote[] | null>(null);
  useEffect(() => {
    let live = true;
    api
      .get<{ notes: AgentNote[] }>(`/api/agents/${encodeURIComponent(name)}/notes`)
      .then((d) => live && setNotes(d.notes))
      .catch((e) => {
        if (!live) return;
        setNotes([]);
        fail(e, "Нотатник не завантажено");
      });
    return () => {
      live = false;
    };
  }, [api, fail, name]);

  return (
    <section className="notebook" aria-label={`Нотатник ${name}`}>
      <p className="muted small">Нотатник веде сам агент. Тут він лише для читання, і видно тільки поточний стан записів.</p>
      {!notes ? (
        <p className="muted small">Завантаження…</p>
      ) : !notes.length ? (
        <p className="muted">Нотатник порожній.</p>
      ) : (
        <ul className="notebook-list">
          {[...notes]
            .sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : b.id - a.id))
            .map((n) => (
              <li key={n.id} className="note">
                <div className="note-head muted small">
                  {n.topic && <span className="note-topic">{n.topic}</span>}
                  <span className="num">{fmtShort(n.ts)}</span>
                </div>
                <div className="note-title">{n.title}</div>
                <div className="note-description">{n.description}</div>
                {n.text && (
                  <details className="note-more">
                    <summary className="muted small">Текст, {n.text.length} символів</summary>
                    <div className="note-text">{n.text}</div>
                  </details>
                )}
              </li>
            ))}
        </ul>
      )}
    </section>
  );
}
