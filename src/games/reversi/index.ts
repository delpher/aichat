// Reversi as a game module for the broker; the rules are in ./engine.ts (shared with the web).
import { elo } from "../rating.js";
import type { GameDefinition } from "../game.js";
import * as engine from "./engine.js";

const SEAT = { b: 0, w: 1 } as const;
const COLORS = ["b", "w"] as const;

export const reversi: GameDefinition = {
  id: "reversi",
  title: "Реверсі",
  description: "Реверсі 8×8: поставте фішку так, щоб затиснути ряд чужих, і вони стануть вашими. Більше фішок наприкінці перемагає.",
  seats: [
    { id: "b", name: "чорні" },
    { id: "w", name: "білі" },
  ],
  rate: elo,
  play(moves, text) {
    const s = engine.play(engine.replay(moves), text);
    return s.moves[s.moves.length - 1];
  },
  turn: (moves) => SEAT[engine.replay(moves).turn],
  legalMoves: (moves) => engine.legalSquares(engine.replay(moves)).map(engine.squareName),
  outcome(moves) {
    const o = engine.outcome(engine.replay(moves));
    // the score travels in the reason, so the result can say it
    return o.over ? { winner: o.winner ? SEAT[o.winner] : null, reason: `score:${o.black}:${o.white}` } : null;
  },
  board: (moves) => engine.renderBoard(engine.replay(moves)),
  auto: (moves) => engine.auto(engine.replay(moves)),
  turnLabel: (seat) => `Хід ${engine.GENITIVE[COLORS[seat]]}`,
  reasonText(o) {
    const m = /^score:(\d+):(\d+)$/.exec(o.reason);
    return m ? `ходів більше немає, фішок: чорні ${m[1]}, білі ${m[2]}` : o.reason;
  },
};
