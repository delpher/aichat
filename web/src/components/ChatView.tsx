import { Upload } from "lucide-react";
import { useCallback, useState } from "react";
import type { ChatMessage } from "../api/types";
import { useChat } from "../context";
import { useMessages } from "../hooks/useMessages";
import type { View } from "../lib/views";
import { Composer } from "./Composer";
import { MessageList } from "./MessageList";

type ChatViewKind = Extract<View, { kind: "all" | "room" | "dm" }>;

export function ChatView({ view }: { view: ChatViewKind }) {
  const { session, view: current } = useChat();
  const { messages, hasOlder, loading, loadOlder, olderLoads } = useMessages(view);
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null);
  /** A name clicked in the message list, to insert into the composer as @name (seq makes repeats count). */
  const [mention, setMention] = useState<{ name: string; seq: number } | null>(null);
  const onMention = useCallback((name: string) => setMention((m) => ({ name, seq: (m?.seq ?? 0) + 1 })), []);
  const [dragging, setDragging] = useState(false);
  const [dropped, setDropped] = useState<File[]>([]);
  // admins see other people's DMs but cannot write there
  const canWrite =
    session.mode === "user" || current.kind !== "dm" || current.a === session.admin.name || current.b === session.admin.name;

  const hasFiles = (e: React.DragEvent) => [...e.dataTransfer.types].includes("Files");
  return (
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
      <MessageList
        messages={messages}
        loading={loading}
        hasOlder={hasOlder}
        olderLoads={olderLoads}
        onLoadOlder={loadOlder}
        onReply={canWrite ? setReplyTo : undefined}
        onMention={canWrite ? onMention : undefined}
        showWhere={view.kind === "all"}
        emptyText={view.kind === "dm" ? "Тут ще ніхто не писав. Почніть розмову." : "Повідомлень поки немає."}
      />
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
  );
}
