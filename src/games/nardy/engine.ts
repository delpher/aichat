// Long nardy (длинные нарды). Pure logic, no I/O: the broker uses it to check moves and roll dice,
// the web UI to draw the board and highlight steps.
//
// Rules: 15 checkers each start on the player's "head" (own point 24); both sides move the same way
// round the board, from 24 down to 1, and bear off from home (own points 1-6). White's point p is
// black's point p+12 (mod 24), so the heads sit in opposite corners. There is no hitting: a checker may
// not land on a point the opponent holds, and one checker is enough to hold a point. A turn is one roll
// of two dice; a double is played four times. Only one checker may leave the head per turn, except on a
// player's first turn with 6-6, 4-4 or 3-3, when two may. Both dice must be used if any order allows it;
// if only one can be used, the larger one must be used when possible. Six points in a row may not be
// blocked unless at least one opposing checker is already past the block. Bearing off: all 15 must be
// home; a die takes off a checker from the matching point, or from the highest point when the die is
// larger than every point with a checker. The first to bear off all 15 wins ("mars" when the loser has
// borne off none).
//
// The game is the list of entries: "first 5-3" (who starts: white's and black's die), "roll 6-3",
// "pass" (no legal step at all) — these three are added by the broker — and a player's steps
// "24-18 18-15" (1-4 steps, in the mover's own numbering; bearing off is "3-off"). A player may play
// a turn in several entries; the turn passes when no legal step is left.

export type Color = "w" | "b";

export interface NardyState {
  /** 24 points, index i = white's point i+1; positive = white checkers, negative = black. */
  points: number[];
  /** Checkers borne off: [white, black]. */
  off: [number, number];
  turn: Color;
  /** Dice still to play this turn; empty while waiting for a roll (or before the first roll). */
  dice: number[];
  /** This turn's roll, for showing; null between turns. */
  roll: [number, number] | null;
  /** Checkers that left the head this turn. */
  headUsed: number;
  /** Finished turns per side: [white, black]. */
  turns: [number, number];
  /** True once the "first" roll decided who starts. */
  started: boolean;
  moves: string[];
}

export interface Step {
  /** Own points of the mover; to = 0 is bearing off. */
  from: number;
  to: number;
  die: number;
  notation: string;
}

export type Outcome = { over: false } | { over: true; winner: Color; reason: "mars" | "off" };

export const CHECKERS = 15;
export const HEAD = 24;
const IDX: Record<Color, number> = { w: 0, b: 1 };
const SIGN: Record<Color, number> = { w: 1, b: -1 };
export const other = (c: Color): Color => (c === "w" ? "b" : "w");

/** The other side's number for a point one side calls `p` (the numberings differ by 12). */
export const flip = (p: number) => ((p + 11) % 24) + 1;

/** White's number of the point `p` as `c` counts it. */
export function toWhite(p: number, c: Color): number {
  return c === "w" ? p : flip(p);
}

/** How many checkers `c` has on its own point `p`. */
export function count(s: NardyState, c: Color, p: number): number {
  const v = s.points[toWhite(p, c) - 1] * SIGN[c];
  return v > 0 ? v : 0;
}

/** Is the point held by the opponent of `c`? */
function blocked(s: NardyState, c: Color, p: number): boolean {
  return s.points[toWhite(p, c) - 1] * SIGN[c] < 0;
}

export function newGame(): NardyState {
  const points = Array<number>(24).fill(0);
  points[toWhite(HEAD, "w") - 1] = CHECKERS;
  points[toWhite(HEAD, "b") - 1] = -CHECKERS;
  return { points, off: [0, 0], turn: "w", dice: [], roll: null, headUsed: 0, turns: [0, 0], started: false, moves: [] };
}

function clone(s: NardyState): NardyState {
  return { ...s, points: [...s.points], off: [...s.off], dice: [...s.dice], roll: s.roll && [...s.roll], turns: [...s.turns], moves: [...s.moves] };
}

export const stepNotation = (from: number, to: number) => `${from}-${to === 0 ? "off" : to}`;

// ---------- single steps ----------

