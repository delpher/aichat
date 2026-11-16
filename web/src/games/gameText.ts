import type { GameInfo, GameType } from "../api/types";
import { findGame } from "./registry";

export const FREE_SEAT = "вільне місце";

/** The seat's name ("білі"), from the broker's catalog. */
export const seatName = (t: GameType | undefined, i: number) => t?.seats[i]?.name ?? `місце ${i + 1}`;

/** "за білих": the game module's wording, or the seat name. */
export function joinAs(t: GameType | undefined, i: number): string {
  const id = t?.seats[i]?.id;
  const m = t && findGame(t.id);
  return (id && m?.joinAs?.[id]) || seatName(t, i);
}

/** Who is to move, who is awaited, or how the game ended (the broker words results itself). */
export function gameStatus(g: GameInfo, t: GameType | undefined): string {
  if (g.status === "open") {
    const free = g.players.findIndex((p) => !p);
    return `Чекає суперника за ${joinAs(t, free < 0 ? 0 : free)}`;
  }
  if (g.status === "active") {
    if (g.turn == null) return "Триває";
    return `Хід: ${g.players[g.turn] ?? FREE_SEAT} (${seatName(t, g.turn)})`;
  }
  return g.result?.text || "Завершено";
}

const ORDER = { open: 0, active: 1, finished: 2 } as const;

/** Open games first, then active, then finished; newest first within each. */
export function sortGames(games: GameInfo[]): GameInfo[] {
  return [...games].sort((a, b) => ORDER[a.status] - ORDER[b.status] || b.updated_ts.localeCompare(a.updated_ts));
}

export function upsertGame(games: GameInfo[], g: GameInfo): GameInfo[] {
  return games.some((x) => x.id === g.id) ? games.map((x) => (x.id === g.id ? g : x)) : [g, ...games];
}

export const seatOf = (g: GameInfo, me: string): number | null => {
  const i = g.players.indexOf(me);
  return i < 0 ? null : i;
};

/** Whether `me` can take a free seat of an open game. */
export const canJoin = (g: GameInfo, me: string) => g.status === "open" && !g.players.includes(me);
