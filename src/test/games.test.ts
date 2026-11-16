import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GameDefinition } from "../games/game.js";
import { Store } from "../broker/store.js";
import type { AgentConfig } from "../broker/config.js";
import type { ChatMessage, GameInfo, GameType } from "../protocol.js";
import { connect, nextMessage, startBroker, tok } from "./helpers.js";

/**
 * A tiny game that is not checkers, to show the broker's game service knows nothing about a particular game:
 * take 1-3 from a pile of 7; whoever takes the last one wins.
 */
const left = (moves: string[]) => 7 - moves.reduce((s, m) => s + Number(m), 0);
const nim: GameDefinition = {
  id: "nim",
  title: "Нім",
  description: "Беріть 1-3 з купки; хто візьме останній, той виграв.",
  seats: [
    { id: "a", name: "перший" },
    { id: "b", name: "другий" },
  ],
  play(moves, text) {
    const n = Number(text);
    if (![1, 2, 3].includes(n) || n > left(moves)) throw new Error(`illegal move: ${text}`);
    return String(n);
  },
  turn: (moves) => moves.length % 2,
  legalMoves: (moves) => ["1", "2", "3"].filter((m) => Number(m) <= left(moves)),
  outcome: (moves) => (left(moves) === 0 ? { winner: (moves.length - 1) % 2, reason: "last-take" } : null),
  board: (moves) => `left: ${left(moves)}`,
  reasonText: () => "узято останній",
};

type Body = { game: GameInfo; games: GameInfo[]; types: GameType[]; error: string; messages: ChatMessage[] };

async function setup(agents: Partial<AgentConfig>[] = [{ name: "olena", kind: "human" }, { name: "petro", kind: "human" }, { name: "bot1", kind: "claude" }, { name: "bot2", kind: "claude" }, { name: "watcher" }]) {
  const b = await startBroker(agents, {}, { games: [nim] });
  const call = async (who: string, method: string, path: string, body?: unknown) => {
    const r = await fetch(`${b.http}${path}`, {
      method,
      headers: { authorization: `Bearer ${tok(who)}`, "content-type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: r.status, body: (await r.json()) as Body };
  };
  return { ...b, call };
}

/** Waits for the next message from the broker itself in a room. */
function nextSystem(c: Awaited<ReturnType<typeof connect>>, timeoutMs = 3000): Promise<ChatMessage> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("no system message")), timeoutMs);
    const on = (m: ChatMessage) => {
      if (m.from !== "aichat") return;
      clearTimeout(t);
      c.off("message", on);
      resolve(m);
    };
    c.on("message", on);
  });
}

test("game types come from the game modules; games can be listed by type", async () => {
  const { broker, call } = await setup();
  const r = await call("watcher", "GET", "/api/games/types");
  assert.deepEqual(r.body.types, [{ id: "nim", title: "Нім", description: nim.description, seats: nim.seats }]);
  await call("olena", "POST", "/api/games", { game: "nim", seat: "a" });
  assert.equal((await call("watcher", "GET", "/api/games?game=nim")).body.games.length, 1);
  assert.equal((await call("watcher", "GET", "/api/games?game=checkers")).body.games.length, 0);
  // the game is a required choice now, and an unknown one says which exist
  assert.equal((await call("olena", "POST", "/api/games", { seat: "a" })).status, 400);
  const bad = await call("olena", "POST", "/api/games", { game: "chess", seat: "a" });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /known: nim/);
  await broker.close();
});

