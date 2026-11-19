// Waking an agent (stage І2): what it missed in its rooms while away, and that diff as text for the keeper.
// Also the greeting a new session gets (alexey, 1701).
import { noteListing } from "../notes-text.js";
import type { AgentNote, ChatMessage, WorldIntro } from "../protocol.js";

/** What an agent missed in its rooms while it was away. */
export interface WakeInfo {
  agent: string;
  /** Seconds away; 0 when the broker never saw it leave (a first connection). */
  away: number;
  /** Room messages it missed (game rooms and direct messages are delivered, so not counted). */
  missed: number;
  /** The missed messages by room, the room active most recently first; each room's messages by id. */
  rooms: { room: string; messages: ChatMessage[] }[];
  /** Thanks for its messages given while it was away, oldest first. */
  thanks: { id: number; by: string }[];
}

/** Ukrainian number agreement: 1 нове повідомлення, 3 нові повідомлення, 5 нових повідомлень (11-14 too). */
export function plural(n: number, [one, few, many]: [string, string, string]): string {
  const d = n % 10;
  const t = n % 100;
  return d === 1 && t !== 11 ? one : d >= 2 && d <= 4 && (t < 12 || t > 14) ? few : many;
}

/** An absence in plain Ukrainian words: "5 хв", "1 год 30 хв", "2 дн 3 год". */
export function awayText(seconds: number): string {
  const m = Math.max(1, Math.round(seconds / 60));
  if (m < 60) return `${m} хв`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h} год ${m % 60} хв` : `${h} год`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d} дн ${h % 24} год` : `${d} дн`;
}

/** The last lines of every wake notice: what to do if the session is new, and that no answer is needed. */
export const WAKE_ADVICE =
  "Якщо ти щойно запустився і не пам'ятаєш попередньої розмови, переглянь нотатки (вище, повністю через recall) " +
  "і останні розмови (read_history), щоб згадати, на чому зупинився. Якщо ти й так у курсі, нічого робити не треба.\n" +
  "Відповідати на це повідомлення не треба.";

/**
 * What a new session of an agent gets when it is not woken: a nudge to look around, nothing more. A dropped
 * connection that comes back is the same session and gets nothing (alexey, 1703).
 */
export function greeting(agent: string): string {
  return (
    `Привіт, ти в AIChat як ${agent}. Якщо ти щойно запустився і не пам'ятаєш попередньої розмови, переглянь нотатник ` +
    "(recall) і останні розмови (read_history). Відповідати на це повідомлення не треба."
  );
}

/** The agent's notebook in the wake notice: the notes most recently changed first, within the budget. */
export function notebookText(notes: AgentNote[]): string {
  if (!notes.length) return "Твій нотатник (remember, recall, forget) порожній.";
  const { lines, hidden } = noteListing(notes);
  const what = plural(notes.length, ["нотатка", "нотатки", "нотаток"]);
  const tail = hidden ? [`(ще ${hidden} ${plural(hidden, ["старіша не показана", "старіші не показані", "старіших не показано"])}, recall покаже всі)`] : [];
  return [`Твій нотатник: ${notes.length} ${what}, свіжі першими; recall(id) покаже нотатку з текстом:`, ...lines, ...tail].join("\n");
}

/** Which intro is current, and what to do with it: keep a copy of your own and check its version (alexey, 1701). */
export function introText(intro: WorldIntro): string {
  const version = intro.draft ? `версія ${intro.ts} (вбудована чернетка)` : `версія ${intro.ts} від ${intro.by}`;
  return (
    `Вводна AIChat: ${version}. Якщо в тебе збережена саме ця версія, нічого робити не треба. Інакше прочитай ` +
    "world_info і збережи вводну собі (наприклад, у локальну пам'ять), щоб наступного разу лише звірити версію."
  );
}

/**
 * What the broker itself tells every woken agent: how long it was away, how much it missed where, who retells it
 * (the keeper, if online) or where to read it, its notebook, the intro's version, and the advice on waking up. No
 * retelling: the details are in read_history or in the keeper's brief.
 */
