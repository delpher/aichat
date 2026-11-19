// Balda on a 5x5 board, for 2-4 players, in Ukrainian. Pure logic, no I/O: the broker uses it to check
// moves (with the dictionary, see ./index.ts) and the web UI to draw the board (without one).
//
// Rules: a five-letter word stands in the middle row. In turn, a player puts one letter on an empty cell next
// to a letter (left, right, up or down) and reads a word through it: a chain of neighbouring cells, each
// used once, that passes through the new letter. The word must be a noun from the dictionary and must not
// have been played before (the start word counts). It scores one point per letter. A player may pass. The
// game ends when the board is full, when everyone still playing has passed in a row, or when one player is
// left; the highest score wins, and a tie for it is a draw.
//
// Cells use the names of a 5x5 board: files a-e left to right, ranks 1-5 bottom to top; the start word is
// on rank 3. A move is "<cell> <letter> <word>" ("c2 к кіт", the broker finds the chain) or
// "<cell> <letter> <cell> <cell> ..." (the chain itself, e.g. "c2 к c2 c3 d3"); "pass" passes.
// The broker writes two more kinds of entries: "start <players> <word>" first, and "out <seat>" for a
// player who resigns.

export const SIZE = 5;
export const CELLS = SIZE * SIZE;
export const LETTERS = "абвгґдеєжзиіїйклмнопрстуфхцчшщьюя";
export const PASS = "pass";
export const MIN_WORD = 3;

export interface BaldaState {
  /** How many sit at the table; 0 until the start entry. */
  seats: number;
  /** 25 cells, "" when empty; index = rank * 5 + file (a1 = 0, e5 = 24). */
  board: string[];
  /** Seat to move. */
  turn: number;
  scores: number[];
  /** Words played so far, the start word first (seat null). */
  words: { word: string; seat: number | null }[];
  /** Seats that resigned. */
  out: boolean[];
  /** Passes in a row. */
  passes: number;
  moves: string[];
  /** The last word's new cell and chain, for the web to highlight. */
  last: { cell: number; path: number[] } | null;
}

export type EndReason = "full" | "passes" | "last";
export type Outcome = { over: false } | { over: true; winner: number | null; reason: EndReason; scores: number[] };

/** Whether a word is in the dictionary; the web replays moves without one. */
export type IsWord = (word: string) => boolean;

const CELL_RE = /^[a-e][1-5]$/;

export function cell(name: string): number {
  const m = /^([a-e])([1-5])$/.exec(name.trim().toLowerCase());
  if (!m) throw new Error(`немає клітинки «${name}»: стовпчик a-e і рядок 1-5, наприклад c2`);
  return (Number(m[2]) - 1) * SIZE + (m[1].charCodeAt(0) - 97);
}

export function cellName(i: number): string {
  return String.fromCharCode(97 + (i % SIZE)) + String(Math.floor(i / SIZE) + 1);
}

/** The cells left, right, below and above `i`. */
export function neighbours(i: number): number[] {
  const r = Math.floor(i / SIZE), f = i % SIZE;
  const out: number[] = [];
  if (f > 0) out.push(i - 1);
  if (f < SIZE - 1) out.push(i + 1);
  if (r > 0) out.push(i - SIZE);
  if (r < SIZE - 1) out.push(i + SIZE);
  return out;
}

export function newGame(): BaldaState {
  return { seats: 0, board: Array(CELLS).fill(""), turn: 0, scores: [], words: [], out: [], passes: 0, moves: [], last: null };
}

/** Empty cells next to a letter: where a letter may go. */
export function openCells(state: BaldaState): number[] {
  const out: number[] = [];
  for (let i = 0; i < CELLS; i++) if (!state.board[i] && neighbours(i).some((n) => state.board[n])) out.push(i);
  return out;
}

