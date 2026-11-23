// "Шпигун" (Spy), a word game for 3-8 players, in Ukrainian. Pure logic, no I/O: the broker uses it with the
// full list of moves, the web UI with the public one (see publicMoves), where the word, the spy and the votes
// still being cast are left out.
//
// Rules (agreed in mini-games-dev, 2519-2526; balance from the board game's rules, alexey 2819-2827; questions
// and answers, 2830-2835): every player but one gets the same secret word; the spy gets none. Then the players
// talk, so that the others see they know the word, without giving it away to the spy:
// - Questions and answers (games from 0.19.0): the first seat (the broker seats the players at random) asks
//   anyone a question, or passes the turn to ask to another player; either costs one of their TRIES. The one
//   asked answers and asks next, anyone but the one who just asked them. Passing goes only to a player with
//   tries left; one who has none (after answering) passes for free. Once nobody has tries left, the vote.
// - Clues (games before 0.19.0): two rounds; in seat order each player gives one clue, a word or a short phrase.
// - While the players talk, any player may once per game accuse another: the rest vote in secret, yes or no
//   (the accuser counts as yes). Everyone but the suspect for it: the game ends; the suspect is the spy, the
//   others win, an innocent one, the spy wins. Otherwise the talk goes on where it was.
// - While the players talk, the spy may stop the game and name the word (privately): right, the spy wins,
//   wrong, the others win. Not during a vote, and not once caught.
// - After the two rounds everyone votes in secret for whom they think is the spy. Only a unanimous vote (all
//   but the suspect) accuses: the spy, the others win; an innocent one, or no unanimous vote, the spy wins.
// A spy who leaves loses; with fewer than three players left the game ends without a winner.
//
// Entries: "deal qa <players> <spy seat> <word>" first (the broker's; public as "deal qa <players>"; without
// "qa" a game of clues), "ask <seat> <question>", "answer <text>", "pass <seat>", "clue <text>", "accuse <by> <suspect>", "ballot <voter> yes|no" (public as "ballot <voter>" until the
// verdict), "vote <voter> <target>" (public as "vote <voter>" until the verdict), "verdict <seat> spy|team" or
// "verdict -" (the broker's, once all have voted), "stop <spy seat> <word>" (the spy's guess) and "out <seat>"
// (resigned). Games from before 0.18.2 also have "reveal <seat> spy|team", "reveal -" and "guess <word>": the
// final vote then went by most votes, and an accused spy had a guess.

export const ROUNDS = 2;
export const MIN_PLAYERS = 3;
export const MAX_PLAYERS = 8;
export const MAX_CLUE = 40;
/** Questions and passes each player may make. */
export const TRIES = 2;
export const MAX_TEXT = 200;

export type Mode = "clue" | "qa";
export type Phase = "deal" | "clue" | "ask" | "answer" | "accuse" | "vote" | "guess" | "over";
export type EndReason = "guessed" | "missed" | "caught" | "wrong" | "tie" | "spy-left" | "few";

export interface Clue {
  seat: number;
  round: number;
  text: string;
}

/** A question asked, or the turn to ask passed on. */
export interface Exchange {
  by: number;
  to: number;
  /** undefined for a pass. */
  question?: string;
  /** undefined while awaited, null when the one asked left without answering. */
  answer?: string | null;
  /** A pass by a player with no tries left, which cost nothing. */
  free?: boolean;
}

export interface Accusation {
  by: number;
  suspect: number;
  /** By seat: yes/no, null for a ballot not shown yet, undefined for none. The accuser's is yes. */
  ballots: (boolean | null | undefined)[];
  /** Once all have voted: "spy" or "team" for a unanimous accusation, "-" when it failed. */
  verdict?: "spy" | "team" | "-";
}

