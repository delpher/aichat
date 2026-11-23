import { test } from "node:test";
import assert from "node:assert/strict";
import * as engine from "../games/spy/engine.js";
import { WORDS } from "../games/spy/words.js";
import { dictionary } from "../games/balda/index.js";
import type { ChatMessage, GameInfo } from "../protocol.js";
import { connect, startBroker, tok } from "./helpers.js";

const ctx = (seat: number, priv = false): engine.Context => ({
  seat,
  players: ["ann", "bob", "cat", "dan"],
  private: priv,
});
const run = (moves: string[]) => engine.replay(moves);
/** Plays `texts` in turn, each by the seat to move. */
function clues(moves: string[], texts: string[]): string[] {
  for (const t of texts) moves = [...moves, engine.play(run(moves), t, ctx(run(moves).turn))];
  return moves;
}
const DEAL = "deal 4 1 стілець";
const allClues = () => clues([DEAL], ["дерево", "сидять", "чотири ноги", "кухня", "спинка", "меблі", "м'який", "стоїть"]);

test("spy: the words are common nouns, all in the Balda dictionary, none twice", () => {
  assert.ok(WORDS.length >= 250, `${WORDS.length} words`);
  assert.equal(new Set(WORDS).size, WORDS.length);
  const dict = dictionary();
  assert.deepEqual(
    WORDS.filter((w) => !dict.has(w)),
    [],
  );
});

test("spy: two rounds of clues in seat order, then a secret vote", () => {
  let moves = clues([DEAL], ["дерево", "сидять", "чотири ноги"]);
  let s = run(moves);
  assert.deepEqual([s.phase, s.round, s.turn], ["clue", 1, 3]);
  moves = allClues();
  s = run(moves);
  assert.equal(s.phase, "vote");
  assert.deepEqual(engine.movers(s), [0, 1, 2, 3]);
  assert.deepEqual(
    s.clues.map((c) => [c.seat, c.round]),
    [
      [0, 1],
      [1, 1],
      [2, 1],
      [3, 1],
      [0, 2],
      [1, 2],
      [2, 2],
      [3, 2],
    ],
  );
  assert.match(engine.renderBoard(s), /^Коло 1: гравець 1 — «дерево»; гравець 2 — «сидять»/);
});

test("spy: clues are short, one line, and never the word itself", () => {
  const s = run([DEAL]);
  const no = (t: string, re: RegExp) => assert.throws(() => engine.play(s, t, ctx(0)), re);
  no("мій СТІЛЕЦЬ", /не може містити саме слово/);
  no("а".repeat(41), /довша за 40/);
  no("раз\nдва", /в один рядок/);
  no("123", /мають бути слова/);
  assert.throws(() => engine.play(s, "дерево", ctx(1)), /підказку дає гравець 1/);
  assert.equal(engine.play(s, "підказка: дерево", ctx(0)), "clue дерево");
  // the spy is never refused for the word: that would tell them the word
  const spyTurn = run([DEAL, "clue дерево"]);
  assert.equal(engine.play(spyTurn, "стілець", ctx(1)), "clue стілець");
});

