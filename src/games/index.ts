// Every game the broker hosts. A new game is a folder under src/games/ exporting a GameDefinition,
// plus one line here.
import type { GameDefinition } from "./game.js";
import { checkers } from "./checkers/index.js";
import { nardy } from "./nardy/index.js";
import { reversi } from "./reversi/index.js";
import { balda } from "./balda/index.js";
import { spy } from "./spy/index.js";

export type { GameDefinition, GameOutcome, MoveContext } from "./game.js";
export { elo, type RateGame, type RatedGame } from "./rating.js";

export const GAMES: GameDefinition[] = [checkers, nardy, reversi, balda, spy];
