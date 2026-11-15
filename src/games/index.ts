// Rules of every mini-game the broker hosts, by the name used in POST /api/games {game}.
import type { GameRules } from "../broker/games.js";
import * as checkers from "./checkers.js";

const checkersRules: GameRules = {
  play: (moves, text) => {
    const s = checkers.play(checkers.replay(moves), text);
    return s.moves[s.moves.length - 1];
  },
  turn: (moves) => checkers.replay(moves).turn,
  legalMoves: (moves) => checkers.legalMoves(checkers.replay(moves)).map((m) => m.notation),
  outcome: (moves) => {
    const o = checkers.outcome(checkers.replay(moves));
    return o.over ? { winner: o.winner, reason: o.reason } : null;
  },
  board: (moves) => checkers.renderBoard(checkers.replay(moves)),
};

export const GAME_RULES: Record<string, GameRules> = { checkers: checkersRules };