test("spy: votes are secret, by name or number, once, not for yourself, and not in the room", () => {
  const s = run(allClues());
  assert.throws(() => engine.play(s, "vote bob", ctx(0)), /голосують таємно/);
  assert.equal(engine.play(s, "vote Bob", ctx(0, true)), "vote 0 1");
  assert.equal(engine.play(s, "голос 2", ctx(0, true)), "vote 0 1");
  assert.throws(() => engine.play(s, "vote ann", ctx(0, true)), /за себе/);
  assert.throws(() => engine.play(s, "vote zed", ctx(0, true)), /немає гравця/);
  assert.throws(() => engine.play(s, "bob", ctx(0, true)), /vote <ім'я>/);
  const voted = run([...allClues(), "vote 0 1"]);
  assert.throws(() => engine.play(voted, "vote cat", ctx(0, true)), /вже проголосували/);
  assert.deepEqual(engine.movers(voted), [1, 2, 3]);
  // the public moves hide the word, the spy and the votes until all are in
  const pub = engine.publicMoves([...allClues(), "vote 0 1"]);
  assert.equal(pub[0], "deal 4");
  assert.equal(pub.at(-1), "vote 0");
  const p = run(pub);
  assert.deepEqual([p.spy, p.word, p.votes[0]], [null, null, null]);
  assert.doesNotMatch(engine.renderBoard(p), /стілець|гравець 2 →/);
});

const vote = (moves: string[], targets: number[]) => [...moves, ...targets.map((t, v) => `vote ${v} ${t}`)];
const reveal = (moves: string[]) => {
  const a = engine.auto(run(moves), () => 0, 4, WORDS)!;
  return { moves: [...moves, a.move], note: a.note };
};

test("spy: the final vote accuses only when unanimous; then no guess", () => {
  // all but the suspect: the spy is caught and loses at once
  const caught = reveal(vote(allClues(), [1, 2, 1, 1]));
  assert.equal(caught.moves.at(-1), "verdict 1 spy");
  assert.match(caught.note, /Одностайно викрито: гравець 2 — шпигун!/);
  assert.deepEqual(run(caught.moves).end, { reason: "caught", winners: [0, 2, 3] });
  // unanimous for an innocent one: the spy wins
  const wrong = reveal(vote(allClues(), [2, 2, 1, 2]));
  assert.equal(wrong.moves.at(-1), "verdict 2 team");
  assert.deepEqual(run(wrong.moves).end, { reason: "wrong", winners: [1] });
  // most votes but not all: no one is accused, the spy wins
  const most = reveal(vote(allClues(), [1, 2, 1, 2]));
  assert.equal(most.moves.at(-1), "verdict -");
  assert.match(most.note, /Одностайного рішення немає/);
  assert.deepEqual(run(most.moves).end, { reason: "tie", winners: [1] });
  assert.match(engine.renderBoard(run(most.moves)), /Слово: «стілець»\. Шпигун: гравець 2\./);
  // the votes stay hidden until the verdict
  const pub = engine.publicMoves(vote(allClues(), [1, 2, 1, 1]));
  assert.equal(pub.at(-1), "vote 3");
  assert.equal(engine.publicMoves(caught.moves).at(-2), "vote 3 1");
});

test("spy: the spy may stop the game and name the word, privately, only while clues are given", () => {
  const s = run(clues([DEAL], ["дерево"]));
  // out of turn is fine; in the room it is refused the same way for everyone
  assert.equal(engine.anytime(s, 1, "guess стіл"), true, "also on their own turn");
  assert.equal(engine.anytime(s, 3, "guess стіл"), true);
  assert.equal(engine.anytime(s, 3, "просто слово"), false);
  assert.throws(() => engine.play(s, "guess стіл", ctx(1)), /таємно/);
  assert.throws(() => engine.play(s, "guess стіл", ctx(0)), /таємно/);
  assert.throws(() => engine.play(s, "guess стіл", ctx(0, true)), /ти не шпигун/);
  assert.equal(engine.play(s, "вгадую СТІЛЕЦЬ", ctx(1, true)), "stop 1 стілець");
  assert.deepEqual(run([...s.moves, "stop 1 стілець"]).end, { reason: "guessed", winners: [1] });
  assert.deepEqual(run([...s.moves, "stop 1 стіл"]).end, { reason: "missed", winners: [0, 2, 3] });
  assert.match(engine.card(s, 1)!, /guess <слово>/);
  // not while voting
  const voting = run(allClues());
  assert.equal(engine.anytime(voting, 1, "guess стіл"), false);
  assert.throws(() => engine.play(voting, "guess стіл", ctx(1, true)), /vote <ім'я>/);
});

test("spy: anyone may accuse once; a unanimous yes ends the game, otherwise the clues go on", () => {
  const s = run(clues([DEAL], ["дерево"]));
  assert.equal(engine.anytime(s, 3, "accuse ann"), true);
  assert.equal(engine.play(s, "accuse ann", ctx(3)), "accuse 3 0");
  assert.equal(engine.play(s, "звинувачую 2", ctx(0)), "accuse 0 1");
  assert.throws(() => engine.play(s, "accuse dan", ctx(3)), /себе/);
  // ann (seat 0) accuses bob, the spy: the others vote, the accuser counts as yes
  let moves = [...s.moves, "accuse 0 1"];
  let a = run(moves);
  assert.equal(a.phase, "accuse");
  assert.deepEqual(engine.movers(a), [2, 3]);
  assert.equal(engine.anytime(a, 1, "guess стіл"), false, "no guess once accused");
  assert.throws(() => engine.play(a, "vote так", ctx(2)), /таємно/);
  assert.throws(() => engine.play(a, "vote так", ctx(1, true)), /не голосує|вже/);
  assert.equal(engine.play(a, "vote так", ctx(2, true)), "ballot 2 yes");
  assert.equal(engine.play(a, "голос ні", ctx(3, true)), "ballot 3 no");
  // unanimous: the spy is caught
  const yes = reveal([...moves, "ballot 2 yes", "ballot 3 yes"]);
  assert.equal(yes.moves.at(-1), "verdict 1 spy");
  assert.deepEqual(run(yes.moves).end, { reason: "caught", winners: [0, 2, 3] });
  // one no: the clues go on from where they were, and ann may not accuse again
  const no = reveal([...moves, "ballot 2 yes", "ballot 3 no"]);
  assert.equal(no.moves.at(-1), "verdict -");
  assert.match(no.note, /гравець 3 — так, гравець 4 — ні\. Не одностайно — гра триває/);
  a = run(no.moves);
  assert.deepEqual([a.phase, a.turn, a.round], ["clue", 1, 1]);
  assert.throws(() => engine.play(a, "accuse cat", ctx(0)), /лише раз/);
  assert.match(engine.renderBoard(a), /Звинувачення: гравець 2 \(звинувачує гравець 1; .*\): не одностайно/);
  assert.match(engine.renderBoard(a), /Уже звинувачували: гравець 1/);
  // ballots stay hidden until the verdict
  assert.equal(engine.publicMoves([...moves, "ballot 2 yes"]).at(-1), "ballot 2");
  assert.equal(engine.publicMoves(no.moves).at(-2), "ballot 3 no");
  // unanimous against an innocent one: the spy wins
  moves = [...s.moves, "accuse 1 2", "ballot 0 yes", "ballot 3 yes"];
  const wrong = reveal(moves);
  assert.equal(wrong.moves.at(-1), "verdict 2 team");
  assert.deepEqual(run(wrong.moves).end, { reason: "wrong", winners: [1] });
  // the suspect leaves: the accusation is dropped
  a = run([...s.moves, "accuse 0 3", "out 3"]);
  assert.deepEqual([a.phase, a.turn], ["clue", 1]);
  // a voter leaves: unanimity counts those still playing (5 players, so 4 stay)
  const five = clues(["deal 5 1 стілець"], ["дерево"]);
  a = run([...five, "accuse 0 1", "ballot 2 yes", "ballot 3 yes", "out 4"]);
  assert.deepEqual(engine.movers(a), []);
  assert.equal(reveal(a.moves).moves.at(-1), "verdict 1 spy");
});

test("spy: games from before 0.18.2 replay as they were played", () => {
  const old = [...vote(allClues(), [1, 2, 3, 1]), "reveal 1 spy"];
  let s = run(old);
  assert.deepEqual([s.phase, s.turn], ["guess", 1]);
  assert.deepEqual(run([...old, "guess стілець"]).end, { reason: "guessed", winners: [1] });
  assert.deepEqual(run([...old, "guess стіл"]).end, { reason: "caught", winners: [0, 2, 3] });
  s = run([...vote(allClues(), [1, 2, 3, 0]), "reveal -"]);
  assert.deepEqual(s.end, { reason: "tie", winners: [1] });
});

test("spy: leaving: the spy loses, fewer than three ends it, a turn passes on, votes for the one who left go", () => {
  assert.deepEqual(run([DEAL, "out 1"]).end, {
    reason: "spy-left",
    winners: [0, 2, 3],
  });
  let s = run([DEAL, "out 0"]);
  assert.deepEqual([s.phase, s.turn], ["clue", 1]);
  s = run([DEAL, "out 0", "out 2"]);
  assert.deepEqual(s.end, { reason: "few", winners: [] });
  // the last of round 2 leaves on their turn: on to the vote
  s = run([...clues([DEAL], ["a", "b", "c", "d", "e", "f", "g"]), "out 3"]);
  assert.equal(s.phase, "vote");
  s = run([...allClues(), "vote 0 2", "vote 1 0", "out 2"]);
  assert.deepEqual(engine.movers(s), [0, 3], "ann voted for the one who left: she votes again");
});

const QA = "deal qa 4 1 стілець";
/** Plays `texts` in turn, each by the seat to move, from a game of questions and answers. */
const talk = (moves: string[], texts: string[]) => clues(moves, texts);

test("spy Q&A: the one asked answers and asks next, not back; asking and passing cost a try; then the vote", () => {
  let s = run([QA]);
  assert.deepEqual([s.mode, s.phase, s.turn, s.tries], ["qa", "ask", 0, [2, 2, 2, 2]]);
  const no = (st: engine.SpyState, t: string, seat: number, re: RegExp) => assert.throws(() => engine.play(st, t, ctx(seat)), re);
  no(s, "ask cat де він?", 1, /зараз питає гравець 1/);
  no(s, "ask ann де він?", 0, /себе/);
  no(s, "ask cat", 0, /ask <ім'я> <питання>/);
  no(s, "де він?", 0, /ask <ім'я> <питання>/);
  no(s, "ask cat де стілець?", 0, /не може містити саме слово/);
  no(s, "ask cat де він?\nа?", 0, /ask <ім'я>|один рядок/);
  no(s, "ask zed де він?", 0, /немає гравця/);
  no(s, "pass ann", 0, /собі/);
  assert.equal(engine.play(s, "ask @Cat: де він стоїть?", ctx(0)), "ask 2 де він стоїть?");
  assert.equal(engine.play(s, "питаю 3 де він стоїть?", ctx(0)), "ask 2 де він стоїть?");
  assert.equal(engine.play(s, "передаю dan", ctx(0)), "pass 3");

  let moves = [QA, "ask 2 де він стоїть?"];
  s = run(moves);
  assert.deepEqual([s.phase, s.turn, s.tries[0]], ["answer", 2, 1]);
  assert.deepEqual(engine.movers(s), [2]);
  no(s, "на кухні", 0, /зараз відповідає гравець 3/);
  no(s, "мій стілець", 2, /не може містити саме слово/);
  assert.equal(engine.play(s, "відповідь: на кухні", ctx(2)), "answer на кухні");
  moves = [...moves, "answer на кухні"];
  s = run(moves);
  assert.deepEqual([s.phase, s.turn, s.noAsk, s.tries[2]], ["ask", 2, 0, 2], "answering costs nothing");
  no(s, "ask ann а ти?", 2, /щойно питав\(-ла\) тебе/);
  // a pass costs a try and lifts the "not back"
  moves = [...moves, "pass 3"];
  s = run(moves);
  assert.deepEqual([s.phase, s.turn, s.noAsk, s.tries], ["ask", 3, -1, [1, 2, 1, 2]]);
  moves = talk(moves, ["ask ann який він?", "дерев'яний", "ask bob а твій?", "м'який", "pass cat", "ask dan скільки їх?", "чотири"]);
  s = run(moves);
  assert.deepEqual([s.turn, s.tries], [3, [0, 1, 0, 1]]);
  moves = talk(moves, ["ask bob де купив?", "на ринку"]);
  // the last question is answered before the vote
  moves = talk(moves, ["ask ann а ти?"]);
  s = run(moves);
  assert.deepEqual([s.phase, s.turn, s.tries], ["answer", 0, [0, 0, 0, 0]]);
  moves = talk(moves, ["теж"]);
  s = run(moves);
  assert.equal(s.phase, "vote");
  assert.deepEqual(engine.movers(s), [0, 1, 2, 3]);
  const board = engine.renderBoard(s);
  assert.match(board, /^1\. гравець 1 питає гравець 3: «де він стоїть\?» — «на кухні»\n2\. гравець 3 передає хід: гравець 4\n/);
  assert.match(board, /передає хід: гравець 3$/m);
  assert.equal(reveal(vote(moves, [1, 2, 1, 1])).moves.at(-1), "verdict 1 spy");
});

test("spy Q&A: one with no tries left passes for free, to one who has some", () => {
  const moves = talk([QA], ["ask bob а?", "так", "ask cat б?", "ні", "ask ann в?", "може", "ask dan г?", "ага", "ask cat ґ?", "угу", "ask ann д?", "ой"]);
  const s = run(moves);
  assert.deepEqual([s.phase, s.turn, s.tries], ["ask", 0, [0, 1, 0, 1]]);
  assert.throws(() => engine.play(s, "ask bob ще?", ctx(0)), /спроб у тебе не лишилось/);
  assert.match(engine.renderBoard(s), /гравець 1 без спроб/);
  assert.equal(engine.play(s, "pass bob", ctx(0)), "pass 1");
  const p = run([...moves, "pass 1"]);
  assert.deepEqual([p.turn, p.tries, p.qa.at(-1)!.free], [1, [0, 1, 0, 1], true]);
  assert.throws(() => engine.play(p, "pass ann", ctx(1)), /спроб не лишилось/);
  assert.match(engine.renderBoard(p), /гравець 1 передає хід: гравець 2 \(без спроби\)/);
});

test("spy Q&A: accusations and the spy's guess go on all the talk; a failed vote returns to the open question", () => {
  const moves = [QA, "ask 2 де він?"];
  const s = run(moves);
  assert.equal(engine.anytime(s, 3, "accuse bob"), true);
  assert.equal(engine.anytime(s, 1, "guess стіл"), true);
  assert.equal(engine.play(s, "вгадую стілець", ctx(1, true)), "stop 1 стілець");
  assert.equal(engine.play(s, "accuse bob", ctx(3)), "accuse 3 1");
  const back = run([...moves, "accuse 3 1", "ballot 0 no", "ballot 2 yes", "verdict -"]);
  assert.deepEqual([back.phase, back.turn, back.tries[0]], ["answer", 2, 1], "the same question, no try spent again");
  const asking = run([...moves, "answer там", "accuse 0 3", "ballot 1 no", "ballot 2 no", "verdict -"]);
  assert.deepEqual([asking.phase, asking.turn, asking.noAsk], ["ask", 2, 0]);
});

test("spy Q&A: leaving: the one asked leaves unanswered and the asker asks again; the one to ask leaves, the next asks", () => {
  let s = run([QA, "ask 2 де він?", "out 2"]);
  assert.deepEqual([s.phase, s.turn, s.tries[0], s.qa[0].answer], ["ask", 0, 2, null]);
  assert.match(engine.renderBoard(s), /без відповіді/);
  s = run([QA, "out 0"]);
  assert.deepEqual([s.phase, s.turn], ["ask", 1]);
  // left while an accusation is voted on: back to someone who still plays
  s = run([QA, "ask 2 де він?", "accuse 3 1", "out 2", "ballot 0 no", "verdict -"]);
  assert.deepEqual([s.phase, s.turn], ["ask", 0]);
  // the last one with tries leaves: the vote
  s = run([...talk([QA], ["pass bob", "pass cat", "pass dan", "pass ann", "pass bob", "pass cat", "ask dan а?", "так"]), "out 3"]);
  assert.equal(s.phase, "vote");
});

test("spy Q&A: new games deal it; the card and the public moves say so", () => {
  const d = engine.auto(engine.initial(), () => 0.4, 5, WORDS)!;
  assert.match(d.move, /^deal qa 5 2 /);
  assert.match(d.note, /Першим питає гравець 1/);
  assert.equal(engine.publicMoves([QA])[0], "deal qa 4");
  const p = run(engine.publicMoves([QA]));
  assert.deepEqual([p.mode, p.spy, p.word], ["qa", null, null]);
  assert.match(engine.card(run([QA]), 0)!, /твоє слово — «стілець»\. Питай і відповідай/);
  assert.match(engine.card(run([QA]), 1)!, /слухай питання й відповіді/);
});

type Body = {
  game: GameInfo;
  card: string | null;
  error: string;
  messages: ChatMessage[];
};

test("spy through the broker: cards in private, questions and answers in the room, secret votes by direct message or the site", async () => {
  // random 0.99 three times: the seats stay in order (see shuffleSeats); then 0.4: the spy is seat 1 (bot1)
  const dice = [0.99, 0.99, 0.99];
  const { broker, url, http } = await startBroker(
    [
      { name: "olena", kind: "human" },
      { name: "bot1", kind: "claude" },
      { name: "bot2", kind: "claude" },
      { name: "bot3", kind: "claude" },
      { name: "watcher", kind: "claude" },
    ],
    {},
    { random: () => dice.shift() ?? 0.4 },
  );
  const call = async (who: string, method: string, path: string, body?: unknown) => {
    const r = await fetch(`${http}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${tok(who)}`,
        "content-type": "application/json",
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: r.status, body: (await r.json()) as Body };
  };
  const settle = () => new Promise((r) => setTimeout(r, 100));
  const bots = {
    bot1: await connect(url, "bot1"),
    bot2: await connect(url, "bot2"),
    bot3: await connect(url, "bot3"),
  };
  try {
    const dms: Record<string, string[]> = { bot1: [], bot2: [], bot3: [] };
    for (const [name, c] of Object.entries(bots))
      c.on("message", (m: ChatMessage) => m.from === "aichat" && m.to === name && dms[name].push(m.text));

    const created = await call("olena", "POST", "/api/games", {
      game: "spy",
      players: ["olena", "bot1", "bot2", "bot3"],
    });
    assert.equal(created.status, 201);
    const id = created.body.game.id;
    const room = `game-${id}`;
    await settle();
    const word = WORDS[Math.floor(0.4 * WORDS.length)];

    // cards: agents by direct message, people on the site; nobody else
    assert.match(dms.bot1[0], /ти — шпигун/);
    assert.match(dms.bot2[0], new RegExp(`твоє слово — «${word}»`));
    assert.match(dms.bot2[0], new RegExp(`card ${id}`));
    assert.equal((await call("olena", "GET", `/api/games/${id}/card`)).body.card!.includes(word), true);
    assert.equal((await call("watcher", "GET", `/api/games/${id}/card`)).status, 403);
    const shown = (await call("watcher", "GET", `/api/games/${id}`)).body.game;
    assert.deepEqual(shown.moves, ["deal qa 4"]);
    // asked again
    await bots.bot3.send({ to: "aichat", text: "card" });
    await settle();
    assert.match(dms.bot3.at(-1)!, new RegExp(`«${word}»`));
    // thanks are not answered
    await bots.bot3.send({ to: "aichat", text: "дякую!" });
    await settle();
    assert.equal(dms.bot3.length, 2);

    // questions and answers: on the site or in the room
    const say = async (who: "bot1" | "bot2" | "bot3", text: string) => {
      await bots[who].send({ room, text });
      await settle();
    };
    // out of turn: bot3 accuses bot2; the others vote in secret, not unanimously, so the talk goes on
    await say("bot3", "move accuse bot2");
    let g = (await call("watcher", "GET", `/api/games/${id}`)).body.game;
    assert.equal(g.moves.at(-1), "accuse 3 2");
    assert.deepEqual(g.movers, [0, 1]);
    await bots.bot1.send({ to: "aichat", text: "vote так" });
    await call("olena", "POST", `/api/games/${id}/move`, { move: "vote ні" });
    await settle();
    g = (await call("watcher", "GET", `/api/games/${id}`)).body.game;
    assert.deepEqual(g.moves.slice(-3), ["ballot 1 yes", "ballot 0 no", "verdict -"]);
    assert.equal(g.turn, 0);
    // the spy's guess is refused in the room, the same way as anyone's
    await say("bot1", "move guess щось");
    const site = async (move: string) => assert.equal((await call("olena", "POST", `/api/games/${id}/move`, { move })).body.error ?? "", "");
    await site("ask bot1 де ти його бачив?");
    await say("bot1", "move вдома");
    // not back to the one who just asked
    await say("bot1", "move ask olena а ти?");
    await say("bot1", "move ask bot2 а ти?");
    await say("bot2", "move теж удома");
    await say("bot2", "move pass bot3");
    await say("bot3", "move ask olena який він?");
    await site("звичайний");
    await site("ask bot2 часто бачиш?");
    await say("bot2", "move щодня");
    await say("bot2", "move ask bot1 а ти?");
    await say("bot1", "move буває");
    await say("bot1", "move pass bot3");
    await say("bot3", "move ask bot2 подобається?");
    g = (await call("watcher", "GET", `/api/games/${id}`)).body.game;
    assert.deepEqual(g.movers, [2], "the last question is answered first");
    await say("bot2", "move так");
    g = (await call("watcher", "GET", `/api/games/${id}`)).body.game;
    assert.deepEqual(g.movers, [0, 1, 2, 3]);
    assert.equal(g.moves.filter((m) => /^(ask|pass) /.test(m)).length, 8);

    // a vote in the room is refused there; by direct message or on the site it stays secret
    await say("bot2", "move vote bot1");
    await bots.bot2.send({ to: "aichat", text: "vote bot1" });
    await settle();
    assert.match(dms.bot2.at(-1)!, /Прийнято/);
    await bots.bot3.send({ to: "aichat", text: `move ${id} vote bot1` });
    await call("olena", "POST", `/api/games/${id}/move`, { move: "vote bot1" });
    await settle();
    g = (await call("watcher", "GET", `/api/games/${id}`)).body.game;
    assert.deepEqual(g.movers, [1]);
    assert.deepEqual(g.moves.slice(-3), ["vote 2", "vote 3", "vote 0"]);
    const before = (await call("watcher", "GET", `/api/games/${id}/card`)).status; // still not a player
    assert.equal(before, 403);

    // the last vote reveals all of them; all but bot1 voted for bot1, the spy: caught, no guess
    await bots.bot1.send({ to: "aichat", text: "vote olena" });
    await settle();
    g = (await call("watcher", "GET", `/api/games/${id}`)).body.game;
    assert.equal(g.moves.at(-1), "verdict 1 spy");
    assert.equal(g.status, "finished");
    assert.deepEqual(g.result!.winners, [0, 2, 3]);
    assert.match(g.result!.text, /^Перемога: olena, bot2, bot3\. Шпигуна викрито/);
    assert.equal(g.moves[0], `deal qa 4 1 ${word}`);

    // nothing in the room gave the word or the votes away before the end
    const history: ChatMessage[] = await bots.bot2.history({
      room,
      limit: 200,
    });
    const last = history.findIndex((m: ChatMessage) => m.from === "aichat" && /завершено/.test(m.text));
    const allVoted = history.findIndex((m: ChatMessage) => m.from === "aichat" && /^bot1: проголосував/.test(m.text) && /Голоси:/.test(m.text));
    assert.ok(allVoted > 0 && last >= allVoted);
    for (const m of history.slice(0, last)) assert.doesNotMatch(m.text, new RegExp(word), m.text);
    for (const m of history.slice(0, allVoted)) assert.doesNotMatch(m.text, /гравець \d → /, m.text);
    assert.match(history[allVoted].text, /Голоси: гравець 1 → гравець 2, гравець 2 → гравець 1/);
    assert.ok(history.some((m: ChatMessage) => m.from === "aichat" && /голосують таємно/.test(m.text)));
    assert.ok(history.some((m: ChatMessage) => /bot2: проголосував/.test(m.text)));
    assert.ok(history.some((m: ChatMessage) => /^bot3: звинувачує: гравець 3!/.test(m.text)));
    assert.ok(history.some((m: ChatMessage) => /^bot1: слово шпигун називає таємно/.test(m.text)));
    assert.ok(history.some((m: ChatMessage) => /Не одностайно — гра триває/.test(m.text)));
    assert.ok(history.some((m: ChatMessage) => /^olena: питає гравець 2: «де ти його бачив\?»/.test(m.text)));
    assert.ok(history.some((m: ChatMessage) => /^bot1: відповідає: «вдома»/.test(m.text)));
    assert.ok(history.some((m: ChatMessage) => /^bot2: передає хід: гравець 4/.test(m.text)));
    assert.ok(history.some((m: ChatMessage) => /^bot1: .*щойно питав\(-ла\) тебе/.test(m.text)));
    assert.match(history[last].text, new RegExp(`Слово: «${word}»`));
  } finally {
    for (const c of Object.values(bots)) c.close();
    await broker.close();
  }
});

test("spy seats the players in a random order once the table is full", async () => {
  // random 0: Fisher-Yates swaps seat 2 with 0, then 1 with 0
  const { broker, http } = await startBroker(
    [
      { name: "olena", kind: "human" },
      { name: "bot1", kind: "claude" },
      { name: "bot2", kind: "claude" },
    ],
    {},
    { random: () => 0 },
  );
  const call = async (who: string, path: string, body: unknown) => {
    const r = await fetch(`${http}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${tok(who)}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return (await r.json()) as { game: GameInfo };
  };
  try {
    const open = (await call("olena", "/api/games", { game: "spy", players: ["olena", "bot1", null] })).game;
    assert.equal(open.status, "open");
    assert.deepEqual(open.players, ["olena", "bot1", null]);
    const started = (await call("bot2", `/api/games/${open.id}/join`, {})).game;
    assert.equal(started.status, "active");
    assert.deepEqual(started.players, ["bot1", "bot2", "olena"]);
    // a full table at creation is mixed too
    const full = (await call("olena", "/api/games", { game: "spy", players: ["olena", "bot1", "bot2"] })).game;
    assert.deepEqual(full.players, ["bot1", "bot2", "olena"]);
  } finally {
    await broker.close();
  }
});
