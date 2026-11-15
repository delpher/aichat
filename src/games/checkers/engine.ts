// Checkers (Russian/Ukrainian rules) on an 8x8 board. Pure logic, no I/O:
// the broker uses it to validate moves and the web UI to highlight them.
//
// Rules: white moves first; men step diagonally forward and capture both ways;
// capturing is mandatory and a capture continues while it can (any sequence may
// be chosen, not necessarily the longest); captured pieces leave the board only
// when the move ends and cannot be jumped twice; a man that reaches the last rank
// becomes a king, even mid-capture, and keeps capturing as a king; kings fly
// (move and capture along a diagonal at any distance). A side with no legal move
// loses. Draw: by agreement, threefold repetition, or 30 plies in a row with no
// capture and no man move.
//
// Squares use algebraic names: files a-h left to right from white's side, ranks
// 1-8 bottom to top; a1 is a dark square. Moves are written "c3-d4" for a step
// and "c3:e5:g3" for a capture listing every landing square.

export type Color = "w" | "b";
/** One cell: "." empty, "w"/"b" man, "W"/"B" king. */
export type Cell = "." | "w" | "b" | "W" | "B";

export interface CheckersState {
  /** 64 cells, index = rank * 8 + file (a1 = 0, h8 = 63). */
  board: Cell[];
  turn: Color;
  /** Plies since the last capture or man move (for the draw rule). */
  quiet: number;
  /** Position keys seen so far, for threefold repetition. */
  seen: Record<string, number>;
  /** Moves played so far in notation. */
  moves: string[];
}

export interface Move {
  /** Squares the piece stands on: start, then every landing. */
  path: number[];
  /** Squares of captured pieces, in capture order. */
  captures: number[];
  notation: string;
}

export type Outcome =
  | { over: false }
  | { over: true; winner: Color | null; reason: "no-moves" | "repetition" | "quiet" | "resign" | "agreement" };

export const DRAW_QUIET_PLIES = 30;

const DIRS: Array<[number, number]> = [[1, 1], [1, -1], [-1, 1], [-1, -1]];

export function square(name: string): number {
  const m = /^([a-h])([1-8])$/.exec(name.trim().toLowerCase());
  if (!m) throw new Error(`bad square "${name}"`);
  return (Number(m[2]) - 1) * 8 + (m[1].charCodeAt(0) - 97);
}

export function squareName(i: number): string {
  return String.fromCharCode(97 + (i % 8)) + String(Math.floor(i / 8) + 1);
}

export function isDark(i: number): boolean {
  return (Math.floor(i / 8) + (i % 8)) % 2 === 0;
}

export function colorOf(c: Cell): Color | null {
  return c === "." ? null : (c.toLowerCase() as Color);
}

export function isKing(c: Cell): boolean {
  return c === "W" || c === "B";
}

export function opponent(c: Color): Color {
  return c === "w" ? "b" : "w";
}

export function newGame(): CheckersState {
  const board: Cell[] = Array(64).fill(".");
  for (let i = 0; i < 64; i++) {
    if (!isDark(i)) continue;
    const rank = Math.floor(i / 8);
    if (rank <= 2) board[i] = "w";
    else if (rank >= 5) board[i] = "b";
  }
  const state: CheckersState = { board, turn: "w", quiet: 0, seen: {}, moves: [] };
  state.seen[positionKey(state)] = 1;
  return state;
}

function positionKey(s: Pick<CheckersState, "board" | "turn">): string {
  return s.turn + s.board.join("");
}

function at(file: number, rank: number): number | null {
  return file >= 0 && file < 8 && rank >= 0 && rank < 8 ? rank * 8 + file : null;
}

function promotes(cell: Cell, i: number): boolean {
  const rank = Math.floor(i / 8);
  return (cell === "w" && rank === 7) || (cell === "b" && rank === 0);
}

function crown(cell: Cell): Cell {
  return cell.toUpperCase() as Cell;
}

/** Every capture sequence for the piece on `from`, each run to its end. */
function captureSequences(board: Cell[], from: number): Move[] {
  const piece = board[from];
  const me = colorOf(piece)!;
  const out: Move[] = [];

  const walk = (pos: number, cell: Cell, path: number[], captured: number[]) => {
    let extended = false;
    const f0 = pos % 8, r0 = Math.floor(pos / 8);
    for (const [df, dr] of DIRS) {
      let f = f0 + df, r = r0 + dr;
      if (isKing(cell)) {
        // Slide over empty squares up to the first piece.
        while (at(f, r) !== null && board[at(f, r)!] === "." ) { f += df; r += dr; }
      }
      const victim = at(f, r);
      if (victim === null) continue;
      const vc = board[victim];
      if (colorOf(vc) !== opponent(me) || captured.includes(victim)) continue;
      // Landing squares beyond the victim.
      const landings: number[] = [];
      let lf = f + df, lr = r + dr;
      while (at(lf, lr) !== null && (board[at(lf, lr)!] === "." || at(lf, lr) === from)) {
        landings.push(at(lf, lr)!);
        if (!isKing(cell)) break;
        lf += df; lr += dr;
      }
      for (const land of landings) {
        extended = true;
        const next = promotes(cell, land) ? crown(cell) : cell;
        walk(land, next, [...path, land], [...captured, victim]);
      }
    }
    if (!extended && captured.length > 0) {
      out.push({ path, captures: captured, notation: path.map(squareName).join(":") });
    }
  };

  // The moving piece leaves its square, so it never blocks its own path.
  const saved = board[from];
  board[from] = ".";
  try {
    walk(from, saved, [from], []);
  } finally {
    board[from] = saved;
  }
  return out;
}

