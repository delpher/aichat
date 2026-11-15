// The broker's game service, for any game in src/games/: games are stored, every move goes through the
// game's rules, and each game has a chat room `game-<id>` where the broker (as the system sender "aichat")
// posts the board and whose players may also play by plain text: `move <move>`, `resign`, `draw`.
// Nothing here knows about a particular game.
import type { GameInfo, GameResult, GameType } from "../protocol.js";
import type { GameDefinition, GameOutcome } from "../games/game.js";
import type { GameRecord, Store } from "./store.js";

export { SYSTEM_SENDER } from "../protocol.js";
export const GAME_ROOM_RE = /^game-(\d+)$/;
export const gameRoom = (id: number) => `game-${id}`;

export class GameError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

export interface GameHost {
  store: Store;
  games: GameDefinition[];
  isAgent(name: string): boolean;
  isHuman(name: string): boolean;
  /** Puts an agent into a room (and tells its live connections). */
  join(agent: string, room: string): void;
  /** Posts a message from the system sender to a room. */
  announce(room: string, text: string): void;
  /** Tells every connected client the game changed. */
  publish(game: GameInfo): void;
}

const FREE = "вільне місце";
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export class Games {
  private defs: Map<string, GameDefinition>;

  constructor(private host: GameHost) {
    this.defs = new Map(host.games.map((d) => [d.id, d]));
  }

  /** The games the broker can host, for GET /api/games/types. */
  types(): GameType[] {
    return [...this.defs.values()].map(({ id, title, description, seats }) => ({ id, title, description, seats }));
  }

  private def(game: string): GameDefinition {
    const d = this.defs.get(game);
    if (!d) throw new GameError(`unknown game: ${game}; known: ${[...this.defs.keys()].join(", ")}`);
    return d;
  }

  get(id: number): GameRecord {
    const g = this.host.store.game(id);
    if (!g) throw new GameError(`unknown game: ${id}`, 404);
    return g;
  }

  list(q: { status?: string; game?: string } = {}): GameRecord[] {
    if (q.status && !["open", "active", "finished"].includes(q.status)) throw new GameError("status must be open, active or finished");
    return this.host.store.games(q);
  }

  /** A stored game as the API and the WebSocket show it. */
  info(g: GameRecord): GameInfo {
    const def = this.defs.get(g.game);
    return {
      ...g,
      room: gameRoom(g.id),
      turn: g.status === "active" && def ? def.turn(g.moves) : null,
      result: g.result ? { ...g.result, text: def ? this.resultText(def, g, g.result) : g.result.reason } : null,
    };
  }

  /**
   * `players`: who sits where, in seat order (null = free). Or `seat`: the creator sits there alone and
   * the game waits for the others. People may set up games they do not play in; agents may not.
   */
  create(by: string, args: { game?: unknown; players?: unknown; seat?: unknown }): GameRecord {
    if (typeof args.game !== "string") throw new GameError("set game (see GET /api/games/types)");
    const def = this.def(args.game);
    let players: (string | null)[];
    if (args.players !== undefined) {
      if (!Array.isArray(args.players) || args.players.length > def.seats.length)
        throw new GameError(`players must be a list of up to ${def.seats.length} names (null for a free seat)`);
      players = def.seats.map((_, i) => this.player((args.players as unknown[])[i]));
    } else {
      players = def.seats.map(() => null);
      players[this.seatIndex(def, args.seat ?? def.seats[0].id)] = by;
    }
    const named = players.filter((p): p is string => !!p);
    if (!named.length) throw new GameError("name at least one player");
    if (new Set(named).size !== named.length) throw new GameError("a player cannot take two seats");
    if (!named.includes(by) && !this.host.isHuman(by)) throw new GameError("agents may only create games they play in", 403);
    const status = named.length === def.seats.length ? "active" : "open";
    const g = this.host.store.createGame({ game: def.id, players, created_by: by, moves: [], status, result: null, draw_offer: null });
    const room = gameRoom(g.id);
    for (const n of new Set([...named, by])) this.host.join(n, room);
    if (status === "active") this.announceStart(def, g);
    else
      this.host.announce(
        room,
        `Партію #${g.id} (${def.title}) створив ${by}. ${this.seatsText(def, g)}. ` +
          `Чекаємо гравців: приєднатися можна через join_game(${g.id}) або на сайті.`,
      );
    this.publish(g);
    return g;
  }

  /** Takes a free seat (the one named, or the first free one); when every seat is taken the game starts. */
  join(by: string, id: number, seat?: unknown): GameRecord {
    const g = this.get(id);
    const def = this.def(g.game);
    if (g.status !== "open") throw new GameError("the game has already started", 409);
    if (g.players.includes(by)) throw new GameError("you are already in this game", 409);
    const i = seat == null || seat === "" ? g.players.indexOf(null) : this.seatIndex(def, seat);
    if (i < 0 || g.players[i] !== null) {
      const free = def.seats.filter((_, j) => g.players[j] === null).map((s) => s.id);
      throw new GameError(`that seat is taken; free: ${free.join(", ") || "none"}`, 409);
    }
    g.players[i] = by;
    if (!g.players.includes(null)) g.status = "active";
    const saved = this.host.store.updateGame(g);
    this.host.join(by, gameRoom(id));
    if (saved.status === "active") this.announceStart(def, saved);
    else this.host.announce(gameRoom(id), `${by} сідає: ${def.seats[i].name}. ${this.seatsText(def, saved)}.`);
    this.publish(saved);
    return saved;
  }

  move(by: string, id: number, text: string): GameRecord {
    const g = this.activeFor(by, id);
    const def = this.def(g.game);
    const turn = def.turn(g.moves);
    if (g.players[turn] !== by) throw new GameError(`Не ваш хід. ${this.turnLabel(def, turn)} (${g.players[turn]}).`, 409);
    let move: string;
    try {
      move = def.play(g.moves, text);
    } catch (e) {
      throw new GameError((e as Error).message);
    }
    g.moves = [...g.moves, move];
    g.draw_offer = null;
    const outcome = def.outcome(g.moves);
    if (outcome) this.finish(g, outcome);
    const saved = this.host.store.updateGame(g);
    this.host.announce(gameRoom(id), outcome ? this.finalText(def, saved) : this.turnText(def, saved, `${by}: ${move}`));
    this.publish(saved);
    return saved;
  }

  /** With two seats the other player wins; with more, the game ends without a winner. */
  resign(by: string, id: number): GameRecord {
    const g = this.activeFor(by, id);
    const def = this.def(g.game);
    const me = g.players.indexOf(by);
    this.finish(g, { winner: def.seats.length === 2 ? 1 - me : null, reason: "resign" });
    const saved = this.host.store.updateGame(g);
    this.host.announce(gameRoom(id), `${by} здається.\n${this.finalText(def, saved)}`);
    this.publish(saved);
    return saved;
  }

  /** Offers a draw, or accepts another player's offer. */
  draw(by: string, id: number): GameRecord {
    const g = this.activeFor(by, id);
    const def = this.def(g.game);
    if (g.draw_offer && g.draw_offer !== by) {
      this.finish(g, { winner: null, reason: "agreement" });
      const saved = this.host.store.updateGame(g);
      this.host.announce(gameRoom(id), `${by} приймає нічию.\n${this.finalText(def, saved)}`);
      this.publish(saved);
      return saved;
    }
    g.draw_offer = by;
    const saved = this.host.store.updateGame(g);
    const others = g.players.filter((p) => p && p !== by).join(", ");
    this.host.announce(gameRoom(id), `${by} пропонує нічию. ${others}, щоб погодитися, напишіть "draw"; щоб грати далі, просто ходіть.`);
    this.publish(saved);
    return saved;
  }

  /**
   * A chat message in a game room: if a player of that game wrote a game command, apply it.
   * Mistakes are answered in the room instead of rejecting the message, so agents see them.
   */
  onRoomMessage(from: string, room: string, text: string) {
    const m = room.match(GAME_ROOM_RE);
    if (!m) return;
    const cmd = text.trim().match(/^(move|хід)\s+(.+)$|^(resign|здаюся|здаюсь)$|^(draw|нічия)$/i);
    if (!cmd) return;
    const id = Number(m[1]);
    const g = this.host.store.game(id);
    if (!g || !g.players.includes(from)) return;
    try {
      if (cmd[2]) this.move(from, id, cmd[2].trim());
      else if (cmd[3]) this.resign(from, id);
      else this.draw(from, id);
    } catch (e) {
      const msg = (e as Error).message;
      // list the legal moves only for a bad move (not when it is not your turn or the game is over),
      // and only if the rules did not list them in the error already (checkers does)
      const badMove = !(e instanceof GameError) || e.status === 400;
      const legal = badMove && g.status === "active" && !/legal moves/i.test(msg) ? this.def(g.game).legalMoves(g.moves) : [];
      this.host.announce(room, `${from}: ${msg}` + (legal.length ? `\nМожливі ходи: ${legal.join(", ")}` : ""));
    }
  }

  private player(v: unknown): string | null {
    if (v == null || v === "") return null;
    if (typeof v !== "string" || !this.host.isAgent(v)) throw new GameError(`unknown player: ${String(v)}`, 404);
    return v;
  }

  private seatIndex(def: GameDefinition, seat: unknown): number {
    const i = def.seats.findIndex((s) => s.id === seat);
    if (i < 0) throw new GameError(`unknown seat: ${String(seat)}; seats: ${def.seats.map((s) => s.id).join(", ")}`);
    return i;
  }

  private activeFor(by: string, id: number): GameRecord {
    const g = this.get(id);
    if (!g.players.includes(by)) throw new GameError("only the players can do this", 403);
    if (g.status !== "active") throw new GameError(g.status === "open" ? "the game has not started yet" : "the game is over", 409);
    return g;
  }

  private finish(g: GameRecord, outcome: GameOutcome) {
    g.status = "finished";
    g.result = outcome;
    g.draw_offer = null;
  }

  private publish(g: GameRecord) {
    this.host.publish(this.info(g));
  }

  /** "Хід білих" from the game, or "Хід: <seat name>". */
  private turnLabel(def: GameDefinition, seat: number): string {
    return def.turnLabel ? def.turnLabel(seat) : `Хід: ${def.seats[seat].name}`;
  }

  /** "білі — alice, чорні — вільне місце" */
  private seatsText(def: GameDefinition, g: GameRecord): string {
    return def.seats.map((s, i) => `${s.name} — ${g.players[i] ?? FREE}`).join(", ");
  }

  private announceStart(def: GameDefinition, g: GameRecord) {
    this.host.announce(gameRoom(g.id), this.turnText(def, g, `Партія #${g.id} (${def.title}) почалася: ${this.seatsText(def, g)}.`));
  }

  /** Board plus whose turn it is and the legal moves, so an agent can answer with one message. */
  private turnText(def: GameDefinition, g: GameRecord, head: string): string {
    const turn = def.turn(g.moves);
    const label = this.turnLabel(def, turn);
    return [
      head,
      "```",
      def.board(g.moves),
      "```",
      `${label} (${g.players[turn]}). Можливі ходи: ${def.legalMoves(g.moves).join(", ")}`,
      `Щоб походити, напишіть у цю кімнату: move <хід>, без reply_to. Також: resign, draw.`,
    ].join("\n");
  }

  /** "Перемога: чорні (bob). У білих немає ходів." / "Нічия: за згодою." */
  private resultText(def: GameDefinition, g: GameRecord, r: GameOutcome): GameResult["text"] {
    const why =
      r.reason === "resign" ? "суперник здався"
      : r.reason === "agreement" ? "за згодою"
      : def.reasonText ? def.reasonText(r)
      : r.reason;
    if (r.winner === null) return `Нічия: ${why}.`;
    return `Перемога: ${def.seats[r.winner].name} (${g.players[r.winner] ?? FREE}). ${capitalize(why)}.`;
  }

  private finalText(def: GameDefinition, g: GameRecord): string {
    return [`Партію #${g.id} завершено. ${this.resultText(def, g, g.result!)}`, "```", def.board(g.moves), "```"].join("\n");
  }
}
