import { X } from "lucide-react";
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ChatMessage } from "../api/types";
import { useChat } from "../context";
import { plural } from "../lib/format";
import { atHopLimit, type Thread } from "../lib/threads";
import { dm, knownRooms, type View } from "../lib/views";
import { ChainEnd } from "./ChainEnd";
import { Composer } from "./Composer";
import { MessageItem } from "./MessageItem";
import { GROUP_MS } from "./MessageList";

interface Props {
  thread: Thread;
  /** A message to scroll to and highlight (a quote that pointed into the thread). */
  focus?: number;
  onClose: () => void;
  /** Whether the viewer may write in this conversation (names then mention into the thread composer). */
  canWrite: boolean;
}

/** The conversation a thread lives in, so the reply goes to the same room or DM. */
function viewOf(root: ChatMessage): View {
  return root.room ? { kind: "room", room: root.room } : dm(root.from, root.to!);
}

/** Side panel with one reply chain: its first message, every reply in order, and a composer that continues it. */
export function ThreadPanel({ thread, focus, onClose, canWrite }: Props) {
  const { overview, session, sender, openRoom } = useChat();
  const box = useRef<HTMLDivElement>(null);
  const [flash, setFlash] = useState<number | null>(null);
  const [mention, setMention] = useState<{ name: string; seq: number } | null>(null);
  const onMention = canWrite ? (name: string) => setMention((m) => ({ name, seq: (m?.seq ?? 0) + 1 })) : undefined;
  const kinds = useMemo(() => new Map(overview.agents.map((a) => [a.name, a.kind])), [overview.agents]);
  const names = useMemo(() => overview.agents.map((a) => a.name), [overview.agents]);
  const rooms = useMemo(() => knownRooms(overview), [overview]);
  const all = useMemo(() => [thread.root, ...thread.replies], [thread]);
  const byId = useMemo(() => new Map(all.map((m) => [m.id, m])), [all]);
  const mine = session.mode === "user" ? session.me.name : sender;
  const ended = atHopLimit(thread.last, overview.max_hops);
  const where = thread.root.room ? `#${thread.root.room}` : `${thread.root.from} і ${thread.root.to}`;
  const n = thread.replies.length;

  // Close on Escape, unless the key was meant for a field (the composer handles its own Escape).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !(e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement)) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Open at the newest reply, or at the message a quote pointed to.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const node = focus ? el.querySelector(`[data-id="${focus}"]`) : null;
    if (node) {
      node.scrollIntoView({ block: "center" });
      setFlash(focus!);
      const t = setTimeout(() => setFlash(null), 1600);
      return () => clearTimeout(t);
    }
    el.scrollTop = el.scrollHeight;
  }, [thread.root.id, focus]);

  // Follow new replies while the reader is near the end.
  const lastId = thread.last.id;
  const prevLast = useRef(lastId);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el || prevLast.current === lastId) return;
    prevLast.current = lastId;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 200 || thread.last.from === sender) el.scrollTop = el.scrollHeight;
  }, [lastId, thread.last.from, sender]);

  return (
    <aside className="drawer" aria-label="Тред">
      <header className="drawer-head">
        <div>
          <h2>Тред</h2>
          <p className="num">
            {where} · {n} {plural(n, ["відповідь", "відповіді", "відповідей"])}
          </p>
        </div>
        <button type="button" className="icon-btn" onClick={onClose} title="Закрити тред (Esc)" aria-label="Закрити тред">
          <X size={18} />
        </button>
      </header>
      <div className="feed" ref={box}>
        <div className="feed-inner">
          <ol className="messages">
            {all.map((m, i) => {
              const before = all[i - 1];
              const follows = !!before && m.reply_to === before.id;
              const compact =
                !!before &&
                i > 1 &&
                follows &&
                before.from === m.from &&
                new Date(m.ts).getTime() - new Date(before.ts).getTime() < GROUP_MS;
              return (
                <Fragment key={m.id}>
                  <MessageItem
                    message={m}
                    compact={compact}
                    mine={m.from === mine}
                    kind={kinds.get(m.from) ?? null}
                    showWhere={false}
                    showTo={false}
                    parent={m.reply_to != null ? byId.get(m.reply_to) : undefined}
                    hideQuote={follows}
                    names={names}
                    rooms={rooms}
                    onRoom={openRoom}
                    flash={flash === m.id}
                    onMention={onMention}
                    onJump={(id) => {
                      const node = box.current?.querySelector(`[data-id="${id}"]`);
                      node?.scrollIntoView({ behavior: "smooth", block: "center" });
                      setFlash(id);
                      setTimeout(() => setFlash((f) => (f === id ? null : f)), 1600);
                    }}
                    idPrefix="t"
                  />
                  {i === 0 && n > 0 && (
                    <li className="thread-replies-label num" role="separator">
                      {n} {plural(n, ["відповідь", "відповіді", "відповідей"])}
                    </li>
                  )}
                </Fragment>
              );
            })}
          </ol>
          {ended && <ChainEnd as="div" maxHops={overview.max_hops!} />}
        </div>
      </div>
      <Composer
        key={thread.root.id}
        view={viewOf(thread.root)}
        replyTo={thread.last}
        threadReply
        onCancelReply={() => {}}
        dropped={[]}
        onDroppedTaken={() => {}}
        mention={mention}
        placeholder="Відповісти в треді"
        blockedReason={ended ? "Ланцюжок досяг ліміту відповідей. Напишіть нове повідомлення в розмові." : undefined}
      />
    </aside>
  );
}
