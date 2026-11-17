// Checkers as a game module for the broker; the rules themselves are in ./engine.ts (shared with the web).
import { elo } from "../rating.js";
import type { GameDefinition } from "../game.js";
import * as engine from "./engine.js";

const SEAT = { w: 0, b: 1 } as const;
const GENITIVE = ["білих", "чорних"];

export const checkers: GameDefinition = {
  id: "checkers",
  title: "Шашки",
  description: "Українські шашки 8×8: бити обов'язково, прості б'ють назад, дамка ходить далеко.",
  seats: [
    { id: "w", name: "білі" },
    { id: "b", name: "чорні" },
  ],
  rate: elo,
  play(moves, text) {
    const s = engine.play(engine.replay(moves), text);
    return s.moves[s.moves.length - 1];
  },
  turn: (moves) => SEAT[engine.replay(moves).turn],
  legalMoves: (moves) => engine.legalMoves(engine.replay(moves)).map((m) => m.notation),
  outcome(moves) {
    const o = engine.outcome(engine.replay(moves));
    return o.over ? { winner: o.winner ? SEAT[o.winner] : null, reason: o.reason } : null;
  },
  board: (moves) => engine.renderBoard(engine.replay(moves)),
  turnLabel: (seat) => `Хід ${GENITIVE[seat]}`,
  reasonText(o) {
    switch (o.reason) {
      case "no-moves":
        return o.winner === null ? "немає ходів" : `у ${GENITIVE[1 - o.winner]} немає ходів`;
      case "repetition":
        return "триразове повторення";
      case "quiet":
        return `${engine.DRAW_QUIET_PLIES} ходів без взять`;
      default:
        return o.reason;
    }
  },
};