export interface SpyState {
  /** How many sit at the table; 0 before the deal. */
  seats: number;
  /** null when not known (the public moves of a game in progress). */
  spy: number | null;
  word: string | null;
  /** Questions and answers, or clues (games before 0.19.0). */
  mode: Mode;
  phase: Phase;
  /** Round of clues, 1..ROUNDS. */
  round: number;
  /**
   * Seat to give a clue, to ask (or pass) or to answer (also while an accusation is voted on), or the spy to
   * guess; -1 while voting or when over.
   */
  turn: number;
  clues: Clue[];
  /** Questions and passes, in order. */
  qa: Exchange[];
  /** By seat: questions and passes left. */
  tries: number[];
  /** The seat the one to ask may not ask (the one who just asked them), or -1. */
  noAsk: number;
  /** Accusations made, the one being voted on last. */
  accusations: Accusation[];
  /** By seat: the seat voted for in the final vote, null for a vote not shown yet, undefined for no vote. */
  votes: (number | null | undefined)[];
  /** Set by the final vote: the accused seat (null when no one was) and whether it is the spy. */
  accused?: { seat: number | null; spy: boolean };
  guess?: string;
  out: boolean[];
  end?: { reason: EndReason; winners: number[] };
  moves: string[];
}

export const seatLabel = (seat: number) => `гравець ${seat + 1}`;

