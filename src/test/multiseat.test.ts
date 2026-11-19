import { test } from "node:test";
import assert from "node:assert/strict";
import type { GameDefinition } from "../games/game.js";
import type { GameInfo, GameType } from "../protocol.js";
import { startBroker, tok } from "./helpers.js";

/**
 * A game for 2-4 to show the broker's part: players in turn add 1-3 to a count; whoever reaches 10 wins.
 * A player who resigns is "out" and skipped; the last one in wins. The first entry, made by auto, says how
 * many sit at the table.
 */
const table = (moves: string[]) => Number(/^start (\d)$/.exec(moves[0] ?? "")?.[1] ?? 0);
const outs = (moves: string[]) => moves.filter((m) => m.startsWith("out ")).map((m) => Number(m.slice(4)));
const sum = (moves: string[]) => moves.filter((m) => /^[123]$/.test(m)).reduce((s, m) => s + Number(m), 0);
/** Seat to move: plays go round, skipping those out. */
function turn(moves: string[]): number {
  const n = table(moves), out = new Set(outs(moves));
  let seat = 0;
  for (const m of moves.slice(1)) if (/^[123]$/.test(m)) seat = (seat + 1) % n;
  while (out.has(seat)) seat = (seat + 1) % n;
  return seat;
}
const race: GameDefinition = {
  id: "race",
  title: "Перегони",
  description: "Додавайте 1-3; хто дійде до 10, той виграв.",
  seats: [
    { id: "a", name: "перший" },
    { id: "b", name: "другий" },
    { id: "c", name: "третій" },
    { id: "d", name: "четвертий" },
  ],
  minSeats: 2,
  play(_moves, text) {
    if (!/^[123]$/.test(text.trim())) throw new Error(`add 1, 2 or 3, not ${text}`);
    return text.trim();
  },
  turn,
  legalMoves: () => ["1", "2", "3"],
  movesHint: (moves) => `Додайте 1, 2 або 3 (зараз ${sum(moves)} з 10).`,
  outcome(moves) {
    if (!table(moves)) return null;
    const left = [...Array(table(moves)).keys()].filter((s) => !outs(moves).includes(s));
    if (left.length === 1) return { winner: left[0], reason: "last" };
    if (sum(moves) >= 10) {
      const plays = moves.filter((m) => /^[123]$/.test(m));
      return { winner: turn(moves.slice(0, moves.lastIndexOf(plays.at(-1)!))), reason: "ten" };
    }
    return null;
  },
  board: (moves) => `count: ${sum(moves)}`,
  auto: (moves, _random, seats) => (moves.length ? null : { move: `start ${seats}`, note: `За столом ${seats}.` }),
  dropOut(moves, seat) {
    if (outs(moves).includes(seat)) throw new Error("you are out already");
    return `out ${seat}`;
  },
};

async function setup() {
  const b = await startBroker(
    ["olena", "petro", "bot1", "bot2", "bot3"].map((name) => ({ name, kind: name.startsWith("bot") ? "claude" : "human" })),
    {},
    { games: [race] },
  );
  const call = async (who: string, method: string, path: string, body?: unknown) => {
    const r = await fetch(`${b.http}${path}`, {
      method,
      headers: { authorization: `Bearer ${tok(who)}`, "content-type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: r.status, body: (await r.json()) as { game: GameInfo; types: GameType[]; error: string; messages: { from: string; text: string }[] } };
  };
  return { ...b, call };
}

test("a game for 2-4: the creator picks how many seats, and it starts when they are all taken", async () => {
  const { broker, call } = await setup();
  try {
    const types = (await call("olena", "GET", "/api/games/types")).body.types;
    assert.equal(types[0].minSeats, 2);

    assert.equal((await call("olena", "POST", "/api/games", { game: "race", seat: "a", seats: 5 })).status, 400);
    assert.equal((await call("olena", "POST", "/api/games", { game: "race", seat: "a", seats: 1 })).status, 400);
    assert.match((await call("olena", "POST", "/api/games", { game: "race", seat: "d", seats: 3 })).body.error, /unknown seat: d; seats: a, b, c/);

    let g = (await call("olena", "POST", "/api/games", { game: "race", seat: "a", seats: 3 })).body.game;
    assert.deepEqual(g.players, ["olena", null, null]);
    assert.equal(g.status, "open");
    g = (await call("bot1", "POST", `/api/games/${g.id}/join`, {})).body.game;
    g = (await call("bot2", "POST", `/api/games/${g.id}/join`, {})).body.game;
    assert.equal(g.status, "active");
    assert.deepEqual(g.moves, ["start 3"]); // the game learns the table size from auto
    assert.equal((await call("bot3", "POST", `/api/games/${g.id}/join`, {})).status, 409);

    // naming fewer players than seats, within minSeats, makes a smaller table that starts at once
    const two = (await call("olena", "POST", "/api/games", { game: "race", players: ["olena", "bot1"] })).body.game;
    assert.equal(two.players.length, 2);
    assert.equal(two.status, "active");
  } finally {
    await broker.close();
  }
});

test("in a game of more than two, resigning takes the player out and the game goes on; no draws", async () => {
  const { broker, call } = await setup();
  try {
    let g = (await call("olena", "POST", "/api/games", { game: "race", players: ["olena", "bot1", "bot2"] })).body.game;
    assert.equal(g.turn, 0);
    g = (await call("olena", "POST", `/api/games/${g.id}/move`, { move: "2" })).body.game;
    assert.equal(g.turn, 1);
    assert.equal((await call("bot1", "POST", `/api/games/${g.id}/draw`)).status, 409);

    g = (await call("bot1", "POST", `/api/games/${g.id}/resign`)).body.game;
    assert.equal(g.status, "active");
    assert.equal(g.moves.at(-1), "out 1");
    assert.equal(g.turn, 2); // bot1 is skipped
    assert.equal((await call("bot1", "POST", `/api/games/${g.id}/resign`)).status, 409); // out already

    const room = (await call("olena", "GET", `/api/history?room=${g.room}`)).body.messages;
    const last = room.at(-1)!.text;
    assert.match(last, /bot1 здається й вибуває з партії/);
    assert.match(last, /Додайте 1, 2 або 3 \(зараз 2 з 10\)/); // the hint instead of a list
    assert.match(last, /resign \(вийти з партії\)/);

    g = (await call("bot2", "POST", `/api/games/${g.id}/resign`)).body.game;
    assert.equal(g.status, "finished");
    assert.equal(g.result?.winner, 0);
  } finally {
    await broker.close();
  }
});