function headLimit(s: NardyState): number {
  const r = s.roll;
  return s.turns[IDX[s.turn]] === 0 && r && r[0] === r[1] && [3, 4, 6].includes(r[0]) ? 2 : 1;
}

function allHome(s: NardyState, c: Color): boolean {
  for (let p = 7; p <= 24; p++) if (count(s, c, p)) return false;
  return true;
}

/** After `c` put a checker on its own point `to`: does it now block six points with no opponent past them? */
function illegalBlock(s: NardyState, c: Color, to: number): boolean {
  const o = other(c);
  // walk the opponent's path in its own numbering (24 down to 1): "past the block" means a lower number
  const mine = (q: number) => q >= 1 && q <= 24 && count(s, c, flip(q)) > 0;
  let lo = flip(to);
  let hi = lo;
  while (mine(lo - 1)) lo--;
  while (mine(hi + 1)) hi++;
  if (hi - lo + 1 < 6) return false;
  for (let q = 1; q < lo; q++) if (count(s, o, q) > 0) return false;
  return true;
}

function apply(s: NardyState, from: number, to: number) {
  const c = s.turn;
  s.points[toWhite(from, c) - 1] -= SIGN[c];
  if (to === 0) s.off[IDX[c]]++;
  else s.points[toWhite(to, c) - 1] += SIGN[c];
  if (from === HEAD) s.headUsed++;
}

function undo(s: NardyState, from: number, to: number) {
  const c = s.turn;
  s.points[toWhite(from, c) - 1] += SIGN[c];
  if (to === 0) s.off[IDX[c]]--;
  else s.points[toWhite(to, c) - 1] -= SIGN[c];
  if (from === HEAD) s.headUsed--;
}

/** Steps with die `d` that obey every rule except "use as many dice as possible". */
function rawSteps(s: NardyState, d: number): Array<[number, number]> {
  const c = s.turn;
  const out: Array<[number, number]> = [];
  const home = allHome(s, c);
  for (let from = 24; from >= 1; from--) {
    if (!count(s, c, from)) continue;
    if (from === HEAD && s.headUsed >= headLimit(s)) continue;
    let to = from - d;
    if (to <= 0) {
      if (!home) continue;
      if (to < 0) {
        let higher = false;
        for (let p = from + 1; p <= 6; p++) if (count(s, c, p)) higher = true;
        if (higher) continue;
      }
      to = 0;
    } else if (blocked(s, c, to)) continue;
    if (to > 0) {
      apply(s, from, to);
      const bad = illegalBlock(s, c, to);
      undo(s, from, to);
      if (bad) continue;
    }
    out.push([from, to]);
  }
  return out;
}

/** The most dice that can still be played this turn. */
function maxDepth(s: NardyState, dice: number[]): number {
  if (!dice.length) return 0;
  let best = 0;
  for (const d of new Set(dice)) {
    const rest = [...dice];
    rest.splice(rest.indexOf(d), 1);
    for (const [from, to] of rawSteps(s, d)) {
      apply(s, from, to);
      const n = 1 + maxDepth(s, rest);
      undo(s, from, to);
      if (n > best) best = n;
      if (best === dice.length) return best;
    }
  }
  return best;
}

/** Legal next steps for the side to move, with the "play as many dice as you can, the larger first" rule. */
export function legalSteps(state: NardyState): Step[] {
  const s = clone(state);
  if (!s.dice.length) return [];
  const want = maxDepth(s, s.dice);
  if (!want) return [];
  let steps: Step[] = [];
  for (const d of new Set(s.dice)) {
    const rest = [...s.dice];
    rest.splice(rest.indexOf(d), 1);
    for (const [from, to] of rawSteps(s, d)) {
      apply(s, from, to);
      const n = 1 + maxDepth(s, rest);
      undo(s, from, to);
      if (n === want) steps.push({ from, to, die: d, notation: stepNotation(from, to) });
    }
  }
  // only one die can be played: the larger one if it can
  if (want === 1 && s.dice.length === 2 && s.dice[0] !== s.dice[1]) {
    const big = Math.max(...s.dice);
    if (steps.some((st) => st.die === big)) steps = steps.filter((st) => st.die === big);
  }
  return steps;
}

