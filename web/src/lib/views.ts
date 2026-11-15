// What the main area shows, and how that maps to the URL hash.
import type { ChatMessage, Overview, Session } from "../api/types";

export type PanelKind = "people" | "rooms" | "settings";
export type View =
  | { kind: "all" }
  | { kind: "room"; room: string }
  | { kind: "dm"; a: string; b: string }
  | { kind: PanelKind }
  | { kind: "none" };

export const PANELS: PanelKind[] = ["people", "rooms", "settings"];
export const isPanel = (v: View): v is { kind: PanelKind } => (PANELS as string[]).includes(v.kind);

export const pairKey = (x: string, y: string) => (x < y ? `${x}|${y}` : `${y}|${x}`);

export function viewKey(v: View): string {
  if (v.kind === "room") return `r:${v.room}`;
  if (v.kind === "dm") return `d:${pairKey(v.a, v.b)}`;
  return v.kind;
}

export const messageKey = (m: ChatMessage) => (m.room ? `r:${m.room}` : `d:${pairKey(m.from, m.to!)}`);

export function dm(a: string, b: string): View {
  const [x, y] = [a, b].sort();
  return { kind: "dm", a: x, b: y };
}

export function hashFor(v: View): string {
  if (v.kind === "room") return `#room/${encodeURIComponent(v.room)}`;
  if (v.kind === "dm") return `#dm/${encodeURIComponent(v.a)}/${encodeURIComponent(v.b)}`;
  if (v.kind === "none") return "";
  return `#${v.kind}`;
}

export function parseHash(hash: string): View | null {
  const parts = hash
    .replace(/^#/, "")
    .split("/")
    .map((p) => {
      try {
        return decodeURIComponent(p);
      } catch {
        return "";
      }
    });
  if ((PANELS as string[]).includes(parts[0])) return { kind: parts[0] as PanelKind };
  if (parts[0] === "all") return { kind: "all" };
  if (parts[0] === "room" && parts[1]) return { kind: "room", room: parts[1] };
  if (parts[0] === "dm" && parts[1] && parts[2]) return dm(parts[1], parts[2]);
  return null;
}

/** The view this session may show: people see only their own rooms and DMs; admins see everything. */
export function resolveView(wanted: View | null, session: Session, overview: Overview): View {
  if (session.mode === "admin") return wanted && wanted.kind !== "none" ? wanted : { kind: "all" };
  const me = session.me.name;
  if (wanted?.kind === "room" && overview.rooms.some((r) => r.name === wanted.room)) return wanted;
  if (wanted?.kind === "dm" && (wanted.a === me || wanted.b === me)) return wanted;
  const first = [...overview.rooms].sort((x, y) => x.name.localeCompare(y.name))[0];
  if (first) return { kind: "room", room: first.name };
  const d = overview.dms[0];
  if (d) return dm(d.a, d.b);
  return { kind: "none" };
}

export function matchesView(m: ChatMessage, v: View): boolean {
  if (v.kind === "all") return true;
  if (v.kind === "room") return m.room === v.room;
  if (v.kind === "dm") return !m.room && pairKey(m.from, m.to!) === pairKey(v.a, v.b);
  return false;
}

/** History endpoint for a view: the admin API sees any conversation, a person only their own. */
export function historyPath(v: View, session: Session, limit: number, before?: number): string {
  const q = new URLSearchParams({ limit: String(limit) });
  if (before) q.set("before", String(before));
  if (session.mode === "admin") {
    if (v.kind === "room") q.set("room", v.room);
    if (v.kind === "dm") {
      q.set("a", v.a);
      q.set("b", v.b);
    }
    return `/admin/api/messages?${q}`;
  }
  if (v.kind === "room") q.set("room", v.room);
  if (v.kind === "dm") q.set("with", v.a === session.me.name ? v.b : v.a);
  return `/api/history?${q}`;
}
