import {
  Bold,
  Code,
  FileText,
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
import { MAX_ATTACHMENTS, type ChatMessage } from "../api/types";
import { useChat } from "../context";
import { fmtSize } from "../lib/format";
import { applyFormat, type FormatKind } from "../lib/markdownEdit";
import type { View } from "../lib/views";
import { isImage } from "./Attachments";
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
}

let pendingSeq = 0;

export function Composer({ view, replyTo, onCancelReply, dropped, onDroppedTaken }: Props) {
  const { session, api, overview, sender, setSender, humans, addLive, fail, toast } = useChat();
  const admin = session.mode === "admin";
  const [text, setText] = useState("");
  const [files, setFiles] = useState<Pending[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [to, setTo] = useState("");
  const area = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);

  // "All messages" (admin): pick the conversation to write to
  const targets = useMemo(() => {
    if (view.kind !== "all") return [];
    const rooms = [...overview.rooms].sort((x, y) => x.name.localeCompare(y.name)).map((r) => `#${r.name}`);
    const people = overview.agents
      .map((a) => a.name)
      .filter((n) => n !== sender)
      .sort()
      .map((n) => `@${n}`);
    return [...rooms, ...people];
  }, [view.kind, overview, sender]);
  useEffect(() => {
    if (view.kind === "all" && targets.length && !targets.includes(to)) setTo(targets[0]);
  }, [targets, to, view.kind]);
  useEffect(() => {
    if (replyTo && view.kind === "all") {
      const t = replyTo.room ? `#${replyTo.room}` : `@${replyTo.from === sender ? replyTo.to : replyTo.from}`;
      if (targets.includes(t)) setTo(t);
    }
    if (replyTo) area.current?.focus();
  }, [replyTo, view.kind, sender, targets]);

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

  let blocked = "";
  if (admin && !humans.length) blocked = "Щоб писати з вебу, додайте людину в розділі «Агенти й люди».";
  else if (admin && view.kind === "dm" && sender !== view.a && sender !== view.b)
    blocked = `${sender} не учасник цієї розмови. Оберіть ${view.a} або ${view.b} у полі «Від», якщо це люди.`;

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
    if (!sender || !t) {
      toast("Оберіть відправника й отримувача.", true);
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
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
      return;
    }
    if (e.key === "Escape" && replyTo) onCancelReply();
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
      {(admin || view.kind === "all") && (
        <div className="composer-route">
          {admin && (
            <label>
              Від
              <select value={sender ?? ""} onChange={(e) => setSender(e.target.value)} disabled={!humans.length} aria-label="Від">
                {humans.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
          )}
          {view.kind === "all" && (
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
          )}
        </div>
      )}
      <div className={`composer-box${blocked ? " blocked" : ""}`}>
        {replyTo && (
          <div className="reply-bar">
            <span>
              Відповідь <strong>{replyTo.from}</strong>: <span className="reply-text">{snippet(replyTo)}</span>
            </span>
            <button type="button" className="icon-btn sm" onClick={onCancelReply} title="Скасувати відповідь" aria-label="Скасувати відповідь">
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
        <textarea
          ref={area}
          rows={1}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          disabled={disabled}
          placeholder={blocked || "Повідомлення… Enter надіслати, Shift+Enter новий рядок"}
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
            title="Надіслати (Enter)"
            aria-label="Надіслати"
          >
            {busy ? <LoaderCircle className="spin" size={18} /> : <SendHorizontal size={18} />}
          </button>
        </div>
      </div>
    </form>
  );
}
