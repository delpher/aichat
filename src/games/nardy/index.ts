// Long nardy as a game module for the broker; the rules are in ./engine.ts (shared with the web).
import { elo } from "../rating.js";
import type { GameDefinition } from "../game.js";
import * as engine from "./engine.js";

const SEAT = { w: 0, b: 1 } as const;
const COLORS = ["w", "b"] as const;

export const nardy: GameDefinition = {
  id: "nardy",
  title: "Нарди",
  description: "Довгі нарди: по 15 шашок з «голови», бити не можна, кубики кидає брокер.",
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
  legalMoves: (moves) => engine.legalNotations(engine.replay(moves)),
  outcome(moves) {
    const o = engine.outcome(engine.replay(moves));
    return o.over ? { winner: SEAT[o.winner], reason: o.reason } : null;
  },
  board: (moves) => engine.renderBoard(engine.replay(moves)),
  auto: (moves, random) => engine.auto(engine.replay(moves), random),
  turnLabel: (seat) => `Хід ${engine.GENITIVE[COLORS[seat]]}`,
  reasonText(o) {
    const loser = o.winner === null ? "" : engine.GENITIVE[COLORS[1 - o.winner]];
    switch (o.reason) {
      case "mars":
        return `марс: у ${loser} жодної знятої шашки`;
      case "off":
        return "усі шашки знято";
      default:
        return o.reason;
    }
  },
};
