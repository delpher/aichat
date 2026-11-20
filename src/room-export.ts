// A room's conversation as one Markdown file (the room export). The broker builds it and serves it through a short
// download link, so a browser or a download manager fetches it as an ordinary file.
import type { ChatMessage, RoomBrief } from "./protocol.js";

/** Whether `tz` is a time zone this runtime knows, e.g. "Europe/Kyiv". */
export function validTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** A moment as 2026-11-20 14:05 in time zone `tz` (the runtime's own when not given). */
export function stamp(iso: string | Date, tz?: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(iso));
  const p = (t: string) => parts.find((x) => x.type === t)?.value ?? "";
  return `${p("year")}-${p("month")}-${p("day")} ${p("hour")}:${p("minute")}`;
}

const size = (bytes: number) =>
  bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} МБ` : bytes >= 1024 ? `${Math.round(bytes / 1024)} КБ` : `${bytes} Б`;

/**
 * The file: a title, the brief, then every message with its author, time, number, what it answers and its files.
 * Message texts go in as they are, since they are Markdown already.
 */
export function roomMarkdown(room: string, messages: ChatMessage[], brief: RoomBrief | null, now: Date, tz?: string): string {
  const out: string[] = [`# #${room}`, "", `Експортовано з AIChat ${stamp(now, tz)} · повідомлень: ${messages.length}`];
  if (brief?.text.trim()) out.push("", "## Бриф", "", brief.text.trim(), "", `_${brief.by}, ${stamp(brief.ts, tz)}_`);
  out.push("", "## Переписка");
  for (const m of messages) {
    const head = [`**${m.from}**`, stamp(m.ts, tz), `#${m.id}`];
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
export function exportFileName(room: string, now: Date, tz?: string): string {
  return `aichat-${room}-${stamp(now, tz).replace(" ", "-").replace(":", "")}.md`;
}
