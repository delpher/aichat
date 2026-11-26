import { ChevronDown, Download, ListTodo, ListTree, LoaderCircle } from "lucide-react";
import { useState } from "react";
import { MAX_BRIEF_LENGTH, type RoomBrief } from "../api/types";
import { useChat } from "../context";
import { isActive } from "../lib/activity";
import { exportRoom as saveRoomExport } from "../lib/exportRoom";
import { knownRooms } from "../lib/views";
import { fmtShort } from "../lib/format";
import { Markdown } from "./Markdown";

interface BarProps {
  brief: RoomBrief | null;
  /** The brief is expanded under the header. */
  open: boolean;
  onToggle: () => void;
  /** Opens the editor (an empty brief included). */
  onEdit: () => void;
}

/** The room's brief in the header row (AIChat #aichat-improvement-dev, 3751); the expanded text is `BriefPanel`. */
export function RoomBar({ brief, open, onToggle, onEdit }: BarProps) {
  // first non-empty line as plain text: no heading, list or emphasis markers
  const firstLine = (brief?.text.split("\n").find((l) => l.trim()) ?? "")
    .replace(/^\s*(?:#+|[-*+]|\d+\.)\s+/, "")
    .replace(/[*_`~]+/g, "")
    .trim();

  if (!brief)
    return (
      <button type="button" className="btn quiet sm" onClick={onEdit}>
        Додати бриф кімнати
      </button>
    );
  return (
    <button type="button" className="brief-toggle" onClick={onToggle} aria-expanded={open} title={firstLine}>
      <span className="brief-label hide-sm">Бриф</span>
      <span className="brief-line">{firstLine}</span>
      <ChevronDown size={14} className="brief-chevron" />
    </button>
  );
}

/**
 * The header's buttons for a room: threads, the work panel and the export of the conversation
 * (AIChat #aichat-improvement-dev, 3751).
 */
export function RoomActions({ room, workOpen, onToggleWork }: { room: string; workOpen: boolean; onToggleWork: () => void }) {
  const { overview, api, session, fail, threaded, setThreaded } = useChat();
  const [exporting, setExporting] = useState(false);

  /** The whole conversation of the room, with its brief, as a Markdown file to save. */
  const exportRoom = async () => {
    setExporting(true);
    try {
      await saveRoomExport(api, session, room);
    } catch (e) {
      fail(e, "не вдалось експортувати");
    } finally {
      setExporting(false);
    }
  };
  /** Agents busy in this room right now. */
  const working = overview.agents.filter(
    (a) => isActive(a.online, a.activity) && a.activity!.state === "busy" && a.activity!.room === room,
  ).length;

  return (
    <div className="head-actions">
        <button
          type="button"
          className={`btn sm ${threaded ? "ghost on" : "quiet"}`}
          onClick={() => setThreaded(!threaded)}
          aria-pressed={threaded}
          title={threaded ? "Відповіді згорнуті в тредах. Повторний клік поверне їх у стрічку" : "Згорнути відповіді в тредах"}
        >
          <ListTree size={16} /> <span className="hide-sm">Треди</span>
        </button>
        <button
          type="button"
          className={`btn sm ${workOpen ? "ghost on" : "quiet"} work-toggle`}
          onClick={onToggleWork}
          aria-pressed={workOpen}
          title={`Хто що робить у #${room}`}
        >
          <ListTodo size={16} /> <span className="hide-sm">Робота</span>
          {working > 0 && (
            <span className="activity-dots" aria-label={`працюють тут: ${working}`}>
              <i />
              <i />
              <i />
            </span>
          )}
        </button>
        <button
          type="button"
          className="btn quiet sm export-toggle"
          onClick={() => void exportRoom()}
          disabled={exporting}
          aria-label={`Експортувати переписку #${room} у Markdown`}
          title={`Експортувати переписку #${room} у Markdown`}
        >
          {exporting ? <LoaderCircle className="spin" size={16} /> : <Download size={16} />}
    </button>
    </div>
  );
}

interface PanelProps {
  room: string;
  brief: RoomBrief | null;
  /** The editor instead of the text. */
  editing: boolean;
  onEdit: () => void;
  onClose: () => void;
  /** Back to the text (or folded away when there is no brief yet). */
  onCancel: () => void;
  onSave: (text: string) => Promise<void>;
}

/** The brief under the header: its text, or the editor. */
export function BriefPanel({ room, brief, editing, onEdit, onClose, onCancel, onSave }: PanelProps) {
  const { overview, fail, openRoom } = useChat();
  const [draft, setDraft] = useState(brief?.text ?? "");
  const [busy, setBusy] = useState(false);
  const names = overview.agents.map((a) => a.name);
  const rooms = knownRooms(overview);

  const save = async () => {
    setBusy(true);
    try {
      await onSave(draft);
    } catch (e) {
      fail(e, "бриф не збережено");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="brief-panel" aria-label={`Бриф #${room}`}>
      {editing ? (
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
              "що це за кімната, правила, хто в роботі.\nНаприклад: claude-a пише код, claude-b робить рев'ю; звернення загальні — до olena."
            }
          />
          <div className="actions">
            <button type="submit" className="btn primary sm" disabled={busy}>
              {busy && <LoaderCircle className="spin" size={14} />} Зберегти бриф
            </button>
            <button type="button" className="btn quiet sm" onClick={onCancel} disabled={busy}>
              Скасувати
            </button>
            <span className="muted small num brief-count">
              {draft.length}/{MAX_BRIEF_LENGTH}
            </span>
          </div>
          <p className="muted small">Бачать бриф усі, хто заходить до кімнати, і агенти кімнати бачать його на старті.</p>
        </form>
      ) : (
        brief && (
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
              <button type="button" className="btn quiet sm" onClick={onEdit}>
                Змінити
              </button>
              <button type="button" className="btn quiet sm" onClick={onClose}>
                згорнути
              </button>
            </div>
          </div>
        )
      )}
    </section>
  );
}