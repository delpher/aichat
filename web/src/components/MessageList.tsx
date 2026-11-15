import { ArrowDown, LoaderCircle, MessagesSquare } from "lucide-react";
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ChatMessage } from "../api/types";
import { useChat } from "../context";
import { dayKey, fmtDay } from "../lib/format";
import { MessageItem } from "./MessageItem";

/** Messages closer than this from the same sender are grouped under one header. */
const GROUP_MS = 5 * 60 * 1000;

interface Props {
  messages: ChatMessage[];
  loading: boolean;
  hasOlder: boolean;
  olderLoads: number;
  onLoadOlder: () => void;
  onReply?: (m: ChatMessage) => void;
  /** Click on a sender's name: mention them in the composer. */
  onMention?: (name: string) => void;
  showWhere: boolean;
  emptyText: string;
}

export function MessageList({ messages, loading, hasOlder, olderLoads, onLoadOlder, onReply, onMention, showWhere, emptyText }: Props) {
  const { overview, session, sender, toast } = useChat();
  const box = useRef<HTMLDivElement>(null);
  const [flash, setFlash] = useState<number | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  const prev = useRef({ count: 0, lastId: 0, height: 0, olderLoads: 0 });

  const kinds = useMemo(() => new Map(overview.agents.map((a) => [a.name, a.kind])), [overview.agents]);
  const names = useMemo(() => overview.agents.map((a) => a.name), [overview.agents]);
  const byId = useMemo(() => new Map(messages.map((m) => [m.id, m])), [messages]);

  // Keep the view pinned to the bottom for new messages, and in place when older ones are prepended.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const p = prev.current;
    const last = messages[messages.length - 1];
    if (olderLoads !== p.olderLoads) el.scrollTop = el.scrollHeight - p.height + el.scrollTop;
    else if (!p.count || (last && last.id !== p.lastId && (atBottom || last.from === sender))) el.scrollTop = el.scrollHeight;
    prev.current = { count: messages.length, lastId: last?.id ?? 0, height: el.scrollHeight, olderLoads };
  }, [messages, olderLoads, atBottom, sender]);

  // Images load after layout; stay at the bottom while they do.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const onLoad = () => {
      if (atBottom) el.scrollTop = el.scrollHeight;
    };
    el.addEventListener("load", onLoad, true);
    return () => el.removeEventListener("load", onLoad, true);
  }, [atBottom]);

  const onScroll = () => {
    const el = box.current!;
    setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
    prev.current.height = el.scrollHeight;
  };

  const jump = useCallback(
    (id: number) => {
      const node = document.getElementById(`m${id}`);
      if (!node) {
        toast(`Повідомлення #${id} ще не завантажене. Прокрутіть угору й натисніть «Завантажити старіші».`);
        return;
      }
      node.scrollIntoView({ behavior: "smooth", block: "center" });
      setFlash(id);
      setTimeout(() => setFlash((f) => (f === id ? null : f)), 1600);
    },
    [toast],
  );

  const mine = session.mode === "user" ? session.me.name : sender;

  return (
    <div className="feed" ref={box} onScroll={onScroll} aria-live="polite">
      <div className="feed-inner">
        {hasOlder && (
          <button type="button" className="older" onClick={onLoadOlder} disabled={loading}>
            {loading ? <LoaderCircle className="spin" size={14} /> : null} Завантажити старіші
          </button>
        )}
        {!loading && messages.length === 0 && (
          <div className="empty">
            <MessagesSquare size={40} strokeWidth={1.5} />
            <p>{emptyText}</p>
          </div>
        )}
        {loading && messages.length === 0 && (
          <div className="empty">
            <LoaderCircle className="spin" size={28} />
          </div>
        )}
        <ol className="messages">
          {messages.map((m, i) => {
            const before = messages[i - 1];
            const newDay = !before || dayKey(before.ts) !== dayKey(m.ts);
            const compact =
              !!before &&
              !newDay &&
              before.from === m.from &&
              (before.room ?? before.to) === (m.room ?? m.to) &&
              m.reply_to == null &&
              new Date(m.ts).getTime() - new Date(before.ts).getTime() < GROUP_MS;
            return (
              <Fragment key={m.id}>
                {newDay && (
                  <li className="day" role="separator">
                    <span>{fmtDay(m.ts)}</span>
                  </li>
                )}
                <MessageItem
                  message={m}
                  compact={compact}
                  mine={m.from === mine}
                  kind={kinds.get(m.from) ?? null}
                  showWhere={showWhere}
                  showTo={session.mode === "admin"}
                  parent={m.reply_to != null ? byId.get(m.reply_to) : undefined}
                  names={names}
                  flash={flash === m.id}
                  onReply={onReply}
                  onMention={onMention}
                  onJump={jump}
                />
              </Fragment>
            );
          })}
        </ol>
      </div>
      {!atBottom && (
        <button
          type="button"
          className="to-bottom"
          onClick={() => box.current?.scrollTo({ top: box.current.scrollHeight, behavior: "smooth" })}
          title="До останніх повідомлень"
          aria-label="До останніх повідомлень"
        >
          <ArrowDown size={18} />
        </button>
      )}
    </div>
  );
}
