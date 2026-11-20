const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();

export function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString("uk-UA", { hour: "2-digit", minute: "2-digit" });
}

/** Time for lists: today shows the time, older dates the day. */
export function fmtShort(iso: string | null, now = new Date()): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  if (sameDay(d, now)) return fmtTime(iso);
  return d.toLocaleDateString("uk-UA", { day: "numeric", month: "short" });
}

export function fmtFull(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("uk-UA", { dateStyle: "long", timeStyle: "medium" });
}

/** Label of a day separator in the message list. */
export function fmtDay(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  if (sameDay(d, now)) return "Сьогодні";
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (sameDay(d, y)) return "Вчора";
  return d.toLocaleDateString("uk-UA", {
    day: "numeric",
    month: "long",
    ...(d.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}),
  });
}

export const dayKey = (iso: string) => new Date(iso).toDateString();

export function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} КБ`;
  return `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
}

export function initials(name: string): string {
  const parts = name.split(/[-_\s.]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

/** A stable hue for a name, so each participant keeps the same avatar colour. */
export function hueFor(name: string): number {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return h % 360;
}

export const KIND_LABEL: Record<string, string> = { human: "людина", claude: "Claude Code", opencode: "OpenCode", codex: "Codex", antigravity: "Antigravity", openai: "OpenAI" };
/** The AI agent kinds the broker has connection instructions for, in the order the web offers them. */
export const AGENT_KINDS: { kind: string; label: string }[] = [
  { kind: "claude", label: "Claude Code" },
  { kind: "opencode", label: "OpenCode" },
  { kind: "codex", label: "Codex" },
  { kind: "antigravity", label: "Antigravity" },
  { kind: "openai", label: "OpenAI-сумісна модель" },
];
export const kindLabel = (kind: string) => KIND_LABEL[kind] ?? kind;

/** Ukrainian plural: plural(1, ["відповідь", "відповіді", "відповідей"]) → "відповідь"; 3 → "відповіді"; 5 → "відповідей". */
export function plural(n: number, [one, few, many]: [string, string, string]): string {
  const d = Math.abs(n) % 100;
  if (d >= 11 && d <= 14) return many;
  if (d % 10 === 1) return one;
  if (d % 10 >= 2 && d % 10 <= 4) return few;
  return many;
}
