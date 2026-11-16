import { test } from "node:test";
import assert from "node:assert/strict";
import {
  auto, count, legalNotations, newGame, outcome, play, renderBoard, replay, toWhite,
  type Color, type NardyState,
} from "../games/nardy/engine.js";
import { nardy } from "../games/nardy/index.js";
import type { ChatMessage, GameInfo } from "../protocol.js";
import { connect, startBroker, tok } from "./helpers.js";

/** A position from checkers on each side's own points; `dice` are those left to play this turn. */
function position(white: Record<number, number>, black: Record<number, number>, turn: Color, roll: [number, number], extra: Partial<NardyState> = {}): NardyState {
  const s = newGame();
  s.points.fill(0);
  for (const [p, n] of Object.entries(white)) s.points[toWhite(Number(p), "w") - 1] += n;
  for (const [p, n] of Object.entries(black)) s.points[toWhite(Number(p), "b") - 1] -= n;
  s.started = true;
  s.turn = turn;
  s.roll = roll;
  s.dice = roll[0] === roll[1] ? [roll[0], roll[0], roll[0], roll[0]] : [...roll];
  s.turns = [5, 5]; // not the first turn
  return { ...s, ...extra };
}

const steps = (s: NardyState) => legalNotations(s).sort();

test("start: 15 on each head, heads in opposite corners", () => {
  const s = newGame();
  assert.equal(count(s, "w", 24), 15);
  assert.equal(count(s, "b", 24), 15);
  assert.equal(toWhite(24, "b"), 12);
  assert.equal(toWhite(1, "b"), 13);
});

test("one checker from the head per turn; a step may span both dice", () => {
  const s = replay(["first 5-3", "roll 6-3"]);
  assert.equal(s.turn, "w");
  assert.deepEqual(steps(s), ["24-18", "24-21"]);
  const next = play(s, "24-15");
  assert.equal(next.moves.at(-1), "24-18 18-15");
  assert.equal(next.turn, "b");
  assert.deepEqual(next.dice, []);
  assert.throws(() => play(s, "24-18 24-21"), /неможливий/);
});

test("first turn 6-6 takes two checkers off the head, later 6-6 only one", () => {
  const first = play(replay(["first 5-3", "roll 6-6"]), "24-18 24-18");
  assert.equal(count(first, "w", 18), 2);
  assert.equal(first.turn, "b"); // 18-12 is black's head: nothing else to play
  const later = replay(["first 5-3", "roll 2-1", "24-22 22-21", "roll 1-2", "24-23 23-21", "roll 6-6"]);
  assert.equal(later.turn, "w");
  assert.throws(() => play(later, "24-18 24-18"), /неможливий/);
});

test("no landing on a point the opponent holds", () => {
  // white 20 → 14 with a 6; black holds white's 14 = black's 2
  const s = position({ 20: 1, 1: 14 }, { 2: 1, 24: 14 }, "w", [6, 5]);
  assert.ok(!steps(s).includes("20-14"));
  assert.ok(steps(s).includes("20-15"));
});

test("both dice must be played when some order allows it", () => {
  // white 13 and 10; black holds white 4 (its 16): 10-4 is out, 10-5 then 13-7 plays both
  const both = position({ 13: 1, 10: 1, 1: 13 }, { 16: 1, 24: 14 }, "w", [6, 5]);
  assert.deepEqual(steps(both), ["10-5", "13-7", "13-8"]);
  // one checker on 13; black holds white 7 (its 19) and white 2 (its 14): only the 5 can be played
  const one = position({ 13: 1, 1: 14 }, { 19: 1, 14: 1, 24: 13 }, "w", [6, 5]);
  assert.deepEqual(steps(one), ["13-8"]);
});

test("the larger die when only one can be played", () => {
  // white on 10: 10-4 (6) and 10-5 (5) both open, but after either the other die is blocked
  // white 20 is stuck (black holds white 14 and 15, its 2 and 3), so the other die is lost either way
  const s = position({ 20: 1, 10: 1, 1: 13 }, { 2: 1, 3: 1, 24: 13 }, "w", [6, 5]);
  assert.deepEqual(steps(s), ["10-4"]);
});

test("no block of six with no opposing checker past it", () => {
  // white 22..18 is black's 10..6; 24-23 adds black's 11: six in a row with every black checker behind it
  const s = position({ 22: 1, 21: 1, 20: 1, 19: 1, 18: 1, 24: 10 }, { 24: 15 }, "w", [1, 2]);
  assert.ok(!steps(s).includes("24-23"));
  assert.ok(steps(s).includes("24-22"));
  const ahead = position({ 22: 1, 21: 1, 20: 1, 19: 1, 18: 1, 24: 10 }, { 24: 14, 3: 1 }, "w", [1, 2]);
  assert.ok(steps(ahead).includes("24-23")); // a black checker on its 3 is past the block
});