/** Legal step notations without repeats (a bearing-off step may be possible with either die). */
export function legalNotations(s: NardyState): string[] {
  return [...new Set(legalSteps(s).map((st) => st.notation))];
}

/** Can the side to move play anything at all with the dice left? */
function canStep(s: NardyState): boolean {
  const t = clone(s);
  return [...new Set(t.dice)].some((d) => rawSteps(t, d).length > 0);
}

// ---------- entries ----------

function endTurn(s: NardyState) {
  s.turns[IDX[s.turn]]++;
  s.turn = other(s.turn);
  s.dice = [];
  s.roll = null;
  s.headUsed = 0;
}

const DIE = /^[1-6]$/;

function parseDice(text: string): [number, number] | null {
  const m = /^(\d)-(\d)$/.exec(text);
  return m && DIE.test(m[1]) && DIE.test(m[2]) ? [Number(m[1]), Number(m[2])] : null;
}

/** Applies one stored entry without checking it (the broker checked it when it was played). */
function replayEntry(s: NardyState, entry: string) {
  const [kind, arg] = entry.split(" ");
  if (kind === "first") {
    const d = parseDice(arg);
    if (!d) throw new Error(`bad entry "${entry}"`);
    s.started = true;
    s.turn = d[0] > d[1] ? "w" : "b";
  } else if (kind === "roll") {
    const d = parseDice(arg);
    if (!d) throw new Error(`bad entry "${entry}"`);
    s.roll = d;
    s.dice = d[0] === d[1] ? [d[0], d[0], d[0], d[0]] : [...d];
    s.headUsed = 0;
  } else if (kind === "pass") {
    endTurn(s);
  } else {
    for (const tok of entry.split(" ")) {
      const [from, to] = tok.split("-").map((x) => (x === "off" ? 0 : Number(x)));
      const die = to === 0 ? useOffDie(s, from) : from - to;
      apply(s, from, to);
      s.dice.splice(s.dice.indexOf(die), 1);
    }
    if (!s.dice.length || !canStep(s)) endTurn(s);
  }
  s.moves.push(entry);
}

/** Which die a bearing-off step from `from` uses: the exact one if there is one, else the smallest larger. */
function useOffDie(s: NardyState, from: number): number {
  if (s.dice.includes(from)) return from;
  const bigger = s.dice.filter((d) => d > from).sort((a, b) => a - b);
  return bigger[0] ?? from;
}

export function replay(moves: string[]): NardyState {
  const s = newGame();
  for (const m of moves) replayEntry(s, m);
  return s;
}

/** Parses "24-18", "24/18", "3-off", "3-0". */
function parseStep(tok: string): [number, number] | null {
  const m = /^(\d{1,2})\s*[-/:]\s*(\d{1,2}|off|з|о)$/i.exec(tok);
  if (!m) return null;
  const from = Number(m[1]);
  const to = /^\d+$/.test(m[2]) ? Number(m[2]) : 0;
  if (from < 1 || from > 24 || to < 0 || to >= from) return null;
  return [from, to];
}

/**
 * Plays the mover's steps, e.g. "24-18 18-15". A step may also span several dice of one checker
 * ("24-15" with 6-3), which is written out as its single steps. Returns the new state; its last move is
 * the canonical entry.
 */
export function play(state: NardyState, text: string): NardyState {
  if (!state.dice.length) throw new Error("кубики ще не кинуто");
  const toks = text.trim().split(/[\s,;]+/).filter(Boolean);
  if (!toks.length) throw new Error("напишіть кроки, наприклад 24-18 18-15");
  const s = clone(state);
  const done: string[] = [];
  for (const [i, tok] of toks.entries()) {
    const want = parseStep(tok);
    if (!want) throw new Error(`не розумію крок "${tok}": пишіть "24-18", зняття "3-off"`);
    if (!s.dice.length) throw new Error(`зайвий крок ${tok}: кубики вже зіграні`);
    const path = findPath(s, want[0], want[1]);
    if (!path) throw new Error(`крок ${tok} неможливий`);
    for (const st of path) {
      apply(s, st.from, st.to);
      s.dice.splice(s.dice.indexOf(st.die), 1);
      done.push(st.notation);
      if (!s.dice.length) break;
    }
    if (i < toks.length - 1 && (!s.dice.length || !canStep(s))) throw new Error(`після ${done.join(" ")} хід закінчено, зайві кроки`);
  }
  const entry = done.join(" ");
  // replay the entry on the original state so the turn passes exactly as replay() would do it
  const next = clone(state);
  replayEntry(next, entry);
  return next;
}

