// What a game module gives the broker. The broker's game service (src/broker/games.ts) knows only seats,
// moves, turns, resigning, draws, rooms and announcements; everything about a particular game (its rules,
// notation, board and wording) lives in its own folder under src/games/ and is listed in src/games/index.ts.
import type { GameType } from "../protocol.js";
import type { RateGame } from "./rating.js";

/** How a game ended by its own rules; resigning and agreed draws are handled by the broker. */
export interface GameOutcome {
  /** Index of the winning seat, or null for a draw. When a side of several wins, the first of `winners`. */
  winner: number | null;
  /** When several seats win together (a team): all of them. */
  winners?: number[];
  /** The game's own reason, e.g. checkers "no-moves", "repetition", "quiet". */
  reason: string;
}

/** Who makes a move, for games that need it (see GameDefinition.play). */
export interface MoveContext {
  /** The seat moving. */
  seat: number;
  /** Player names by seat. */
  players: (string | null)[];
  /**
   * Whether only the broker sees the text: sent over the API (the web) or in a direct message to the
   * system sender, not written in the game room.
   */
  private: boolean;
}

/** A game the broker can host. The state is always rebuilt from the list of moves. */
export interface GameDefinition extends GameType {
  /** Checks `text` as the next move; returns it in canonical notation or throws with a readable reason. */
  play(moves: string[], text: string, ctx: MoveContext): string;
  /** Index of the seat to move. */
  turn(moves: string[]): number;
  /** When several seats may move now in any order (a secret vote): which. Without it, only turn(). */
  movers?(moves: string[]): number[];
  /**
   * For games with hidden information: the moves as everyone may see them while the game is on (the API,
   * the live feed, the board posted in the room). A finished game shows all its moves. Without it, every
   * move is public.
   */
  publicMoves?(moves: string[]): string[];
  /**
   * What only the player at `seat` knows (e.g. the secret word), or null. The broker sends it to agents in a
   * direct message when the game starts and on request; the web asks for it (GET /api/games/<id>/card).
   */
  card?(moves: string[], seat: number): string | null;
  /**
   * Words that start a move an agent may send to the system sender in a direct message without "move",
   * e.g. ["vote"]. Other direct messages need "move <move>" (or "card").
   */
  privateVerbs?: string[];
  /** How the room is told of a move (given in its public form); without it, the move itself. */
  moveText?(move: string): string;
  legalMoves(moves: string[]): string[];
  outcome(moves: string[]): GameOutcome | null;
  /** Text board for agents (posted in a code block). */
  board(moves: string[]): string;
  /** "Хід білих"; without it the broker writes "Хід: <seat name>". */
  turnLabel?(seat: number): string;
  /** Words for one of the game's own reasons, e.g. "у білих немає ходів"; without it the reason id is shown. */
  reasonText?(outcome: GameOutcome): string;
  /**
   * For games of chance: the entry the broker itself adds next (a dice roll, a forced pass), with words for
   * the room, or null when it is a player's turn. `random` returns [0, 1). The broker asks again after
   * each entry, so the state stays a plain list of moves. `seats` is how many seats this game has, for a
   * game whose first entry sets it up (see GameType.minSeats).
   */
  auto?(moves: string[], random: () => number, seats: number): { move: string; note: string } | null;
  /**
   * How a finished game changes its players' ratings (see src/games/rating.ts); without it the game has no
   * rating. The hub calls it for each counted game in the order the games finished.
   */
  rate?: RateGame;
  /**
   * For games of more than two: the entry that takes a resigning seat out (the broker adds it to the moves).
   * From then on the rules skip that seat, and outcome() tells when the game is over. It throws when the seat
   * is out already. Without it, resigning ends the game.
   */
  dropOut?(moves: string[], seat: number): string;
  /**
   * For games with too many legal moves to list: a hint at what may be played, posted instead of the list
   * (e.g. "вільні клітинки поруч із літерами: b2, c2").
   */
  movesHint?(moves: string[]): string;
}