function quietMoves(board: Cell[], from: number): Move[] {
  const cell = board[from];
  const f0 = from % 8, r0 = Math.floor(from / 8);
  const forward = cell === "w" ? 1 : -1;
  const out: Move[] = [];
  for (const [df, dr] of DIRS) {
    if (!isKing(cell) && dr !== forward) continue;
    let f = f0 + df, r = r0 + dr;
    while (at(f, r) !== null && board[at(f, r)!] === ".") {
      const to = at(f, r)!;
      out.push({ path: [from, to], captures: [], notation: `${squareName(from)}-${squareName(to)}` });
      if (!isKing(cell)) break;
      f += df; r += dr;
    }
  }
  return out;
}

/** All legal moves for the side to move. Captures, when any exist, are the only legal moves. */
export function legalMoves(state: CheckersState): Move[] {
  const board = [...state.board];
  const mine = board.map((c, i) => (colorOf(c) === state.turn ? i : -1)).filter((i) => i >= 0);
  const captures = mine.flatMap((i) => captureSequences(board, i));
  if (captures.length > 0) return dedupe(captures);
  return mine.flatMap((i) => quietMoves(board, i));
}

function dedupe(moves: Move[]): Move[] {
  const seen = new Set<string>();
  return moves.filter((m) => (seen.has(m.notation) ? false : (seen.add(m.notation), true)));
}

/**
 * Finds the legal move a player meant. Accepts "c3-d4", "c3:e5:g3", "c3xe5",
 * "C3 D4", and a capture given only by start and end ("c3:g3") when that is unambiguous.
 */
export function parseMove(state: CheckersState, text: string): Move {
  const squares = text.toLowerCase().match(/[a-h][1-8]/g);
  if (!squares || squares.length < 2) throw new Error(`can't read a move in "${text}"; write it like c3-d4 or c3:e5:g3`);
  const path = squares.map(square);
  const legal = legalMoves(state);
  const exact = legal.filter((m) => m.path.length === path.length && m.path.every((s, i) => s === path[i]));
  if (exact.length === 1) return exact[0];
  if (path.length === 2) {
    const ends = legal.filter((m) => m.path[0] === path[0] && m.path[m.path.length - 1] === path[1]);
    if (ends.length === 1) return ends[0];
    if (ends.length > 1) throw new Error(`${text} is ambiguous; give every landing square: ${ends.map((m) => m.notation).join(", ")}`);
  }
  throw new Error(`illegal move ${text}; legal moves: ${legal.map((m) => m.notation).join(", ") || "none"}`);
}

/** Plays a legal move and returns the new state (the input is not modified). */
export function applyMove(state: CheckersState, move: Move): CheckersState {
  const board = [...state.board];
  const from = move.path[0], to = move.path[move.path.length - 1];
  let cell = board[from];
  const wasMan = !isKing(cell);
  board[from] = ".";
  for (const sq of move.path.slice(1)) if (promotes(cell, sq)) cell = crown(cell);
  for (const c of move.captures) board[c] = ".";
  board[to] = cell;
  const next: CheckersState = {
    board,
    turn: opponent(state.turn),
    quiet: move.captures.length > 0 || wasMan ? 0 : state.quiet + 1,
    seen: { ...state.seen },
    moves: [...state.moves, move.notation],
  };
  const key = positionKey(next);
  next.seen[key] = (next.seen[key] ?? 0) + 1;
  return next;
}

/** Parses and plays a move in one step; throws with a readable reason when it is illegal. */
export function play(state: CheckersState, text: string): CheckersState {
  return applyMove(state, parseMove(state, text));
}

/** Replays a list of moves from the start position. */
export function replay(moves: string[]): CheckersState {
  return moves.reduce(play, newGame());
}

export function outcome(state: CheckersState): Outcome {
  if (legalMoves(state).length === 0) return { over: true, winner: opponent(state.turn), reason: "no-moves" };
  if ((state.seen[positionKey(state)] ?? 0) >= 3) return { over: true, winner: null, reason: "repetition" };
  if (state.quiet >= DRAW_QUIET_PLIES) return { over: true, winner: null, reason: "quiet" };
  return { over: false };
}

/** Text board for agents: white at the bottom, "w"/"b" men, "W"/"B" kings. */
export function renderBoard(state: CheckersState): string {
  const rows: string[] = [];
  for (let r = 7; r >= 0; r--) {
    const cells = [];
    for (let f = 0; f < 8; f++) {
      const i = r * 8 + f;
      cells.push(state.board[i] === "." ? (isDark(i) ? "." : " ") : state.board[i]);
    }
    rows.push(`${r + 1} ${cells.join(" ")}`);
  }
  rows.push("  a b c d e f g h");
  return rows.join("\n");
}