/** For comparing words: case, ґ/г, apostrophes and spaces do not matter. */
export const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/ґ/g, "г")
    .replace(/[’ʼ`‘]/g, "'")
    .replace(/\s+/g, " ")
    .trim();

const active = (s: SpyState) => [...Array(s.seats).keys()].filter((i) => !s.out[i]);

/** The accusation being voted on, if any. */
export const pending = (s: SpyState): Accusation | undefined => (s.phase === "accuse" ? s.accusations.at(-1) : undefined);

/** Whether `seat` has made its one accusation. */
export const hasAccused = (s: SpyState, seat: number) => s.accusations.some((a) => a.by === seat);

/** Whether the players are talking (clues, or questions and answers): when one may accuse, and the spy guess. */
export const talking = (s: SpyState) => s.phase === "clue" || s.phase === "ask" || s.phase === "answer";

/** Players still playing with questions or passes left. */
export const withTries = (s: SpyState) => active(s).filter((i) => s.tries[i] > 0);

/** Seats that may move now: the one whose turn it is, or every player still to vote. */
export function movers(s: SpyState): number[] {
  if (s.phase === "vote") return active(s).filter((i) => s.votes[i] === undefined);
  const a = pending(s);
  if (a) return active(s).filter((i) => i !== a.suspect && a.ballots[i] === undefined);
  return talking(s) || s.phase === "guess" ? [s.turn] : [];
}

/** Verbs of the moves a player may make out of turn while the players talk. */
const ACCUSE = /^(?:accuse|звинувачую)\s+(.+)$/i;
const GUESS = /^(?:guess|вгадую)\s+(.+)$/i;
const ASK = /^(?:ask|питаю|питання)\s+@?([^\s:,]+)[:,]?\s+(.+)$/is;
const PASS = /^(?:pass|передаю)\s+(.+)$/i;

/** Whether `seat` may make `text` out of turn now: an accusation or the spy's guess, while the players talk. */
export function anytime(s: SpyState, seat: number, text: string): boolean {
  const t = text.trim();
  return talking(s) && seat >= 0 && seat < s.seats && !s.out[seat] && (ACCUSE.test(t) || GUESS.test(t));
}

/** The next seat still playing after `seat`, and whether that wrapped round to the start. */
function next(s: SpyState, seat: number): { seat: number; wrapped: boolean } {
  for (let k = 1; k <= s.seats; k++) {
    const i = (seat + k) % s.seats;
    if (!s.out[i]) return { seat: i, wrapped: i <= seat };
  }
  return { seat, wrapped: true };
}

/** Moves on from `seat`'s clue (or from a seat that left on its turn): the next seat, a new round, or the vote. */
function advance(s: SpyState, seat: number) {
  const n = next(s, seat);
  if (n.wrapped) s.round++;
  if (s.round > ROUNDS) {
    s.phase = "vote";
    s.turn = -1;
    s.round = ROUNDS;
  } else s.turn = n.seat;
}

const others = (s: SpyState) => active(s).filter((i) => i !== s.spy);

const SPY_WINS: EndReason[] = ["guessed", "wrong", "tie"];

function end(s: SpyState, reason: EndReason) {
  s.phase = "over";
  s.turn = -1;
  s.end = {
    reason,
    winners: reason === "few" ? [] : SPY_WINS.includes(reason) ? (s.spy === null ? [] : [s.spy]) : others(s),
  };
}

export function initial(): SpyState {
  return {
    seats: 0,
    spy: null,
    word: null,
    phase: "deal",
    round: 1,
    turn: -1,
    mode: "clue",
    clues: [],
    qa: [],
    tries: [],
    noAsk: -1,
    accusations: [],
    votes: [],
    out: [],
    moves: [],
  };
}

const toVote = (s: SpyState) => {
  s.phase = "vote";
  s.turn = -1;
};

/** The question still to be answered, if any. */
export const openQuestion = (s: SpyState) => {
  const q = s.qa.at(-1);
  return q && q.question !== undefined && q.answer === undefined ? q : undefined;
};

/**
 * Questions and answers: makes sure the one to move still plays and that someone has tries left. When the one
 * asked has left, the question goes unanswered and the asker gets the try back; when the one to ask has left,
 * the next one with tries asks; when nobody has tries left, the vote.
 */
function settle(s: SpyState) {
  if (s.phase === "answer" && s.out[s.turn]) {
    const q = openQuestion(s)!;
    q.answer = null;
    s.tries[q.by]++;
    s.phase = "ask";
    s.turn = q.by;
    s.noAsk = -1;
  }
  if (s.phase !== "ask") return;
  const left = withTries(s);
  if (!left.length) return toVote(s);
  if (s.out[s.turn]) {
    s.turn = left.find((i) => i > s.turn) ?? left[0];
    s.noAsk = -1;
  }
}

/** Back to the talk after a failed accusation (or one whose suspect left). */
function resume(s: SpyState) {
  if (s.mode === "qa") {
    s.phase = openQuestion(s) ? "answer" : "ask";
    settle(s);
    return;
  }
  s.phase = "clue";
  if (s.out[s.turn]) advance(s, s.turn);
}

/** Applies one entry, already in canonical form (from the broker or replay). */
function apply(s: SpyState, move: string): SpyState {
  const [kind, ...rest] = move.split(" ");
  const arg = rest.join(" ");
  s = {
    ...s,
    clues: [...s.clues],
    qa: s.qa.map((q) => ({ ...q })),
    tries: [...s.tries],
    accusations: s.accusations.map((a) => ({ ...a, ballots: [...a.ballots] })),
    votes: [...s.votes],
    out: [...s.out],
    moves: [...s.moves, move],
  };
  const a = pending(s);
  if (kind === "deal") {
    const qa = rest[0] === "qa";
    const p = qa ? rest.slice(1) : rest;
    const n = Number(p[0]);
    s.mode = qa ? "qa" : "clue";
    s.seats = n;
    s.spy = p[1] !== undefined ? Number(p[1]) : null;
    s.word = p.length > 2 ? p.slice(2).join(" ") : null;
    s.out = Array(n).fill(false);
    s.votes = Array(n).fill(undefined);
    s.tries = Array(n).fill(qa ? TRIES : 0);
    s.phase = qa ? "ask" : "clue";
    s.turn = 0;
  } else if (kind === "ask") {
    const to = Number(rest[0]);
    s.tries[s.turn] = Math.max(0, s.tries[s.turn] - 1);
    s.qa.push({ by: s.turn, to, question: rest.slice(1).join(" ") });
    s.phase = "answer";
    s.turn = to;
  } else if (kind === "answer") {
    const q = openQuestion(s);
    if (q) {
      q.answer = arg;
      s.noAsk = q.by;
    }
    s.phase = "ask";
    settle(s);
  } else if (kind === "pass") {
    const to = Number(rest[0]);
    const free = !s.tries[s.turn];
    if (!free) s.tries[s.turn]--;
    s.qa.push({ by: s.turn, to, ...(free ? { free } : {}) });
    s.turn = to;
    s.noAsk = -1;
    settle(s);
  } else if (kind === "clue") {
    s.clues.push({ seat: s.turn, round: s.round, text: arg });
    advance(s, s.turn);
  } else if (kind === "accuse") {
    const by = Number(rest[0]);
    const ballots: Accusation["ballots"] = Array(s.seats).fill(undefined);
    ballots[by] = true;
    s.accusations.push({ by, suspect: Number(rest[1]), ballots });
    s.phase = "accuse";
  } else if (kind === "ballot") {
    if (a) a.ballots[Number(rest[0])] = rest[1] === undefined ? null : rest[1] === "yes";
  } else if (kind === "vote") {
    s.votes[Number(rest[0])] = rest[1] !== undefined ? Number(rest[1]) : null;
  } else if (kind === "verdict") {
    const seat = rest[0] === "-" ? null : Number(rest[0]);
    const spy = rest[1] === "spy";
    if (spy) s.spy = seat;
    if (a) {
      a.verdict = seat === null ? "-" : spy ? "spy" : "team";
      if (seat === null) resume(s);
      else end(s, spy ? "caught" : "wrong");
    } else {
      s.accused = { seat, spy };
      end(s, seat === null ? "tie" : spy ? "caught" : "wrong");
    }
  } else if (kind === "stop") {
    s.spy = Number(rest[0]);
    s.guess = rest.slice(1).join(" ");
    end(s, s.word !== null && norm(s.guess) === norm(s.word) ? "guessed" : "missed");
  } else if (kind === "reveal") {
    // before 0.18.2: most votes accused, and an accused spy had a guess
    const seat = rest[0] === "-" ? null : Number(rest[0]);
    s.accused = { seat, spy: rest[1] === "spy" };
    if (s.accused.spy) {
      s.spy = seat;
      s.phase = "guess";
      s.turn = seat!;
    } else end(s, seat === null ? "tie" : "wrong");
  } else if (kind === "guess") {
    s.guess = arg;
    end(s, s.word !== null && norm(arg) === norm(s.word) ? "guessed" : "caught");
  } else if (kind === "out") {
    const seat = Number(rest[0]);
    s.out[seat] = true;
    s.votes[seat] = undefined;
    // votes for a player who left no longer count
    s.votes = s.votes.map((v) => (v === seat ? undefined : v));
    if (a) a.ballots[seat] = undefined;
    if (seat === s.spy) end(s, "spy-left");
    else if (active(s).length < MIN_PLAYERS) end(s, "few");
    else if (a && a.suspect === seat) {
      a.verdict = "-";
      resume(s);
    } else if (s.phase === "clue" && s.turn === seat) advance(s, seat);
    else settle(s);
  } else throw new Error(`невідомий запис: ${move}`);
  return s;
}

export function replay(moves: string[]): SpyState {
  return moves.reduce(apply, initial());
}

/** What everyone may see while the game is on: no word, no spy, and no votes until their verdict. */
export function publicMoves(moves: string[]): string[] {
  const closed = moves.reduce((last, m, i) => (/^(verdict|reveal) /.test(m) ? i : last), -1);
  return moves.map((m, i) => {
    const p = m.split(" ");
    if (p[0] === "deal") return p[1] === "qa" ? `deal qa ${p[2]}` : `deal ${p[1]}`;
    if ((p[0] === "vote" || p[0] === "ballot") && i > closed) return `${p[0]} ${p[1]}`;
    return m;
  });
}

export interface Context {
  /** The seat making the move. */
  seat: number;
  /** Player names by seat, to vote by name. */
  players: (string | null)[];
  /** Whether only the broker sees the text (a direct message or the web), not the game room. */
  private: boolean;
}

/** The seat named by `who` (a player's name, or a number from 1). */
function target(s: SpyState, who: string, ctx: Context): number {
  const name = who.trim().replace(/^@/, "");
  let t = ctx.players.findIndex((p) => p !== null && p.toLowerCase() === name.toLowerCase());
  if (t < 0 && /^\d+$/.test(name)) t = Number(name) - 1;
  if (t < 0 || t >= s.seats) throw new Error(`немає гравця «${name}»`);
  if (s.out[t]) throw new Error(`${ctx.players[t] ?? seatLabel(t)} вже не грає`);
  return t;
}

const SECRET = "голосують таємно: у вебі — кнопкою, агентам — особистим повідомленням для aichat";

/** A question or an answer: one line, with words, and never the word itself (`what`: "питання" or "відповідь"). */
function said(s: SpyState, text: string, ctx: Context, what: string): string {
  const t = text.trim();
  if (!t || /[\r\n]/.test(t)) throw new Error(`${what} — в один рядок`);
  if (t.length > MAX_TEXT) throw new Error(`${what} довша за ${MAX_TEXT} символів`);
  if (!/\p{L}/u.test(t)) throw new Error(`у ${what === "питання" ? "питанні" : "відповіді"} мають бути слова`);
  // only for those who know the word: refusing the spy would tell them the word (opencode-alexey, 2538)
  if (ctx.seat !== s.spy && s.word && norm(t).includes(norm(s.word))) throw new Error(`${what} не може містити саме слово`);
  return t;
}

/** Checks `text` as the next move of `ctx.seat` and returns its entry; throws with a readable reason. */
export function play(s: SpyState, text: string, ctx: Context): string {
  const t = text.trim();
  if (talking(s)) {
    const accuse = ACCUSE.exec(t);
    if (accuse) {
      if (hasAccused(s, ctx.seat)) throw new Error("звинувачувати можна лише раз за гру");
      const suspect = target(s, accuse[1], ctx);
      if (suspect === ctx.seat) throw new Error("себе звинувачувати не можна");
      return `accuse ${ctx.seat} ${suspect}`;
    }
    const guess = GUESS.exec(t);
    if (guess) {
      // the same answer for everyone in the room, so that no one can prove they are not the spy
      if (!ctx.private) throw new Error("слово шпигун називає таємно: у вебі — кнопкою, агенти — особистим повідомленням для aichat: guess <слово>");
      if (ctx.seat !== s.spy) throw new Error("ти не шпигун: слово ти й так знаєш");
      const word = guess[1].trim().toLowerCase();
      if (!word || /[\r\n]/.test(word) || word.length > MAX_CLUE) throw new Error("назвіть одне слово");
      return `stop ${ctx.seat} ${word}`;
    }
  }
  if (s.phase === "ask") {
    if (ctx.seat !== s.turn) throw new Error(`зараз питає ${seatLabel(s.turn)}`);
    const pass = PASS.exec(t);
    if (pass) {
      const to = target(s, pass[1], ctx);
      if (to === ctx.seat) throw new Error("собі передати хід не можна");
      if (!s.tries[to]) throw new Error(`у ${ctx.players[to] ?? seatLabel(to)} спроб не лишилось: передай тому, в кого вони є`);
      return `pass ${to}`;
    }
    if (!s.tries[ctx.seat]) throw new Error("спроб у тебе не лишилось: передай хід тому, в кого вони є: pass <ім'я>");
    const ask = ASK.exec(t);
    if (!ask) throw new Error("питання пишуть так: ask <ім'я> <питання>; або передай хід: pass <ім'я>");
    const to = target(s, ask[1], ctx);
    if (to === ctx.seat) throw new Error("себе питати не можна");
    if (to === s.noAsk) throw new Error(`${ctx.players[to] ?? seatLabel(to)} щойно питав(-ла) тебе: спитай когось іншого`);
    return `ask ${to} ${said(s, ask[2], ctx, "питання")}`;
  }
  if (s.phase === "answer") {
    if (ctx.seat !== s.turn) throw new Error(`зараз відповідає ${seatLabel(s.turn)}`);
    return `answer ${said(s, t.replace(/^(answer|відповідь)\s*:?\s+/i, ""), ctx, "відповідь")}`;
  }
  if (s.phase === "clue") {
    if (ctx.seat !== s.turn) throw new Error(`зараз підказку дає ${seatLabel(s.turn)}`);
    const clue = t.replace(/^(clue|підказка)\s*:?\s+/i, "").trim();
    if (!clue || /[\r\n]/.test(clue)) throw new Error("підказка — одне слово або коротка фраза в один рядок");
    if (clue.length > MAX_CLUE) throw new Error(`підказка довша за ${MAX_CLUE} символів`);
    if (!/\p{L}/u.test(clue)) throw new Error("у підказці мають бути слова");
    // only for those who know the word: refusing the spy would tell them the word (opencode-alexey, 2538)
    if (ctx.seat !== s.spy && s.word && norm(clue).includes(norm(s.word))) throw new Error("підказка не може містити саме слово");
    return `clue ${clue}`;
  }
  const a = pending(s);
  if (a) {
    if (!ctx.private) throw new Error(`${SECRET}: vote так або vote ні`);
    const m = /^(?:vote|голос)\s+(так|ні|yes|no|за|проти)$/i.exec(t);
    if (!m) throw new Error("голос за звинувачення пишуть так: vote так або vote ні");
    if (ctx.seat === a.suspect) throw new Error("підозрюваний не голосує");
    if (a.ballots[ctx.seat] !== undefined) throw new Error("ви вже проголосували");
    return `ballot ${ctx.seat} ${/^(так|yes|за)$/i.test(m[1]) ? "yes" : "no"}`;
  }
  if (s.phase === "vote") {
    if (!ctx.private) throw new Error(`${SECRET}: vote <ім'я>`);
    const m = /^(?:vote|голос)\s+(.+)$/i.exec(t);
    if (!m) throw new Error("голос пишуть так: vote <ім'я>");
    const v = target(s, m[1], ctx);
    if (v === ctx.seat) throw new Error("за себе голосувати не можна");
    if (s.votes[ctx.seat] !== undefined) throw new Error("ви вже проголосували");
    return `vote ${ctx.seat} ${v}`;
  }
  if (s.phase === "guess") {
    if (ctx.seat !== s.turn) throw new Error("зараз слово вгадує шпигун");
    const word = t.replace(/^(guess|слово)\s*:?\s+/i, "").trim();
    if (!word || /[\r\n]/.test(word) || word.length > MAX_CLUE) throw new Error("назвіть одне слово");
    return `guess ${word.toLowerCase()}`;
  }
  throw new Error(s.phase === "over" ? "партію завершено" : "картки ще не роздано");
}

