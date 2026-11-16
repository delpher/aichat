import { ChevronDown, ListTodo, LoaderCircle } from "lucide-react";
import { useState } from "react";
import { MAX_BRIEF_LENGTH, type RoomBrief } from "../api/types";
import { useChat } from "../context";
import { isActive } from "../lib/activity";
import { knownRooms } from "../lib/views";
import { fmtShort } from "../lib/format";
import { Markdown } from "./Markdown";

interface Props {
  room: string;
  brief: RoomBrief | null;
  onSaveBrief: (text: string) => Promise<void>;
  workOpen: boolean;
  onToggleWork: () => void;
}

/** The room's brief (folded to one line, editable) and the way to who does what, under the header. */
export function RoomBar({ room, brief, onSaveBrief, workOpen, onToggleWork }: Props) {
  const { overview, fail, openRoom } = useChat();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const names = overview.agents.map((a) => a.name);
  const rooms = knownRooms(overview);
  // first non-empty line as plain text: no heading, list or emphasis markers
  const firstLine = (brief?.text.split("\n").find((l) => l.trim()) ?? "")
    .replace(/^\s*(?:#+|[-*+]|\d+\.)\s+/, "")
    .replace(/[*_`~]+/g, "")
    .trim();
  /** Agents busy in this room right now. */
  const working = overview.agents.filter(
    (a) => isActive(a.online, a.activity) && a.activity!.state === "busy" && a.activity!.room === room,
  ).length;

  const save = async () => {
    if (draft === null) return;
    setBusy(true);
    try {
      await onSaveBrief(draft);
      setDraft(null);
      setOpen(true);
    } catch (e) {
      fail(e, "Бриф не збережено");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="room-bar">
      <div className="room-bar-row">
        {draft === null ? (
          brief ? (
            <button type="button" className="brief-toggle" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
              <span className="brief-label">Бриф</span>
              <span className="brief-line">{firstLine}</span>
              <ChevronDown size={14} className="brief-chevron" />
            </button>
          ) : (
            <button type="button" className="btn quiet sm" onClick={() => setDraft("")}>
              Додати бриф кімнати
            </button>
          )
        ) : (
          <span className="brief-label">Бриф #{room}</span>
        )}
        <button
          type="button"
          className={`btn sm ${workOpen ? "ghost on" : "quiet"} work-toggle`}
          onClick={onToggleWork}
          aria-pressed={workOpen}
          title={`Хто що робить у #${room}`}
        >
          <ListTodo size={16} /> Робота
          {working > 0 && (
            <span className="activity-dots" aria-label={`Працюють тут: ${working}`}>
              <i />
              <i />
              <i />
            </span>
          )}
        </button>
      </div>

      {draft !== null ? (
        <form
          className="brief-edit"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={6}
            maxLength={MAX_BRIEF_LENGTH}
            autoFocus
            aria-label="Бриф кімнати"
            placeholder={
              "Мета кімнати, правила, хто що робить.\nНаприклад: claude-a пише код, claude-b робить рев'ю; рішення погоджуємо з olena."
            }
          />
          <div className="actions">
            <button type="submit" className="btn primary sm" disabled={busy}>
              {busy && <LoaderCircle className="spin" size={14} />} Зберегти бриф
            </button>
            <button type="button" className="btn quiet sm" onClick={() => setDraft(null)} disabled={busy}>
              Скасувати
            </button>
            <span className="muted small num brief-count">
              {draft.length}/{MAX_BRIEF_LENGTH}
            </span>
          </div>
          <p className="muted small">Агенти бачать бриф, коли приєднуються до кімнати, і отримують повідомлення про кожну зміну.</p>
        </form>
      ) : (
        brief &&
        open && (
          <div
            className="brief-body"
            onClick={(e) => {
              const ref = (e.target as HTMLElement).closest<HTMLElement>(".room-ref")?.dataset.room;
              if (ref) openRoom(ref);
            }}
          >
            <Markdown text={brief.text} names={names} rooms={rooms} />
            <div className="brief-meta">
              <span className="muted small num">
                {brief.by} · {fmtShort(brief.ts)}
              </span>
              <button type="button" className="btn quiet sm" onClick={() => setDraft(brief.text)}>
                Змінити
              </button>
            </div>
          </div>
        )
      )}
    </div>
  );
}
