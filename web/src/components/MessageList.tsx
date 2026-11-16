import { ArrowDown, LoaderCircle } from "lucide-react";
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ChatMessage } from "../api/types";
import { useChat } from "../context";
import { dayKey, fmtDay } from "../lib/format";
import { atHopLimit, type Threads } from "../lib/threads";
import { knownRooms } from "../lib/views";
import { ChainEnd } from "./ChainEnd";
import { MessageItem, type ThreadSummaryInfo } from "./MessageItem";

/** Messages closer than this from the same sender are grouped under one header. */
export const GROUP_MS = 5 * 60 * 1000;

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
  /** Empty state: a short headline and what to do next. */
  emptyTitle: string;
  emptyText: string;
  /** Reply chains of `messages`; without it every message is shown flat. */
  threads?: Threads;
  /** Fold replies into their thread (only roots stay in the feed). */
  threaded?: boolean;
  /** Root of the thread open in the side panel. */
  openThread?: number | null;
  /** Newest reply id the viewer has seen, per thread root. */
  threadSeen?: Map<number, number>;
  /** Opens a thread by its root id, optionally pointing at one message in it. */
  onOpenThread?: (root: number, focus?: number) => void;
  /** A message to scroll to once it is loaded (older pages load until it is). */
  focusId?: number;
  onFocusDone?: () => void;
}

/** Placeholder rows while the first page of history loads. */
function FeedSkeleton() {
  return (
    <div className="skeleton feed-skeleton" aria-label="Завантаження повідомлень">
      {[70, 45, 85].map((w, i) => (
        <div key={i} className="skeleton-row">
          <span className="skeleton-circle" />
          <span className="skeleton-lines">
            <span className="skeleton-block" style={{ width: 120, height: 12 }} />
            <span className="skeleton-block" style={{ width: `${w}%`, height: 14 }} />
          </span>
        </div>
      ))}
    </div>
  );
}