const yesNo = (b: boolean | null | undefined) => (b ? "так" : "ні");

/** "гравець 1 → гравець 3, …" for the final vote. */
const voteList = (s: SpyState) => s.votes.flatMap((v, i) => (v == null ? [] : [`${seatLabel(i)} → ${seatLabel(v)}`])).join(", ");

/** "гравець 1 — так, …" for an accusation. */
const ballotList = (a: Accusation) => a.ballots.flatMap((b, i) => (b == null ? [] : [`${seatLabel(i)} — ${yesNo(b)}`])).join(", ");

/** The broker's own entries: the deal at the start, and the verdict once all have voted. */
export function auto(s: SpyState, random: () => number, seats: number, words: readonly string[]): { move: string; note: string } | null {
  const pick = (n: number) => Math.min(n - 1, Math.floor(random() * n));
  if (!s.moves.length) {
    const spy = pick(seats);
    const word = words[pick(words.length)];
    return {
      move: `deal qa ${seats} ${spy} ${word}`,
      note:
        "Картки роздано: кожен бачить своє слово, шпигун — що він шпигун. Порядок гравців випадковий. " +
        `У кожного ${TRIES} спроби: спитати когось або передати хід. Першим питає ${seatLabel(0)}.`,
    };
  }
  if (movers(s).length) return null;
  const a = pending(s);
  if (a) {
    const voters = active(s).filter((i) => i !== a.suspect);
    const unanimous = voters.every((i) => a.ballots[i] === true);
    const head = `Голоси за звинувачення ${seatLabel(a.suspect)}: ${ballotList(a)}.`;
    if (!unanimous) return { move: "verdict -", note: `${head} Не одностайно — гра триває.` };
    const spy = a.suspect === s.spy;
    return {
      move: `verdict ${a.suspect} ${spy ? "spy" : "team"}`,
      note: `${head} Одностайно! ${seatLabel(a.suspect)} — ${spy ? "шпигун." : "не шпигун."}`,
    };
  }
  if (s.phase === "vote") {
    const voters = active(s);
    const accused = voters.find((t) => voters.every((i) => i === t || s.votes[i] === t));
    const head = `Голоси: ${voteList(s)}.`;
    if (accused === undefined) return { move: "verdict -", note: `${head} Одностайного рішення немає — шпигуна не викрито.` };
    const spy = accused === s.spy;
    return {
      move: `verdict ${accused} ${spy ? "spy" : "team"}`,
      note: `${head} Одностайно викрито: ${seatLabel(accused)} — ${spy ? "шпигун!" : "не шпигун."}`,
    };
  }
  return null;
}

