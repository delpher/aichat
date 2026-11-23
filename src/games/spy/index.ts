// "Шпигун" as a game module for the broker; the rules are in ./engine.ts (shared with the web), the words in
// ./words.ts. The first game with hidden information: the word and the spy travel only in each player's card,
// and the votes are cast in secret (see publicMoves, card and movers in ../game.ts).
import type { GameDefinition } from "../game.js";
import * as engine from "./engine.js";
import { WORDS } from "./words.js";

const SEATS = Array.from({ length: engine.MAX_PLAYERS }, (_, i) => ({
  id: `p${i + 1}`,
  name: engine.seatLabel(i),
}));

export const spy: GameDefinition = {
  id: "spy",
  title: "Шпигун",
  description:
    "Усі, крім шпигуна, знають таємне слово. Два кола підказок, потім таємне голосування: хто шпигун? Від 3 до 8 гравців, українською.",
  seats: SEATS,
  minSeats: engine.MIN_PLAYERS,
  // the order of clues is the order of seats: mix it, so the creator is not always first
  shuffleSeats: true,
  play(moves, text, ctx) {
    return engine.play(engine.replay(moves), text, ctx);
  },
  turn(moves) {
    const s = engine.replay(moves);
    return s.phase === "clue" ? s.turn : (engine.movers(s)[0] ?? 0);
  },
  movers: (moves) => engine.movers(engine.replay(moves)),
  // an accusation, or the spy's guess, while clues are given
  anytime: (moves, seat, text) => engine.anytime(engine.replay(moves), seat, text),
  // clues are free text: nothing to list
  legalMoves: () => [],
  movesHint(moves) {
    const s = engine.replay(moves);
    if (s.phase === "clue")
      return (
        "Підказка: move <слово або коротка фраза>. Будь-коли, поки йдуть підказки: move accuse <ім'я> — звинуватити (раз за гру); " +
        "шпигун може таємно назвати слово: guess <слово> (агенти — особисто aichat)."
      );
    if (s.phase === "accuse") return "Голосування за звинувачення таємне: агенти пишуть aichat особисто «vote так» або «vote ні», люди голосують на сайті.";
    if (s.phase === "vote") return "Голосування таємне: агенти пишуть aichat особисто «vote <ім'я>», люди голосують на сайті.";
    if (s.phase === "guess") return "Шпигун називає слово: move <слово>.";
    return "";
  },
  outcome(moves) {
    const s = engine.replay(moves);
    if (!s.end) return null;
    const { winners, reason } = s.end;
    return {
      winner: winners[0] ?? null,
      ...(winners.length > 1 ? { winners } : {}),
      reason,
    };
  },
  board: (moves) => engine.renderBoard(engine.replay(moves)),
  auto: (moves, random, seats) => engine.auto(engine.replay(moves), random, seats, WORDS),
  dropOut(moves, seat) {
    const s = engine.replay(moves);
    if (s.out[seat]) throw new Error("you are out of this game already");
    return `out ${seat}`;
  },
  publicMoves: engine.publicMoves,
  card: (moves, seat) => engine.card(engine.replay(moves), seat),
  privateVerbs: ["vote", "голос", "guess", "вгадую"],
  moveText(move) {
    const [kind, ...rest] = move.split(" ");
    if (kind === "clue") return `«${rest.join(" ")}»`;
    if (kind === "vote" || kind === "ballot") return "проголосував(-ла)";
    if (kind === "accuse") return `звинувачує: ${engine.seatLabel(Number(rest[1]))}! Решта таємно голосує: так чи ні.`;
    if (kind === "stop") return `зупиняє гру: «я шпигун!» — і називає слово «${rest.slice(1).join(" ")}»`;
    if (kind === "guess") return `називає слово: «${rest.join(" ")}»`;
    return move;
  },
  turnLabel(seat) {
    return `Хід: ${engine.seatLabel(seat)}`;
  },
  reasonText: (o) => engine.REASON[o.reason as engine.EndReason] ?? o.reason,
};
