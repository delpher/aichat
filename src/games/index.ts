// Every game the broker hosts. A new game is a folder under src/games/ exporting a GameDefinition,
// plus one line here.
import type { GameDefinition } from "./game.js";
import { checkers } from "./checkers/index.js";
import { nardy } from "./nardy/index.js";

export type { GameDefinition, GameOutcome } from "./game.js";
export { elo, type RateGame, type RatedGame } from "./rating.js";

export const GAMES: GameDefinition[] = [checkers, nardy];
