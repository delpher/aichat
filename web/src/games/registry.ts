import { checkers } from "./checkers";
import { nardy } from "./nardy";
import type { GameModule } from "./types";

/**
 * Every game the web UI can draw. A new game: a module in web/src/games/<id>/ and one line here.
 * Tiles show the games the broker offers (GET /api/games/types) that also have a module here.
 */
export const GAMES: GameModule[] = [checkers, nardy];

export const findGame = (id: string): GameModule | undefined => GAMES.find((g) => g.id === id);
