// The broker's game service, for any game in src/games/: games are stored, every move goes through the
// game's rules, and each game has a chat room `game-<id>` where the broker (as the system sender "aichat")
// posts the board and whose players may also play by plain text: `move <move>`, `resign`, `draw`.
// Nothing here knows about a particular game.
import type { GameInfo, GameRatings, GameResult, GameType } from "../protocol.js";
import type { GameDefinition, GameOutcome } from "../games/game.js";
import type { GameRecord, Store } from "./store.js";

export { SYSTEM_SENDER } from "../protocol.js";
export const GAME_ROOM_RE = /^game-(\d+)$/;
export const gameRoom = (id: number) => `game-${id}`;

/**
 * Endings that do not count for the rating: the game did not end by play. No game ends this way yet; the
 * names are reserved for clock and abandonment rules. Resigning and agreed draws count.
 */
export const UNRATED_REASONS = new Set(["timeout", "abandoned"]);

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
  /** Tells every connected client the ratings of a game type changed. */
  publishRatings?(game: string, ratings: GameRatings): void;
  /** Dice for games of chance, [0, 1); Math.random when not set (tests pass their own). */
  random?: () => number;
}

const FREE = "вільне місце";
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export class Games {
  private defs: Map<string, GameDefinition>;
  /**
   * Ratings by game type and player, unrounded. Not stored: rebuilt from the finished games on first use and
   * after a game is deleted, then moved on by each game that finishes.
   */
  private table?: Map<string, Map<string, number>>;
  /** A game type whose ratings the last finish() moved, to announce with the game itself. */
  private ratingsChanged?: string;

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

  /** Current ratings, rounded, by game type (only types with a rating); `game` narrows to one type. */
  ratings(game?: string): Record<string, GameRatings> {
    const out: Record<string, GameRatings> = {};
    for (const [id, def] of this.defs) if (def.rate && (!game || game === id)) out[id] = this.ratingsOf(id);
    return out;
  }

  private ratingsOf(game: string): GameRatings {
    return Object.fromEntries([...(this.loadRatings().get(game) ?? [])].map(([name, r]) => [name, Math.round(r)]));
  }

  private loadRatings(): Map<string, Map<string, number>> {
    if (!this.table) {
      this.table = new Map();
      for (const g of this.host.store.finishedGames()) this.rate(g);
    }
    return this.table;
  }

  /** Moves the ratings on by one finished game, if its type has a rating and the way it ended counts. */
  private rate(g: GameRecord): boolean {
    const def = this.defs.get(g.game);
    if (!def?.rate || !g.result || UNRATED_REASONS.has(g.result.reason)) return false;
    if (g.players.some((p) => !p)) return false;
    const players = g.players as string[];
    const table = this.table!;
    if (!table.has(def.id)) table.set(def.id, new Map());
    const mine = table.get(def.id)!;
    const after = def.rate({ players, result: g.result, moves: g.moves }, players.map((p) => mine.get(p)));
    players.forEach((p, i) => Number.isFinite(after[i]) && mine.set(p, after[i]));
    return true;
  }

  /** After an admin deleted a game: its rating effect goes with it, so the ratings are rebuilt. */
  deleted(g: GameRecord) {
    if (g.status !== "finished" || !this.defs.get(g.game)?.rate) return;
    this.table = undefined;
    this.host.publishRatings?.(g.game, this.ratingsOf(g.game));
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
    let g = this.host.store.createGame({ game: def.id, players, created_by: by, moves: [], status, result: null, draw_offer: null });
    const room = gameRoom(g.id);
    for (const n of new Set([...named, by])) this.host.join(n, room);
    if (status === "active") {
      const notes = this.runAuto(def, g);
      if (notes.length) g = this.host.store.updateGame(g);
      this.announceStart(def, g, notes);
    }
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
    const notes = g.status === "active" ? this.runAuto(def, g) : [];
    const saved = this.host.store.updateGame(g);
    this.host.join(by, gameRoom(id));
    if (saved.status === "active") this.announceStart(def, saved, notes);
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
    let outcome = def.outcome(g.moves);
    const notes = outcome ? [] : this.runAuto(def, g);
    outcome ??= def.outcome(g.moves);
    if (outcome) this.finish(g, outcome);
    const saved = this.host.store.updateGame(g);
    const head = [`${by}: ${move}`, ...notes].join("\n");
    this.host.announce(gameRoom(id), outcome ? this.finalText(def, saved) : this.turnText(def, saved, head));
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

  /** Ends the game; the hub counts it for the rating here, the one place every game ends. */
  private finish(g: GameRecord, outcome: GameOutcome) {
    this.loadRatings(); // before the game is saved as finished, so it is not counted twice
    g.status = "finished";
    g.result = outcome;
    g.draw_offer = null;
    if (this.rate(g)) this.ratingsChanged = g.game;
  }

  private publish(g: GameRecord) {
    this.host.publish(this.info(g));
    if (this.ratingsChanged) {
      const game = this.ratingsChanged;
      this.ratingsChanged = undefined;
      this.host.publishRatings?.(game, this.ratingsOf(game));
    }
  }

  /** "Хід білих" from the game, or "Хід: <seat name>". */
  private turnLabel(def: GameDefinition, seat: number): string {
    return def.turnLabel ? def.turnLabel(seat) : `Хід: ${def.seats[seat].name}`;
  }

  /** "білі — alice, чорні — вільне місце"; with `rated`, each player's rating in this game follows the name. */
  private seatsText(def: GameDefinition, g: GameRecord, rated = false): string {
    const ratings = rated && def.rate ? this.ratingsOf(def.id) : {};
    return def.seats
      .map((s, i) => {
        const p = g.players[i];
        return `${s.name} — ${p ?? FREE}${p && ratings[p] !== undefined ? ` (рейтинг ${ratings[p]})` : ""}`;
      })
      .join(", ");
  }

  /**
   * Adds the entries a game of chance makes by itself (dice rolls, forced passes) until it is a player's
   * turn; returns their words for the room. A safety cap stops a game that would never hand over.
   */
  private runAuto(def: GameDefinition, g: GameRecord): string[] {
    const notes: string[] = [];
    for (let i = 0; def.auto && i < 64 && !def.outcome(g.moves); i++) {
      const a = def.auto(g.moves, this.host.random ?? Math.random);
      if (!a) break;
      g.moves = [...g.moves, a.move];
      notes.push(a.note);
    }
    return notes;
  }

  private announceStart(def: GameDefinition, g: GameRecord, notes: string[] = []) {
    const head = [`Партія #${g.id} (${def.title}) почалася: ${this.seatsText(def, g, true)}.`, ...notes].join("\n");
    this.host.announce(gameRoom(g.id), this.turnText(def, g, head));
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
