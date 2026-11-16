// What a mini-game plugs into the games infrastructure. The infrastructure (tiles, lobby, game page
// shell, history, chat, deleting) knows nothing about any particular game; a game is a module that
// describes itself and draws its own board. Seats, turns and results come from the broker.
import type { ComponentType } from "react";
import type { GameInfo } from "../api/types";

export interface PlayProps {
  game: GameInfo;
  /** How many of game.moves to show (less than all while stepping back through the game). */
  ply: number;
  /** Index of the seat the viewer may move for right now, or null (spectator, not their turn, replaying). */
  canMove: number | null;
  /** Index of the seat drawn nearest the viewer. */
  bottom: number;
  /** Sends a move in the game's own notation to the broker. */
  onMove: (move: string) => void;
}

export interface GameModule {
  /** Matches GameInfo.game and the broker's game type id. */
  id: string;
  /** A short rules summary for the game's lobby. */
  rules: string;
  /** Seat labels for "join as …" ("за білих"), by seat id; the broker's seat name is used otherwise. */
  joinAs?: Record<string, string>;
  /** Small picture for the tile. */
  Tile: ComponentType;
  /** The board for a position, interactive when canMove is set. */
  Play: ComponentType<PlayProps>;
  /** The position as text, for "copy as text". */
  toText?: (moves: string[]) => string;
}
