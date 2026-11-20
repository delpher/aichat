import type { Api } from "../api/http";
import type { ChatMessage, RoomBrief, Session } from "../api/types";
import { saveBlob } from "./saveFile";
import { historyPath } from "./views";

/** The broker gives at most this many messages per history request. */
const PAGE = 500;

/** Every message of a room the viewer may read, oldest first, page by page back from the newest. */
export async function fetchRoomHistory(api: Api, session: Session, room: string): Promise<ChatMessage[]> {
  const pages: ChatMessage[][] = [];
  let before: number | undefined;
  for (;;) {
    const data = await api.get<{ messages: ChatMessage[] }>(historyPath({ kind: "room", room }, session, PAGE, before));
    const got = data.messages ?? [];
    if (got.length) pages.unshift(got);
    if (got.length < PAGE) break;
    before = got[0].id;
  }
  return pages.flat();
}

const pad = (n: number) => String(n).padStart(2, "0");
/** Local date and time as 2026-11-20 14:05. */
export function stamp(iso: string | Date): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const size = (bytes: number) =>
  bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} МБ` : bytes >= 1024 ? `${Math.round(bytes / 1024)} КБ` : `${bytes} Б`;

/**
 * A room's conversation as one Markdown file: a title, the brief, then every message with its author, time, number
 * and what it answers. Message texts go in as they are, since they are Markdown already.
 */
export function roomMarkdown(room: string, messages: ChatMessage[], brief: RoomBrief | null, now: Date = new Date()): string {
  const out: string[] = [`# #${room}`, "", `Експортовано з AIChat ${stamp(now)} · повідомлень: ${messages.length}`];
  if (brief?.text.trim()) out.push("", "## Бриф", "", brief.text.trim(), "", `_${brief.by}, ${stamp(brief.ts)}_`);
  out.push("", "## Переписка");
  for (const m of messages) {
    const head = [`**${m.from}**`, stamp(m.ts), `#${m.id}`];
    if (m.reply_to) head.push(`у відповідь на #${m.reply_to}`);
    out.push("", "---", "", head.join(" · "), "", m.text.trim() || "_(без тексту)_");
    if (m.attachments?.length) {
      out.push("");
      for (const f of m.attachments) out.push(`- 📎 ${f.name} (${size(f.size)}, файл ${f.id})`);
    }
  }
  return out.join("\n") + "\n";
}

/** File name for a room's export: aichat-lobby-2026-11-20-1405.md */
export function exportFileName(room: string, now: Date = new Date()): string {
  return `aichat-${room}-${stamp(now).replace(" ", "-").replace(":", "")}.md`;
}

/** Hands the text to the browser as a file to save. */
export function downloadText(text: string, fileName: string) {
  saveBlob(new Blob([text], { type: "text/markdown;charset=utf-8" }), fileName);
}
