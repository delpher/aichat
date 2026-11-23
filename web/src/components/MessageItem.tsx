import { CheckCheck, CornerUpLeft, HandHeart, MessagesSquare, Reply } from "lucide-react";
import { memo, useLayoutEffect, useRef, useState } from "react";
import { isSystemSender, type ChatMessage } from "../api/types";
import { fmtFull, fmtShort, fmtTime, plural } from "../lib/format";
import { dm, hashFor, inPlace, msgLink } from "../lib/views";
import { Attachments } from "./Attachments";
import { Avatar } from "./Avatar";
import { Markdown } from "./Markdown";
import { ReactionList, ReactionPicker } from "./Reactions";
import { isAdmin, useChat } from "../context";

export interface MessageItemProps {
  message: ChatMessage;
  /** Same sender as the message above, shortly after: no avatar and name. */
  compact: boolean;
  mine: boolean;
  /** Who the viewer acts as (thanks and reactions are given in this name); none: read-only. */
  me?: string;
  kind: string | null;
  /** Show where the message went (in the "all messages" view). */
  showWhere: boolean;
  /** Admin viewing a DM: show the recipient. */
  showTo: boolean;
  parent?: ChatMessage;
  names: string[];
  /** Rooms a #name in the text may refer to. */
  rooms?: string[];
  /** Click on a #room reference. */
  onRoom?: (room: string) => void;
  flash: boolean;
  /** Arrived live after the list was opened: slides in. */
  enter?: boolean;
  onReply?: (m: ChatMessage) => void;
  onMention?: (name: string) => void;
  /** Goes to message `id`; `accept` tells whether the message found is the one meant (a [[msg:…]] link names where it is). */
  onJump: (id: number, accept?: (target: ChatMessage) => boolean) => void;
  /** The quoted parent is the message right above (in a thread): skip the quote. */
  hideQuote?: boolean;
  /** This message is the root of a folded thread: show its summary. */
  thread?: ThreadSummaryInfo;
  /** Opens the thread this message belongs to (offered when it belongs to one). */
  onOpenThread?: (id: number) => void;
  /** Prefix of the element id (`m42`); the thread panel uses another so ids stay unique. */
  idPrefix?: string;
}

export interface ThreadSummaryInfo {
  count: number;
  participants: string[];
  kinds: Map<string, string>;
  lastTs: string;
  /** Replies arrived that the viewer has not opened yet. */
  unseen: number;
  /** The chain reached the hop limit. */
  limit: boolean;
  /** The thread panel shows this thread now. */
  open: boolean;
}

/** The message number; a click copies a link to the message to paste into a message (alexey, AIChat 3120-3130). */
function MessageId({ m, me }: { m: ChatMessage; me?: string }) {
  const { toast } = useChat();
  const link = msgLink(m, me);
  return (
    <button
      type="button"
      className="msg-id"
      title={`Скопіювати посилання на повідомлення: ${link}`}
      onClick={() =>
        navigator.clipboard
          ?.writeText(link)
          .then(() => toast(`Скопійовано ${link}`))
          .catch(() => toast(`Не вдалося скопіювати: ${link}`))
      }
    >
      #{m.id}
    </button>
  );
}

/** Thanks the author of message `id`; the socket brings the result back to every viewer. */
function ThankButton({ id, as, author }: { id: number; as: string; author: string }) {
  const { api, session, fail, overview } = useChat();
  const [busy, setBusy] = useState(false);
  // the keeper is part of AIChat itself, not a participant: its messages are not thanked
  if (overview.agents.some((a) => a.name === author && a.keeper)) return null;
  const thank = async () => {
    setBusy(true);
    try {
      if (isAdmin(session)) await api.send("POST", `/admin/api/messages/${id}/thanks`, { as });
      else await api.send("POST", `/api/messages/${id}/thanks`, {});
    } catch (e) {
      fail(e, "Подяку не надіслано");
    } finally {
      setBusy(false);
    }
  };
  return (
    <button type="button" className="icon-btn sm" onClick={thank} disabled={busy} title="Подякувати" aria-label="Подякувати">
      <HandHeart size={15} />
    </button>
  );
}