/** The secret a seat holds, for that player only. */
export function card(s: SpyState, seat: number): string | null {
  if (s.phase === "deal" || seat < 0 || seat >= s.seats || s.spy === null) return null;
  const qa = s.mode === "qa";
  return seat === s.spy
    ? (qa
        ? "ти — шпигун. Слова ти не знаєш: слухай питання й відповіді, питай і відповідай так, ніби знаєш, і не видай себе. " +
          "Поки йде розмова, можеш будь-коли зупинити гру й назвати слово (таємно: guess <слово>): вгадав — переміг, ні — програв. "
        : "ти — шпигун. Слова ти не знаєш: слухай підказки, давай свою так, ніби знаєш, і не видай себе. " +
          "Поки йдуть підказки, можеш будь-коли зупинити гру й назвати слово (таємно: guess <слово>): вгадав — переміг, ні — програв. ") +
        "Якщо тебе одностайно викриють, назвати слово вже не вийде."
    : `твоє слово — «${s.word}». ` +
        (qa
          ? "Питай і відповідай так, щоб свої впізнали, а шпигун не здогадався. Самого слова не називай."
          : "Давай підказки так, щоб свої впізнали, а шпигун не здогадався. Самого слова не називай.");
}

/** The game as text for agents (and for "copy as text"); from the public moves it shows nothing secret. */
export function renderBoard(s: SpyState): string {
  if (s.phase === "deal") return "Картки ще не роздано.";
  const lines: string[] = [];
  s.qa.forEach((q, i) => {
    const head = `${i + 1}. ${seatLabel(q.by)}`;
    if (q.question === undefined) lines.push(`${head} передає хід: ${seatLabel(q.to)}${q.free ? " (без спроби)" : ""}`);
    else
      lines.push(
        `${head} питає ${seatLabel(q.to)}: «${q.question}» — ` +
          (q.answer === undefined ? "чекаємо відповіді" : q.answer === null ? "без відповіді (вийшов з гри)" : `«${q.answer}»`),
      );
  });
  for (let r = 1; r <= ROUNDS; r++) {
    const clues = s.clues.filter((c) => c.round === r);
    if (clues.length) lines.push(`Коло ${r}: ` + clues.map((c) => `${seatLabel(c.seat)} — «${c.text}»`).join("; "));
  }
  for (const a of s.accusations) {
    if (!a.verdict) continue;
    const result = a.verdict === "-" ? "не одностайно" : a.verdict === "spy" ? "одностайно, шпигун" : "одностайно, не шпигун";
    lines.push(`Звинувачення: ${seatLabel(a.suspect)} (звинувачує ${seatLabel(a.by)}; ${ballotList(a)}): ${result}`);
  }
  const left = s.out.flatMap((o, i) => (o ? [seatLabel(i)] : []));
  if (left.length) lines.push(`Вийшли: ${left.join(", ")}`);
  if (s.phase === "clue") {
    lines.push(`Коло ${s.round} з ${ROUNDS}, підказку дає ${seatLabel(s.turn)}.`);
    const used = active(s).filter((i) => hasAccused(s, i));
    if (used.length) lines.push(`Уже звинувачували: ${used.map(seatLabel).join(", ")}.`);
  }
  if (s.phase === "ask" || s.phase === "answer") {
    if (s.phase === "ask")
      lines.push(
        s.tries[s.turn]
          ? `Питає ${seatLabel(s.turn)}: ask <ім'я> <питання> або pass <ім'я>` + (s.noAsk >= 0 ? ` (не ${seatLabel(s.noAsk)}).` : ".")
          : `${seatLabel(s.turn)} без спроб: передає хід безкоштовно тому, в кого вони є.`,
      );
    else lines.push(`Відповідає ${seatLabel(s.turn)}.`);
    lines.push(`Спроби: ${active(s).map((i) => `${seatLabel(i)} — ${s.tries[i]}`).join(", ")}.`);
    const used = active(s).filter((i) => hasAccused(s, i));
    if (used.length) lines.push(`Уже звинувачували: ${used.map(seatLabel).join(", ")}.`);
  }
  const a = pending(s);
  if (a) {
    const voters = active(s).filter((i) => i !== a.suspect);
    const done = voters.filter((i) => a.ballots[i] !== undefined);
    lines.push(
      `Звинувачення: ${seatLabel(a.suspect)} (звинувачує ${seatLabel(a.by)}). Таємне голосування, так чи ні: проголосували ${done.length} з ${voters.length}.`,
    );
  }
  if (s.phase === "vote") {
    const done = active(s).filter((i) => s.votes[i] !== undefined);
    lines.push(
      `Таємне голосування: проголосували ${done.length} з ${active(s).length}` +
        (done.length ? ` (${done.map(seatLabel).join(", ")})` : "") +
        ".",
    );
  }
  if (s.accused && s.phase !== "over") lines.push(`Викрито шпигуна: ${seatLabel(s.accused.seat!)}. Остання спроба — назвати слово.`);
  if (s.phase === "over") {
    const votes = voteList(s);
    if (votes) lines.push(`Голоси: ${votes}`);
    if (s.guess !== undefined) lines.push(`Здогадка шпигуна: «${s.guess}»`);
    if (s.word !== null) lines.push(`Слово: «${s.word}». Шпигун: ${s.spy === null ? "?" : seatLabel(s.spy)}.`);
  }
  return lines.join("\n");
}

export const REASON: Record<EndReason, string> = {
  guessed: "шпигун вгадав слово",
  missed: "шпигун назвав не те слово",
  caught: "шпигуна викрито",
  wrong: "одностайно звинуватили не шпигуна",
  tie: "одностайного рішення не було, шпигуна не викрито",
  "spy-left": "шпигун вийшов з гри",
  few: "лишилося менше трьох гравців",
};
