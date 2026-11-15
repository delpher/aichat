// Mini-games over the broker: games are stored, every move goes through the rules, and each game has
// a chat room `game-<id>` where the broker (as the system sender "aichat") posts the board and whose
// players may also move by plain text: `move c3-d4`, `resign`, `draw`.
import type { GameInfo } from "../protocol.js";
import type { GameRecord, Store } from "./store.js";

export { SYSTEM_SENDER } from "../protocol.js";
export const GAME_ROOM_RE = /^game-(\d+)$/;
export const gameRoom = (id: number) => `game-${id}`;

export type Color = "w" | "b";
export type GameResult = NonNullable<GameInfo["result"]>;

/** What the broker needs from a game's rules; the state is always rebuilt from the list of moves. */
export interface GameRules {
  /** Checks `text` as the next move; returns it in canonical notation or throws with a readable reason. */
  play(moves: string[], text: string): string;
  turn(moves: string[]): Color;
  legalMoves(moves: string[]): string[];
  outcome(moves: string[]): GameResult | null;
  /** Text board for agents. */
  board(moves: string[]): string;
}

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
  rules: Record<string, GameRules>;
  isAgent(name: string): boolean;
  isHuman(name: string): boolean;
  /** Puts an agent into a room (and tells its live connections). */
  join(agent: string, room: string): void;
  /** Posts a message from the system sender to a room. */
  announce(room: string, text: string): void;
  /** Tells every connected client the game changed. */
  publish(game: GameRecord): void;
}

const colorName = (c: Color) => (c === "w" ? "білі" : "чорні");

export class Games {
  constructor(private host: GameHost) {}

  private rules(game: string): GameRules {
    const r = this.host.rules[game];
    if (!r) throw new GameError(`unknown game: ${game}`);
    return r;
  }

  get(id: number): GameRecord {
    const g = this.host.store.game(id);
    if (!g) throw new GameError(`unknown game: ${id}`, 404);
    return g;
  }

  list(status?: string): GameRecord[] {
    if (status && !["open", "active", "finished"].includes(status)) throw new GameError("status must be open, active or finished");
    return this.host.store.games({ status });
  }

  create(by: string, args: { game?: unknown; white?: unknown; black?: unknown }): GameRecord {
    const game = typeof args.game === "string" ? args.game : "checkers";
    this.rules(game);
    const seat = (v: unknown, color: string): string | null => {
      if (v == null || v === "") return null;
      if (typeof v !== "string" || !this.host.isAgent(v)) throw new GameError(`unknown ${color} player: ${String(v)}`, 404);
      return v;
    };
    const white = seat(args.white, "white");
    const black = seat(args.black, "black");
    if (!white && !black) throw new GameError("set white or black (or both)");
    if (white && white === black) throw new GameError("a player cannot play against themselves");
    // An agent may open a game for itself; only people may set up games they do not play in.
    if (white !== by && black !== by && !this.host.isHuman(by))
      throw new GameError("agents may only create games they play in", 403);
    const status = white && black ? "active" : "open";
    const g = this.host.store.createGame({ game, white, black, created_by: by, moves: [], status, result: null, draw_offer: null });
    const room = gameRoom(g.id);
    for (const n of new Set([white, black, by].filter((x): x is string => !!x))) this.host.join(n, room);
    if (status === "active") this.announceStart(g);
    else
      this.host.announce(
        room,
        `Партію #${g.id} (${game}) створив ${by}. ${white ? `Білими грає ${white}` : `Чорними грає ${black}`}; ` +
          `чекаємо суперника: приєднатися можна через join_game(${g.id}) або на сайті.`,
      );
    this.host.publish(g);
    return g;
  }

  join(by: string, id: number, color?: unknown): GameRecord {
    const g = this.get(id);
    if (g.status !== "open") throw new GameError("the game has already started", 409);
    if (g.white === by || g.black === by) throw new GameError("you are already in this game", 409);
    const free: Color = g.white ? "b" : "w";
    if (color != null && color !== free && color !== (free === "w" ? "white" : "black"))
      throw new GameError(`only ${free === "w" ? "white" : "black"} is free`, 409);
    if (free === "w") g.white = by;
    else g.black = by;
    g.status = "active";
    const saved = this.host.store.updateGame(g);
    this.host.join(by, gameRoom(id));
    this.announceStart(saved);
    this.host.publish(saved);
    return saved;
  }

