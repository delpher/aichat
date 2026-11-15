import { CornerUpLeft, Reply } from "lucide-react";
import { memo } from "react";
import type { ChatMessage } from "../api/types";
import { fmtFull, fmtTime } from "../lib/format";
import { dm, hashFor } from "../lib/views";
import { Attachments } from "./Attachments";
import { Avatar } from "./Avatar";
import { Markdown } from "./Markdown";

export interface MessageItemProps {
  message: ChatMessage;
  /** Same sender as the message above, shortly after: no avatar and name. */
  compact: boolean;
  mine: boolean;
  kind: string | null;
  /** Show where the message went (in the "all messages" view). */
  showWhere: boolean;
  /** Admin viewing a DM: show the recipient. */
  showTo: boolean;
  parent?: ChatMessage;
  names: string[];
  flash: boolean;
  onReply?: (m: ChatMessage) => void;
  onJump: (id: number) => void;
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
  const files = m.attachments?.length ? `📎 ${m.attachments.map((f) => f.name).join(", ")}` : "";
  return [text, files].filter(Boolean).join(" ");
}

export const MessageItem = memo(function MessageItem(p: MessageItemProps) {
  const m = p.message;
  const where = m.room ? `#${m.room}` : `→ ${m.to}`;
  return (
    <li
      id={`m${m.id}`}
      className={`msg${p.compact ? " compact" : ""}${p.mine ? " mine" : ""}${p.flash ? " flash" : ""}`}
      data-id={m.id}
    >
      <div className="msg-gutter">
        {p.compact ? (
          <time className="msg-hover-time" dateTime={m.ts} title={fmtFull(m.ts)}>
            {fmtTime(m.ts)}
          </time>
        ) : (
          <Avatar name={m.from} kind={p.kind} />
        )}
      </div>
      <div className="msg-body">
        {!p.compact && (
          <div className="msg-head">
            <span className="msg-from">{m.from}</span>
            {p.kind && p.kind !== "human" && <span className="tag tag-bot">AI</span>}
            {p.showWhere && (
              <a className="msg-where" href={hashFor(m.room ? { kind: "room", room: m.room } : dm(m.from, m.to!))}>
                {where}
              </a>
            )}
            {!p.showWhere && p.showTo && !m.room && <span className="msg-where">→ {m.to}</span>}
            <time dateTime={m.ts} title={fmtFull(m.ts)}>
              {fmtTime(m.ts)}
            </time>
          </div>
        )}
        {m.reply_to != null && (
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
        {m.text && <Markdown text={m.text} names={p.names} />}
        {m.attachments && m.attachments.length > 0 && <Attachments files={m.attachments} />}
      </div>
      <div className="msg-tools">
        <span className="msg-meta" title="Номер повідомлення і довжина ланцюжка відповідей">
          #{m.id}
          {m.hops > 0 && <span className="hops"> · hops {m.hops}</span>}
        </span>
        {p.onReply && (
          <button type="button" className="icon-btn sm" onClick={() => p.onReply!(m)} title="Відповісти" aria-label="Відповісти">
            <Reply size={15} />
          </button>
        )}
      </div>
    </li>
  );
});
