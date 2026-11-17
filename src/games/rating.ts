// Ratings belong to the game hub (src/broker/games.ts): it decides when a game counts, keeps the numbers and
// shows them. Each game decides how its own rating moves by giving its GameDefinition a `rate` function;
// a game without one has no rating. Two-player games can take `elo` as it is.
import type { GameOutcome } from "./game.js";

/** A finished game as a rating function sees it. */
export interface RatedGame {
  /** Who sat where, in seat order. */
  players: string[];
  result: GameOutcome;
  /** The game's moves, for games whose rating depends on how the game went. */
  moves: string[];
}

/**
 * Gets the players' ratings before the game (in seat order; undefined for a player's first rated game of
 * this kind) and returns their ratings after it.
 */
export type RateGame = (game: RatedGame, before: (number | undefined)[]) => number[];

export const ELO_START = 1000;
export const ELO_K = 32;

/** Elo for two seats: start 1000, K = 32, a draw is half a point. */
export const elo: RateGame = (game, before) => {
  const [a, b] = [before[0] ?? ELO_START, before[1] ?? ELO_START];
  if (game.players.length !== 2) return [a, b];
  const expectedA = 1 / (1 + 10 ** ((b - a) / 400));
  const scoreA = game.result.winner === null ? 0.5 : game.result.winner === 0 ? 1 : 0;
  const delta = ELO_K * (scoreA - expectedA);
  return [a + delta, b - delta];
};
