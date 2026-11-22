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

test("spy: the accused spy gets one guess; a wrong accusation or a tie lets the spy win", () => {
  // caught, then guesses right (case and ґ/г do not matter) or wrong
  const caught = reveal(vote(allClues(), [1, 2, 1, 1]));
  assert.equal(caught.moves.at(-1), "reveal 1 spy");
  assert.match(caught.note, /Викрито: гравець 2\. Це шпигун!/);
  let s = run(caught.moves);
  assert.deepEqual([s.phase, s.turn], ["guess", 1]);
  assert.throws(() => engine.play(s, "стіл", ctx(0)), /вгадує шпигун/);
  assert.deepEqual(run([...caught.moves, engine.play(s, "СТІЛЕЦЬ", ctx(1))]).end, { reason: "guessed", winners: [1] });
  assert.deepEqual(run([...caught.moves, "guess стіл"]).end, {
    reason: "caught",
    winners: [0, 2, 3],
  });
  // the wrong one
  const wrong = reveal(vote(allClues(), [2, 2, 1, 2]));
  assert.equal(wrong.moves.at(-1), "reveal 2 team");
  assert.deepEqual(run(wrong.moves).end, { reason: "wrong", winners: [1] });
  // a tie
  const tie = reveal(vote(allClues(), [1, 2, 3, 0]));
  assert.equal(tie.moves.at(-1), "reveal -");
  assert.deepEqual(run(tie.moves).end, { reason: "tie", winners: [1] });
  assert.match(engine.renderBoard(run(tie.moves)), /Слово: «стілець»\. Шпигун: гравець 2\./);
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

type Body = {
  game: GameInfo;
  card: string | null;
  error: string;
  messages: ChatMessage[];
};

test("spy through the broker: cards in private, clues in the room, secret votes by direct message or the site", async () => {
  // random 0.4: the spy is seat 1 (bot1)
  const { broker, url, http } = await startBroker(
    [
      { name: "olena", kind: "human" },
      { name: "bot1", kind: "claude" },
      { name: "bot2", kind: "claude" },
      { name: "bot3", kind: "claude" },
      { name: "watcher", kind: "claude" },
    ],
    {},
    { random: () => 0.4 },
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
    assert.deepEqual(shown.moves, ["deal 4"]);
    // asked again
    await bots.bot3.send({ to: "aichat", text: "card" });
    await settle();
    assert.match(dms.bot3.at(-1)!, new RegExp(`«${word}»`));
    // thanks are not answered
    await bots.bot3.send({ to: "aichat", text: "дякую!" });
    await settle();
    assert.equal(dms.bot3.length, 2);

    // two rounds of clues: on the site or in the room
    const say = async (who: "bot1" | "bot2" | "bot3", text: string) => {
      await bots[who].send({ room, text });
      await settle();
    };
    for (let r = 0; r < 2; r++) {
      assert.equal(
        (
          await call("olena", "POST", `/api/games/${id}/move`, {
            move: `тепло ${r}`,
          })
        ).status,
        200,
      );
      await say("bot1", `move здогадка ${r}`);
      await say("bot2", `move підказка два ${r}`);
      await say("bot3", `move підказка три ${r}`);
    }
    let g = (await call("watcher", "GET", `/api/games/${id}`)).body.game;
    assert.deepEqual(g.movers, [0, 1, 2, 3]);

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

    // the last vote reveals all of them; the spy was caught and guesses wrong
    await bots.bot1.send({ to: "aichat", text: "vote olena" });
    await settle();
    g = (await call("watcher", "GET", `/api/games/${id}`)).body.game;
    assert.equal(g.moves.at(-1), "reveal 1 spy");
    assert.equal(g.turn, 1);
    await say("bot1", "move щось");
    g = (await call("watcher", "GET", `/api/games/${id}`)).body.game;
    assert.equal(g.status, "finished");
    assert.deepEqual(g.result!.winners, [0, 2, 3]);
    assert.match(g.result!.text, /^Перемога: olena, bot2, bot3\. Шпигуна викрито/);
    assert.equal(g.moves[0], `deal 4 1 ${word}`);

    // nothing in the room gave the word or the votes away before the end
    const history: ChatMessage[] = await bots.bot2.history({
      room,
      limit: 200,
    });
    const last = history.findIndex((m: ChatMessage) => m.from === "aichat" && /завершено/.test(m.text));
    const allVoted = history.findIndex((m: ChatMessage) => m.from === "aichat" && /^bot1: проголосував/.test(m.text));
    assert.ok(allVoted > 0 && last > allVoted);
    for (const m of history.slice(0, last)) assert.doesNotMatch(m.text, new RegExp(word), m.text);
    for (const m of history.slice(0, allVoted)) assert.doesNotMatch(m.text, /гравець \d → /, m.text);
    assert.match(history[allVoted].text, /Голоси: гравець 1 → гравець 2, гравець 2 → гравець 1/);
    assert.ok(history.some((m: ChatMessage) => m.from === "aichat" && /голосують таємно/.test(m.text)));
    assert.ok(history.some((m: ChatMessage) => /bot2: проголосував/.test(m.text)));
    assert.match(history[last].text, new RegExp(`Слово: «${word}»`));
  } finally {
    for (const c of Object.values(bots)) c.close();
    await broker.close();
  }
});
