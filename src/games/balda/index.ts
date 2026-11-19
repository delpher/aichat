// Balda as a game module for the broker; the rules are in ./engine.ts (shared with the web), the dictionary
// in ./words-uk.txt (from VESUM, under its own licence: see ./WORDS-LICENSE.md).
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { GameDefinition } from "../game.js";
import * as engine from "./engine.js";

/**
 * Where the dictionary is: next to this module once built (the build copies it into dist/), or in src/ when
 * running from a checkout (tests).
 */
const PLACES = ["./words-uk.txt", "../../../src/games/balda/words-uk.txt"].map((p) => fileURLToPath(new URL(p, import.meta.url)));

let words: Set<string> | undefined;
/** The dictionary, read on first use. */
export function dictionary(): Set<string> {
  if (!words) {
    const file = PLACES.find((p) => existsSync(p));
    if (!file) throw new Error("the Balda dictionary (words-uk.txt) is missing");
    words = new Set(readFileSync(file, "utf8").split("\n").filter(Boolean));
  }
  return words;
}
const isWord = (w: string) => dictionary().has(w);

/** Familiar five-letter nouns to start with; those not in the dictionary are left out. */
const START_WORDS = (
  "балка банка батон бджола берег бочка булка вагон вишня візок вікно вітер ворон гвинт голка гора гроза груша " +
  "дошка дріт дятел жабка завод замок зерно кабан казка калина камін канат каша квота кефір книга " +
  "колос комар корзина кошик краса кріль кулак лампа лимон лисиця лоток мавпа магніт марка маска метро " +
  "молот мотор музей наука нитка носик олень орган ослик осока палац панда парус пенал пилка плита пляма " +
  "поїзд порох посуд птаха пташка ранок ракета решта рибка ручка садок салат сарай свиня сироп скеля слива сокіл " +
  "стіна сумка табір танок тарілка тигр тісто трава труба туман фарба ферма халат хвіст хмара цибуля чашка шапка шафа " +
  "шкіра школа штора юшка ягода якір яблуко"
)
  .split(" ")
  .filter((w) => w.length === engine.SIZE);

const startWords = () => {
  const ok = START_WORDS.filter(isWord);
  if (!ok.length) throw new Error("no Balda start word is in the dictionary");
  return ok;
};

const SEATS = [1, 2, 3, 4].map((n) => ({ id: `p${n}`, name: engine.seatLabel(n - 1) }));

const REASON: Record<engine.EndReason, string> = {
  full: "поле заповнено",
  passes: "усі пропустили хід поспіль",
  last: "інші гравці вибули",
};

export const balda: GameDefinition = {
  id: "balda",
  title: "Балда",
  description: "Слова на полі 5×5: додайте літеру й прочитайте через неї іменник. Від 2 до 4 гравців, українською.",
  seats: SEATS,
  minSeats: 2,
  play(moves, text) {
    const s = engine.play(engine.replay(moves), text, isWord);
    return s.moves[s.moves.length - 1];
  },
  turn: (moves) => engine.replay(moves).turn,
  // too many to list: movesHint says what may be played
  legalMoves: () => [],
  movesHint: (moves) => engine.movesHint(engine.replay(moves)),
  outcome(moves) {
    const o = engine.outcome(engine.replay(moves));
    // the scores travel in the reason, so the result can say them
    return o.over ? { winner: o.winner, reason: `${o.reason}:${o.scores.join(":")}` } : null;
  },
  board: (moves) => engine.renderBoard(engine.replay(moves)),
  auto(moves, random, seats) {
    if (moves.length) return null;
    const pool = startWords();
    const word = pool[Math.floor(random() * pool.length) % pool.length];
    return { move: `start ${seats} ${word}`, note: `Стартове слово: ${word}. Гравців: ${seats}.` };
  },
  dropOut(moves, seat) {
    const s = engine.replay(moves);
    if (s.out[seat]) throw new Error("you are out of this game already");
    return `out ${seat}`;
  },
  turnLabel: (seat) => `Хід: ${engine.seatLabel(seat)}`,
  reasonText(o) {
    const [kind, ...scores] = o.reason.split(":");
    const why = REASON[kind as engine.EndReason] ?? kind;
    return scores.length ? `${why}; очки: ${scores.join(" : ")}` : why;
  },
};
