import { test } from "node:test";
import assert from "node:assert/strict";
import { auto, counts, flips, legalSquares, newGame, outcome, play, renderBoard, replay, square, squareName } from "../games/reversi/engine.js";
import { reversi } from "../games/reversi/index.js";
import type { GameInfo } from "../protocol.js";
import { startBroker, tok } from "./helpers.js";

const names = (squares: number[]) => squares.map(squareName);

/** Found by search: black has no move after these eight, so the broker writes a pass. */
const TO_PASS = ["d3", "c3", "f5", "d2", "d1", "e1", "b2", "c1"];
/** The shortest wipe-out from the usual start: no white disc is left after nine moves. */
const WIPEOUT = ["d3", "c3", "b3", "d2", "e1", "d6", "d7", "e3", "f4"];

test("reversi: black starts with four moves, and a move turns the closed line over", () => {
  const s = newGame();
  assert.equal(s.turn, "b");
  assert.deepEqual(names(legalSquares(s)), ["d3", "c4", "f5", "e6"]);
  assert.deepEqual(names(flips(s.board, square("d3"), "b")), ["d4"]);
  const next = play(s, "D3");
  assert.equal(next.board[square("d4")], "b");
  assert.equal(next.turn, "w");
  assert.deepEqual(next.moves, ["d3"]);
  assert.deepEqual(counts(next), { black: 4, white: 1 });
  assert.equal(newGame().board[square("d4")], "w", "the input state is not changed");
});

test("reversi: a move that turns nothing, a taken square and a pass with moves left are refused with a reason", () => {
  const s = newGame();
  assert.throws(() => play(s, "a1"), /a1 turns over no disc; legal moves: d3, c4, f5, e6/);
  assert.throws(() => play(s, "d4"), /d4 is taken/);
  assert.throws(() => play(s, "pass"), /you have moves, so you cannot pass/);
  assert.throws(() => play(s, "z9"), /bad square/);
});

test("reversi: a side with no move passes, and the game ends when nobody can move", () => {
  const s = replay(TO_PASS);
  assert.equal(s.turn, "b");
  assert.deepEqual(legalSquares(s), []);
  assert.equal(outcome(s).over, false);
  assert.deepEqual(auto(s), { move: "pass", note: "У чорних немає ходів: хід переходить до білих." });
  const after = play(s, "pass");
  assert.equal(after.turn, "w");
  assert.equal(auto(after), null);

  const end = replay(WIPEOUT);
  assert.deepEqual(outcome(end), { over: true, winner: "b", black: 13, white: 0 });
  assert.throws(() => play(end, "a1"), /the game is over/);
});

test("reversi: the text board marks where the side to move may play", () => {
  const board = renderBoard(newGame());
  assert.equal(board.split("\n")[5], "3 . . . * . . . .");
  assert.equal(board.split("\n")[4], "4 . . * w b . . .");
  assert.match(board, /Фішок: чорні 2, білі 2$/);
});

test("reversi in the broker: passes are written for the player, and the result tells the score", async () => {
  const b = await startBroker([{ name: "olena", kind: "human" }, { name: "bot1", kind: "claude" }], {}, { games: [reversi] });
  const call = async (who: string, method: string, path: string, body?: unknown) => {
    const r = await fetch(`${b.http}${path}`, {
      method,
      headers: { authorization: `Bearer ${tok(who)}`, "content-type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return (await r.json()) as { game: GameInfo; error?: string };
  };
  try {
    let g = (await call("olena", "POST", "/api/games", { game: "reversi", players: ["olena", "bot1"] })).game;
    const by = ["olena", "bot1"];
    for (const [i, m] of TO_PASS.entries()) g = (await call(by[i % 2], "POST", `/api/games/${g.id}/move`, { move: m })).game;
    assert.equal(g.moves.at(-1), "pass"); // black had no move: the broker passed for it
    assert.equal(g.turn, 1);

    g = (await call("olena", "POST", "/api/games", { game: "reversi", players: ["olena", "bot1"] })).game;
    for (const [i, m] of WIPEOUT.entries()) g = (await call(by[i % 2], "POST", `/api/games/${g.id}/move`, { move: m })).game;
    assert.equal(g.status, "finished");
    assert.equal(g.result?.winner, 0);
    assert.equal(g.result?.text, "Перемога: чорні (olena). Ходів більше немає, фішок: чорні 13, білі 0.");
  } finally {
    await b.broker.close();
  }
});
