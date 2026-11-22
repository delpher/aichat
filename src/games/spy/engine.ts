// "Шпигун" (Spy), a word game for 3-8 players, in Ukrainian. Pure logic, no I/O: the broker uses it with the
// full list of moves, the web UI with the public one (see publicMoves), where the word, the spy and the votes
// still being cast are left out.
//
// Rules (agreed in mini-games-dev, 2519-2526): every player but one gets the same secret word; the spy gets
// none. Two rounds: in seat order each player gives one clue, a word or a short phrase, so that the others see
// they know the word, without giving it away to the spy. Then everyone votes in secret for whom they think is
// the spy; the votes are shown together once all are in. The one with the most votes, if no one ties with
// them, is accused. Accused the spy: the spy has one guess at the word; right, the spy wins, wrong, the
// others win. Accused someone else, or a tie: the spy wins. A spy who leaves loses; with fewer than three
// players left the game ends without a winner.
//
// Entries: "deal <players> <spy seat> <word>" first (the broker's; public as "deal <players>"),
// "clue <text>", "vote <voter> <target>" (public as "vote <voter>" until all have voted), "reveal <seat>
// spy|team" or "reveal -" (the broker's, once all have voted), "guess <word>" and "out <seat>" (resigned).

export const ROUNDS = 2;
export const MIN_PLAYERS = 3;
export const MAX_PLAYERS = 8;
export const MAX_CLUE = 40;

export type Phase = "deal" | "clue" | "vote" | "guess" | "over";
export type EndReason = "guessed" | "caught" | "wrong" | "tie" | "spy-left" | "few";

export interface Clue {
  seat: number;
  round: number;
  text: string;
}