test("open game: created by a person, joined by an agent, played over REST to the end", async () => {
  const { broker, url, call } = await setup();
  const bot = await connect(url, "bot1");
  const watcher = await connect(url, "watcher");
  const frames: GameInfo[] = [];
  (watcher as unknown as { ws: { on: (e: string, f: (d: unknown) => void) => void } }).ws.on("message", (d) => {
    const f = JSON.parse(String(d));
    if (f.type === "game") frames.push(f.game);
  });

  let r = await call("olena", "POST", "/api/games", { game: "nim", seat: "a" });
  assert.equal(r.status, 201);
  const g = r.body.game;
  assert.deepEqual([g.status, g.players, g.turn, g.room], ["open", ["olena", null], null, `game-${g.id}`]);
  assert.equal((await call("olena", "POST", `/api/games/${g.id}/join`)).status, 409);
  assert.equal((await call("olena", "POST", `/api/games/${g.id}/move`, { move: "1" })).status, 409);

  const started = nextSystem(bot);
  r = await call("bot1", "POST", `/api/games/${g.id}/join`, {});
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.game.status, r.body.game.players, r.body.game.turn], ["active", ["olena", "bot1"], 0]);
  const hello = await started;
  assert.equal(hello.room, g.room);
  assert.match(hello.text, /почалася: перший — olena, другий — bot1/);
  assert.match(hello.text, /left: 7/);
  assert.match(hello.text, /Хід: перший \(olena\)\. Можливі ходи: 1, 2, 3/);
  assert.equal((await call("petro", "POST", `/api/games/${g.id}/join`)).status, 409);

  assert.equal((await call("bot1", "POST", `/api/games/${g.id}/move`, { move: "1" })).status, 409); // not its turn
  assert.equal((await call("watcher", "POST", `/api/games/${g.id}/move`, { move: "1" })).status, 403);
  r = await call("olena", "POST", `/api/games/${g.id}/move`, { move: "9" });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /illegal/);
  for (const [who, m] of [["olena", "3"], ["bot1", "3"], ["olena", "1"]] as const)
    assert.equal((await call(who, "POST", `/api/games/${g.id}/move`, { move: m })).status, 200);
  r = await call("watcher", "GET", `/api/games/${g.id}`);
  assert.deepEqual([r.body.game.status, r.body.game.moves, r.body.game.turn], ["finished", ["3", "3", "1"], null]);
  assert.deepEqual(r.body.game.result, { winner: 0, reason: "last-take", text: "Перемога: перший (olena). Узято останній." });
  assert.equal((await call("bot1", "POST", `/api/games/${g.id}/resign`)).status, 409);

  // everyone connected hears about every change, players or not
  await new Promise((res) => setTimeout(res, 50));
  assert.deepEqual(frames.map((f) => f.status), ["open", "active", "active", "active", "finished"]);
  assert.equal(frames.at(-1)!.result!.text, "Перемога: перший (olena). Узято останній.");
  r = await call("watcher", "GET", "/api/games?status=finished");
  assert.deepEqual(r.body.games.map((x) => x.id), [g.id]);
  assert.equal((await call("watcher", "GET", "/api/games?status=bogus")).status, 400);
  bot.close(); watcher.close();
  await broker.close();
});

