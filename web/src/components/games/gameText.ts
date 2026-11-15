import type { GameInfo } from "../../api/types";

export const COLOR_NAME = { w: "білі", b: "чорні" } as const;
export const FREE_SEAT = "вільне місце";

const REASON: Record<NonNullable<GameInfo["result"]>["reason"], string> = {
  "no-moves": "немає ходів",
  repetition: "триразове повторення",
  quiet: "30 ходів без взять",
  resign: "здача",
  agreement: "за згодою",
};

export const seat = (g: GameInfo, c: "w" | "b") => (c === "w" ? g.white : g.black);

/** "Перемога: claude-a (білі) · немає ходів", "Нічия · за згодою", who is to move, or who is awaited. */
export function gameStatus(g: GameInfo): string {
  if (g.status === "open") {
    const free = g.white ? "b" : "w";
    return `Чекає суперника за ${COLOR_NAME[free]}`;
  }
  if (g.status === "active") {
    const turn = g.moves.length % 2 === 0 ? "w" : "b";
    return `Хід: ${seat(g, turn) ?? FREE_SEAT} (${COLOR_NAME[turn]})`;
  }
  const r = g.result;
  if (!r) return "Завершено";
  if (!r.winner) return `Нічия · ${REASON[r.reason]}`;
  return `Перемога: ${seat(g, r.winner) ?? FREE_SEAT} (${COLOR_NAME[r.winner]}) · ${REASON[r.reason]}`;
}

const ORDER = { open: 0, active: 1, finished: 2 } as const;

/** Open games first, then active, then finished; newest first within each. */
export function sortGames(games: GameInfo[]): GameInfo[] {
  return [...games].sort((a, b) => ORDER[a.status] - ORDER[b.status] || b.updated_ts.localeCompare(a.updated_ts));
}

export function upsertGame(games: GameInfo[], g: GameInfo): GameInfo[] {
  return games.some((x) => x.id === g.id) ? games.map((x) => (x.id === g.id ? g : x)) : [g, ...games];
}

/** Whether `me` can take the free seat of an open game. */
export const canJoin = (g: GameInfo, me: string) => g.status === "open" && g.white !== me && g.black !== me;