/** Legal steps of one checker from `from` that end on `to`: one step, or several with one checker. */
function findPath(s: NardyState, from: number, to: number): Step[] | null {
  const steps = legalSteps(s);
  // a direct step; for bearing off prefer the smallest die
  const direct = steps.filter((st) => st.from === from && st.to === to).sort((a, b) => a.die - b.die);
  if (direct.length) return [direct[0]];
  for (const st of steps) {
    if (st.from !== from || st.to === 0 || st.to <= to) continue;
    const t = clone(s);
    apply(t, st.from, st.to);
    t.dice.splice(t.dice.indexOf(st.die), 1);
    if (!t.dice.length) continue;
    const rest = findPath(t, st.to, to);
    if (rest) return [st, ...rest];
  }
  return null;
}

export function outcome(s: NardyState): Outcome {
  for (const c of ["w", "b"] as Color[]) {
    if (s.off[IDX[c]] === CHECKERS) return { over: true, winner: c, reason: s.off[IDX[other(c)]] === 0 ? "mars" : "off" };
  }
  return { over: false };
}

// ---------- what the broker adds ----------

/**
 * The broker's own entry for this position, if it owes one: the opening roll-off, the roll at the start
 * of a turn, or "pass" when the roll cannot be played. `random` returns [0, 1).
 */
export function auto(state: NardyState, random: () => number): { move: string; note: string } | null {
  if (outcome(state).over) return null;
  const die = () => 1 + Math.min(5, Math.floor(random() * 6));
  if (!state.started) {
    let w = die();
    let b = die();
    for (let i = 0; w === b && i < 100; i++) [w, b] = [die(), die()];
    if (w === b) w = b === 6 ? 5 : b + 1;
    return { move: `first ${w}-${b}`, note: `Жереб: білі ${w}, чорні ${b}; починають ${w > b ? "білі" : "чорні"}.` };
  }
  if (!state.dice.length) {
    const r = `${die()}-${die()}`;
    return { move: `roll ${r}`, note: `Кубики ${GENITIVE[state.turn]}: ${r}.` };
  }
  if (!canStep(state)) return { move: "pass", note: `У ${GENITIVE[state.turn]} немає ходу, хід переходить.` };
  return null;
}

export const GENITIVE: Record<Color, string> = { w: "білих", b: "чорних" };

// ---------- text board ----------

/** The board as the side to move sees it: own point 24 (the head) top right, home 1-6 bottom right. */
export function renderBoard(s: NardyState): string {
  const c = s.turn;
  const cell = (p: number) => {
    const v = s.points[toWhite(p, c) - 1];
    return (v === 0 ? "." : `${v > 0 ? "w" : "b"}${Math.abs(v)}`).padStart(3);
  };
  const nums = (ps: number[]) => ps.map((p) => String(p).padStart(3)).join(" ");
  const cells = (ps: number[]) => ps.map(cell).join(" ");
  const top = [13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24];
  const bottom = [12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1];
  const split = (row: string) => row.slice(0, 23) + " |" + row.slice(23);
  const dice = s.dice.length ? `кубики ${s.roll ? s.roll.join("-") : ""}, лишилось: ${s.dice.join(", ")}` : "кубики не кинуто";
  return [
    `Пункти з боку ${GENITIVE[c]} (w — білі, b — чорні); ${dice}`,
    split(nums(top)),
    split(cells(top)),
    "",
    split(cells(bottom)),
    split(nums(bottom)),
    `Знято: білі ${s.off[0]}, чорні ${s.off[1]}`,
  ].join("\n");
}