  move(by: string, id: number, text: string): GameRecord {
    const g = this.activeFor(by, id);
    const rules = this.rules(g.game);
    const turn = rules.turn(g.moves);
    if ((turn === "w" ? g.white : g.black) !== by) throw new GameError(`it is ${colorName(turn)}' turn, not yours`, 409);
    let move: string;
    try {
      move = rules.play(g.moves, text);
    } catch (e) {
      throw new GameError((e as Error).message);
    }
    g.moves = [...g.moves, move];
    g.draw_offer = null;
    const result = rules.outcome(g.moves);
    if (result) this.finish(g, result);
    const saved = this.host.store.updateGame(g);
    this.host.announce(gameRoom(id), result ? this.finalText(saved) : this.turnText(saved, `${by}: ${move}`));
    this.host.publish(saved);
    return saved;
  }

  resign(by: string, id: number): GameRecord {
    const g = this.activeFor(by, id);
    this.finish(g, { winner: g.white === by ? "b" : "w", reason: "resign" });
    const saved = this.host.store.updateGame(g);
    this.host.announce(gameRoom(id), `${by} здається.\n${this.finalText(saved)}`);
    this.host.publish(saved);
    return saved;
  }

  /** Offers a draw, or accepts the opponent's offer. */
  draw(by: string, id: number): GameRecord {
    const g = this.activeFor(by, id);
    if (g.draw_offer && g.draw_offer !== by) {
      this.finish(g, { winner: null, reason: "agreement" });
      const saved = this.host.store.updateGame(g);
      this.host.announce(gameRoom(id), `${by} приймає нічию.\n${this.finalText(saved)}`);
      this.host.publish(saved);
      return saved;
    }
    g.draw_offer = by;
    const saved = this.host.store.updateGame(g);
    const other = g.white === by ? g.black : g.white;
    this.host.announce(gameRoom(id), `${by} пропонує нічию. ${other}, щоб погодитися, напишіть "draw"; щоб грати далі, просто ходіть.`);
    this.host.publish(saved);
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
    if (!g || (g.white !== from && g.black !== from)) return;
    try {
      if (cmd[2]) this.move(from, id, cmd[2].trim());
      else if (cmd[3]) this.resign(from, id);
      else this.draw(from, id);
    } catch (e) {
      const msg = (e as Error).message;
      // the rules may list the legal moves in the error already (checkers does)
      const legal = g.status === "active" && !/legal moves/i.test(msg) ? this.rules(g.game).legalMoves(g.moves) : [];
      this.host.announce(room, `${from}: ${msg}` + (legal.length ? `\nМожливі ходи: ${legal.join(", ")}` : ""));
    }
  }

  private activeFor(by: string, id: number): GameRecord {
    const g = this.get(id);
    if (g.white !== by && g.black !== by) throw new GameError("only the players can do this", 403);
    if (g.status !== "active") throw new GameError(g.status === "open" ? "the game has not started yet" : "the game is over", 409);
    return g;
  }

  private finish(g: GameRecord, result: GameResult) {
    g.status = "finished";
    g.result = result;
    g.draw_offer = null;
  }

  private announceStart(g: GameRecord) {
    this.host.announce(gameRoom(g.id), this.turnText(g, `Партія #${g.id} почалася: білі ${g.white}, чорні ${g.black}.`));
  }

  /** Board plus whose turn it is and the legal moves, so an agent can answer with one message. */
  private turnText(g: GameRecord, head: string): string {
    const rules = this.rules(g.game);
    const turn = rules.turn(g.moves);
    const player = turn === "w" ? g.white : g.black;
    return [
      head,
      "```",
      rules.board(g.moves),
      "```",
      `Хід ${colorName(turn)} (${player}). Можливі ходи: ${rules.legalMoves(g.moves).join(", ")}`,
      `Щоб походити, напишіть у цю кімнату: move <хід>, без reply_to. Також: resign, draw.`,
    ].join("\n");
  }

  private finalText(g: GameRecord): string {
    const rules = this.rules(g.game);
    const r = g.result!;
    const who = r.winner ? `Перемогли ${colorName(r.winner)} (${r.winner === "w" ? g.white : g.black})` : "Нічия";
    return [`Партію #${g.id} завершено. ${who}, причина: ${r.reason}.`, "```", rules.board(g.moves), "```"].join("\n");
  }
}