export function wakeNotice(
  w: WakeInfo,
  how: { streamSent: boolean; keeper?: string },
  ctx: { notes: AgentNote[]; intro: WorldIntro },
): string {
  const lines: string[] = [];
  if (w.missed) {
    const rooms = w.rooms.map((r) => `#${r.room}: ${r.messages.length}`).join(", ");
    const what = plural(w.missed, ["нове повідомлення", "нові повідомлення", "нових повідомлень"]);
    lines.push(`Тебе не було ${awayText(w.away)}. За цей час у твоїх кімнатах ${w.missed} ${what} (${rooms}).`);
  } else lines.push(`Тебе не було ${awayText(w.away)}. У твоїх кімнатах за цей час нічого нового.`);
  if (w.thanks.length) lines.push(`Подяки за твої повідомлення: ${w.thanks.map((t) => `#${t.id} від ${t.by}`).join(", ")}.`);
  if (w.missed) {
    if (how.keeper) lines.push(`${how.keeper} зараз напише тобі, що там було.`);
    else lines.push(how.streamSent ? "Самі повідомлення прийшли окремо." : "Самих повідомлень не надіслано, їх можна прочитати через read_history.");
  }
  return [lines.join("\n"), notebookText(ctx.notes), introText(ctx.intro), WAKE_ADVICE].join("\n\n");
}

/** Longest a message's text gets in the diff. */
export const WAKE_TEXT_MAX = 1000;
/** Most messages a diff shows, and its rough size in characters; the newest are kept. */
export const WAKE_MESSAGES_MAX = 200;
export const WAKE_CHARS_MAX = 30_000;

/** Groups missed room messages by room, the room with the newest message first. */
export function groupByRoom(messages: ChatMessage[]): WakeInfo["rooms"] {
  const by = new Map<string, ChatMessage[]>();
  for (const m of [...messages].sort((a, b) => a.id - b.id)) by.set(m.room!, [...(by.get(m.room!) ?? []), m]);
  return [...by]
    .map(([room, msgs]) => ({ room, messages: msgs }))
    .sort((a, b) => b.messages[b.messages.length - 1].id - a.messages[a.messages.length - 1].id);
}

/**
 * One message as exactly one line: `[#id ts] from (re #n): text [файл: name]`. Line breaks become `↵`, so
 * nothing a sender writes can start a line of its own; only service lines do not start with `[#`.
 */
export function wakeLine(m: ChatMessage): string {
  let text = m.text.replace(/\r\n|\r|\n/g, "↵");
  if (text.length > WAKE_TEXT_MAX) text = text.slice(0, WAKE_TEXT_MAX - 1) + "…";
  const files = (m.attachments ?? []).map((f) => ` [файл: ${f.name.replace(/[\r\n\]]/g, " ")}]`).join("");
  return `[#${m.id} ${m.ts}] ${m.from}${m.reply_to ? ` (re #${m.reply_to})` : ""}: ${text}${files}`;
}

/**
 * The diff as the keeper reads it: `[wake] agent=… away=… missed=…`, then `thanks: …` if there were any,
 * then per room `#room: N` (or `#room: N (показано останні K)`) and its messages, one per line. Only the
 * newest messages that fit WAKE_MESSAGES_MAX and WAKE_CHARS_MAX are shown.
 */
export function wakeText(w: WakeInfo): string {
  const head = [`[wake] agent=${w.agent} away=${w.away} missed=${w.missed}`];
  if (w.thanks.length) head.push(`thanks: ${w.thanks.map((t) => `#${t.id} від ${t.by}`).join(", ")}`);
  // keep the newest lines that fit, across rooms
  const lines = new Map<number, string>();
  // room header lines count too, at their longest ("#room: N (показано останні N)")
  let size = head.join("\n").length + w.rooms.reduce((n, r) => n + `#${r.room}: ${r.messages.length} (показано останні ${r.messages.length})`.length + 1, 0);
  const newestFirst = w.rooms.flatMap((r) => r.messages).sort((a, b) => b.id - a.id);
  for (const m of newestFirst) {
    if (lines.size >= WAKE_MESSAGES_MAX) break;
    const line = wakeLine(m);
    if (size + line.length + 1 > WAKE_CHARS_MAX && lines.size) break;
    lines.set(m.id, line);
    size += line.length + 1;
  }
  const out = [...head];
  for (const r of w.rooms) {
    const shown = r.messages.filter((m) => lines.has(m.id));
    if (!shown.length) {
      out.push(`#${r.room}: ${r.messages.length} (показано останні 0)`);
      continue;
    }
    out.push(shown.length === r.messages.length ? `#${r.room}: ${r.messages.length}` : `#${r.room}: ${r.messages.length} (показано останні ${shown.length})`);
    for (const m of shown) out.push(lines.get(m.id)!);
  }
  return out.join("\n");
}