/** A chain of neighbouring filled cells, each once, that spells `word` and passes through `through`. */
export function findPath(board: string[], word: string, through: number): number[] | null {
  const path: number[] = [];
  const used = new Set<number>();
  const walk = (i: number, k: number): boolean => {
    if (board[i] !== word[k] || used.has(i)) return false;
    path.push(i);
    used.add(i);
    if (k === word.length - 1 ? used.has(through) : neighbours(i).some((n) => walk(n, k + 1))) return true;
    path.pop();
    used.delete(i);
    return false;
  };
  for (let i = 0; i < CELLS; i++) if (walk(i, 0)) return [...path];
  return null;
}

const active = (s: BaldaState) => [...Array(s.seats).keys()].filter((i) => !s.out[i]);

/** The next seat after `seat` that is still playing. */
function nextSeat(s: BaldaState, seat: number): number {
  for (let k = 1; k <= s.seats; k++) {
    const i = (seat + k) % s.seats;
    if (!s.out[i]) return i;
  }
  return seat;
}

export function outcome(s: BaldaState): Outcome {
  if (!s.seats) return { over: false };
  const left = active(s);
  let reason: EndReason | null = null;
  if (left.length <= 1) reason = "last";
  else if (s.board.every(Boolean)) reason = "full";
  else if (s.passes >= left.length) reason = "passes";
  if (!reason) return { over: false };
  if (reason === "last") return { over: true, winner: left[0] ?? null, reason, scores: s.scores };
  const best = Math.max(...left.map((i) => s.scores[i]));
  const top = left.filter((i) => s.scores[i] === best);
  return { over: true, winner: top.length === 1 ? top[0] : null, reason, scores: s.scores };
}

function clone(s: BaldaState): BaldaState {
  return { ...s, board: [...s.board], scores: [...s.scores], words: [...s.words], out: [...s.out], moves: [...s.moves] };
}

/** A player's move, checked; returns its canonical notation "c2 к кіт" with the new state. */
function playMove(s: BaldaState, text: string, isWord?: IsWord): BaldaState {
  const tokens = text.trim().toLowerCase().replace(/[,;:—–-]+/g, " ").split(/\s+/).filter(Boolean);
  const usage = "хід пишуть так: <клітинка> <літера> <слово>, наприклад c2 к кіт; або pass";
  if (tokens.length < 3) throw new Error(usage);
  const at = cell(tokens[0]);
  const letter = tokens[1];
  if (letter.length !== 1 || !LETTERS.includes(letter)) throw new Error(`«${tokens[1]}» не літера: потрібна одна українська літера. ${usage}`);
  if (s.board[at]) throw new Error(`клітинка ${cellName(at)} зайнята (${s.board[at]})`);
  if (!neighbours(at).some((n) => s.board[n])) throw new Error(`клітинка ${cellName(at)} не поруч із літерою: ставити можна лише поруч`);
  const board = [...s.board];
  board[at] = letter;
  const rest = tokens.slice(2);
  let path: number[] | null;
  let word: string;
  if (rest.every((t) => CELL_RE.test(t))) {
    path = rest.map(cell);
    if (new Set(path).size !== path.length) throw new Error("у ланцюжку клітинка повторюється");
    if (!path.includes(at)) throw new Error(`ланцюжок має проходити через нову літеру (${cellName(at)})`);
    for (let k = 1; k < path.length; k++)
      if (!neighbours(path[k - 1]).includes(path[k])) throw new Error(`${cellName(path[k - 1])} і ${cellName(path[k])} не сусіди`);
    const empty = path.find((i) => !board[i]);
    if (empty !== undefined) throw new Error(`клітинка ${cellName(empty)} порожня`);
    word = path.map((i) => board[i]).join("");
  } else if (rest.length === 1) {
    word = rest[0];
    path = findPath(board, word, at);
    if (!path) throw new Error(`слово «${word}» не складається ланцюжком сусідніх клітинок через ${cellName(at)}`);
  } else throw new Error(usage);
  if (word.length < MIN_WORD) throw new Error(`слово має бути щонайменше з ${MIN_WORD} літер`);
  if (isWord && !isWord(word)) throw new Error(`слова «${word}» немає в словнику (потрібен іменник у називному відмінку)`);
  if (s.words.some((w) => w.word === word)) throw new Error(`слово «${word}» уже було`);
  const next = clone(s);
  next.board = board;
  next.scores[s.turn] += word.length;
  next.words.push({ word, seat: s.turn });
  next.passes = 0;
  next.last = { cell: at, path };
  next.turn = nextSeat(s, s.turn);
  next.moves.push(`${cellName(at)} ${letter} ${word}`);
  return next;
}

