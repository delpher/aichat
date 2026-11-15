import { test } from "node:test";
import assert from "node:assert/strict";
import type { GameRules } from "../broker/games.js";
import type { ChatMessage, GameInfo } from "../protocol.js";
import { connect, nextMessage, startBroker, tok } from "./helpers.js";

/** A tiny game for testing the broker side: take 1-3 from a pile of 7; whoever takes the last one wins. */
const nim: GameRules = {
  play(moves, text) {
    const n = Number(text);
    const left = 7 - moves.reduce((s, m) => s + Number(m), 0);
    if (![1, 2, 3].includes(n) || n > left) throw new Error(`illegal move: ${text}`);
    return String(n);
  },
  turn: (moves) => (moves.length % 2 ? "b" : "w"),
  legalMoves(moves) {
    const left = 7 - moves.reduce((s, m) => s + Number(m), 0);
    return ["1", "2", "3"].filter((m) => Number(m) <= left);
  },
  outcome(moves) {
    const left = 7 - moves.reduce((s, m) => s + Number(m), 0);
    return left === 0 ? { winner: moves.length % 2 ? "w" : "b", reason: "no-moves" } : null;
  },
  board: (moves) => `left: ${7 - moves.reduce((s, m) => s + Number(m), 0)}`,
};

async function setup() {
  const b = await startBroker(
    [{ name: "olena", kind: "human" }, { name: "petro", kind: "human" }, { name: "bot1", kind: "claude" }, { name: "bot2", kind: "claude" }, { name: "watcher" }],
    {},
    { gameRules: { nim } },
  );
  const call = async (who: string, method: string, path: string, body?: unknown) => {
    const r = await fetch(`${b.http}${path}`, {
      method,
      headers: { authorization: `Bearer ${tok(who)}`, "content-type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: r.status, body: (await r.json()) as { game: GameInfo; games: GameInfo[]; error: string } };
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

test("open game: created by a person, joined by an agent, played over REST to the end", async () => {
  const { broker, url, call } = await setup();
  const bot = await connect(url, "bot1");
  const watcher = await connect(url, "watcher");
  const frames: GameInfo[] = [];
  (watcher as unknown as { ws: { on: (e: string, f: (d: unknown) => void) => void } }).ws.on("message", (d) => {
    const f = JSON.parse(String(d));
    if (f.type === "game") frames.push(f.game);
  });

  let r = await call("olena", "POST", "/api/games", { game: "nim", white: "olena" });
  assert.equal(r.status, 201);
  const g = r.body.game;
  assert.deepEqual([g.status, g.white, g.black, g.room], ["open", "olena", null, `game-${g.id}`]);
  assert.equal((await call("olena", "POST", `/api/games/${g.id}/join`)).status, 409);
  assert.equal((await call("olena", "POST", `/api/games/${g.id}/move`, { move: "1" })).status, 409);

  const started = nextSystem(bot);
  r = await call("bot1", "POST", `/api/games/${g.id}/join`, {});
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.game.status, r.body.game.black], ["active", "bot1"]);
  const hello = await started;
  assert.equal(hello.room, g.room);
  assert.match(hello.text, /left: 7/);
  assert.match(hello.text, /Можливі ходи: 1, 2, 3/);
  assert.equal((await call("petro", "POST", `/api/games/${g.id}/join`)).status, 409);

  assert.equal((await call("bot1", "POST", `/api/games/${g.id}/move`, { move: "1" })).status, 409); // not its turn
  assert.equal((await call("watcher", "POST", `/api/games/${g.id}/move`, { move: "1" })).status, 403);
  r = await call("olena", "POST", `/api/games/${g.id}/move`, { move: "9" });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /illegal/);
  for (const [who, m] of [["olena", "3"], ["bot1", "3"], ["olena", "1"]] as const)
    assert.equal((await call(who, "POST", `/api/games/${g.id}/move`, { move: m })).status, 200);
  r = await call("watcher", "GET", `/api/games/${g.id}`);
  assert.deepEqual([r.body.game.status, r.body.game.moves, r.body.game.result], ["finished", ["3", "3", "1"], { winner: "w", reason: "no-moves" }]);
  assert.equal((await call("bot1", "POST", `/api/games/${g.id}/resign`)).status, 409);

  // everyone connected hears about every change, players or not
  await new Promise((res) => setTimeout(res, 50));
  assert.deepEqual(frames.map((f) => f.status), ["open", "active", "active", "active", "finished"]);
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
  assert.equal((await call("bot1", "POST", "/api/games", { game: "nim", white: "bot2", black: "olena" })).status, 403);
  assert.equal((await call("olena", "POST", "/api/games", { game: "nim", white: "bot1", black: "bot1" })).status, 400);
  assert.equal((await call("olena", "POST", "/api/games", { game: "chess", white: "bot1" })).status, 400);
  const first = nextSystem(b1);
  const r = await call("olena", "POST", "/api/games", { game: "nim", white: "bot1", black: "bot2" });
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
  assert.match(last.text, /Партію #\d+ завершено. Перемогли білі \(bot1\)/);

  // a wrong move is answered in the room, not rejected
  const opened = nextSystem(b1);
  const g2 = (await call("olena", "POST", "/api/games", { game: "nim", white: "bot1", black: "bot2" })).body.game;
  await opened;
  const answer = nextSystem(b1);
  await b1.send({ room: g2.room, text: "move 5" });
  assert.match((await answer).text, /bot1: illegal move: 5\nМожливі ходи: 1, 2, 3/);
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
  assert.match((await agreed).text, /Нічия, причина: agreement/);
  b1.close(); b2.close();
  await broker.close();
});

test("an agent opens a game for itself; resign ends it; the name aichat is reserved", async () => {
  const { broker, call } = await setup();
  let r = await call("bot2", "POST", "/api/games", { game: "nim", black: "bot2" });
  assert.equal(r.status, 201);
  const id = r.body.game.id;
  r = await call("petro", "POST", `/api/games/${id}/join`, { color: "black" });
  assert.equal(r.status, 409);
  r = await call("petro", "POST", `/api/games/${id}/join`, { color: "white" });
  assert.equal(r.body.game.white, "petro");
  r = await call("petro", "POST", `/api/games/${id}/resign`);
  assert.deepEqual(r.body.game.result, { winner: "b", reason: "resign" });
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
    body: JSON.stringify({ game: "checkers", white: "olena", black: "bot1" }),
  });
  assert.equal(res.status, 201);
  const g = ((await res.json()) as { game: GameInfo }).game;
  const hello = (await started).text;
  assert.match(hello, /```\n8 /); // board in a code block, white at the bottom
  assert.match(hello, /Хід білі \(olena\)\. Можливі ходи: .*c3-d4/);

  const move = (who: string, text: string) => {
    const next = nextSystem(bot);
    return who === "bot1" ? bot.send({ room: g.room, text }).then(() => next) : fetch(`${b.http}/api/games/${g.id}/move`, {
      method: "POST",
      headers: { authorization: `Bearer ${tok(who)}`, "content-type": "application/json" },
      body: JSON.stringify({ move: text }),
    }).then(() => next);
  };
  assert.match((await move("olena", "C3 D4")).text, /Хід чорні \(bot1\)/);
  const err = (await move("bot1", "move a1-b2")).text;
  assert.match(err, /^bot1: illegal move a1-b2; legal moves: /);
  assert.doesNotMatch(err, /Можливі ходи/); // listed once, by the rules
  await move("bot1", "move f6-e5");
  const r = await fetch(`${b.http}/api/games/${g.id}`, { headers: { authorization: `Bearer ${tok("olena")}` } });
  assert.deepEqual(((await r.json()) as { game: GameInfo }).game.moves, ["c3-d4", "f6-e5"]);
  bot.close();
  await b.broker.close();
});