test("bearing off: exact die, or the highest checker with a larger die", () => {
  const s = position({ 3: 1, 2: 1 }, { 24: 15 }, "w", [6, 1], { off: [13, 0] });
  assert.deepEqual(steps(s), ["2-1", "3-2", "3-off"]);
  const end = play(s, "3-off 2-1");
  assert.equal(end.off[0], 14);
  const last = play(position({ 1: 1 }, { 24: 15 }, "w", [2, 1], { off: [14, 0] }), "1-off");
  assert.deepEqual(outcome(last), { over: true, winner: "w", reason: "mars" });
  assert.throws(() => play(position({ 7: 1, 3: 14 }, { 24: 15 }, "w", [6, 3]), "3-off"), /неможливий/); // not all home
});

test("auto: roll-off, rolls and pass", () => {
  const seq = [0.0, 0.0, 0.5, 0.1]; // dice 1,1 (tie, rolled again), then 4 and 1
  let i = 0;
  const rnd = () => seq[i++] ?? 0.99;
  const a = auto(newGame(), rnd);
  assert.equal(a?.move, "first 4-1");
  assert.match(a!.note, /починають білі/);
  const r = auto(replay(["first 4-1"]), () => 0.99);
  assert.equal(r?.move, "roll 6-6");
  assert.equal(auto(replay(["first 4-1", "roll 6-6"]), rnd), null);
  // a roll that cannot be played: black 15 → 13 is white's 1, held
  const blockedAll = position({ 13: 3, 1: 12 }, { 15: 15 }, "b", [2, 2]); // black 15 → 13 = white 1 → held
  assert.equal(auto(blockedAll, rnd)?.move, "pass");
});

test("the board names the mover's points", () => {
  const b = renderBoard(replay(["first 5-3", "roll 6-3"]));
  assert.match(b, /з боку білих/);
  assert.match(b, /w15/);
  assert.match(b, /лишилось: 6, 3/);
});

test("the game module and the broker roll the dice", async () => {
  const dice = [0.9, 0.1, 0.9, 0.4]; // first 6-1 (white starts), roll 6-3
  let i = 0;
  const b = await startBroker([{ name: "olena", kind: "human" }, { name: "bot1", kind: "claude" }], {}, { games: [nardy], random: () => dice[i++] ?? 0.2 });
  const olena = await connect(b.url, "olena");
  const call = async (who: string, method: string, path: string, body?: unknown) => {
    const r = await fetch(`${b.http}${path}`, {
      method,
      headers: { authorization: `Bearer ${tok(who)}`, "content-type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return (await r.json()) as { game: GameInfo; error?: string };
  };
  // listen before creating: the broker posts the start before the HTTP answer arrives
  const started = new Promise<ChatMessage>((resolve) => {
    const on = (msg: ChatMessage) => {
      if (msg.from !== "aichat") return;
      olena.off("message", on);
      resolve(msg);
    };
    olena.on("message", on);
  });
  let g = (await call("olena", "POST", "/api/games", { game: "nardy", players: ["olena", "bot1"] })).game;
  assert.deepEqual(g.moves, ["first 6-1", "roll 6-3"]);
  assert.equal(g.turn, 0);
  const m = await started;
  assert.match(m.text, /Жереб: білі 6, чорні 1/);
  assert.match(m.text, /Кубики білих: 6-3/);
  assert.match(m.text, /Можливі ходи: 24-18, 24-21/);
  g = (await call("olena", "POST", `/api/games/${g.id}/move`, { move: "24-18" })).game;
  assert.equal(g.turn, 0); // the 3 is still to play
  g = (await call("olena", "POST", `/api/games/${g.id}/move`, { move: "18-15" })).game;
  assert.deepEqual(g.moves.slice(2), ["24-18", "18-15", "roll 2-2"]);
  assert.equal(g.turn, 1);
  olena.close();
  await b.broker.close();
});

test("a refused step says why", () => {
  const start = replay(["first 5-3", "roll 6-3"]);
  assert.throws(() => play(start, "20-14"), /немає ваших шашок/);
  assert.throws(() => play(start, "24-18 24-21"), /лише одну шашку/);
  assert.throws(() => play(start, "24-20"), /немає кубика на 4/);
  const held = position({ 20: 1, 1: 14 }, { 2: 1, 24: 14 }, "w", [6, 5]);
  assert.throws(() => play(held, "20-14"), /пункт 14 зайнятий суперником/);
  const block = position({ 22: 1, 21: 1, 20: 1, 19: 1, 18: 1, 24: 10 }, { 24: 15 }, "w", [1, 2]);
  assert.throws(() => play(block, "24-23"), /шість пунктів поспіль/);
  assert.throws(() => play(position({ 7: 1, 3: 14 }, { 24: 15 }, "w", [6, 3]), "3-off"), /всі шашки в домі/);
  assert.throws(() => play(position({ 5: 1, 2: 1 }, { 24: 15 }, "w", [3, 1], { off: [13, 0] }), "2-off"), /немає кубика|вищих пунктів/);
});
