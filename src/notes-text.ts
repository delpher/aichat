// Notebook notes as text: one line per note for recall, a note in full, and the budgeted list the broker puts in
// the report after a long absence. Shared by the broker and the adapters.
import type { AgentNote } from "./protocol.js";

/** How many characters of descriptions a notebook listing takes; older notes show only their titles. */
export const NOTES_BUDGET = 4000;
/** How many more characters the titles of the older notes may take; the rest is one recall away. */
export const TITLES_BUDGET = 4000;

const noteHead = (n: AgentNote) => `#${n.id}${n.topic ? ` [${n.topic}]` : ""} ${n.title} (${n.ts})`;
const textMark = (n: AgentNote) => (n.text_length ? ` (text: ${n.text_length} characters)` : "");

/** A note as recall lists it: title and description, and how long its text is. */
export const noteSummary = (n: AgentNote) => `${noteHead(n)}: ${n.description}${textMark(n)}`;

/** A note with everything in it. */
export const noteFull = (n: AgentNote) => [noteHead(n), n.description, ...(n.text ? ["", n.text] : [])].join("\n");

/**
 * The notes most recently changed first: with their descriptions while they fit in NOTES_BUDGET characters, then
 * only their titles while those fit in TITLES_BUDGET. `hidden` is how many did not fit at all.
 */
export function noteListing(list: AgentNote[]): { lines: string[]; hidden: number } {
  const lines: string[] = [];
  let described = 0;
  let titled = 0;
  for (const note of [...list].sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : b.id - a.id))) {
    const full = noteSummary(note);
    if (titled === 0 && described + full.length <= NOTES_BUDGET) {
      lines.push(full);
      described += full.length;
      continue;
    }
    const short = noteHead(note) + textMark(note);
    if (titled + short.length > TITLES_BUDGET) break;
    lines.push(short);
    titled += short.length;
  }
  return { lines, hidden: list.length - lines.length };
}