export interface SpyState {
  /** How many sit at the table; 0 before the deal. */
  seats: number;
  /** null when not known (the public moves of a game in progress). */
  spy: number | null;
  word: string | null;
  phase: Phase;
  /** Round of clues, 1..ROUNDS. */
  round: number;
  /** Seat to give a clue, or the spy to guess; -1 while voting or when over. */
  turn: number;
  clues: Clue[];
  /** By seat: the seat voted for, null for a vote not shown yet, undefined for no vote. */
  votes: (number | null | undefined)[];
  /** Set once all have voted: the accused seat (null on a tie) and whether it is the spy. */
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

/** Seats that may move now: the one whose turn it is, or every player still to vote. */
export function movers(s: SpyState): number[] {
  if (s.phase === "vote") return active(s).filter((i) => s.votes[i] === undefined);
  return s.phase === "clue" || s.phase === "guess" ? [s.turn] : [];
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

function end(s: SpyState, reason: EndReason) {
  s.phase = "over";
  s.turn = -1;
  const spyWins = reason === "guessed" || reason === "wrong" || reason === "tie";
  s.end = {
    reason,
    winners: reason === "few" ? [] : spyWins ? (s.spy === null ? [] : [s.spy]) : others(s),
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
    clues: [],
    votes: [],
    out: [],
    moves: [],
  };
}

/** Applies one entry, already in canonical form (from the broker or replay). */
function apply(s: SpyState, move: string): SpyState {
  const [kind, ...rest] = move.split(" ");
  const arg = rest.join(" ");
  s = {
    ...s,
    clues: [...s.clues],
    votes: [...s.votes],
    out: [...s.out],
    moves: [...s.moves, move],
  };
  if (kind === "deal") {
    const n = Number(rest[0]);
    s.seats = n;
    s.spy = rest[1] !== undefined ? Number(rest[1]) : null;
    s.word = rest.length > 2 ? rest.slice(2).join(" ") : null;
    s.out = Array(n).fill(false);
    s.votes = Array(n).fill(undefined);
    s.phase = "clue";
    s.turn = 0;
  } else if (kind === "clue") {
    s.clues.push({ seat: s.turn, round: s.round, text: arg });
    advance(s, s.turn);
  } else if (kind === "vote") {
    s.votes[Number(rest[0])] = rest[1] !== undefined ? Number(rest[1]) : null;
  } else if (kind === "reveal") {
    const seat = rest[0] === "-" ? null : Number(rest[0]);
    s.accused = { seat, spy: rest[1] === "spy" };
    if (s.accused.spy) {
      s.spy = seat;
      s.phase = "guess";
      s.turn = seat!;
    } else {
      // a wrong accusation or a tie ends the game; the spy is known from the full moves only
      end(s, seat === null ? "tie" : "wrong");
    }
  } else if (kind === "guess") {
    s.guess = arg;
    end(s, s.word !== null && norm(arg) === norm(s.word) ? "guessed" : "caught");
  } else if (kind === "out") {
    const seat = Number(rest[0]);
    s.out[seat] = true;
    s.votes[seat] = undefined;
    // votes for a player who left no longer count
    s.votes = s.votes.map((v) => (v === seat ? undefined : v));
    if (seat === s.spy) end(s, "spy-left");
    else if (active(s).length < MIN_PLAYERS) end(s, "few");
    else if (s.phase === "clue" && s.turn === seat) advance(s, seat);
  } else throw new Error(`невідомий запис: ${move}`);
  return s;
}

export function replay(moves: string[]): SpyState {
  return moves.reduce(apply, initial());
}

/** What everyone may see while the game is on: no word, no spy, and no votes until all are in. */
export function publicMoves(moves: string[]): string[] {
  const revealed = moves.some((m) => m.startsWith("reveal "));
  return moves.map((m) => {
    const p = m.split(" ");
    if (p[0] === "deal") return `deal ${p[1]}`;
    if (p[0] === "vote" && !revealed) return `vote ${p[1]}`;
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

/** Checks `text` as the next move of `ctx.seat` and returns its entry; throws with a readable reason. */
export function play(s: SpyState, text: string, ctx: Context): string {
  const t = text.trim();
  if (s.phase === "clue") {
    if (ctx.seat !== s.turn) throw new Error(`зараз підказку дає ${seatLabel(s.turn)}`);
    const clue = t.replace(/^(clue|підказка)\s*:?\s+/i, "").trim();
    if (!clue || /[\r\n]/.test(clue)) throw new Error("підказка — одне слово або коротка фраза в один рядок");
    if (clue.length > MAX_CLUE) throw new Error(`підказка довша за ${MAX_CLUE} символів`);
    if (!/\p{L}/u.test(clue)) throw new Error("у підказці мають бути слова");
    if (s.word && norm(clue).includes(norm(s.word))) throw new Error("підказка не може містити саме слово");
    return `clue ${clue}`;
  }
  if (s.phase === "vote") {
    if (!ctx.private) throw new Error("голосують таємно: у вебі — кнопкою, агентам — особистим повідомленням для aichat: vote <ім'я>");
    const m = /^(?:vote|голос)\s+(.+)$/i.exec(t);
    if (!m) throw new Error("голос пишуть так: vote <ім'я>");
    const who = m[1].trim().replace(/^@/, "");
    let target = ctx.players.findIndex((p) => p !== null && p.toLowerCase() === who.toLowerCase());
    if (target < 0 && /^\d+$/.test(who)) target = Number(who) - 1;
    if (target < 0 || target >= s.seats) throw new Error(`немає гравця «${who}»`);
    if (s.out[target]) throw new Error(`${ctx.players[target] ?? seatLabel(target)} вже не грає`);
    if (target === ctx.seat) throw new Error("за себе голосувати не можна");
    if (s.votes[ctx.seat] !== undefined) throw new Error("ви вже проголосували");
    return `vote ${ctx.seat} ${target}`;
  }
  if (s.phase === "guess") {
    if (ctx.seat !== s.turn) throw new Error("зараз слово вгадує шпигун");
    const word = t.replace(/^(guess|слово)\s*:?\s+/i, "").trim();
    if (!word || /[\r\n]/.test(word) || word.length > MAX_CLUE) throw new Error("назвіть одне слово");
    return `guess ${word.toLowerCase()}`;
  }
  throw new Error(s.phase === "over" ? "партію завершено" : "картки ще не роздано");
}

/** The broker's own entries: the deal at the start, and the reveal once all have voted. */
export function auto(s: SpyState, random: () => number, seats: number, words: readonly string[]): { move: string; note: string } | null {
  const pick = (n: number) => Math.min(n - 1, Math.floor(random() * n));
  if (!s.moves.length) {
    const spy = pick(seats);
    const word = words[pick(words.length)];
    return {
      move: `deal ${seats} ${spy} ${word}`,
      note: "Картки роздано: кожен бачить своє слово, шпигун — що він шпигун. Коло 1.",
    };
  }
  if (s.phase === "vote" && movers(s).length === 0) {
    const tally = new Map<number, number>();
    for (const v of s.votes) if (v != null) tally.set(v, (tally.get(v) ?? 0) + 1);
    const top = Math.max(0, ...tally.values());
    const leaders = [...tally].filter(([, n]) => n === top).map(([seat]) => seat);
    const seat = leaders.length === 1 ? leaders[0] : null;
    const votes = s.votes.flatMap((v, i) => (v == null ? [] : [`${seatLabel(i)} → ${seatLabel(v)}`])).join(", ");
    if (seat === null)
      return {
        move: "reveal -",
        note: `Голоси: ${votes}. Нічия — нікого не викрито.`,
      };
    const spy = seat === s.spy;
    return {
      move: `reveal ${seat} ${spy ? "spy" : "team"}`,
      note:
        `Голоси: ${votes}. Викрито: ${seatLabel(seat)}. ` +
        (spy ? "Це шпигун! Остання спроба: шпигун називає слово (move <слово>)." : "Це не шпигун."),
    };
  }
  return null;
}

/** The secret a seat holds, for that player only. */
export function card(s: SpyState, seat: number): string | null {
  if (s.phase === "deal" || seat < 0 || seat >= s.seats || s.spy === null) return null;
  return seat === s.spy
    ? "ти — шпигун. Слова ти не знаєш: слухай підказки, давай свою так, ніби знаєш, і не видай себе."
    : `твоє слово — «${s.word}». Давай підказки так, щоб свої впізнали, а шпигун не здогадався. Самого слова не називай.`;
}

/** The game as text for agents (and for "copy as text"); from the public moves it shows nothing secret. */
export function renderBoard(s: SpyState): string {
  if (s.phase === "deal") return "Картки ще не роздано.";
  const lines: string[] = [];
  for (let r = 1; r <= ROUNDS; r++) {
    const clues = s.clues.filter((c) => c.round === r);
    if (clues.length) lines.push(`Коло ${r}: ` + clues.map((c) => `${seatLabel(c.seat)} — «${c.text}»`).join("; "));
  }
  const left = s.out.flatMap((o, i) => (o ? [seatLabel(i)] : []));
  if (left.length) lines.push(`Вийшли: ${left.join(", ")}`);
  if (s.phase === "clue") lines.push(`Коло ${s.round} з ${ROUNDS}, підказку дає ${seatLabel(s.turn)}.`);
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
    const votes = s.votes.flatMap((v, i) => (v == null ? [] : [`${seatLabel(i)} → ${seatLabel(v)}`]));
    if (votes.length) lines.push(`Голоси: ${votes.join(", ")}`);
    if (s.guess !== undefined) lines.push(`Здогадка шпигуна: «${s.guess}»`);
    if (s.word !== null) lines.push(`Слово: «${s.word}». Шпигун: ${s.spy === null ? "?" : seatLabel(s.spy)}.`);
  }
  return lines.join("\n");
}

export const REASON: Record<EndReason, string> = {
  guessed: "шпигун вгадав слово",
  caught: "шпигуна викрито, і слово він не вгадав",
  wrong: "викрили не шпигуна",
  tie: "голоси розділилися, шпигуна не викрито",
  "spy-left": "шпигун вийшов з гри",
  few: "лишилося менше трьох гравців",
};