/** Messages taller than this fold to FOLDED_PX with a "show all" button. */
const FOLD_OVER_PX = 480;

/** Message text that folds when it is very long. */
function FoldableText({
  children,
  className,
  onClick,
}: {
  children: React.ReactNode;
  className: string;
  onClick?: React.MouseEventHandler;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [tall, setTall] = useState(false);
  const [open, setOpen] = useState(false);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setTall(el.scrollHeight > FOLD_OVER_PX);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <>
      <div ref={box} className={`${className}${tall && !open ? " folded" : ""}`} onClick={onClick}>
        {children}
      </div>
      {tall && (
        <button type="button" className="fold-toggle" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          {open ? "Згорнути" : "Показати повністю"}
        </button>
      )}
    </>
  );
}

function ThreadSummary({ t, onOpen }: { t: ThreadSummaryInfo; onOpen: () => void }) {
  return (
    <button
      type="button"
      className={`thread-summary${t.open ? " open" : ""}${t.unseen ? " fresh" : ""}`}
      onClick={onOpen}
      aria-expanded={t.open}
      title="Відкрити тред"
    >
      <span className="faces">
        {t.participants.slice(0, 4).map((n) => (
          <Avatar key={n} name={n} kind={t.kinds.get(n)} size="sm" />
        ))}
      </span>
      <span className="count num">
        {t.count} {plural(t.count, ["відповідь", "відповіді", "відповідей"])}
      </span>
      {t.unseen > 0 && <span className="new num">+{t.unseen}</span>}
      <span className="muted num">остання {fmtShort(t.lastTs)}</span>
      {t.limit && <span className="limit">· ліміт</span>}
    </button>
  );
}