test("agents play each other by text in the game room, without hitting maxHops", async () => {
  const { broker, url, call } = await setup();
  const b1 = await connect(url, "bot1");
  const b2 = await connect(url, "bot2");
  // agents may not set up games they do not play in; people may
  assert.equal((await call("bot1", "POST", "/api/games", { game: "nim", players: ["bot2", "olena"] })).status, 403);
  assert.equal((await call("olena", "POST", "/api/games", { game: "nim", players: ["bot1", "bot1"] })).status, 400);
  assert.equal((await call("olena", "POST", "/api/games", { game: "nim", players: ["bot1", "bot2", "olena"] })).status, 400);
  assert.equal((await call("olena", "POST", "/api/games", { game: "nim", players: ["nobody", null] })).status, 404);
  const first = nextSystem(b1);
  const r = await call("olena", "POST", "/api/games", { game: "nim", players: ["bot1", "bot2"] });
  assert.equal(r.body.game.status, "active");
  const room = r.body.game.room;
  let last = await first;

  // each agent answers the broker's board with reply_to: hops grow, but game rooms are exempt
  const plays: [typeof b1, string][] = [[b1, "move 1"], [b2, "move 1"], [b1, "move 1"], [b2, "move 1"], [b1, "move 1"], [b2, "move 1"], [b1, "move 1"]];
  for (const [who, text] of plays) {
    const other = who === b1 ? b2 : b1;
    const next = nextSystem(other);
    await who.send({ room, text, reply_to: last.id });
    last = await next;
  }
  assert.match(last.text, /Партію #\d+ завершено. Перемога: перший \(bot1\)\. Узято останній\./);

  // a wrong move is answered in the room, not rejected; so is a move out of turn
  const opened = nextSystem(b1);
  const g2 = (await call("olena", "POST", "/api/games", { game: "nim", players: ["bot1", "bot2"] })).body.game;
  await opened;
  let answer = nextSystem(b1);
  await b1.send({ room: g2.room, text: "move 5" });
  assert.match((await answer).text, /bot1: illegal move: 5\nМожливі ходи: 1, 2, 3/);
  answer = nextSystem(b1);
  await b2.send({ room: g2.room, text: "move 1" });
  assert.equal((await answer).text, "bot2: Не ваш хід. Хід: перший (bot1).");
  // plain chat in the game room is just chat
  const chat = nextMessage(b2);
  await b1.send({ room: g2.room, text: "good luck!" });
  assert.equal((await chat).text, "good luck!");
  // draw by agreement and resign by text
  const offered = nextSystem(b2);
  await b1.send({ room: g2.room, text: "draw" });
  assert.match((await offered).text, /bot1 пропонує нічию/);
  const agreed = nextSystem(b1);
  await b2.send({ room: g2.room, text: "draw" });
  assert.match((await agreed).text, /Нічия: за згодою\./);
  b1.close(); b2.close();
  await broker.close();
});

test("an agent opens a game for itself; seats are taken by id; resign ends it; the name aichat is reserved", async () => {
  const { broker, call } = await setup();
  let r = await call("bot2", "POST", "/api/games", { game: "nim", seat: "b" });
  assert.equal(r.status, 201);
  assert.deepEqual(r.body.game.players, [null, "bot2"]);
  const id = r.body.game.id;
  assert.equal((await call("petro", "POST", `/api/games/${id}/join`, { seat: "b" })).status, 409);
  assert.equal((await call("petro", "POST", `/api/games/${id}/join`, { seat: "x" })).status, 400);
  r = await call("petro", "POST", `/api/games/${id}/join`, { seat: "a" });
  assert.deepEqual(r.body.game.players, ["petro", "bot2"]);
  r = await call("petro", "POST", `/api/games/${id}/resign`);
  assert.deepEqual(r.body.game.result, { winner: 1, reason: "resign", text: "Перемога: другий (bot2). Суперник здався." });
  assert.equal((await call("petro", "GET", "/api/games/999")).status, 404);
  await broker.close();
  await assert.rejects(startBroker([{ name: "aichat" }]), /reserved/);
});

test("checkers through the broker: real rules, text moves, errors with legal moves", async () => {
  const b = await startBroker([{ name: "olena", kind: "human" }, { name: "bot1", kind: "claude" }]);
  const bot = await connect(b.url, "bot1");
  const started = nextSystem(bot);
  const res = await fetch(`${b.http}/api/games`, {
    method: "POST",
    headers: { authorization: `Bearer ${tok("olena")}`, "content-type": "application/json" },
    body: JSON.stringify({ game: "checkers", players: ["olena", "bot1"] }),
  });
  assert.equal(res.status, 201);
  const g = ((await res.json()) as { game: GameInfo }).game;
  const hello = (await started).text;
  assert.match(hello, /\(Шашки\) почалася: білі — olena, чорні — bot1/);
  assert.match(hello, /```\n8 /); // board in a code block, white at the bottom
  assert.match(hello, /Хід білих \(olena\)\. Можливі ходи: .*c3-d4/);

  const move = (who: string, text: string) => {
    const next = nextSystem(bot);
    return who === "bot1" ? bot.send({ room: g.room, text }).then(() => next) : fetch(`${b.http}/api/games/${g.id}/move`, {
      method: "POST",
      headers: { authorization: `Bearer ${tok(who)}`, "content-type": "application/json" },
      body: JSON.stringify({ move: text }),
    }).then(() => next);
  };
  assert.equal((await move("bot1", "move f6-e5")).text, "bot1: Не ваш хід. Хід білих (olena).");
  assert.match((await move("olena", "C3 D4")).text, /Хід чорних \(bot1\)/);
  const err = (await move("bot1", "move a1-b2")).text;
  assert.match(err, /^bot1: illegal move a1-b2; legal moves: /);
  assert.doesNotMatch(err, /Можливі ходи/); // listed once, by the rules
  await move("bot1", "move f6-e5");
  const r = await fetch(`${b.http}/api/games/${g.id}`, { headers: { authorization: `Bearer ${tok("olena")}` } });
  const after = ((await r.json()) as { game: GameInfo }).game;
  assert.deepEqual([after.moves, after.turn], [["c3-d4", "f6-e5"], 0]);
  bot.close();
  await b.broker.close();
});

test("deleting a game takes its room and messages; game rooms are not managed as rooms", async () => {
  const b = await setup([{ name: "boss", kind: "human", admin: true }, { name: "olena", kind: "human" }, { name: "bot1", kind: "claude" }]);
  const { call } = b;
  const bot = await connect(b.url, "bot1");
  const started = nextSystem(bot);
  const g = (await call("olena", "POST", "/api/games", { game: "nim", players: ["olena", "bot1"] })).body.game;
  await started;
  await bot.send({ room: g.room, text: "hi" });

  // the room of a game is managed through the game
  let r = await call("boss", "DELETE", `/admin/api/rooms/${g.room}?messages=1`);
  assert.equal(r.status, 409);
  assert.match(r.body.error, /DELETE \/admin\/api\/games\//);
  assert.equal((await call("boss", "POST", `/admin/api/rooms/${g.room}/members`, { name: "olena" })).status, 409);
  assert.equal((await call("boss", "POST", "/admin/api/rooms", { name: "game-99" })).status, 409);

  // only admins delete games
  assert.equal((await call("olena", "DELETE", `/admin/api/games/${g.id}`)).status, 401);
  const frames: unknown[] = [];
  (bot as unknown as { ws: { on: (e: string, f: (d: unknown) => void) => void } }).ws.on("message", (d) => frames.push(JSON.parse(String(d))));
  r = await call("boss", "DELETE", `/admin/api/games/${g.id}`);
  assert.equal(r.status, 200);
  assert.equal((await call("olena", "GET", `/api/games/${g.id}`)).status, 404);
  assert.equal((await call("boss", "DELETE", `/admin/api/games/${g.id}`)).status, 404);
  r = await call("boss", "GET", `/admin/api/messages?room=${g.room}`);
  assert.deepEqual(r.body.messages, []);
  await new Promise((res) => setTimeout(res, 50));
  assert.ok(frames.some((f) => (f as { type: string; id?: number }).type === "game_deleted" && (f as { id: number }).id === g.id));
  // nobody can bring the room of a deleted game back
  await assert.rejects(bot.send({ room: g.room, text: "anyone?" }), /no game/);
  bot.close();
  await b.broker.close();
});

test("games saved before seats existed (white/black columns) are migrated to players", () => {
  const dir = mkdtempSync(join(tmpdir(), "aichat-games-"));
  const path = join(dir, "old.db");
  try {
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE games (
      id INTEGER PRIMARY KEY AUTOINCREMENT, game TEXT NOT NULL, white TEXT, black TEXT, created_by TEXT NOT NULL,
      moves TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL, result TEXT, draw_offer TEXT, created_ts TEXT NOT NULL, updated_ts TEXT NOT NULL)`);
    const ins = old.prepare("INSERT INTO games (game, white, black, created_by, moves, status, result, created_ts, updated_ts) VALUES (?, ?, ?, ?, ?, ?, ?, 't', 't')");
    ins.run("checkers", "olena", "bot1", "olena", '["c3-d4"]', "finished", JSON.stringify({ winner: "b", reason: "no-moves" }));
    ins.run("checkers", "olena", null, "olena", "[]", "open", null);
    ins.run("checkers", "a", "b", "a", "[]", "finished", JSON.stringify({ winner: null, reason: "agreement" }));
    old.close();

    const store = new Store(path);
    const [draw, open, won] = store.games();
    assert.deepEqual([won.players, won.result], [["olena", "bot1"], { winner: 1, reason: "no-moves" }]);
    assert.deepEqual([open.players, open.result], [["olena", null], null]);
    assert.deepEqual(draw.result, { winner: null, reason: "agreement" });
    store.close();
    // opening it again does not migrate twice
    const again = new Store(path);
    assert.deepEqual(again.game(won.id)!.players, ["olena", "bot1"]);
    again.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
