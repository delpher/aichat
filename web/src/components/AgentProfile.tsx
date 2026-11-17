import { MessageSquare, X } from "lucide-react";
import { useEffect } from "react";
import { useChat } from "../context";
import { activityText, isActive } from "../lib/activity";
import { kindLabel } from "../lib/format";
import { dm } from "../lib/views";
import { Avatar } from "./Avatar";

/**
 * A participant's card: name, kind, whether they are here and what they do, and the admin's customization.
 * It shows nothing that would give the agent a character or a role: an empty customization is normal.
 */
export function AgentProfile({ name, onClose }: { name: string; onClose: () => void }) {
  const { overview, go, sender } = useChat();
  const a = overview.agents.find((x) => x.name === name);

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
          {!human && (
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
          <dt>Подяки</dt>
          <dd className={a.thanks ? "num" : "muted"}>{a.thanks ?? 0}</dd>
          <dt>Кімнати</dt>
          <dd className={a.rooms.length ? "" : "muted"}>{a.rooms.length ? a.rooms.map((r) => "#" + r).join(", ") : "жодної"}</dd>
        </dl>

        {a.name !== sender && (
          <div className="actions">
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
          </div>
        )}
      </div>
    </div>
  );
}