/** One line of plain text for quotes: Markdown markers dropped, files mentioned. */
export function snippet(m: ChatMessage): string {
  const text = m.text
    .replace(/```[\s\S]*?```/g, " [код] ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_~`>#]+/g, "")
    .replace(/^\s*(?:-|\d+\.)\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  const files = m.attachments?.length ? `файли: ${m.attachments.map((f) => f.name).join(", ")}` : "";
  return [text, files].filter(Boolean).join(" ");
}

export const MessageItem = memo(function MessageItem(p: MessageItemProps) {
  const m = p.message;
  const where = m.room ? `#${m.room}` : `→ ${m.to}`;
  const system = isSystemSender(m.from);
  const gameId = m.room?.match(/^game-(\d+)$/)?.[1];
  const hasThanks = Boolean(m.thanked_by && m.thanked_by.length > 0);
  const hasReactions = Boolean(m.reactions && Object.values(m.reactions).some((who) => who.length > 0));
  const canReact = Boolean(p.me && m.from !== p.me);
  return (
    <li
      id={`${p.idPrefix ?? "m"}${m.id}`}
      className={`msg${p.compact ? " compact" : ""}${p.mine ? " mine" : ""}${p.flash ? " flash" : ""}${system ? " system" : ""}${p.enter ? " enter" : ""}`}
      data-id={m.id}
    >
      <div className="msg-gutter">
        {p.compact ? (
          <time className="msg-hover-time" dateTime={m.ts} title={`#${m.id} · ${fmtFull(m.ts)}`}>
            {fmtTime(m.ts)}
          </time>
        ) : (
          <Avatar name={m.from} kind={p.kind} />
        )}
      </div>
      <div className="msg-body">
        {!p.compact && (
          <div className="msg-head">
            {p.onMention && !system && !p.mine ? (
              <button
                type="button"
                className="msg-from as-link"
                onClick={() => p.onMention!(m.from)}
                title={`Згадати @${m.from} у повідомленні`}
              >
                {m.from}
              </button>
            ) : (
              <span className="msg-from">{m.from}</span>
            )}
            {system && gameId && (
              <a className="msg-where" href={hashFor({ kind: "game", id: Number(gameId) })}>
                Відкрити дошку
              </a>
            )}
            {p.showWhere && (
              <a className="msg-where" href={hashFor(m.room ? { kind: "room", room: m.room } : dm(m.from, m.to!))}>
                {where}
              </a>
            )}
            {!p.showWhere && p.showTo && !m.room && <span className="msg-where">→ {m.to}</span>}
            <time dateTime={m.ts} title={`#${m.id} · ${fmtFull(m.ts)}`}>
              {fmtTime(m.ts)}
            </time>
            <MessageId m={m} me={p.me} />
          </div>
        )}
        {m.reply_to != null && !p.hideQuote && (
          <button type="button" className="msg-quote" onClick={() => p.onJump(m.reply_to!)} title="Перейти до повідомлення">
            <CornerUpLeft size={13} />
            {p.parent ? (
              <>
                <strong>{p.parent.from}</strong>
                <span className="msg-quote-text">{snippet(p.parent)}</span>
              </>
            ) : (
              <span className="msg-quote-text">відповідь на #{m.reply_to}</span>
            )}
          </button>
        )}
        {m.text && (
          <FoldableText
            className={`msg-text${p.onMention ? " can-mention" : ""}`}
            onClick={(e) => {
              const target = e.target as HTMLElement;
              // a #room opens that room, a [[msg:…]] goes to that message; a highlighted @name mentions that person
              const room = target.closest<HTMLElement>(".room-ref")?.dataset.room;
              if (room) return p.onRoom?.(room);
              const ref = target.closest<HTMLElement>(".msg-ref")?.dataset;
              if (ref?.msg) return p.onJump(Number(ref.msg), (t) => inPlace(t, ref.place, m));
              const el = target.closest(".mention");
              if (el?.textContent && p.onMention) p.onMention(el.textContent.replace(/^@/, ""));
            }}
          >
            <Markdown text={m.text} names={p.names} rooms={p.rooms} />
          </FoldableText>
        )}
        {m.attachments && m.attachments.length > 0 && <Attachments files={m.attachments} />}
        {(hasThanks || hasReactions) && (
          <div className="msg-reactions-row">
            {hasThanks && (
              <span className="msg-thanks" title={`Подякували: ${m.thanked_by!.join(", ")}`}>
                <HandHeart size={13} aria-hidden />
                <span>{m.thanked_by!.join(", ")}</span>
              </span>
            )}
            <ReactionList id={m.id} reactions={m.reactions} me={p.me} canReact={canReact} />
          </div>
        )}
        {p.thread && p.onOpenThread && <ThreadSummary key={p.thread.count} t={p.thread} onOpen={() => p.onOpenThread!(m.id)} />}
      </div>
      <div className="msg-tools">
        {p.compact && (
          <MessageId m={m} me={p.me} />
        )}
        {p.mine && m.delivered_to && m.delivered_to.length > 0 && (
          <span
            className="delivered"
            title={`Доставлено: ${m.delivered_to.join(", ")}`}
            aria-label={`Доставлено: ${m.delivered_to.join(", ")}`}
          >
            <CheckCheck size={13} />
          </span>
        )}
        {m.hops > 0 && (
          <span className="hops" title="Довжина ланцюжка відповідей між агентами">
            ланцюжок {m.hops}
          </span>
        )}
        {p.onOpenThread && (
          <button
            type="button"
            className="icon-btn sm"
            onClick={() => p.onOpenThread!(m.id)}
            title="Відкрити тред"
            aria-label="Відкрити тред"
          >
            <MessagesSquare size={15} />
          </button>
        )}
        {canReact && <ReactionPicker id={m.id} reactions={m.reactions} as={p.me!} />}
        {p.me && m.from !== p.me && !system && !m.thanked_by?.includes(p.me) && (
          <ThankButton id={m.id} as={p.me} author={m.from} />
        )}
        {p.onReply && (
          <button type="button" className="icon-btn sm" onClick={() => p.onReply!(m)} title="Відповісти" aria-label="Відповісти">
            <Reply size={15} />
          </button>
        )}
      </div>
    </li>
  );
});
