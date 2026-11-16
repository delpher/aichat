import type { AgentActivity } from "../api/types";

/** Tool names from Claude Code hooks, in words people read, when the hook said nothing about the target. */
const TOOLS: Record<string, string> = {
  Bash: "команда",
  PowerShell: "команда",
  Read: "читає файл",
  Edit: "редагує файл",
  MultiEdit: "редагує файл",
  Write: "пише файл",
  NotebookEdit: "редагує блокнот",
  Grep: "шукає в коді",
  Glob: "шукає файли",
  WebFetch: "відкриває сторінку",
  WebSearch: "шукає в інтернеті",
  Agent: "запустив субагента",
  Task: "запустив субагента",
  send_message: "пише повідомлення",
  read_history: "читає історію",
};

/** The same tools with their target: "редагує App.tsx", "виконує npm test", "шукає «hopLimit»". */
const WITH_TARGET: Record<string, (t: string) => string> = {
  Bash: (t) => `виконує ${t}`,
  PowerShell: (t) => `виконує ${t}`,
  Read: (t) => `читає ${t}`,
  Edit: (t) => `редагує ${t}`,
  MultiEdit: (t) => `редагує ${t}`,
  Write: (t) => `пише ${t}`,
  NotebookEdit: (t) => `редагує ${t}`,
  Grep: (t) => `шукає «${t}»`,
  Glob: (t) => `шукає файли ${t}`,
  WebFetch: (t) => `відкриває ${t}`,
  WebSearch: (t) => `шукає в інтернеті «${t}»`,
  Agent: (t) => `субагент: ${t}`,
  Task: (t) => `субагент: ${t}`,
};

/** "редагує App.tsx", "виконує команду", "читає файл", or the raw detail. */
export function toolText(detail: string | undefined, target?: string): string {
  if (!detail) return "";
  if (target && WITH_TARGET[detail]) return WITH_TARGET[detail](target);
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

/** Where the agent works, as people read it: "#lobby", "з вами", "з olena". */
export function whereText(a: AgentActivity, me?: string): string {
  if (a.room) return `#${a.room}`;
  if (a.with) return a.with === me ? "з вами" : `з ${a.with}`;
  return "";
}

/**
 * A full line: "claude-a працює над web: редагує App.tsx · 3 хв", "claude-a чекає: дозволу на Bash".
 * Used above the composer, in DM headers and in tooltips.
 */
export function activityText(name: string, a: AgentActivity, now = Date.now()): string {
  const t = since(a, now);
  if (a.state === "waiting") {
    const w = waitingText(a.detail);
    return `${name} чекає${w.startsWith("на ") ? " " : ": "}${w}${t ? ` · ${t}` : ""}`;
  }
  if (a.state === "busy") {
    const what = toolText(a.detail, a.target);
    return `${name} працює${a.topic ? ` над ${a.topic}` : ""}${what ? `: ${what}` : ""}${t ? ` · ${t}` : ""}`;
  }
  return a.topic ? `${name}: ${a.topic} (пауза)` : name;
}

/**
 * Short status for the sidebar and the work panel: "Працює над web у #lobby", "Чекає дозволу на Bash",
 * "Працює у #ops", "Web у #lobby · пауза"; empty when there is nothing to say.
 */
export function statusText(a: AgentActivity | undefined, me?: string): string {
  if (!a) return "";
  const where = whereText(a, me);
  const at = where ? (where.startsWith("#") ? ` у ${where}` : ` ${where}`) : "";
  if (a.state === "waiting") {
    const w = waitingText(a.detail);
    return `Чекає ${w.startsWith("на ") ? w : w.replace(/^./, (c) => c.toLowerCase())}`;
  }
  if (a.state === "busy") return a.topic ? `Працює над ${a.topic}${at}` : `Працює${at}`;
  if (a.topic) return `${a.topic.replace(/^./, (c) => c.toUpperCase())}${at} · пауза`;
  return "";
}

/** Short label: "працює", "чекає". */
export const activityShort = (a: AgentActivity) => (a.state === "waiting" ? "чекає" : a.state === "busy" ? "працює…" : "");

/** Whether the agent is doing something people should see now (busy or waiting, online). */
export const isActive = (online: boolean, a: AgentActivity | undefined): a is AgentActivity => online && !!a && a.state !== "idle";
