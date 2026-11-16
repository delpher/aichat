import {
  Bold,
  Code,
  FileText,
  Hash,
  Italic,
  Link,
  List,
  ListOrdered,
  LoaderCircle,
  Paperclip,
  Quote,
  SendHorizontal,
  SquareCode,
  Strikethrough,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { MAX_ATTACHMENTS, type Agent, type ChatMessage } from "../api/types";
import { useChat } from "../context";
import { fmtSize, kindLabel } from "../lib/format";
import { applyFormat, insertMention, insertRef, refQuery, type FormatKind } from "../lib/markdownEdit";
import { knownRooms, type View } from "../lib/views";
import { isImage } from "./Attachments";
import { Avatar } from "./Avatar";
import { snippet } from "./MessageItem";

const TOOLS: { kind: FormatKind; icon: typeof Bold; label: string; key?: string }[] = [
  { kind: "bold", icon: Bold, label: "Жирний (Ctrl+B)", key: "b" },
  { kind: "italic", icon: Italic, label: "Курсив (Ctrl+I)", key: "i" },
  { kind: "strike", icon: Strikethrough, label: "Закреслений" },
  { kind: "code", icon: Code, label: "Код (Ctrl+E)", key: "e" },
  { kind: "codeblock", icon: SquareCode, label: "Блок коду" },
  { kind: "link", icon: Link, label: "Посилання (Ctrl+K)", key: "k" },
  { kind: "bullet", icon: List, label: "Список" },
  { kind: "numbered", icon: ListOrdered, label: "Нумерований список" },
  { kind: "quote", icon: Quote, label: "Цитата" },
];

interface Pending {
  key: string;
  file: File;
  preview?: string;
}

interface Props {
  view: View;
  replyTo: ChatMessage | null;
  onCancelReply: () => void;
  /** Files dropped on the chat area. */
  dropped: File[];
  onDroppedTaken: () => void;
  /** A name to insert as @name at the caret (a new seq inserts again). */
  mention?: { name: string; seq: number } | null;
  /** In a thread: every message answers `replyTo` (the thread's newest), with no reply bar to cancel. */
  threadReply?: boolean;
  /** Why writing is not possible here (shown instead of the placeholder). */
  blockedReason?: string;
  placeholder?: string;
}

let pendingSeq = 0;

/** A suggestion while typing "@name" or "#room". */
type Candidate = { type: "agent"; name: string; agent: Agent } | { type: "room"; name: string };

/**
 * Touch keyboards have no Shift+Enter, so there Enter makes a new line and the send button sends.
 * A coarse pointer without hover is a phone or tablet; a laptop with a touchscreen keeps Enter-to-send.
 */
export const enterSends = () => {
  try {
    return !window.matchMedia("(pointer: coarse) and (hover: none)").matches;
  } catch {
    return true;
  }
};

export function Composer({
  view,
  replyTo,
  onCancelReply,
  dropped,
  onDroppedTaken,
  mention,
  threadReply,
  blockedReason,
  placeholder,
}: Props) {
  const { session, api, overview, sender, addLive, fail, toast } = useChat();
  const admin = session.mode === "admin";
  const [text, setText] = useState("");
  const [files, setFiles] = useState<Pending[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [to, setTo] = useState("");
  const area = useRef<HTMLTextAreaElement>(null);

  // ---- @mentions: a clicked name is inserted; typing "@" offers names ----
  const [caret, setCaret] = useState(0);
  const [pickIdx, setPickIdx] = useState(0);
  const [pickClosed, setPickClosed] = useState(false);
  const placeCaret = (pos: number) =>
    requestAnimationFrame(() => {
      const el = area.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(pos, pos);
      setCaret(pos);
    });
  useEffect(() => {
    if (!mention) return;
    const el = area.current;
    const focused = el && document.activeElement === el;
    const start = focused ? el.selectionStart : text.length;
    const end = focused ? el.selectionEnd : text.length;
    const r = insertMention(text, start, end, mention.name);
    setText(r.text);
    placeCaret(r.caret);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mention?.seq]);
  // "@" offers people and agents, "#" offers rooms
  const query = refQuery(text, caret);
  const q = query ? query.query.toLowerCase() : null;
  const sigil = query?.sigil ?? "@";
  const myRooms = useMemo(() => new Set(overview.rooms.map((r) => r.name)), [overview.rooms]);
  const candidates = useMemo<Candidate[]>(() => {
    if (q === null) return [];
    if (sigil === "#")
      return knownRooms(overview)
        .filter((n) => n.toLowerCase().startsWith(q))
        .sort((x, y) => Number(myRooms.has(y)) - Number(myRooms.has(x)) || x.localeCompare(y))
        .slice(0, 8)
        .map((name) => ({ type: "room", name }));
    return overview.agents
      .filter((a) => a.name !== sender && a.name.toLowerCase().startsWith(q))
      .sort((x, y) => Number(y.online) - Number(x.online) || x.name.localeCompare(y.name))
      .slice(0, 8)
      .map((a) => ({ type: "agent", name: a.name, agent: a }));
  }, [q, sigil, overview, sender, myRooms]);
  const picking = !pickClosed && candidates.length > 0;
  useEffect(() => {
    setPickIdx(0);
    setPickClosed(false);
  }, [query?.start, q]);
  const pick = (name: string) => {
    if (!query) return;
    const r = insertRef(text, query.start, caret, query.sigil, name);
    setText(r.text);
    placeCaret(r.caret);
  };
  const picker = useRef<HTMLInputElement>(null);

  // "All messages" (admin): pick the conversation to write to
  // "Кому" lists people and agents; to write to a room, open the room. Only a reply keeps its room as the target.
  const targets = useMemo(() => {
    if (view.kind !== "all") return [];
    const people = overview.agents
      .map((a) => a.name)
      .filter((n) => n !== sender)
      .sort()
      .map((n) => `@${n}`);
    return replyTo?.room ? [`#${replyTo.room}`, ...people] : people;
  }, [view.kind, overview, sender, replyTo?.room]);
  useEffect(() => {
    if (view.kind === "all" && targets.length && !targets.includes(to)) {
      // filtered to one participant: write to them by default
      const preferred = view.agent && view.agent !== sender ? `@${view.agent}` : "";
      setTo(targets.includes(preferred) ? preferred : targets[0]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- view.agent is part of the view key; the composer remounts with it
  }, [targets, to, view.kind]);
  useEffect(() => {
    if (replyTo && view.kind === "all") {
      const t = replyTo.room ? `#${replyTo.room}` : `@${replyTo.from === sender ? replyTo.to : replyTo.from}`;
      if (targets.includes(t)) setTo(t);
    }
    if (replyTo && !threadReply) area.current?.focus();
  }, [replyTo, view.kind, sender, targets, threadReply]);

  const addFiles = (list: File[]) => {
    if (!list.length) return;
    setFiles((cur) => {
      const room = MAX_ATTACHMENTS - cur.length;
      if (list.length > room) toast(`До одного повідомлення можна додати не більше ${MAX_ATTACHMENTS} файлів.`, true);
      const add = list.slice(0, Math.max(room, 0)).map((file) => ({
        key: `p${++pendingSeq}`,
        file,
        preview: isImage({ mime: file.type }) ? URL.createObjectURL(file) : undefined,
      }));
      return [...cur, ...add];
    });
  };
  useEffect(() => {
    if (dropped.length) {
      addFiles(dropped);
      onDroppedTaken();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dropped]);
  const removeFile = (key: string) =>
    setFiles((cur) => {
      const f = cur.find((x) => x.key === key);
      if (f?.preview) URL.revokeObjectURL(f.preview);
      return cur.filter((x) => x.key !== key);
    });

  let blocked = blockedReason ?? "";
  if (view.kind === "dm" && sender !== view.a && sender !== view.b)
    blocked = "Це чужа особиста розмова: ви її бачите як адмін, але писати в неї не можете.";

  const target = (): { room: string } | { to: string } | null => {
    if (view.kind === "room") return { room: view.room };
    if (view.kind === "dm") return { to: sender === view.a ? view.b : view.a };
    if (view.kind === "all" && to) return to.startsWith("#") ? { room: to.slice(1) } : { to: to.slice(1) };
    return null;
  };

  const format = (kind: FormatKind) => {
    const el = area.current;
    if (!el) return;
    const r = applyFormat(kind, text, el.selectionStart, el.selectionEnd);
    setText(r.text);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(r.start, r.end);
    });
  };

  const send = async () => {
    if (busy || blocked) return;
    if (!text.trim() && !files.length) return;
    const t = target();
    if (!t) {
      toast("Оберіть отримувача.", true);
      return;
    }
    try {
      const ids: string[] = [];
      for (const [i, p] of files.entries()) {
        setBusy(files.length > 1 ? `Надсилаю файли… ${i + 1}/${files.length}` : `Надсилаю ${p.file.name}…`);
        ids.push((await api.upload(admin ? `/admin/api/files?as=${encodeURIComponent(sender)}` : "/api/files", p.file)).id);
      }
      setBusy("Надсилаю…");
      const body = {
        ...(admin ? { as: sender } : {}),
        ...t,
        text,
        ...(replyTo ? { reply_to: replyTo.id } : {}),
        ...(ids.length ? { attachments: ids } : {}),
      };
      const data = await api.send<{ message: ChatMessage }>("POST", admin ? "/admin/api/messages" : "/api/messages", body);
      setText("");
      files.forEach((f) => f.preview && URL.revokeObjectURL(f.preview));
      setFiles([]);
      onCancelReply();
      if (data?.message) addLive(data.message);
    } catch (err) {
      fail(err, "Не надіслано");
    } finally {
      setBusy(null);
      area.current?.focus();
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (picking) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const d = e.key === "ArrowDown" ? 1 : -1;
        setPickIdx((i) => (i + d + candidates.length) % candidates.length);
        return;
      }
      if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
        e.preventDefault();
        pick(candidates[Math.min(pickIdx, candidates.length - 1)].name);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setPickClosed(true);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && enterSends()) {
      e.preventDefault();
      void send();
      return;
    }
    if (e.key === "Escape" && replyTo && !threadReply) onCancelReply();
    if ((e.ctrlKey || e.metaKey) && !e.altKey) {
      const tool = TOOLS.find((t) => t.key === e.key.toLowerCase());
      if (tool) {
        e.preventDefault();
        format(tool.kind);
      }
    }
  };

  const onPaste = (e: React.ClipboardEvent) => {
    const pasted = [...e.clipboardData.files];
    if (pasted.length) {
      e.preventDefault();
      addFiles(pasted);
    }
  };

  // grow with the text, up to a limit
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [text]);

  const disabled = !!blocked || !!busy;
  return (
    <form
      className="composer"
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
    >
      {view.kind === "all" && (
        <div className="composer-route">
          <label>
            Кому
            <select value={to} onChange={(e) => setTo(e.target.value)} aria-label="Кому">
              {targets.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
      <div className={`composer-box${blocked ? " blocked" : ""}`}>
        {replyTo && !threadReply && (
          <div className="reply-bar">
            <span>
              Відповідь <strong>{replyTo.from}</strong>: <span className="reply-text">{snippet(replyTo)}</span>
            </span>
            <button
              type="button"
              className="icon-btn sm"
              onClick={onCancelReply}
              title="Скасувати відповідь"
              aria-label="Скасувати відповідь"
            >
              <X size={14} />
            </button>
          </div>
        )}
        {files.length > 0 && (
          <ul className="pending-files" aria-label="Файли до надсилання">
            {files.map((p) => (
              <li key={p.key} className={p.preview ? "pf-image" : ""}>
                {p.preview ? <img src={p.preview} alt={p.file.name} /> : <FileText size={18} />}
                <span className="pf-meta">
                  <span className="pf-name">{p.file.name}</span>
                  <span className="pf-size">{fmtSize(p.file.size)}</span>
                </span>
                <button
                  type="button"
                  className="pf-remove"
                  onClick={() => removeFile(p.key)}
                  disabled={!!busy}
                  title={`Прибрати ${p.file.name}`}
                  aria-label={`Прибрати ${p.file.name}`}
                >
                  <X size={12} />
                </button>
              </li>
            ))}
          </ul>
        )}
        {picking && (
          <ul className="mentions" id="mention-list" role="listbox" aria-label={sigil === "#" ? "Яку кімнату згадати" : "Кого згадати"}>
            {candidates.map((c, i) => (
              <li key={c.name} role="option" aria-selected={i === pickIdx}>
                <button
                  type="button"
                  tabIndex={-1}
                  className={i === pickIdx ? "on" : ""}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pick(c.name);
                  }}
                  onMouseEnter={() => setPickIdx(i)}
                >
                  {c.type === "room" ? (
                    <>
                      <span className="mention-icon">
                        <Hash size={14} />
                      </span>
                      <span>{c.name}</span>
                      {!myRooms.has(c.name) && <span className="muted small">ви не в кімнаті</span>}
                    </>
                  ) : (
                    <>
                      <Avatar name={c.agent.name} kind={c.agent.kind} online={c.agent.online} size="sm" />
                      <span>{c.name}</span>
                      {c.agent.kind !== "human" && <span className="muted small">{kindLabel(c.agent.kind)}</span>}
                    </>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
        <textarea
          ref={area}
          rows={1}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setCaret(e.target.selectionStart);
          }}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
          onBlur={() => setPickClosed(true)}
          onFocus={() => setPickClosed(false)}
          onKeyDown={onKeyDown}
          aria-autocomplete="list"
          aria-expanded={picking}
          aria-controls={picking ? "mention-list" : undefined}
          onPaste={onPaste}
          disabled={disabled}
          placeholder={
            blocked ||
            placeholder ||
            (view.kind === "room"
              ? `Написати в #${view.room}`
              : view.kind === "dm"
                ? `Написати ${sender === view.a ? view.b : view.a}`
                : "Написати повідомлення")
          }
          enterKeyHint={enterSends() ? "send" : "enter"}
          aria-label="Повідомлення"
        />
        <div className="composer-bar">
          <div className="toolbar" role="toolbar" aria-label="Форматування">
            {TOOLS.map(({ kind, icon: Icon, label }) => (
              <button
                key={kind}
                type="button"
                className="icon-btn sm"
                title={label}
                aria-label={label}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => format(kind)}
                disabled={disabled}
              >
                <Icon size={15} />
              </button>
            ))}
            <span className="toolbar-sep" />
            <button
              type="button"
              className="icon-btn sm"
              title="Додати файли або зображення"
              aria-label="Додати файли"
              onClick={() => picker.current?.click()}
              disabled={disabled}
            >
              <Paperclip size={15} />
            </button>
            <input
              ref={picker}
              type="file"
              multiple
              hidden
              data-testid="file-input"
              onChange={(e) => {
                addFiles([...(e.target.files ?? [])]);
                e.target.value = "";
              }}
            />
          </div>
          {busy && <span className="composer-status">{busy}</span>}
          <button
            type="submit"
            className="send"
            disabled={disabled || (!text.trim() && !files.length)}
            title={enterSends() ? "Надіслати (Enter). Новий рядок: Shift+Enter" : "Надіслати"}
            aria-label="Надіслати"
          >
            {busy ? <LoaderCircle className="spin" size={18} /> : <SendHorizontal size={18} />}
          </button>
        </div>
      </div>
    </form>
  );
}
