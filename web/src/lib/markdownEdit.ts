// Toolbar actions of the composer: wrap the selection in Markdown, or prefix the selected lines.

export type FormatKind = "bold" | "italic" | "strike" | "code" | "codeblock" | "link" | "bullet" | "numbered" | "quote";

export interface Edit {
  text: string;
  start: number;
  end: number;
}

const WRAP: Partial<Record<FormatKind, [string, string, string]>> = {
  bold: ["**", "**", "жирний текст"],
  italic: ["_", "_", "курсив"],
  strike: ["~~", "~~", "закреслений"],
  code: ["`", "`", "код"],
};

/** Applies a format to `text` with the selection [start, end); returns the new text and selection. */
export function applyFormat(kind: FormatKind, text: string, start: number, end: number): Edit {
  const sel = text.slice(start, end);
  const before = text.slice(0, start);
  const after = text.slice(end);

  const wrap = WRAP[kind];
  if (wrap) {
    const [open, close, placeholder] = wrap;
    // already wrapped: unwrap
    if (before.endsWith(open) && after.startsWith(close) && sel) {
      return {
        text: before.slice(0, -open.length) + sel + after.slice(close.length),
        start: start - open.length,
        end: end - open.length,
      };
    }
    const inner = sel || placeholder;
    return { text: before + open + inner + close + after, start: start + open.length, end: start + open.length + inner.length };
  }

  if (kind === "link") {
    const label = sel || "текст";
    const out = `[${label}](https://)`;
    const urlStart = start + label.length + 3;
    return { text: before + out + after, start: urlStart, end: urlStart + "https://".length };
  }

  if (kind === "codeblock") {
    const nlBefore = before && !before.endsWith("\n") ? "\n" : "";
    const nlAfter = after && !after.startsWith("\n") ? "\n" : "";
    const body = sel || "код";
    const open = `${nlBefore}\`\`\`\n`;
    return {
      text: `${before}${open}${body}\n\`\`\`${nlAfter}${after}`,
      start: start + open.length,
      end: start + open.length + body.length,
    };
  }

  // line prefixes: expand the selection to whole lines
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  const nl = text.indexOf("\n", end);
  const lineEnd = nl === -1 ? text.length : nl;
  const lines = text.slice(lineStart, lineEnd).split("\n");
  const prefix = (i: number) => (kind === "bullet" ? "- " : kind === "quote" ? "> " : `${i + 1}. `);
  const re = kind === "bullet" ? /^- / : kind === "quote" ? /^> / : /^\d+\. /;
  const all = lines.every((l) => re.test(l));
  const next = lines.map((l, i) => (all ? l.replace(re, "") : prefix(i) + l)).join("\n");
  return {
    text: text.slice(0, lineStart) + next + text.slice(lineEnd),
    start: lineStart,
    end: lineStart + next.length,
  };
}

/** The "@na" being typed right before the caret, if any: where it starts and what follows the @. */
export function mentionQuery(text: string, caret: number): { start: number; query: string } | null {
  const m = /(^|[\s(])@([A-Za-z0-9_-]*)$/.exec(text.slice(0, caret));
  return m ? { start: caret - m[2].length - 1, query: m[2] } : null;
}

/** Replaces text[start, end) with "@name " and returns the new text and caret position. */
export function insertMention(text: string, start: number, end: number, name: string): { text: string; caret: number } {
  const before = text.slice(0, start);
  const lead = before && !/[\s(]$/.test(before) ? " " : "";
  const after = text.slice(end).replace(/^ /, "");
  const ins = `${lead}@${name} `;
  return { text: before + ins + after, caret: before.length + ins.length };
}