export function MessageList({
  messages,
  loading,
  hasOlder,
  olderLoads,
  onLoadOlder,
  onReply,
  onMention,
  showWhere,
  emptyTitle,
  emptyText,
  threads,
  threaded = false,
  openThread = null,
  threadSeen,
  onOpenThread,
  focusId,
  onFocusDone,
}: Props) {
  const { overview, session, sender, toast, openRoom } = useChat();
  const box = useRef<HTMLDivElement>(null);
  const [flash, setFlash] = useState<number | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  const prev = useRef({ count: 0, lastId: 0, height: 0, olderLoads: 0 });
  const mine = session.mode === "user" ? session.me.name : sender;
  const maxHops = overview.max_hops;

  /** What the feed shows: everything, or only thread roots when replies fold into threads. */
  const visible = useMemo(
    () => (threaded && threads ? messages.filter((m) => threads.rootOf.get(m.id) === m.id) : messages),
    [messages, threads, threaded],
  );

  /** Newest id when the list first showed messages: anything newer arrived live and animates in. */
  const firstLast = useRef<number | null>(null);
  if (firstLast.current === null && !loading) firstLast.current = messages[messages.length - 1]?.id ?? 0;
  /** Newest visible id seen while scrolled to the bottom; newer ones from others count as unseen. */
  const [seenId, setSeenId] = useState(0);
  const lastId = visible[visible.length - 1]?.id ?? 0;
  useEffect(() => {
    if (atBottom) setSeenId(lastId);
  }, [atBottom, lastId]);

  const kinds = useMemo(() => new Map(overview.agents.map((a) => [a.name, a.kind])), [overview.agents]);
  const names = useMemo(() => overview.agents.map((a) => a.name), [overview.agents]);
  const rooms = useMemo(() => knownRooms(overview), [overview]);
  const byId = useMemo(() => new Map(messages.map((m) => [m.id, m])), [messages]);

  // Keep the view pinned to the bottom for new messages, and in place when older ones are prepended.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const p = prev.current;
    const last = visible[visible.length - 1];
    if (olderLoads !== p.olderLoads) el.scrollTop = el.scrollHeight - p.height + el.scrollTop;
    else if (!p.count || (last && last.id !== p.lastId && (atBottom || last.from === sender))) el.scrollTop = el.scrollHeight;
    prev.current = { count: visible.length, lastId: last?.id ?? 0, height: el.scrollHeight, olderLoads };
  }, [visible, olderLoads, atBottom, sender]);

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
      const node = box.current?.querySelector(`[data-id="${id}"]`);
      if (node) {
        node.scrollIntoView({ behavior: "smooth", block: "center" });
        setFlash(id);
        setTimeout(() => setFlash((f) => (f === id ? null : f)), 1600);
        return;
      }
      // Folded into a thread: open it there.
      const root = threads?.rootOf.get(id);
      if (root !== undefined && onOpenThread) return onOpenThread(root, id);
      toast(`Повідомлення #${id} ще не завантажене. Прокрутіть угору й натисніть «Завантажити старіші».`);
    },
    [toast, threads, onOpenThread],
  );

  // Bring a requested message (from search) into view: load older pages until it is there.
  useEffect(() => {
    if (focusId === undefined || loading) return;
    if (byId.has(focusId)) {
      const root = threads?.rootOf.get(focusId);
      if (threaded && root !== undefined && root !== focusId && threads?.byRoot.has(root)) onOpenThread?.(root, focusId);
      else jump(focusId);
      onFocusDone?.();
    } else if (hasOlder && messages.length && messages[0].id > focusId) onLoadOlder();
    else {
      toast(`Повідомлення #${focusId} не знайдено в цій розмові.`);
      onFocusDone?.();
    }
  }, [focusId, loading, messages, hasOlder]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Opens the thread of a message, if it is part of one. */
  const openOf = useCallback(
    (id: number) => {
      const root = threads?.rootOf.get(id);
      if (root !== undefined) onOpenThread?.(root, id === root ? undefined : id);
    },
    [threads, onOpenThread],
  );

  const summary = (m: ChatMessage): ThreadSummaryInfo | undefined => {
    const t = threaded ? threads?.byRoot.get(m.id) : undefined;
    if (!t) return undefined;
    const seen = Math.max(firstLast.current ?? 0, threadSeen?.get(m.id) ?? 0);
    return {
      count: t.replies.length,
      participants: t.participants,
      kinds,
      lastTs: t.last.ts,
      unseen: openThread === m.id ? 0 : t.replies.filter((r) => r.id > seen && r.from !== mine).length,
      limit: atHopLimit(t.last, maxHops),
      open: openThread === m.id,
    };
  };

  const unseen = atBottom ? 0 : visible.filter((m) => m.id > seenId && m.from !== mine).length;

  return (
    <div className="feed" ref={box} onScroll={onScroll} aria-live="polite">
      <div className="feed-inner">
        {hasOlder && (
          <button type="button" className="btn ghost sm older" onClick={onLoadOlder} disabled={loading}>
            {loading && <LoaderCircle className="spin" size={14} />} Завантажити старіші
          </button>
        )}
        {!loading && messages.length === 0 && (
          <div className="empty">
            <strong>{emptyTitle}</strong>
            <p>{emptyText}</p>
          </div>
        )}
        {loading && messages.length === 0 && <FeedSkeleton />}
        <ol className="messages">
          {visible.map((m, i) => {
            const before = visible[i - 1];
            const newDay = !before || dayKey(before.ts) !== dayKey(m.ts);
            const compact =
              !!before &&
              !newDay &&
              before.from === m.from &&
              (before.room ?? before.to) === (m.room ?? m.to) &&
              m.reply_to == null &&
              !(threaded && threads?.byRoot.has(before.id)) &&
              new Date(m.ts).getTime() - new Date(before.ts).getTime() < GROUP_MS;
            const thread = summary(m);
            const inThread = !!threads?.byRoot.get(threads.rootOf.get(m.id) ?? -1);
            // A folded thread shows its limit in the summary; otherwise the notice follows the message.
            const ends = atHopLimit(m, maxHops) && !thread;
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
                  rooms={rooms}
                  onRoom={openRoom}
                  flash={flash === m.id}
                  enter={firstLast.current !== null && m.id > firstLast.current}
                  onReply={onReply}
                  onMention={onMention}
                  onJump={jump}
                  thread={thread}
                  onOpenThread={inThread && onOpenThread ? openOf : undefined}
                />
                {ends && <ChainEnd maxHops={maxHops!} />}
              </Fragment>
            );
          })}
        </ol>
      </div>
      {!atBottom && (
        <button
          type="button"
          className={`to-bottom${unseen ? " has-new" : ""}`}
          onClick={() => box.current?.scrollTo({ top: box.current.scrollHeight, behavior: "smooth" })}
          title="До останніх повідомлень"
          aria-label={unseen ? `Нові повідомлення: ${unseen}` : "До останніх повідомлень"}
        >
          <ArrowDown size={16} />
          {unseen > 0 && <span className="num">{unseen} нов.</span>}
        </button>
      )}
    </div>
  );
}