/**
 * Applies one entry of the game record: the broker's "start" and "out", a player's "pass" or move.
 * With `isWord` a move's word must be in the dictionary; replays of checked games leave it out.
 */
export function apply(s: BaldaState, entry: string, isWord?: IsWord): BaldaState {
  const t = entry.trim();
  const start = /^start ([2-9]) (\S+)$/.exec(t);
  if (start) {
    if (s.seats) throw new Error("the game has started already");
    const word = start[2];
    if (word.length !== SIZE) throw new Error(`the start word must have ${SIZE} letters`);
    const n = Number(start[1]);
    const next: BaldaState = { ...newGame(), seats: n, scores: Array(n).fill(0), out: Array(n).fill(false), words: [{ word, seat: null }] };
    for (let f = 0; f < SIZE; f++) next.board[2 * SIZE + f] = word[f];
    next.moves = [t];
    return next;
  }
  if (!s.seats) throw new Error("гра ще не почалася");
  const out = /^out (\d)$/.exec(t);
  if (out) {
    const seat = Number(out[1]);
    if (seat >= s.seats || s.out[seat]) throw new Error("цей гравець уже вибув");
    const next = clone(s);
    next.out[seat] = true;
    if (next.turn === seat) next.turn = nextSeat(next, seat);
    next.moves.push(t);
    return next;
  }
  if (outcome(s).over) throw new Error("гру завершено");
  if (t.toLowerCase() === PASS) {
    const next = clone(s);
    next.passes++;
    next.last = null;
    next.turn = nextSeat(s, s.turn);
    next.moves.push(PASS);
    return next;
  }
  return playMove(s, t, isWord);
}

/** A player's entry (a move or "pass"): the broker's own entries are refused here. */
export function play(s: BaldaState, text: string, isWord?: IsWord): BaldaState {
  if (/^\s*(start|out)\b/i.test(text)) throw new Error("хід пишуть так: <клітинка> <літера> <слово>, наприклад c2 к кіт; або pass");
  return apply(s, text, isWord);
}

export function replay(moves: string[]): BaldaState {
  return moves.reduce((s, m) => apply(s, m), newGame());
}

export const seatLabel = (seat: number) => `гравець ${seat + 1}`;

/** Text board for agents: letters, "." for empty cells, then scores and the words played. */
export function renderBoard(s: BaldaState): string {
  const rows = [`  ${[...Array(SIZE).keys()].map((f) => String.fromCharCode(97 + f)).join(" ")}`];
  for (let r = SIZE - 1; r >= 0; r--) rows.push(`${r + 1} ${s.board.slice(r * SIZE, r * SIZE + SIZE).map((c) => c || ".").join(" ")}`);
  if (s.seats) {
    rows.push("Очки: " + s.scores.map((p, i) => `${seatLabel(i)} — ${p}${s.out[i] ? " (вибув)" : ""}`).join(", "));
    rows.push("Слова: " + s.words.map((w) => (w.seat === null ? `${w.word} (старт)` : `${w.word} (${w.seat + 1})`)).join(", "));
  }
  return rows.join("\n");
}

/** What the player to move may do, since the moves are too many to list. */
export function movesHint(s: BaldaState): string {
  const open = openCells(s).map(cellName);
  return (
    `Вільні клітинки поруч із літерами: ${open.join(", ") || "немає"}. ` +
    "Хід: move <клітинка> <літера> <слово>, наприклад move c2 к кіт (слово — іменник у називному відмінку, що проходить через нову літеру); або move pass."
  );
}
