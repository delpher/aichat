import { test } from "node:test";
import assert from "node:assert/strict";
import { movesHint, openCells, outcome, play, renderBoard, replay, type BaldaState } from "../games/balda/engine.js";
import { balda, dictionary } from "../games/balda/index.js";
import type { ChatMessage, GameInfo } from "../protocol.js";
import { startBroker, tok } from "./helpers.js";

const isWord = (w: string) => dictionary().has(w);
const started = (n = 2, word = "кошик"): BaldaState => replay([`start ${n} ${word}`]);
const names = (cells: number[]) => cells.map((i) => "abcde"[i % 5] + (Math.floor(i / 5) + 1));

test("balda: the dictionary holds common nouns and nothing else", () => {
  for (const w of ["кіт", "кит", "кошик", "стіл", "вода", "сани", "ніс"]) assert.ok(isWord(w), w);
  for (const w of ["київ", "бігти", "зелений", "м'яч", "кіт-воркіт", "Кіт"]) assert.ok(!isWord(w), w);
});

test("balda: the start word stands in the middle row, and letters go next to letters", () => {
  const s = started();
  assert.equal(s.board.slice(10, 15).join(""), "кошик");
  assert.deepEqual(names(openCells(s)), ["a2", "b2", "c2", "d2", "e2", "a4", "b4", "c4", "d4", "e4"]);
  assert.equal(renderBoard(s).split("\n")[3], "3 к о ш и к");
  assert.match(renderBoard(s), /Очки: гравець 1 — 0, гравець 2 — 0\nСлова: кошик \(старт\)$/);
  assert.match(movesHint(s), /^Вільні клітинки поруч із літерами: a2, b2, c2, d2, e2, a4, b4, c4, d4, e4\. Хід: move/);
});

test("balda: a word through the new letter scores its length; the chain is found or given", () => {
  let s = play(started(), "D2 т КИТ", isWord); // к(e3) и(d3) т(d2)
  assert.deepEqual(s.moves.at(-1), "d2 т кит");
  assert.deepEqual(s.scores, [3, 0]);
  assert.equal(s.turn, 1);
  assert.deepEqual(names(s.last!.path), ["e3", "d3", "d2"]);
  s = play(s, "b2 д a3 b3 b2", isWord); // к(a3) о(b3) д(b2): the chain itself
  assert.equal(s.moves.at(-1), "b2 д код");
  assert.deepEqual(s.scores, [3, 3]);
  assert.equal(s.turn, 0);
  // a replay without the dictionary gives the same position
  assert.deepEqual(replay(s.moves).board, s.board);
});

test("balda: refused moves say why", () => {
  const s = play(started(), "d2 т кит", isWord);
  const no = (text: string, re: RegExp) => assert.throws(() => play(s, text, isWord), re);
  no("d4 т кит", /слово «кит» уже було/);
  no("b2 ж жок", /слова «жок» немає в словнику/);
  no("c1 к кок", /не поруч із літерою/);
  no("d2 б бик", /клітинка d2 зайнята/);
  no("a2 о кошик", /не складається ланцюжком сусідніх клітинок через a2/);
  no("a2 q кок", /не літера/);
  no("a2 о a2 a3 c3", /a3 і c3 не сусіди/);
  no("b2 м ом", /щонайменше з 3 літер/);
  no("start 2 кошик", /хід пишуть так/);
  no("a2", /хід пишуть так/);
});

test("balda: the game ends when everyone passes in a row, when the board is full, or when one is left", () => {
  let s = play(started(3), "d2 т кит", isWord);
  for (let i = 0; i < 2; i++) s = play(s, "pass");
  assert.equal(outcome(s).over, false);
  s = play(s, "pass");
  assert.deepEqual(outcome(s), { over: true, winner: 0, reason: "passes", scores: [3, 0, 0] });
  assert.throws(() => play(s, "pass"), /гру завершено/);

  const full: BaldaState = { ...started(2), board: Array(25).fill("а"), scores: [7, 7] };
  assert.deepEqual(outcome(full), { over: true, winner: null, reason: "full", scores: [7, 7] }); // a tie is a draw

  const left = replay(["start 3 кошик", "out 1", "out 0"]);
  assert.deepEqual(outcome(left), { over: true, winner: 2, reason: "last", scores: [0, 0, 0] });
});

test("balda in the broker: three players, a start word, hints, dropping out", async () => {
  const b = await startBroker(
    [{ name: "olena", kind: "human" }, { name: "bot1", kind: "claude" }, { name: "bot2", kind: "claude" }],
    {},
    { games: [balda], random: () => 0 },
  );
  const call = async (who: string, method: string, path: string, body?: unknown) => {
    const r = await fetch(`${b.http}${path}`, {
      method,
      headers: { authorization: `Bearer ${tok(who)}`, "content-type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return (await r.json()) as { game: GameInfo; messages: ChatMessage[]; error?: string };
  };
  try {
    let g = (await call("olena", "POST", "/api/games", { game: "balda", players: ["olena", "bot1", "bot2"], seats: 3 })).game;
    assert.equal(g.status, "active");
    const start = /^start 3 (\S{5})$/.exec(g.moves[0]);
    assert.ok(start, g.moves[0]);
    let room = (await call("olena", "GET", `/api/history?room=${g.room}`)).messages;
    assert.match(room.at(-1)!.text, new RegExp(`Стартове слово: ${start[1]}`));
    assert.match(room.at(-1)!.text, /Вільні клітинки поруч із літерами: a2, /); // a hint, not a list of moves

    g = (await call("olena", "POST", `/api/games/${g.id}/move`, { move: "pass" })).game;
    assert.equal(g.turn, 1);
    g = (await call("bot1", "POST", `/api/games/${g.id}/resign`)).game;
    assert.equal(g.status, "active");
    assert.equal(g.turn, 2);
    g = (await call("bot2", "POST", `/api/games/${g.id}/resign`)).game;
    assert.equal(g.status, "finished");
    assert.equal(g.result?.text, "Перемога: гравець 1 (olena). Інші гравці вибули; очки: 0 : 0 : 0.");
  } finally {
    await b.broker.close();
  }
});
