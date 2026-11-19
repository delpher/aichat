// Reversi on an 8x8 board. Pure logic, no I/O: the broker uses it to check moves and the web UI to
// highlight them.
//
// Rules: black moves first from the usual start (white d4 and e5, black d5 and e4). A move puts a disc on
// an empty square so that it closes at least one straight line (across, down or diagonal) of the other
// colour's discs with a disc of one's own; every such line is turned over. A side with no such move passes
// (the broker writes "pass" for it). The game ends when neither side can move; more discs wins, equal is a
// draw.
//
// Squares use algebraic names: files a-h left to right, ranks 1-8 bottom to top. A move is a square ("d3").

export type Color = "b" | "w";
/** One cell: "." empty, "b" black disc, "w" white disc. */
export type Cell = "." | Color;

export interface ReversiState {
  /** 64 cells, index = rank * 8 + file (a1 = 0, h8 = 63). */
  board: Cell[];
  turn: Color;
  /** Moves played so far: squares, and "pass" for a side that could not move. */
  moves: string[];
}

export type Outcome = { over: false } | { over: true; winner: Color | null; black: number; white: number };

export const PASS = "pass";
export const GENITIVE: Record<Color, string> = { b: "чорних", w: "білих" };

const DIRS: Array<[number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

export const opponent = (c: Color): Color => (c === "b" ? "w" : "b");

export function square(name: string): number {
  const m = /^([a-h])([1-8])$/.exec(name.trim().toLowerCase());
  if (!m) throw new Error(`bad square "${name}": write a file a-h and a rank 1-8, e.g. d3`);
  return (Number(m[2]) - 1) * 8 + (m[1].charCodeAt(0) - 97);
}

export function squareName(i: number): string {
  return String.fromCharCode(97 + (i % 8)) + String(Math.floor(i / 8) + 1);
}

export function newGame(): ReversiState {
  const board: Cell[] = Array(64).fill(".");
  board[square("d4")] = "w";
  board[square("e5")] = "w";
  board[square("d5")] = "b";
  board[square("e4")] = "b";
  return { board, turn: "b", moves: [] };
}

/** The discs a disc of `color` on empty square `i` would turn over; empty when that is no move. */
export function flips(board: Cell[], i: number, color: Color): number[] {
  if (board[i] !== ".") return [];
  const out: number[] = [];
  const r0 = Math.floor(i / 8), f0 = i % 8;
  for (const [dr, df] of DIRS) {
    const line: number[] = [];
    for (let r = r0 + dr, f = f0 + df; r >= 0 && r < 8 && f >= 0 && f < 8; r += dr, f += df) {
      const c = board[r * 8 + f];
      if (c === ".") break;
      if (c === color) {
        out.push(...line);
        break;
      }
      line.push(r * 8 + f);
    }
  }
  return out;
}

/** Squares the side to move may play, in board order (a1, b1, ... h8). */
export function legalSquares(state: ReversiState, color: Color = state.turn): number[] {
  const out: number[] = [];
  for (let i = 0; i < 64; i++) if (flips(state.board, i, color).length) out.push(i);
  return out;
}

export function counts(state: ReversiState): { black: number; white: number } {
  let black = 0, white = 0;
  for (const c of state.board) {
    if (c === "b") black++;
    else if (c === "w") white++;
  }
  return { black, white };
}

export function outcome(state: ReversiState): Outcome {
  if (legalSquares(state, "b").length || legalSquares(state, "w").length) return { over: false };
  const { black, white } = counts(state);
  return { over: true, winner: black === white ? null : black > white ? "b" : "w", black, white };
}

/** Plays `text` ("d3", or "pass" when there is no move) and returns the new state; the input is not changed. */
export function play(state: ReversiState, text: string): ReversiState {
  const t = text.trim().toLowerCase();
  const legal = legalSquares(state);
  if (outcome(state).over) throw new Error("the game is over");
  if (t === PASS) {
    if (legal.length) throw new Error(`you have moves, so you cannot pass: ${legal.map(squareName).join(", ")}`);
    return { board: state.board, turn: opponent(state.turn), moves: [...state.moves, PASS] };
  }
  const i = square(t);
  const turned = flips(state.board, i, state.turn);
  if (!turned.length) {
    const why = state.board[i] !== "." ? `${t} is taken` : `${t} turns over no disc`;
    throw new Error(`illegal move: ${why}; legal moves: ${legal.map(squareName).join(", ") || "none"}`);
  }
  const board = [...state.board];
  board[i] = state.turn;
  for (const s of turned) board[s] = state.turn;
  return { board, turn: opponent(state.turn), moves: [...state.moves, squareName(i)] };
}

export function replay(moves: string[]): ReversiState {
  return moves.reduce(play, newGame());
}

/** The pass the broker writes for a side that cannot move while the game goes on, or null. */
export function auto(state: ReversiState): { move: string; note: string } | null {
  if (outcome(state).over || legalSquares(state).length) return null;
  return { move: PASS, note: `У ${GENITIVE[state.turn]} немає ходів: хід переходить до ${GENITIVE[opponent(state.turn)]}.` };
}

/** Text board for agents: "b" black, "w" white, "*" where the side to move may play, "." empty. */
export function renderBoard(state: ReversiState): string {
  const legal = new Set(outcome(state).over ? [] : legalSquares(state));
  const rows: string[] = [];
  for (let r = 7; r >= 0; r--) {
    const cells = [];
    for (let f = 0; f < 8; f++) {
      const i = r * 8 + f;
      cells.push(state.board[i] !== "." ? state.board[i] : legal.has(i) ? "*" : ".");
    }
    rows.push(`${r + 1} ${cells.join(" ")}`);
  }
  rows.push("  a b c d e f g h");
  const { black, white } = counts(state);
  rows.push(`Фішок: чорні ${black}, білі ${white}`);
  return rows.join("\n");
}
