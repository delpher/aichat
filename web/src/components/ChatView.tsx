import { Upload } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ChatMessage } from "../api/types";
import { useChat } from "../context";
import { useMessages } from "../hooks/useMessages";
import { useRoomBoard } from "../hooks/useRoomBoard";
import { buildThreads } from "../lib/threads";
import { isGameRoom, viewKey, type View } from "../lib/views";
import { ActivityBar } from "./ActivityBar";
import { Composer } from "./Composer";
import { MessageList } from "./MessageList";
import { Header } from "./Header";
import { BriefPanel, RoomActions, RoomBar } from "./RoomBar";
import { WorkPanel } from "./WorkPanel";
import { ThreadPanel } from "./ThreadPanel";

type ChatViewKind = Extract<View, { kind: "all" | "room" | "dm" }>;

export function ChatView({
  view,
  onMenu = () => {},
  onLeave = () => {},
  chrome = true,
}: {
  view: ChatViewKind;
  onMenu?: () => void;
  onLeave?: (room: string) => void;
  /** Draw the header too; a page that already has one (a game) passes false. */
  chrome?: boolean;
}) {
  const { session, view: current, threaded, overview, go, focus, clearFocus } = useChat();
  const { messages, hasOlder, loading, loadOlder, olderLoads } = useMessages(view);
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null);
  /** A name clicked in the message list, to insert into the composer as @name (seq makes repeats count). */
  const [mention, setMention] = useState<{ name: string; seq: number } | null>(null);
  const onMention = useCallback((name: string) => setMention((m) => ({ name, seq: (m?.seq ?? 0) + 1 })), []);
  const [dragging, setDragging] = useState(false);
  const [dropped, setDropped] = useState<File[]>([]);
  // admins see other people's DMs but cannot write there
  const canWrite = session.mode === "user" || current.kind !== "dm" || current.a === session.admin.name || current.b === session.admin.name;

  // ---- threads: reply chains, one of them open in the side panel ----
  const threads = useMemo(() => buildThreads(messages), [messages]);
  const [open, setOpen] = useState<{ root: number; focus?: number } | null>(null);
  /** Newest reply the viewer has seen in each thread, so the summary can count new ones. */
  const [seen, setSeen] = useState<Map<number, number>>(new Map());
  const openThread = open ? threads.byRoot.get(open.root) : undefined;
  const openLast = openThread?.last.id;
  useEffect(() => {
    if (open && openLast !== undefined) setSeen((cur) => (cur.get(open.root) === openLast ? cur : new Map(cur).set(open.root, openLast)));
  }, [open, openLast]);
  const onOpenThread = useCallback((root: number, focus?: number) => {
    setWorkOpen(false);
    setOpen((cur) => (cur?.root === root && focus === undefined ? null : { root, focus }));
  }, []);
  const closeThread = useCallback(() => setOpen(null), []);
  const admin = session.mode === "admin" ? session.admin.name : null;
  const canWriteThread = (root: ChatMessage) => !admin || !!root.room || root.from === admin || root.to === admin;

  // ---- the room's brief and who does what (plain rooms only; game rooms belong to their game) ----
  const boardRoom = view.kind === "room" && !isGameRoom(view.room) ? view.room : null;
  const board = useRoomBoard(boardRoom);
  /** The brief under the header: folded, its text, or the editor. The view is keyed per room, so this resets. */
  const [briefMode, setBriefMode] = useState<"closed" | "view" | "edit">("closed");
  const [workOpen, setWorkOpen] = useState(false);
  const toggleWork = useCallback(() => {
    setOpen(null);
    setWorkOpen((o) => !o);
  }, []);
  const closeWork = useCallback(() => setWorkOpen(false), []);
  const members = boardRoom ? [...(overview.rooms.find((r) => r.name === boardRoom)?.members ?? [])].sort() : [];

  const hasFiles = (e: React.DragEvent) => [...e.dataTransfer.types].includes("Files");
  return (
    <>
      {chrome && (
        <Header
          onMenu={onMenu}
          onLeave={onLeave}
          bar={
            boardRoom ? (
              <RoomBar
                brief={board.brief}
                open={briefMode !== "closed"}
                onToggle={() => setBriefMode((m) => (m === "closed" ? "view" : "closed"))}
                onEdit={() => setBriefMode("edit")}
              />
            ) : undefined
          }
          actions={boardRoom ? <RoomActions room={boardRoom} workOpen={workOpen} onToggleWork={toggleWork} /> : undefined}
        />
      )}
      {boardRoom && briefMode !== "closed" && (
        <BriefPanel
          key={`${boardRoom}:${briefMode}`}
          room={boardRoom}
          brief={board.brief}
          editing={briefMode === "edit"}
          onEdit={() => setBriefMode("edit")}
          onClose={() => setBriefMode("closed")}
          onCancel={() => setBriefMode(board.brief ? "view" : "closed")}
          onSave={async (text) => {
            await board.saveBrief(text);
            setBriefMode("view");
          }}
        />
      )}
      <div className="chat-wrap">
        <div
          className="chat"
        onDragEnter={(e) => {
          if (canWrite && hasFiles(e)) {
            e.preventDefault();
            setDragging(true);
          }
        }}
        onDragOver={(e) => {
          if (canWrite && hasFiles(e)) e.preventDefault();
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false);
        }}
        onDrop={(e) => {
          if (!hasFiles(e)) return;
          e.preventDefault();
          setDragging(false);
          setDropped([...e.dataTransfer.files]);
        }}
      >
        {view.kind === "all" && (
          <div className="room-bar">
            <div className="room-bar-row filter-row">
              <label className="filter">
                <span className="muted small">Учасник</span>
                <select
                  value={view.agent ?? ""}
                  onChange={(e) => go(e.target.value ? { kind: "all", agent: e.target.value } : { kind: "all" })}
                  aria-label="Показати розмови учасника"
                >
                  <option value="">усі</option>
                  {[...overview.agents]
                    .map((a) => a.name)
                    .sort()
                    .map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                </select>
              </label>
              {view.agent && (
                <button type="button" className="btn quiet sm" onClick={() => go({ kind: "all" })}>
                  Скинути фільтр
                </button>
              )}
            </div>
          </div>
        )}
        <MessageList
          messages={messages}
          loading={loading}
          hasOlder={hasOlder}
          olderLoads={olderLoads}
          onLoadOlder={loadOlder}
          onReply={canWrite ? setReplyTo : undefined}
          onMention={canWrite ? onMention : undefined}
          showWhere={view.kind === "all"}
          focusId={focus && focus.key === viewKey(view) ? focus.id : undefined}
          onFocusDone={clearFocus}
          threads={threads}
          threaded={threaded}
          openThread={openThread ? open!.root : null}
          threadSeen={seen}
          onOpenThread={onOpenThread}
          emptyTitle={
            view.kind === "room" ? `У #${view.room} ще тихо` : view.kind === "dm" ? "Розмова ще не почалася" : "Повідомлень ще немає"
          }
          emptyText={
            view.kind === "all"
              ? "Тут з'являтимуться всі розмови агентів і людей, щойно хтось напише."
              : canWrite
                ? "Напишіть перше повідомлення. Щоб звернутися до агента, згадайте його через @ім'я."
                : "Повідомлення з'являться тут, щойно учасники почнуть розмову."
          }
        />
        <ActivityBar view={view} />
        <Composer
          mention={mention}
          key={view.kind === "room" ? view.room : view.kind === "dm" ? `${view.a}|${view.b}` : "all"}
          view={view}
          replyTo={replyTo}
          onCancelReply={() => setReplyTo(null)}
          dropped={dropped}
          onDroppedTaken={() => setDropped([])}
        />
        {dragging && (
          <div className="drop-zone">
            <Upload size={36} />
            <span>Відпустіть, щоб додати файли</span>
          </div>
        )}
      </div>
      {boardRoom && workOpen && <WorkPanel room={boardRoom} members={members} onClose={closeWork} />}
      {openThread && (
        <ThreadPanel
          key={openThread.root.id}
          thread={openThread}
          focus={open?.focus}
          onClose={closeThread}
          canWrite={canWriteThread(openThread.root)}
        />
      )}
      </div>
    </>
  );
}
