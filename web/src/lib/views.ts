// What the main area shows, and how that maps to the URL hash.
import type { ChatMessage, Overview, Session } from "../api/types";

export type PanelKind = "people" | "rooms" | "settings" | "intro";
export type View =
  /** Admin: every conversation, or only those one participant is in. */
  | { kind: "all"; agent?: string }
  | { kind: "room"; room: string }
  | { kind: "dm"; a: string; b: string }
  | { kind: PanelKind }
  /** Admin: one participant's page (settings, access), and the page that adds a participant. */
  | { kind: "person"; name: string }
  | { kind: "people-new" }
  /** Mini-games: the tiles, or one game's lobby and history. */
  | { kind: "games"; game?: string }
  | { kind: "game"; id: number }
  | { kind: "none" };

export const PANELS: PanelKind[] = ["people", "rooms", "settings", "intro"];
export const isPanel = (v: View): v is { kind: PanelKind } => (PANELS as string[]).includes(v.kind);

/** Rooms the broker makes for mini-games ("game-12"); they live in the games tab, not the sidebar. */
export const GAME_ROOM_RE = /^game-(\d+)$/;
export const gameIdOfRoom = (room: string | undefined): number | null => {
  const m = room ? GAME_ROOM_RE.exec(room) : null;
  return m ? Number(m[1]) : null;
};
export const isGameRoom = (room: string) => GAME_ROOM_RE.test(room);

export const pairKey = (x: string, y: string) => (x < y ? `${x}|${y}` : `${y}|${x}`);

export function viewKey(v: View): string {
  if (v.kind === "room") return `r:${v.room}`;
  if (v.kind === "dm") return `d:${pairKey(v.a, v.b)}`;
  if (v.kind === "game") return `g:${v.id}`;
  if (v.kind === "games" && v.game) return `games:${v.game}`;
  if (v.kind === "all" && v.agent) return `all:${v.agent}`;
  if (v.kind === "person") return `person:${v.name}`;
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
  if (v.kind === "game") return `#game/${v.id}`;
  if (v.kind === "games" && v.game) return `#games/${encodeURIComponent(v.game)}`;
  if (v.kind === "all" && v.agent) return `#all/${encodeURIComponent(v.agent)}`;
  if (v.kind === "person") return `#person/${encodeURIComponent(v.name)}`;
  if (v.kind === "people-new") return "#people/new";
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
  if (parts[0] === "people" && parts[1] === "new") return { kind: "people-new" };
  if (parts[0] === "person" && parts[1]) return { kind: "person", name: parts[1] };
  if ((PANELS as string[]).includes(parts[0])) return { kind: parts[0] as PanelKind };
  if (parts[0] === "all") return parts[1] ? { kind: "all", agent: parts[1] } : { kind: "all" };
  if (parts[0] === "games") return parts[1] ? { kind: "games", game: parts[1] } : { kind: "games" };
  if (parts[0] === "game" && /^\d+$/.test(parts[1] ?? "")) return { kind: "game", id: Number(parts[1]) };
  if (parts[0] === "room" && parts[1]) return { kind: "room", room: parts[1] };
  if (parts[0] === "dm" && parts[1] && parts[2]) return dm(parts[1], parts[2]);
  return null;
}

/** The view this session may show: people see only their own rooms and DMs; admins every room, but only their own DMs. */
export function resolveView(wanted: View | null, session: Session, overview: Overview): View {
  if (session.mode === "admin") {
    const me = session.admin.name;
    if (!wanted || wanted.kind === "none" || (wanted.kind === "dm" && wanted.a !== me && wanted.b !== me)) return { kind: "all" };
    return wanted;
  }
  const me = session.me.name;
  if (wanted?.kind === "games" || wanted?.kind === "game" || wanted?.kind === "intro") return wanted;
  if (wanted?.kind === "room" && overview.rooms.some((r) => r.name === wanted.room)) return wanted;
  if (wanted?.kind === "dm" && (wanted.a === me || wanted.b === me)) return wanted;
  const first = [...overview.rooms].sort((x, y) => x.name.localeCompare(y.name))[0];
  if (first) return { kind: "room", room: first.name };
  const d = overview.dms[0];
  if (d) return dm(d.a, d.b);
  return { kind: "none" };
}

export function matchesView(m: ChatMessage, v: View): boolean {
  if (v.kind === "all") return !v.agent || m.from === v.agent || m.to === v.agent;
  if (v.kind === "room") return m.room === v.room;
  if (v.kind === "game") return gameIdOfRoom(m.room) === v.id;
  if (v.kind === "dm") return !m.room && pairKey(m.from, m.to!) === pairKey(v.a, v.b);
  return false;
}

/** History endpoint for a view: the admin API sees every room, a person only their own; both only their own DMs. */
export function historyPath(v: View, session: Session, limit: number, before?: number): string {
  const q = new URLSearchParams({ limit: String(limit) });
  if (before) q.set("before", String(before));
  if (session.mode === "admin") {
    if (v.kind === "room") q.set("room", v.room);
    if (v.kind === "dm") {
      q.set("a", v.a);
      q.set("b", v.b);
    }
    if (v.kind === "all" && v.agent) q.set("agent", v.agent);
    return `/admin/api/messages?${q}`;
  }
  if (v.kind === "room") q.set("room", v.room);
  if (v.kind === "dm") q.set("with", v.a === session.me.name ? v.b : v.a);
  return `/api/history?${q}`;
}

/** The conversation a message belongs to: its room, its direct conversation, or its game. */
export function viewOfMessage(m: ChatMessage): View {
  const game = gameIdOfRoom(m.room);
  if (game !== null) return { kind: "game", id: game };
  return m.room ? { kind: "room", room: m.room } : dm(m.from, m.to!);
}

/** Every room a #name may refer to: the viewer's rooms and the ones they could join (game rooms excluded). */
export function knownRooms(o: Overview): string[] {
  return [...new Set([...o.rooms.map((r) => r.name), ...o.all_rooms])].filter((n) => !isGameRoom(n)).sort();
}
