import { test } from "node:test";
import assert from "node:assert/strict";
import {
  newGame, legalMoves, play, replay, outcome, parseMove, renderBoard, square,
  type CheckersState, type Cell,
} from "../games/checkers.js";

/** Builds a position from {square: cell}. */
function position(pieces: Record<string, Cell>, turn: "w" | "b" = "w"): CheckersState {
  const board: Cell[] = Array(64).fill(".");
  for (const [sq, c] of Object.entries(pieces)) board[square(sq)] = c;
  return { board, turn, quiet: 0, seen: {}, moves: [] };
}

const notations = (s: CheckersState) => legalMoves(s).map((m) => m.notation).sort();

test("start position has 12 men a side and 7 opening moves", () => {
  const s = newGame();
  assert.equal(s.board.filter((c) => c === "w").length, 12);
  assert.equal(s.board.filter((c) => c === "b").length, 12);
  assert.deepEqual(notations(s), ["a3-b4", "c3-b4", "c3-d4", "e3-d4", "e3-f4", "g3-f4", "g3-h4"]);
});

test("capture is mandatory", () => {
  const s = position({ c3: "w", d4: "b", a1: "w" });
  assert.deepEqual(notations(s), ["c3:e5"]);
});

test("men capture backwards", () => {
  const s = position({ e5: "w", d4: "b" });
  assert.deepEqual(notations(s), ["e5:c3"]);
});

test("multi-capture continues to the end", () => {
  const s = position({ a1: "w", b2: "b", d4: "b", f6: "b" });
  assert.deepEqual(notations(s), ["a1:c3:e5:g7"]);
  const next = play(s, "a1:g7");
  assert.equal(next.board.filter((c) => c === "b").length, 0);
});

test("man promoted mid-capture keeps capturing as a king", () => {
  const s = position({ b6: "w", c7: "b", f6: "b" });
  // b6:d8 promotes, then as a king d8 x e7? e7 empty; king flies d8-e7 and captures f6 landing g5/h4.
  assert.deepEqual(notations(s), ["b6:d8:g5", "b6:d8:h4"]);
  const next = play(s, "b6:d8:h4");
  assert.equal(next.board[square("h4")], "W");
});

test("flying king moves and captures at distance", () => {
  const s = position({ a1: "W", e5: "b" });
  assert.deepEqual(notations(s), ["a1:f6", "a1:g7", "a1:h8"]);
  const quiet = position({ a1: "W" });
  assert.equal(legalMoves(quiet).length, 7);
});

test("a captured piece cannot be jumped twice and blocks the path", () => {
  // King on a1 captures c3; Turkish rule keeps c3 on the board until the move ends.
  const s = position({ a1: "W", c3: "b", e3: "b", e5: "b" });
  for (const m of legalMoves(s)) assert.equal(new Set(m.captures).size, m.captures.length);
});

test("parseMove accepts loose notation and reports illegal moves", () => {
  const s = newGame();
  assert.equal(parseMove(s, "C3 D4").notation, "c3-d4");
  assert.throws(() => parseMove(s, "c3-c4"), /illegal move/);
  assert.throws(() => parseMove(s, "hello"), /can't read/);
});

test("side without moves loses", () => {
  const s = position({ a1: "w", b2: "b", c3: "b" });
  assert.deepEqual(outcome(s), { over: true, winner: "b", reason: "no-moves" });
});

test("replay rebuilds a game and renders a board", () => {
  const s = replay(["c3-d4", "f6-e5", "d4:f6", "g7:e5"]);
  assert.equal(s.turn, "w");
  assert.equal(s.moves.length, 4);
  assert.match(renderBoard(s), /^8 /);
  assert.equal(outcome(s).over, false);
});

test("quiet king moves end in a draw", () => {
  let s = position({ a1: "W", h4: "B" });
  const shuffle = ["a1-b2", "h4-g3", "b2-a1", "g3-h4"];
  for (let i = 0; i < 12 && !outcome(s).over; i++) s = play(s, shuffle[i % 4]);
  assert.deepEqual(outcome(s), { over: true, winner: null, reason: "repetition" });
});
