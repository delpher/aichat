import type { AgentActivity } from "../api/types";

/** Tool names from Claude Code hooks, in words people read. */
const TOOLS: Record<string, string> = {
  Bash: "команда",
  PowerShell: "команда",
  Read: "читає файл",
  Edit: "редагує файл",
  Write: "пише файл",
  Grep: "шукає в коді",
  Glob: "шукає файли",
  WebFetch: "відкриває сторінку",
  WebSearch: "шукає в інтернеті",
  Agent: "запустив субагента",
  send_message: "пише повідомлення",
  read_history: "читає історію",
};

/** "команда (Bash)", "редагує файл", or the raw detail. */
export function toolText(detail: string | undefined): string {
  if (!detail) return "";
  const t = TOOLS[detail];
  return t ? (t === "команда" ? `виконує команду` : t) : detail;
}

/** Minutes since the state began, as "2 хв" (nothing under a minute). */
export function since(a: AgentActivity, now = Date.now()): string {
  const min = Math.floor((now - Date.parse(a.since)) / 60000);
  if (!(min >= 1)) return "";
  return min < 60 ? `${min} хв` : `${Math.floor(min / 60)} год ${min % 60} хв`;
}

/** Claude Code's notification texts ("Claude needs your permission to use Bash") in Ukrainian; others as they are. */
export function waitingText(detail: string | undefined): string {
  if (!detail) return "на людину";
  const perm = /permission to use (.+?)\.?$/i.exec(detail);
  if (perm) return `дозволу на ${perm[1].replace(/^mcp__[^_]+(?:_[^_]+)*__/, "")}`;
  if (/waiting for your input/i.test(detail)) return "на відповідь людини";
  return detail;
}

/** A full line: "claude-alexey працює: редагує файл · 3 хв", "claude-a чекає: дозволу на Bash". */
export function activityText(name: string, a: AgentActivity, now = Date.now()): string {
  const t = since(a, now);
  if (a.state === "waiting") {
    const w = waitingText(a.detail);
    return `${name} чекає${w.startsWith("на ") ? " " : ": "}${w}${t ? ` · ${t}` : ""}`;
  }
  if (a.state === "busy") {
    const what = toolText(a.detail);
    return `${name} працює${what ? `: ${what}` : ""}${t ? ` · ${t}` : ""}`;
  }
  return name;
}

/** Short label for the sidebar: "працює", "чекає". */
export const activityShort = (a: AgentActivity) => (a.state === "waiting" ? "чекає" : a.state === "busy" ? "працює…" : "");
