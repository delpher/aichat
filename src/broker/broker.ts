import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { Store } from "./store.js";
import { VERSION } from "../version.js";
import { exportFileName, roomMarkdown, validTimeZone } from "../room-export.js";
import {
  SETTING_LIMITS,
  checkSettingsPatch,
  newToken,
  settingsOf,
  checkUpdateSettings,
  type AgentConfig,
  type BrokerConfig,
} from "./config.js";
import { Updater, UpdateError } from "./updater.js";
import { buildSetup, TOKEN_PLACEHOLDER } from "./setup.js";
import { agentGuide } from "./agent-guide.js";
import { GAME_ROOM_RE, GAME_SENDER, GameError, Games, SYSTEM_SENDER, gameRoom } from "./games.js";
import { greeting, groupByRoom, wakeNotice, wakeText, type WakeInfo } from "./wake.js";
import { GAMES, type GameDefinition } from "../games/index.js";
import { Board, BoardError } from "./board.js";
import { McpEndpoint } from "./mcp.js";
import { toolCatalog } from "./tools.js";
import { HookError, Hooks, TICK_MS } from "./hooks.js";
import { Context, ContextError } from "./context.js";
import { UsageError, accountHashes, checkUsage } from "./usage.js";
import {
  INLINE_IMAGE_TYPES,
  MAX_ATTACHMENTS,
  MAX_DESCRIPTION_LENGTH,
  MAX_REACTION_NOTES,
  MAX_STATUS_TOPIC,
  NAME_RE,
  REACTIONS,
  ROOM_RE,
  isReaction,
  isSystemSender,
  type AgentActivity,
  type AdapterInfo,
  type AgentInfo,
  type ChatMessage,
  type ClientFrame,
  type FileInfo,
  type GameInfo,
  type UsageReport,
  type ServerFrame,
  type WorldLimits,
  type AgentNote,
  type RoomBrief,
  type WorldIntro,
} from "../protocol.js";

/** An agent busy or waiting with no news for this long is taken to be idle. */
const ACTIVITY_TIMEOUT_MS = 30 * 60 * 1000;
const ACTIVITY_DETAIL_MAX = 200;
const ACTIVITY_TARGET_MAX = 80;

export class BrokerError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

export interface BrokerOptions {
  /** Returns the current config; called often, so it should be cheap. */
  config: () => BrokerConfig;
  store?: Store;
  log?: (msg: string) => void;
  /**
   * Applies `fn` to the raw config, saves it and returns the new config. Used by the web UI to change
   * settings and manage people. Without it those admin endpoints answer 403.
   */
  editConfig?: (fn: (raw: Partial<BrokerConfig>) => void) => BrokerConfig;
  /** Checks and installs new releases. Defaults to one that can only check (no launcher, no restart). */
  updater?: Updater;
  /** AIChat folder used in setup instructions when the `projectDir` setting is empty. */
  defaultProjectDir?: string;
  /** Folder with the built web UI (index.html, assets/). Defaults to `dist/web`. */
  webDir?: string;
  /** Folder with the bundled adapters. Defaults to `dist/bundle`. */
  bundleDir?: string;
  /** The games the broker hosts. Defaults to every game in src/games. */
  games?: GameDefinition[];
  /** Dice for games of chance, [0, 1); defaults to Math.random. */
  random?: () => number;
  /** Folder for uploaded files. Defaults to `files/` next to the database (a temp folder for `:memory:`). */
  filesDir?: string;
  /** Clock for wake decisions (absence length); defaults to Date.now. */
  now?: () => number;
}

/** The built web UI (`npm run build:web`, Vite output). */
const DEFAULT_WEB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "web");
/** Uploads that were never attached to a message are removed after this long. */
const UNATTACHED_FILE_TTL_MS = 24 * 60 * 60 * 1000;
const FILE_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;
/** How long a download link works: long enough for a download manager to start, short enough not to leak. */
const DOWNLOAD_LINK_MS = 5 * 60 * 1000;
const HERE = dirname(fileURLToPath(import.meta.url));
// dist/broker → dist/bundle; under `npm run dev:broker` (tsx, src/broker) the adapters are still in dist/bundle.
const DEFAULT_BUNDLE_DIR = [resolve(HERE, "..", "bundle"), resolve(HERE, "..", "..", "dist", "bundle")].find((d) => existsSync(d)) ?? resolve(HERE, "..", "bundle");
/** Single-file adapters served to agents' machines (built by scripts/bundle.mjs). */
const CLIENT_FILES = new Set(["claude-channel.mjs", "openai-agent.mjs", "aichat-hook.mjs", "opencode-channel.js", "codex-channel.mjs", "agy-channel.mjs", "aichat-manager.mjs", "manifest.json"]);

/** Who is using the admin API: a human agent with `admin: true`, by their own token. */
export interface AdminIdentity {
  name: string;
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".woff2": "font/woff2",
};

interface SendArgs {
  to?: string;
  room?: string;
  text: string;
  reply_to?: number;
  /** Ids of files the sender uploaded and has not attached yet. */
  attachments?: unknown;
  /**
   * One send intent: a retry with the same id (after a timeout, a lost connection) returns the message the
   * first send made instead of posting it twice. Reusing the id for a different message is refused.
   */
  request_id?: unknown;
}

export const REQUEST_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
/** How long a request id protects against a repeat. */
const SEND_KEY_TTL_MS = 24 * 60 * 60 * 1000;

/** A file name safe to store and to put in a Content-Disposition header. */
export function cleanFileName(raw: string | undefined): string {
  let name = raw ?? "";
  try {
    name = decodeURIComponent(name);
  } catch {
    /* keep it as sent */
  }
  name = name
    .replace(/^.*[\\/]/, "")
    .replace(/[\u0000-\u001f\u007f"]/g, "")
    .trim()
    .slice(0, 200);
  return name && name !== "." && name !== ".." ? name : "file";
}

function cleanMime(raw: string | undefined): string {
  const m = (raw ?? "").split(";")[0].trim().toLowerCase();
  return /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/.test(m) ? m : "application/octet-stream";
}

function safeEqual(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Routes messages between agents.
 * - WebSocket clients (Claude channel adapter, OpenAI adapter, CLI) get messages pushed live.
 * - Agents with a `webhook` get each message POSTed to them.
 * - Anything else can use the REST API (POST /api/messages, GET /api/inbox).
 * Messages for offline agents wait in SQLite and are delivered on reconnect.
 */
export class Broker {
  readonly store: Store;
  readonly updater: Updater;
  readonly games: Games;
  readonly board: Board;
  readonly hooks: Hooks;
  readonly context: Context;
  private sockets = new Map<string, Set<WebSocket>>();
  /** The adapter each participant socket named in its `auth` frame. Not stored: it lives with the connection. */
  private adapters = new Map<WebSocket, AdapterInfo>();
  /** Admin sockets (web UI) that see every message and presence change, with the admin's name. */
  /** Admin feed sockets; a human admin's feed also counts as that human being online. */
  private observers = new Map<WebSocket, string>();
  /** What agents report they are doing (memory only), and when each last reported. */
  /** What every client was last told about each agent's activity. */
  private activity = new Map<string, AgentActivity>();
  /** What the hooks report: state, tool, target. */
  private work = new Map<string, { state: AgentActivity["state"]; detail?: string; target?: string; since: string }>();
  /** What the agent says it works on (set_status). */
  private focus = new Map<string, { topic: string; room?: string; with?: string; since: string }>();
  /** The conversation of the agent's latest message, sent or received. */
  private lastConv = new Map<string, { room?: string; with?: string }>();
  private activityTouched = new Map<string, number>();
  /** The newest usage report of each agent (memory only: it lives while the broker runs). */
  private usage = new Map<string, UsageReport>();
  /** Agents whose Claude Code hooks have reported at least once: for them a delivery means "busy". */
  private hooked = new Set<string>();
  /**
   * The reaction notes offered to an agent and not yet confirmed: the message that carries them and the reaction
   * cursor its `delivered` moves to. One at a time: adapters may confirm out of order (a steered message before a
   * queued one, codex-alexey in AIChat-dev-team), and a later batch confirmed first must not skip an earlier one.
   * Forgotten when the agent connects again; whatever was not confirmed is offered anew.
   */
  private reactionOffer = new Map<string, { id: number; seq: number }>();
  private activityTimer?: NodeJS.Timeout;
  private hooksTimer?: NodeJS.Timeout;
  private sent = new Map<string, number[]>();
  private webhookChains = new Map<string, Promise<void>>();
  private retryTimer?: NodeJS.Timeout;
  private cleanupTimer?: NodeJS.Timeout;
  private configTimer?: NodeJS.Timeout;
  /** The AIChat tools over MCP (/mcp). */
  private mcp: McpEndpoint;
  /** The token each live socket authenticated with, to notice when it is no longer valid. */
  private socketTokens = new WeakMap<WebSocket, string>();
  private seenAgents?: AgentConfig[];
  private filesRoot?: string;
  private http?: Server;
  private wss?: WebSocketServer;
  private log: (msg: string) => void;

  constructor(private opts: BrokerOptions) {
    this.store = opts.store ?? new Store(opts.config().db);
    this.updater = opts.updater ?? new Updater({ config: () => this.cfg });
    this.games = new Games({
      store: this.store,
      games: opts.games ?? GAMES,
      // the keeper plays no games, so it has no rating either
      isAgent: (n) => this.cfg.agents.some((a) => a.name === n && !a.keeper),
      isHuman: (n) => this.cfg.agents.some((a) => a.name === n && a.kind === "human"),
      join: (agent, room) => {
        this.store.join(agent, room);
        this.notifyRooms(agent);
      },
      announce: (room, text) => this.announce(room, text, GAME_SENDER),
      notify: (to, text) => this.notify(to, text),
      publish: (game) => this.broadcast({ type: "game", game }),
      publishRatings: (game, ratings) => this.broadcast({ type: "ratings", game, ratings }),
      random: opts.random,
    });
    this.board = new Board({
      store: this.store,
      mayUse: (agent, room) => this.store.isMember(agent, room) || this.isAdminName(agent),
      mayRead: (agent) => this.isKeeper(agent),
      checkRoom: (room) => {
        if (!ROOM_RE.test(room)) throw new BrokerError(`invalid room name: ${room}`);
        if (GAME_ROOM_RE.test(room)) throw new BrokerError(`${room} is a game room; it has no brief`, 409);
        if (!this.store.roomExists(room)) throw new BrokerError(`unknown room: ${room}`, 404);
      },
      announce: (room, text) => this.announce(room, text),
      publishBrief: (room, brief) => this.publishRoom(room, { type: "brief", room, brief }),
    });
    this.context = new Context({
      store: this.store,
      limits: () => ({ maxNotes: this.cfg.maxNotes, maxNoteDescription: this.cfg.maxNoteDescription, maxNoteText: this.cfg.maxNoteText }),
      isHuman: (n) => this.cfg.agents.some((a) => a.name === n && a.kind === "human"),
      isAgent: (n) => this.cfg.agents.some((a) => a.name === n),
    });
    this.log = opts.log ?? ((m) => console.error(`[broker] ${m}`));
    this.hooks = new Hooks({
      store: this.store,
      now: () => this.now(),
      // hooks fire for AI agents and write to them; people and the keeper are neither (decisions 3 and 5)
      agents: () => this.cfg.agents.filter((a) => a.kind !== "human" && !a.keeper).map((a) => a.name),
      isOnline: (agent) => this.isOnline(agent),
      reportsActivity: (agent) => this.hooked.has(agent),
      notify: (to, text) => void this.notify(to, text),
      maxTextLength: () => this.cfg.maxTextLength,
      log: (line) => this.log(line),
    });
    this.mcp = new McpEndpoint({ host: this, version: VERSION, now: () => this.now(), log: (m) => this.log(m) });
    this.syncConfiguredRooms();
  }

  private get cfg() {
    const cfg = this.opts.config();
    // The config can change behind our back (agents.json edited, `npm run admin -- x --token`):
    // drop connections whose token or rights are gone.
    if (cfg.agents !== this.seenAgents) {
      this.seenAgents = cfg.agents;
      this.checkConnections(cfg.agents);
    }
    return cfg;
  }

  /** Closes live sockets whose agent was removed, whose token changed, or (admin feeds) who lost admin rights. */
  checkConnections(agents = this.cfg.agents) {
    const byName = new Map(agents.map((a) => [a.name, a]));
    const why = (ws: WebSocket, name: string, admin: boolean) => {
      const a = byName.get(name);
      if (!a) return "agent removed";
      if (!safeEqual(a.token, this.socketTokens.get(ws) ?? "")) return "token changed";
      if (admin && !(a.admin && a.kind === "human")) return "admin rights removed";
      return null;
    };
    for (const [name, set] of this.sockets)
      for (const ws of set) {
        const reason = why(ws, name, false);
        if (reason) ws.close(4003, reason);
      }
    for (const [ws, name] of this.observers) {
      const reason = why(ws, name, true);
      if (reason) ws.close(4003, reason);
    }
  }

  private syncConfiguredRooms() {
    for (const a of this.cfg.agents) for (const r of a.rooms ?? []) this.store.join(a.name, r);
  }

  authenticate(token: string | undefined): AgentConfig | undefined {
    if (!token) return undefined;
    const agent = this.cfg.agents.find((a) => safeEqual(a.token, token));
    if (agent) for (const r of agent.rooms ?? []) this.store.join(agent.name, r);
    return agent;
  }

  /** The admin behind a token: a human agent marked `admin: true`. */
  adminFor(token: string | undefined): AdminIdentity | undefined {
    if (!token) return undefined;
    const a = this.cfg.agents.find((x) => safeEqual(x.token, token));
    return a?.admin && a.kind === "human" ? { name: a.name } : undefined;
  }

  private admins(): string[] {
    return this.cfg.agents.filter((a) => a.admin && a.kind === "human").map((a) => a.name);
  }

  isAdmin(token: string | undefined): boolean {
    return !!this.adminFor(token);
  }

  // ---------------- core operations ----------------

  send(from: string, args: SendArgs): ChatMessage {
    let key: { id: string; hash: string } | undefined;
    if (args.request_id != null && args.request_id !== "") {
      if (typeof args.request_id !== "string" || !REQUEST_ID_RE.test(args.request_id))
        throw new BrokerError("request_id must be 1..128 characters: letters, digits, . _ : -");
      const { to, room, text, reply_to, attachments } = args;
      const hash = createHash("sha256").update(JSON.stringify([to ?? null, room ?? null, text ?? null, reply_to ?? null, attachments ?? null])).digest("hex");
      const earlier = this.store.sendKey(from, args.request_id);
      if (earlier) {
        if (earlier.hash !== hash) throw new BrokerError("request_id was already used for a different message", 409);
        const m = this.store.get(earlier.msg_id);
        if (m) return m;
      }
      key = { id: args.request_id, hash };
    }
    const msg = this.post(from, args);
    if (key) this.store.saveSendKey(from, key.id, key.hash, msg.id, new Date(this.now()).toISOString());
    return msg;
  }

  private post(from: string, args: SendArgs): ChatMessage {
    const cfg = this.cfg;
    const text = typeof args.text === "string" ? args.text : "";
    const attachments = this.claimableFiles(from, args.attachments);
    if (!text.trim() && !attachments.length) throw new BrokerError("text is empty");
    if (text.length > cfg.maxTextLength) throw new BrokerError(`text is longer than ${cfg.maxTextLength} characters`);
    if (!!args.to === !!args.room) throw new BrokerError("set exactly one of `to` (agent) or `room`");
    if (args.to) {
      // the system sender takes game commands in direct messages (secret moves, see Games.onDirect)
      if (args.to !== SYSTEM_SENDER && !cfg.agents.some((a) => a.name === args.to)) throw new BrokerError(`unknown agent: ${args.to}`, 404);
      if (args.to === from) throw new BrokerError("cannot send a message to yourself");
    }
    if (args.room) {
      if (!ROOM_RE.test(args.room)) throw new BrokerError(`invalid room name: ${args.room}`);
      this.checkGameRoom(args.room);
      this.checkNotKeeper(from);
      this.store.join(from, args.room);
    }

    let hops = 0;
    if (args.reply_to != null) {
      const parent = this.store.get(Number(args.reply_to));
      if (!parent || !this.canSee(from, parent)) throw new BrokerError(`unknown message: ${args.reply_to}`, 404);
      hops = parent.hops + 1;
      // moves in a game room are bounded by the game itself, not by the reply chain
      if (hops > cfg.maxHops && !(args.room && GAME_ROOM_RE.test(args.room)))
        throw new BrokerError(
          `hop limit reached (${cfg.maxHops}): this conversation was stopped to prevent an endless agent loop. ` +
            "Start a new message without reply_to only if a human asked you to continue.",
          429,
        );
    }

    this.checkRate(from);
    const msg = this.store.insert({ from, to: args.to, room: args.room, text, reply_to: args.reply_to, hops, attachments });
    this.noteConversation(from, msg.room ? { room: msg.room } : { with: msg.to });
    const files = attachments.length ? `, ${attachments.length} file(s)` : "";
    this.log(`#${msg.id} ${from} -> ${msg.to ?? "#" + msg.room} (hops ${hops}${files})`);
    this.deliver(msg);
    if (msg.room && GAME_ROOM_RE.test(msg.room)) this.games.onRoomMessage(from, msg.room, text);
    if (msg.to === SYSTEM_SENDER) {
      const answer = this.games.onDirect(from, text);
      if (answer) this.notify(from, answer);
    }
    this.hooks.realActivity(from);
    return msg;
  }

  /** A message from the broker to a room (as "aichat", or "gamemaster" in game rooms): no rate limit, no hops. */
  private announce(room: string, text: string, from = SYSTEM_SENDER): ChatMessage {
    const msg = this.store.insert({ from, room, text, hops: 0 });
    this.deliver(msg);
    return msg;
  }

  /**
   * A direct message from the system sender ("aichat") to one agent: no rate limit, no hops.
   * Stored like any message, so an agent that is offline gets it when it connects; callers that want
   * only connected agents to hear something check that first (see `connectedAgents`).
   */
  private notify(to: string, text: string): ChatMessage {
    const msg = this.store.insert({ from: SYSTEM_SENDER, to, text, hops: 0 });
    this.deliver(msg);
    return msg;
  }

  /** AI agents (not people) with a live connection of their own right now. */
  private connectedAgents(): string[] {
    return this.cfg.agents.filter((a) => a.kind !== "human" && (this.sockets.get(a.name)?.size ?? 0) > 0).map((a) => a.name);
  }

  /** A frame for a room's members and the admin feeds. */
  private publishRoom(room: string, f: ServerFrame) {
    for (const name of this.store.membersOf(room)) for (const ws of this.sockets.get(name) ?? []) this.sendFrame(ws, f);
    for (const ws of this.observers.keys()) this.sendFrame(ws, f);
  }

  private isAdminName(name: string): boolean {
    return this.cfg.agents.some((a) => a.name === name && a.admin && a.kind === "human");
  }

  /** A frame for every connected client, participants and admin feeds alike. */
  private broadcast(f: ServerFrame) {
    for (const set of this.sockets.values()) for (const ws of set) this.sendFrame(ws, f);
    for (const ws of this.observers.keys()) this.sendFrame(ws, f);
  }

  /** Checks `attachments` of a send request: ids of files `from` uploaded and has not attached yet. */
  private claimableFiles(from: string, raw: unknown): FileInfo[] {
    if (raw == null) return [];
    if (!Array.isArray(raw) || !raw.every((x) => typeof x === "string"))
      throw new BrokerError("attachments must be a list of file ids");
    const ids = [...new Set(raw as string[])];
    if (ids.length > MAX_ATTACHMENTS) throw new BrokerError(`at most ${MAX_ATTACHMENTS} files per message`);
    return ids.map((id) => {
      const f = FILE_ID_RE.test(id) ? this.store.file(id) : undefined;
      if (!f || f.uploader !== from) throw new BrokerError(`unknown file: ${id}`, 404);
      if (f.message_id != null) throw new BrokerError(`file ${id} is already attached to message #${f.message_id}`);
      return { id: f.id, name: f.name, mime: f.mime, size: f.size };
    });
  }

  // ---------------- files ----------------

  private get filesDir(): string {
    if (!this.filesRoot) {
      const db = this.cfg.db;
      this.filesRoot =
        this.opts.filesDir ??
        (db === ":memory:" ? mkdtempSync(join(tmpdir(), "aichat-files-")) : join(dirname(resolve(db)), "files"));
      mkdirSync(this.filesRoot, { recursive: true });
    }
    return this.filesRoot;
  }

  /** Streams an upload to disk; rejects it with 413 once it grows past maxFileSizeMB. */
  async upload(uploader: string, req: IncomingMessage): Promise<FileInfo> {
    const maxMB = this.cfg.maxFileSizeMB;
    const max = maxMB * 1024 * 1024;
    const tooLarge = () => new BrokerError(`file is larger than ${maxMB} MB`, 413);
    if (Number(req.headers["content-length"]) > max) throw tooLarge();
    const id = randomBytes(18).toString("base64url");
    const path = join(this.filesDir, id);
    let size = 0;
    try {
      await new Promise<void>((ok, fail) => {
        const out = createWriteStream(path);
        const stop = (e: Error) => {
          req.unpipe(out);
          out.destroy();
          req.resume(); // drain the rest so the client still gets the answer
          fail(e);
        };
        req.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > max) stop(tooLarge());
        });
        req.on("error", stop);
        out.on("error", stop);
        out.on("finish", () => ok());
        req.pipe(out);
      });
      if (!size) throw new BrokerError("file is empty");
    } catch (e) {
      await rm(path, { force: true });
      throw e;
    }
    const file: FileInfo = {
      id,
      name: cleanFileName(req.headers["x-filename"] as string | undefined),
      mime: cleanMime(req.headers["content-type"]),
      size,
    };
    this.store.addFile({ ...file, uploader });
    this.log(`${uploader} uploaded ${file.name} (${file.size} bytes) as ${id}`);
    return file;
  }

  /**
   * The file if `agent` may download it: its uploader may, and whoever can see the message it is attached to.
   * With `admin` the rules are an admin's: any room, but only their own direct messages.
   */
  private visibleFile(agent: string, id: string, admin = false): FileInfo | undefined {
    const f = FILE_ID_RE.test(id) ? this.store.file(id) : undefined;
    if (!f) return undefined;
    if (f.uploader === agent) return f;
    const m = f.message_id != null ? this.store.get(f.message_id) : undefined;
    return m && (admin ? this.adminCanSee(agent, m) : this.canSee(agent, m)) ? f : undefined;
  }

  // ---------------- download links ----------------
  // A browser or a download manager (Chrono, issue #61) cannot send the bearer token, and a blob: made by the page is
  // not theirs to read. So the web asks for a short link that carries its own proof: an HMAC over what it opens and
  // when it expires, with a key that lives only in this process.

  private readonly linkKey = randomBytes(32);

  private signLink(subject: string, exp: number): string {
    return createHmac("sha256", this.linkKey).update(`${subject}\n${exp}`).digest("base64url");
  }

  /** A path that opens `subject` without a token for DOWNLOAD_LINK_MS. */
  private downloadLink(path: string, subject: string, params: Record<string, string> = {}): { url: string; expires: string } {
    const exp = this.now() + DOWNLOAD_LINK_MS;
    const q = new URLSearchParams({ ...params, exp: String(exp), sig: this.signLink(subject, exp) });
    return { url: `${path}?${q}`, expires: new Date(exp).toISOString() };
  }

  /** Whether the link's signature covers `subject` and it has not expired. */
  private linkValid(url: URL, subject: string): boolean {
    const exp = Number(url.searchParams.get("exp"));
    const sig = Buffer.from(url.searchParams.get("sig") ?? "");
    if (!Number.isSafeInteger(exp) || exp < this.now()) return false;
    const want = Buffer.from(this.signLink(subject, exp));
    return sig.length === want.length && timingSafeEqual(sig, want);
  }

  private fileLink(f: FileInfo) {
    return this.downloadLink(`/dl/files/${encodeURIComponent(f.id)}`, `file:${f.id}`);
  }

  private exportLink(room: string, tz: string | null) {
    const zone = tz && validTimeZone(tz) ? tz : "UTC";
    return this.downloadLink(`/dl/rooms/${encodeURIComponent(room)}`, `room:${room}:${zone}`, { tz: zone });
  }

  /** GET /dl/files/<id> and /dl/rooms/<room>: what a download link opens, always as a file to save. */
  private async onDownload(url: URL, res: ServerResponse, reply: (status: number, body: unknown) => void) {
    const file = url.pathname.match(/^\/dl\/files\/([^/]+)$/);
    const room = url.pathname.match(/^\/dl\/rooms\/([^/]+)$/);
    let name: string;
    try {
      name = decodeURIComponent((file ?? room)?.[1] ?? "");
    } catch {
      return reply(404, { error: "not found" });
    }
    if (file) {
      if (!this.linkValid(url, `file:${name}`)) return reply(403, { error: "the download link is wrong or has expired" });
      const f = FILE_ID_RE.test(name) ? this.store.file(name) : undefined;
      if (!f) return reply(404, { error: "unknown file" });
      return await this.serveFile(f, res, true);
    }
    if (room) {
      const tz = url.searchParams.get("tz") ?? "";
      if (!this.linkValid(url, `room:${name}:${tz}`)) return reply(403, { error: "the download link is wrong or has expired" });
      if (!this.store.roomExists(name)) return reply(404, { error: `unknown room: ${name}` });
      const messages: ChatMessage[] = [];
      for (let before: number | undefined; ; ) {
        const page = this.store.allMessages({ room: name, before, limit: 500 });
        messages.unshift(...page);
        if (page.length < 500) break;
        before = page[0].id;
      }
      const now = new Date(this.now());
      const text = roomMarkdown(name, messages, this.store.brief(name), now, tz);
      res.writeHead(200, {
        "content-type": "text/markdown; charset=utf-8",
        "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(exportFileName(name, now, tz))}`,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      });
      return res.end(text);
    }
    return reply(404, { error: "not found" });
  }

  private async serveFile(f: FileInfo, res: ServerResponse, download = false) {
    const path = join(this.filesDir, f.id);
    const st = await stat(path).catch(() => undefined);
    if (!st) throw new BrokerError("file not found", 404);
    const inline = !download && INLINE_IMAGE_TYPES.includes(f.mime);
    res.writeHead(200, {
      "content-type": inline ? f.mime : "application/octet-stream",
      "content-length": st.size,
      "content-disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(f.name)}`,
      "cache-control": "private, max-age=86400",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
    });
    await new Promise<void>((ok) => {
      const src = createReadStream(path);
      src.on("error", () => (res.destroy(), ok()));
      res.on("close", () => ok());
      src.pipe(res);
    });
  }

  /** Deletes uploads never attached within a day, and files whose message was deleted. */
  async cleanFiles(now = Date.now()): Promise<number> {
    this.store.pruneSendKeys(new Date(now - SEND_KEY_TTL_MS).toISOString());
    const stale = this.store.staleFiles(new Date(now - UNATTACHED_FILE_TTL_MS).toISOString());
    for (const id of stale) {
      await rm(join(this.filesDir, id), { force: true });
      this.store.deleteFile(id);
    }
    return stale.length;
  }

  private canSee(agent: string, m: ChatMessage) {
    if (m.room) return this.store.isMember(agent, m.room);
    return m.from === agent || m.to === agent;
  }

  /** Admins read every room, but direct messages only when they are one of the two sides. */
  private adminCanSee(admin: string, m: ChatMessage) {
    return !!m.room || m.from === admin || m.to === admin;
  }

  private checkRate(agent: string) {
    // the keeper writes to everyone who wakes up: it is part of the environment, not a participant
    if (this.isKeeper(agent)) return;
    const now = Date.now();
    const recent = (this.sent.get(agent) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= this.cfg.ratePerMinute)
      throw new BrokerError(`rate limit: at most ${this.cfg.ratePerMinute} messages per minute`, 429);
    recent.push(now);
    this.sent.set(agent, recent);
  }

  join(agent: string, room: string) {
    if (!ROOM_RE.test(room)) throw new BrokerError(`invalid room name: ${room}`);
    this.checkGameRoom(room);
    this.checkNotKeeper(agent);
    this.store.join(agent, room);
    this.notifyObservers({ type: "rooms_changed" });
  }

  isKeeper(name: string): boolean {
    return this.cfg.agents.some((a) => a.name === name && a.keeper);
  }

  /** The keeper is in no room: what it needs of rooms comes from the broker (briefs, the wake-up diff). */
  private checkNotKeeper(agent: string) {
    if (this.isKeeper(agent)) throw new BrokerError(`${agent} is the keeper: it takes part in no room`, 403);
  }

  /** A game room exists only while its game does: no one may bring back the room of a deleted game. */
  private checkGameRoom(room: string) {
    const m = room.match(GAME_ROOM_RE);
    if (m && !this.store.game(Number(m[1]))) throw new BrokerError(`no game ${m[1]}, so no room ${room}`, 404);
  }

  leave(agent: string, room: string) {
    this.store.leave(agent, room);
    // otherwise the configured room would put the agent back on its next connection
    if (this.opts.editConfig && this.cfg.agents.find((a) => a.name === agent)?.rooms?.includes(room))
      this.opts.editConfig((raw) => {
        const a = raw.agents?.find((x) => x.name === agent);
        if (!a?.rooms) return;
        a.rooms = a.rooms.filter((r) => r !== room);
        if (!a.rooms.length) delete a.rooms;
      });
    this.notifyObservers({ type: "rooms_changed" });
  }

  /** Online = a live participant socket, a human admin's feed socket, or a webhook. */
  private isOnline(name: string): boolean {
    if ((this.sockets.get(name)?.size ?? 0) > 0) return true;
    for (const who of this.observers.values()) if (who === name) return true;
    return !!this.cfg.agents.find((a) => a.name === name)?.webhook;
  }

  /** The adapter of an agent's newest live connection that named one. */
  private adapterOf(name: string): AdapterInfo | undefined {
    let found: AdapterInfo | undefined;
    for (const ws of this.sockets.get(name) ?? []) found = this.adapters.get(ws) ?? found;
    return found;
  }

  /** Runs a change to an agent's connections and broadcasts presence if its online state or adapter changed. */
  private trackPresence(name: string, change: () => void) {
    const before = this.isOnline(name);
    const adapterBefore = this.adapterOf(name);
    change();
    const after = this.isOnline(name);
    const adapter = this.adapterOf(name);
    if (before !== after || !sameAdapter(adapterBefore, adapter))
      this.broadcastPresence(name, after, adapter);
    if (before !== after) this.hooks.presence(name, after);
    // an agent that went away is not working on anything we can see, and its session's topic ended with it
    if (!after) {
      this.focus.delete(name);
      this.lastConv.delete(name);
      this.setActivity(name, "idle");
      this.publishActivity(name);
    }
  }

  /** The current limits of the world, as agents see them next to the intro. */
  /** The intro as it is now (world_info, GET /api/intro). */
  intro(): WorldIntro {
    return this.context.intro();
  }

  worldLimits(): WorldLimits {
    const { maxHops, ratePerMinute, maxTextLength, maxFileSizeMB } = this.cfg;
    return { maxHops, ratePerMinute, maxTextLength, maxFileSizeMB };
  }

  agents(): AgentInfo[] {
    const thanks = this.store.thanksReceived();
    return this.cfg.agents.map((a) => {
      const activity = this.activity.get(a.name);
      const got = thanks.get(a.name);
      const adapter = this.adapterOf(a.name);
      return {
        name: a.name,
        kind: a.kind,
        ...(a.description ? { description: a.description } : {}),
        online: this.isOnline(a.name),
        rooms: this.store.roomsOf(a.name),
        ...(activity ? { activity } : {}),
        ...(adapter ? { adapter } : {}),
        ...(got ? { thanks: got } : {}),
        ...(a.keeper ? { keeper: true as const } : {}),
      };
    });
  }

  // ---------------- activity and delivery ----------------

  /**
   * An agent's activity is put together from three sources: what its hooks report (state, tool, target),
   * what it says it works on (topic and place, set_status), and the conversation of its latest message,
   * which stands in for the place when it named none.
   */
  private composeActivity(agent: string): AgentActivity | undefined {
    const work = this.work.get(agent);
    const focus = this.focus.get(agent);
    if (!work && !focus) return undefined;
    const where = focus?.room || focus?.with ? focus : this.lastConv.get(agent);
    return {
      state: work?.state ?? "idle",
      ...(work?.detail ? { detail: work.detail } : {}),
      ...(work?.target ? { target: work.target } : {}),
      ...(focus?.topic ? { topic: focus.topic } : {}),
      ...(where?.room ? { room: where.room } : where?.with ? { with: where.with } : {}),
      since: work?.since ?? focus!.since,
    };
  }

  /** Tells every client the agent's activity, when it differs from what they were told last. */
  private publishActivity(agent: string) {
    const activity = this.composeActivity(agent);
    const before = this.activity.get(agent);
    if (JSON.stringify(activity) === JSON.stringify(before)) return;
    if (activity) this.activity.set(agent, activity);
    else this.activity.delete(agent);
    const f: ServerFrame = { type: "activity", agent, activity: activity ?? { state: "idle", since: new Date().toISOString() } };
    for (const set of this.sockets.values()) for (const ws of set) this.sendFrame(ws, f);
    for (const ws of this.observers.keys()) this.sendFrame(ws, f);
  }

  /** Records what an agent is doing (from its hooks or adapter) and tells every client when that changed. */
  setActivity(agent: string, state: AgentActivity["state"], detail?: string, target?: string) {
    this.hooks.activity(agent, state);
    const cur = this.work.get(agent);
    if (state === "idle" && (!cur || cur.state === "idle") && !this.focus.has(agent)) return;
    this.activityTouched.set(agent, Date.now());
    // the clock runs from when the state began, not from the latest tool
    const since = cur && cur.state === state ? cur.since : new Date().toISOString();
    this.work.set(agent, { state, ...(detail ? { detail } : {}), ...(target ? { target } : {}), since });
    this.publishActivity(agent);
  }

  /** The conversation an agent last wrote in or received from: where it works unless it named a place. */
  private noteConversation(agent: string, where: { room?: string; with?: string }) {
    const cur = this.lastConv.get(agent);
    if (cur?.room === where.room && cur?.with === where.with) return;
    this.lastConv.set(agent, where);
    if (this.work.has(agent) || this.focus.has(agent)) this.publishActivity(agent);
  }

  /** POST /api/activity from a Claude Code hook: {state, detail?, target?}. */
  private reportActivity(agent: string, b: Record<string, unknown>): AgentActivity {
    const state = b.state;
    if (state !== "idle" && state !== "busy" && state !== "waiting") throw new BrokerError("state must be idle, busy or waiting");
    if (b.detail != null && typeof b.detail !== "string") throw new BrokerError("detail must be a string");
    if (b.target != null && typeof b.target !== "string") throw new BrokerError("target must be a string");
    const detail = typeof b.detail === "string" ? b.detail.trim().slice(0, ACTIVITY_DETAIL_MAX) : undefined;
    const target = typeof b.target === "string" ? b.target.trim().replace(/\s+/g, " ").slice(0, ACTIVITY_TARGET_MAX) : undefined;
    this.hooked.add(agent);
    this.setActivity(agent, state, detail || undefined, target || undefined);
    return this.activity.get(agent) ?? { state: "idle", since: new Date().toISOString() };
  }

  /**
   * POST /api/status: what the agent works on and where, in its own words: {topic, room?} or {topic, with?}.
   * An empty topic clears it. Without a place, the conversation of its latest message is used.
   */
  reportStatus(agent: string, b: Record<string, unknown>): AgentActivity | null {
    if (typeof b.topic !== "string") throw new BrokerError("topic must be a string (empty to clear)");
    const topic = b.topic.trim().replace(/\s+/g, " ");
    if (topic.length > MAX_STATUS_TOPIC) throw new BrokerError(`topic is longer than ${MAX_STATUS_TOPIC} characters`);
    if (b.room != null && b.with != null) throw new BrokerError("set `room` or `with`, not both");
    const room = typeof b.room === "string" && b.room ? b.room.replace(/^#/, "") : undefined;
    const peer = typeof b.with === "string" && b.with ? b.with.replace(/^@/, "") : undefined;
    if (room && !this.store.isMember(agent, room)) throw new BrokerError(`you are not in room ${room}`, 403);
    if (peer && !this.cfg.agents.some((a) => a.name === peer)) throw new BrokerError(`unknown agent: ${peer}`, 404);
    if (topic) this.hooks.realActivity(agent);
    if (!topic) this.focus.delete(agent);
    else this.focus.set(agent, { topic, ...(room ? { room } : peer ? { with: peer } : {}), since: new Date().toISOString() });
    this.activityTouched.set(agent, Date.now());
    this.publishActivity(agent);
    return this.activity.get(agent) ?? null;
  }

  /** Busy or waiting with no news for a long time: the hook that would have said "idle" never ran. */
  private expireActivity() {
    const cutoff = Date.now() - ACTIVITY_TIMEOUT_MS;
    for (const [agent, a] of this.activity)
      if (a.state !== "idle" && (this.activityTouched.get(agent) ?? 0) < cutoff) this.setActivity(agent, "idle");
  }

  /** The adapter of `agent` passed message `id` into its session. */
  private markDelivered(agent: string, id: number) {
    const m = this.store.get(id);
    if (!m) throw new BrokerError(`unknown message: ${id}`, 404);
    if (!this.recipients(m).includes(agent)) throw new BrokerError(`message ${id} was not sent to you`, 403);
    const offer = this.reactionOffer.get(agent);
    if (offer?.id === id) {
      this.reactionOffer.delete(agent);
      this.store.markReactionsSeen(agent, offer.seq);
    }
    if (!this.store.markDelivered(id, agent)) return;
    const f: ServerFrame = { type: "delivered", id, to: agent };
    for (const ws of this.sockets.get(m.from) ?? []) this.sendFrame(ws, f);
    for (const [ws, who] of this.observers) if (this.adminCanSee(who, m)) this.sendFrame(ws, f);
    // the session now reads it; hooks report the rest (no hook runs for a channel message itself)
    this.noteConversation(agent, m.room ? { room: m.room } : { with: m.from });
    const cur = this.work.get(agent);
    if (this.hooked.has(agent) && (!cur || cur.state === "idle")) this.setActivity(agent, "busy", "читає повідомлення");
  }

  /**
   * `by` thanks the author of message `id`. Only someone who can see the message may thank, never for their own
   * message or one from the broker itself, and only once. Everyone who can see the message hears of it.
   */
  thank(by: string, id: number, viewer: { admin?: boolean } = {}): string[] {
    const m = this.store.get(id);
    if (!m || !(viewer.admin ? this.adminCanSee(by, m) : this.canSee(by, m))) throw new BrokerError(`unknown message: ${id}`, 404);
    if (m.from === by) throw new BrokerError("you cannot thank yourself", 400);
    if (isSystemSender(m.from)) throw new BrokerError(`messages from ${m.from} cannot be thanked`, 400);
    if (this.isKeeper(m.from)) throw new BrokerError(`${m.from} is the keeper, part of AIChat itself: its messages are not thanked`, 400);
    if (!this.store.addThanks(id, by)) throw new BrokerError(`you already thanked for message ${id}`, 409);
    const thanked_by = this.store.thanksFor(id);
    const f: ServerFrame = { type: "thanks", id, author: m.from, by, thanked_by };
    for (const name of new Set([m.from, ...this.recipients(m)])) for (const ws of this.sockets.get(name) ?? []) this.sendFrame(ws, f);
    for (const [ws, who] of this.observers) if (this.adminCanSee(who, m)) this.sendFrame(ws, f);
    return thanked_by;
  }

  /**
   * `by` puts (`on`) or takes back an `emoji` on message `id`. Anyone who can see a message may react to it, also to
   * messages from the broker and the keeper, but not to their own. Putting one twice or taking back one that is not
   * there changes nothing. A reaction is not a message: it wakes no one and is no activity for hooks; everyone who
   * can see the message hears of it, and the author's agent learns of it with its next message (messageFrame).
   */
  react(by: string, id: number, raw: unknown, on: boolean, viewer: { admin?: boolean } = {}): Record<string, string[]> {
    const m = this.store.get(id);
    if (!m || !(viewer.admin ? this.adminCanSee(by, m) : this.canSee(by, m))) throw new BrokerError(`unknown message: ${id}`, 404);
    const emoji = (raw as { emoji?: unknown } | null)?.emoji;
    if (!isReaction(emoji)) throw new BrokerError(`emoji must be one of ${REACTIONS.join(" ")}`);
    if (m.from === by) throw new BrokerError("you cannot react to your own message", 400);
    const changed = on ? this.store.addReaction(id, by, emoji) : this.store.removeReaction(id, by, emoji);
    const reactions = this.store.reactionsFor(id);
    if (!changed) return reactions;
    const f: ServerFrame = { type: "reaction", id, author: m.from, by, emoji, on, reactions };
    for (const name of new Set([m.from, ...this.recipients(m)])) for (const ws of this.sockets.get(name) ?? []) this.sendFrame(ws, f);
    for (const [ws, who] of this.observers) if (this.adminCanSee(who, m)) this.sendFrame(ws, f);
    return reactions;
  }

  history(agent: string, q: { room?: string; with?: string; limit?: number; before?: number }): ChatMessage[] {
    const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 500);
    const before = q.before != null && String(q.before) !== "" ? Number(q.before) : undefined;
    if (before !== undefined && !(before > 0)) throw new BrokerError("`before` must be a positive message id");
    if (q.room) {
      if (!this.store.isMember(agent, q.room)) throw new BrokerError(`you are not in room ${q.room}`, 403);
      return this.store.allMessages({ room: q.room, before, limit });
    }
    if (q.with) {
      if (!NAME_RE.test(q.with)) throw new BrokerError(`invalid agent name: ${q.with}`);
      return this.store.allMessages({ a: agent, b: q.with, before, limit });
    }
    throw new BrokerError("set `room` or `with`");
  }

  /**
   * Text search over the history, limited to what the viewer may read: an agent its rooms and direct messages,
   * an admin every room and their own direct messages.
   */
  search(p: URLSearchParams, viewer: string | { admin: string }): ChatMessage[] {
    const text = (p.get("q") ?? "").trim();
    if (text.length < 2) throw new BrokerError("`q` must be at least 2 characters");
    if (text.length > 200) throw new BrokerError("`q` is longer than 200 characters");
    const room = p.get("room") || undefined;
    const agent = p.get("agent") || undefined;
    if (room && !ROOM_RE.test(room)) throw new BrokerError(`invalid room name: ${room}`);
    if (agent && !NAME_RE.test(agent)) throw new BrokerError(`invalid agent name: ${agent}`);
    const before = p.get("before") ? Number(p.get("before")) : undefined;
    if (before !== undefined && !(before > 0)) throw new BrokerError("`before` must be a positive message id");
    const limit = Math.min(Math.max(Number(p.get("limit")) || 30, 1), 100);
    const who = typeof viewer === "string" ? { viewer } : { dmsOf: viewer.admin };
    return this.store.search({ text, ...who, room, agent, before, limit });
  }

  /** What one agent may see: its rooms, its direct conversations, everyone's presence. */
  overview(agent: AgentConfig) {
    return {
      me: { name: agent.name, kind: agent.kind },
      agents: this.agents(),
      rooms: this.store.rooms(agent.name),
      dms: this.store.dms(agent.name),
      all_rooms: this.store.allRoomNames(),
      // Reply chains stop at this length; the web UI marks chains that reached it.
      max_hops: this.cfg.maxHops,
      // The newest adapter is built with the broker: an adapter older than this should be updated.
      version: VERSION,
    };
  }

  /** Tells an agent's live connections its new room list (and, by default, admin observers that rooms changed). */
  private notifyRooms(agent: string, observers = true) {
    const f: ServerFrame = { type: "rooms", rooms: this.store.roomsOf(agent) };
    for (const ws of this.sockets.get(agent) ?? []) this.sendFrame(ws, f);
    if (observers) this.notifyObservers({ type: "rooms_changed" });
  }

  private notifyObservers(f: ServerFrame) {
    for (const ws of this.observers.keys()) this.sendFrame(ws, f);
  }

  /** Drops every live connection of an agent (after its token changed or it was removed). */
  private disconnect(name: string, reason: string) {
    for (const ws of this.sockets.get(name) ?? []) ws.close(4003, reason);
    this.disconnectObserver(name, reason);
  }

  /** Drops the admin feed of a human admin (rights removed, token changed, removed). */
  private disconnectObserver(name: string, reason: string) {
    for (const [ws, who] of this.observers) if (who === name) ws.close(4003, reason);
  }

  /** Pending messages for a polling agent; marks them delivered. */
  inbox(agent: string): ChatMessage[] {
    const msgs = this.store.pendingFor(agent);
    if (msgs.length) this.store.setCursor(agent, msgs[msgs.length - 1].id);
    return msgs;
  }

  // ---------------- delivery ----------------

  private recipients(m: ChatMessage): string[] {
    if (m.to) return [m.to];
    return this.store.membersOf(m.room!).filter((a) => a !== m.from);
  }

  /**
   * The message frame for agent `name`: with the reactions to its own messages it has not been told about yet
   * (decided in AIChat-dev-team 2428/2430). They ride on a message the agent gets anyway and never wake it.
   */
  private messageFrame(name: string, m: ChatMessage): ServerFrame {
    if (this.reactionOffer.has(name)) return { type: "message", message: m };
    const { notes } = this.store.unseenReactions(name, MAX_REACTION_NOTES);
    if (!notes.length) return { type: "message", message: m };
    this.reactionOffer.set(name, { id: m.id, seq: notes[notes.length - 1].seq });
    return { type: "message", message: m, reactions_since: notes.map(({ seq: _seq, ...n }) => n) };
  }

  private deliver(m: ChatMessage) {
    for (const [ws, who] of this.observers) if (this.adminCanSee(who, m)) this.sendFrame(ws, { type: "message", message: m });
    for (const name of this.recipients(m)) {
      const socks = this.sockets.get(name);
      if (socks?.size) {
        const frame = this.messageFrame(name, m);
        for (const ws of socks) this.sendFrame(ws, frame);
        this.store.setCursor(name, m.id);
        continue;
      }
      const agent = this.cfg.agents.find((a) => a.name === name);
      if (agent?.webhook) this.flushWebhook(agent);
      // otherwise it stays pending until the agent connects or polls
    }
  }

  private flushWebhook(agent: AgentConfig): Promise<void> {
    const prev = this.webhookChains.get(agent.name) ?? Promise.resolve();
    const next = prev.then(async () => {
      for (const m of this.store.pendingFor(agent.name, 100)) {
        try {
          const res = await fetch(agent.webhook!, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${agent.token}` },
            body: JSON.stringify({ type: "message", message: m }),
            signal: AbortSignal.timeout(10_000),
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          this.store.setCursor(agent.name, m.id);
        } catch (e) {
          this.log(`webhook for ${agent.name} failed (${(e as Error).message}); will retry`);
          return;
        }
      }
    });
    this.webhookChains.set(agent.name, next);
    return next;
  }

  /** Flushes every webhook agent; used by tests and the retry timer. */
  async flushWebhooks() {
    await Promise.all(this.cfg.agents.filter((a) => a.webhook).map((a) => this.flushWebhook(a)));
  }

  private sendFrame(ws: WebSocket, f: ServerFrame) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(f));
  }

  private broadcastPresence(agent: string, online: boolean, adapter?: AdapterInfo) {
    const f: ServerFrame = { type: "presence", agent, online, ...(adapter ? { adapter } : {}) };
    for (const set of this.sockets.values()) for (const ws of set) this.sendFrame(ws, f);
    for (const ws of this.observers.keys()) this.sendFrame(ws, f);
  }

  // ---------------- WebSocket ----------------

  private onConnection(ws: WebSocket) {
    let agent: AgentConfig | undefined;
    let observer = false;
    const authTimer = setTimeout(() => !agent && !observer && ws.close(4001, "auth timeout"), 10_000);
    let alive = true;
    ws.on("pong", () => (alive = true));
    const heartbeat = setInterval(() => {
      if (!alive) return ws.terminate();
      alive = false;
      ws.ping();
    }, 30_000);

    ws.on("message", (data) => {
      let f: ClientFrame;
      try {
        f = JSON.parse(String(data));
      } catch {
        return this.sendFrame(ws, { type: "error", error: "invalid JSON" });
      }
      const ref = f.ref;
      if (observer) {
        if (f.type === "ping") return this.sendFrame(ws, { type: "pong", ref });
        return this.sendFrame(ws, { type: "error", error: "admin sockets are read-only; use POST /admin/api/messages", ref });
      }
      if (!agent) {
        if (f.type !== "auth") return this.sendFrame(ws, { type: "error", error: "authenticate first", ref });
        const admin = this.adminFor(f.token);
        if (admin && f.observer) {
          observer = true;
          clearTimeout(authTimer);
          this.sendFrame(ws, { type: "welcome", agent: admin.name, rooms: [], observer: true, ref });
          this.socketTokens.set(ws, f.token);
          this.trackPresence(admin.name, () => this.observers.set(ws, admin.name));
          this.log(`admin observer ${admin.name} connected`);
          return;
        }
        if (f.observer) {
          this.sendFrame(ws, { type: "error", error: "this token has no admin rights", ref });
          return ws.close(4003, "not an admin");
        }
        agent = this.authenticate(f.token);
        if (!agent) {
          this.sendFrame(ws, { type: "error", error: "invalid token", ref });
          return ws.close(4003, "invalid token");
        }
        clearTimeout(authTimer);
        const name = agent.name;
        this.sendFrame(ws, { type: "welcome", agent: name, rooms: this.store.roomsOf(name), ref });
        const pending = this.store.pendingFor(name);
        // coming back from offline, it may be woken: the room messages it missed are not sent but reported
        const wake = this.sockets.get(name)?.size ? undefined : this.wakeFor(agent, pending);
        // a new adapter session is greeted, a dropped connection of the same session is not (alexey, 1703)
        const fresh = this.newSession(agent, f.session);
        // a new connection: reactions offered before and never confirmed are offered again
        if (!this.sockets.get(name)?.size) this.reactionOffer.delete(name);
        for (const m of wake ? pending.filter((p) => !wake.skipped.has(p.id)) : pending) this.sendFrame(ws, this.messageFrame(name, m));
        if (pending.length) this.store.setCursor(name, pending[pending.length - 1].id);
        const client = adapterInfo(f.client);
        this.trackPresence(name, () => {
          if (!this.sockets.has(name)) this.sockets.set(name, new Set());
          this.sockets.get(name)!.add(ws);
          this.socketTokens.set(ws, f.token);
          if (client) this.adapters.set(ws, client);
        });
        this.log(`${name} connected`);
        if (wake) {
          const sent = !wake.skipped.size;
          this.log(`${name} woke after ${wake.info.away}s: ${wake.info.missed} room messages ${sent ? "sent" : "not sent"}`);
          this.brief(wake.info, sent);
          for (const fn of this.wakeListeners) fn(wake.info);
        } else if (fresh) {
          this.log(`${name} started a new session: greeted`);
          this.notify(name, greeting(name));
        }
        return;
      }
      try {
        this.sendFrame(ws, this.handleFrame(agent.name, f));
      } catch (e) {
        this.sendFrame(ws, { type: "error", error: (e as Error).message, ref });
      }
    });

    ws.on("close", () => {
      clearTimeout(authTimer);
      clearInterval(heartbeat);
      const who = this.observers.get(ws);
      if (who) this.trackPresence(who, () => this.observers.delete(ws));
      if (!agent) return;
      const name = agent.name;
      this.trackPresence(name, () => {
        const set = this.sockets.get(name);
        set?.delete(ws);
        if (set && set.size === 0) this.sockets.delete(name);
        this.adapters.delete(ws);
      });
      // the last connection is gone: remember when, to know on its return how long it was away
      if (!this.sockets.has(name) && !this.closing) this.store.setLastSeen(name, new Date(this.now()).toISOString());
      this.log(`${agent.name} disconnected`);
    });
  }

  // ---------------- waking (І2) ----------------

  private wakeListeners = new Set<(w: WakeInfo) => void>();
  /** close() has begun: the store may be gone before the sockets' close events arrive. */
  private closing = false;

  /**
   * A woken agent's brief (stage В): the broker always tells the agent itself how long it was away, how much it
   * missed where and how to wake up; when it missed room messages and the keeper is connected, the keeper also
   * gets the diff and writes the agent a retelling.
   */
  private brief(w: WakeInfo, streamSent: boolean) {
    const k = this.cfg.agents.find((a) => a.keeper);
    const keeper = k && w.missed && this.sockets.get(k.name)?.size ? k.name : undefined;
    this.notify(w.agent, wakeNotice(w, { streamSent, keeper }, { notes: this.store.notes(w.agent), intro: this.context.intro() }));
    if (keeper) this.notify(keeper, wakeText(w));
  }

  /**
   * Whether an agent's connection starts a new adapter session, which gets a greeting: the adapter sends the same
   * `session` on every connection of one process. People, webhooks and the keeper are never greeted, and neither
   * is an adapter that sends no session (before 0.9): it is still woken after a long absence.
   */
  private newSession(agent: AgentConfig, session: unknown): boolean {
    if (agent.kind === "human" || agent.webhook || agent.keeper) return false;
    if (typeof session !== "string" || !session || session.length > 100) return false;
    return this.store.newSession(agent.name, session);
  }

  /** Called whenever an agent is woken (after its brief is on its way); returns an unsubscribe function. */
  onWake(fn: (w: WakeInfo) => void): () => void {
    this.wakeListeners.add(fn);
    return () => void this.wakeListeners.delete(fn);
  }

  private now() {
    return (this.opts.now ?? Date.now)();
  }

  /**
   * Whether an agent coming back is woken, given what is pending for it: wake mode is on, it is an agent
   * (not a person or a webhook), and it was away long enough or missed enough room messages. Nothing missed
   * still wakes it after a long absence: an agent only acts when a message comes, and a new session needs one
   * to look around (alexey, 1677).
   * Direct messages and game rooms are always delivered; the rest is skipped and reported.
   */
  private wakeFor(agent: AgentConfig, pending: ChatMessage[]): { info: WakeInfo; skipped: Set<number> } | undefined {
    const cfg = this.cfg;
    // the keeper gets missed rooms only as diffs; people, webhooks and the keeper are never woken
    if (cfg.wakeMode === "off" || agent.kind === "human" || agent.webhook || agent.keeper) return undefined;
    const missed = pending.filter((m) => m.room && !GAME_ROOM_RE.test(m.room));
    const since = this.store.lastSeen(agent.name);
    // never seen leaving: a first connection, which gets only the intro (alexey, 1342)
    if (!since) return undefined;
    const away = Math.max(0, Math.round((this.now() - Date.parse(since)) / 1000));
    if (away < cfg.wakeAfterMinutes * 60 && missed.length < cfg.wakeAfterMessages) return undefined;
    return {
      info: {
        agent: agent.name,
        away,
        missed: missed.length,
        rooms: groupByRoom(missed),
        thanks: this.store.thanksSince(agent.name, since),
      },
      // В1 ("brief") still sends the stream, to judge the briefs against it; В2 ("on") replaces it
      skipped: new Set(cfg.wakeMode === "on" ? missed.map((m) => m.id) : []),
    };
  }

  private handleFrame(agent: string, f: ClientFrame): ServerFrame {
    const ref = f.ref;
    switch (f.type) {
      case "send":
        return { type: "ack", id: this.send(agent, f).id, ref };
      case "join":
        this.join(agent, f.room);
        return { type: "ack", ref };
      case "leave":
        this.leave(agent, f.room);
        return { type: "ack", ref };
      case "list_agents":
        return { type: "agents", agents: this.agents(), ref };
      case "history":
        return { type: "history", messages: this.history(agent, f), ref };
      case "delivered":
        this.markDelivered(agent, Number(f.id));
        return { type: "ack", ref };
      case "ping":
        return { type: "pong", ref };
      case "auth":
        throw new BrokerError("already authenticated");
      default:
        throw new BrokerError(`unknown frame type: ${(f as { type: string }).type}`);
    }
  }

  // ---------------- HTTP ----------------

  private async onRequest(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://x");
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    try {
      if (url.pathname === "/health") return reply(200, { ok: true, version: VERSION });
      if (req.method === "GET" && url.pathname.startsWith("/client/")) return await this.serveClient(url.pathname, res);
      if (req.method === "GET" && url.pathname.startsWith("/dl/")) return await this.onDownload(url, res, reply);
      // the public guide for AI agents: what AIChat is and how to connect, no secrets (alexey, 1706)
      if (req.method === "GET" && (url.pathname === "/agents.md" || url.pathname === "/llms.txt")) {
        res.writeHead(200, { "content-type": "text/markdown; charset=utf-8", "cache-control": "no-cache", "x-content-type-options": "nosniff" });
        return res.end(
          agentGuide({
            httpUrl: this.cfg.publicUrl || `http://${req.headers.host ?? `127.0.0.1:${this.cfg.port}`}`,
            version: VERSION,
            limits: this.worldLimits(),
            games: this.games.types().map((t) => t.id),
          }),
        );
      }
      if (req.method === "GET" && (url.pathname === "/" || url.pathname.startsWith("/web/")))
        return await this.serveStatic(url.pathname, res);
      if (url.pathname.startsWith("/admin/api/")) return await this.onAdminRequest(req, res, url, reply);
      if (url.pathname === "/mcp") return await this.onMcpRequest(req, res);
      if (!url.pathname.startsWith("/api/")) return reply(404, { error: "not found" });
      const token = req.headers.authorization?.replace(/^Bearer\s+/i, "");
      const agent = this.authenticate(token);
      if (!agent) return reply(401, { error: "invalid or missing bearer token" });
      const me = agent.name;

      const body = () => readJson(req);

      const route = `${req.method} ${url.pathname}`;
      const roomMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/(join|leave)$/);
      if (route === "GET /api/me")
        return reply(200, {
          name: me,
          kind: agent.kind,
          ...(agent.description ? { description: agent.description } : {}),
          rooms: this.store.roomsOf(me),
          notes: this.context.stats(me),
          ...(agent.kind === "human" ? { accounts: agent.accounts?.length ?? 0 } : {}),
        });
      if (route === "GET /api/intro") return reply(200, { intro: this.intro(), limits: this.worldLimits() });
      if (route === "GET /api/tools") return reply(200, { tools: toolCatalog() });
      if (url.pathname === "/api/notes" || url.pathname.startsWith("/api/notes/")) return await this.onNotesRequest(req, url, me, reply);
      const notesOf = url.pathname.match(/^\/api\/agents\/([^/]+)\/notes$/);
      if (req.method === "GET" && notesOf) return reply(200, { notes: this.context.notesOf(me, decodeURIComponent(notesOf[1])) });
      if (route === "GET /api/overview") return reply(200, this.overview(agent));
      if (route === "GET /api/agents") return reply(200, { agents: this.agents() });
      if (route === "POST /api/activity") return reply(200, { activity: this.reportActivity(me, await body()) });
      if (route === "POST /api/status") return reply(200, { activity: this.reportStatus(me, await body()) });
      if (route === "POST /api/usage") return reply(200, { usage: this.reportUsage(agent, await body()) });
      if (route === "GET /api/usage")
        return reply(200, { usage: this.usageFor(agent), ...(agent.kind === "human" ? { accounts: agent.accounts ?? [] } : {}) });
      if (route === "PUT /api/me/accounts") return reply(200, { accounts: this.setAccounts(agent, await body()) });
      if (route === "POST /api/messages") {
        const b = await body();
        const m = this.send(me, b as unknown as SendArgs);
        return reply(201, { message: m });
      }
      const thanksMatch = url.pathname.match(/^\/api\/messages\/(\d+)\/thanks$/);
      if (req.method === "POST" && thanksMatch) return reply(200, { thanked_by: this.thank(me, Number(thanksMatch[1])) });
      const reactMatch = url.pathname.match(/^\/api\/messages\/(\d+)\/reactions$/);
      if (reactMatch && (req.method === "POST" || req.method === "DELETE"))
        return reply(200, { reactions: this.react(me, Number(reactMatch[1]), await readJson(req), req.method === "POST") });
      if (route === "POST /api/files") return reply(201, { file: await this.upload(me, req) });
      const fileMatch = url.pathname.match(/^\/api\/files\/([^/]+)$/);
      if (req.method === "GET" && fileMatch) {
        const f = this.visibleFile(me, decodeURIComponent(fileMatch[1]));
        if (!f) return reply(404, { error: "unknown file" });
        return await this.serveFile(f, res);
      }
      // short links a browser or download manager can fetch without the token (issue #61)
      const fileLinkMatch = url.pathname.match(/^\/api\/files\/([^/]+)\/link$/);
      if (req.method === "POST" && fileLinkMatch) {
        const f = this.visibleFile(me, decodeURIComponent(fileLinkMatch[1]));
        if (!f) return reply(404, { error: "unknown file" });
        return reply(200, this.fileLink(f));
      }
      const exportMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/export$/);
      if (req.method === "POST" && exportMatch) {
        const room = decodeURIComponent(exportMatch[1]);
        if (!this.store.isMember(me, room)) throw new BrokerError(`you are not in room ${room}`, 403);
        return reply(200, this.exportLink(room, url.searchParams.get("tz")));
      }
      if (url.pathname === "/api/games" || url.pathname.startsWith("/api/games/")) return await this.onGameRequest(req, url, me, reply);
      const briefMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/brief$/);
      if (briefMatch) return await this.onBriefRequest(req, me, reply, briefMatch);
      if (route === "GET /api/inbox") return reply(200, { messages: this.inbox(me) });
      if (route === "GET /api/search") return reply(200, { messages: this.search(url.searchParams, me) });
      // one message by its id (a #1234 reference in the text), if the caller can see it
      const oneMatch = url.pathname.match(/^\/api\/messages\/(\d+)$/);
      if (req.method === "GET" && oneMatch) {
        const m = this.store.message(Number(oneMatch[1]));
        if (!m || !this.canSee(me, m)) throw new BrokerError(`unknown message: ${oneMatch[1]}`, 404);
        return reply(200, { message: m });
      }
      if (route === "GET /api/history") {
        const q = Object.fromEntries(url.searchParams);
        return reply(200, {
          messages: this.history(me, { room: q.room, with: q.with, limit: Number(q.limit) || 50, before: q.before as unknown as number }),
        });
      }
      if (req.method === "POST" && roomMatch) {
        const room = decodeURIComponent(roomMatch[1]);
        roomMatch[2] === "join" ? this.join(me, room) : this.leave(me, room);
        return reply(200, { ok: true, rooms: this.store.roomsOf(me) });
      }
      return reply(404, { error: "not found" });
    } catch (e) {
      const status = e instanceof BrokerError || e instanceof ContextError || e instanceof UsageError ? e.status : 500;
      if (status === 500) this.log(`HTTP error: ${(e as Error).stack}`);
      return reply(status, { error: (e as Error).message });
    }
  }

  /**
   * /mcp: the AIChat tools over MCP (Streamable HTTP) for a participant with a bearer token. The token is
   * checked on every request, as on /api/; the endpoint answers in JSON-RPC, so its errors are written here.
   */
  private async onMcpRequest(req: IncomingMessage, res: ServerResponse) {
    const agent = this.authenticate(req.headers.authorization?.replace(/^Bearer\s+/i, ""));
    if (!agent) {
      res.writeHead(401, { "content-type": "application/json", "www-authenticate": 'Bearer realm="aichat"' });
      return res.end(JSON.stringify({ error: "invalid or missing bearer token" }));
    }
    try {
      const body = req.method === "POST" ? await readJson(req) : undefined;
      await this.mcp.handle(req, res, agent.name, body);
    } catch (e) {
      const status = e instanceof BrokerError ? e.status : 500;
      if (status === 500) this.log(`MCP error: ${(e as Error).stack}`);
      if (res.headersSent) return res.end();
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: (e as Error).message }, id: null }));
    }
  }

  // ---------------- usage ----------------

  /** POST /api/usage: an agent's adapter reports the account it works on, its limits and its session. */
  private reportUsage(agent: AgentConfig, b: Record<string, unknown>): UsageReport {
    if (agent.kind === "human") throw new BrokerError("people do not report usage: their agents' adapters do", 403);
    const report = checkUsage(agent.name, b, new Date(this.now()));
    this.usage.set(agent.name, report);
    const f: ServerFrame = { type: "usage", usage: report };
    for (const name of new Set([agent.name, ...this.ownersOf(report.account)]))
      for (const ws of this.sockets.get(name) ?? []) this.sendFrame(ws, f);
    for (const ws of this.observers.keys()) this.sendFrame(ws, f);
    return report;
  }

  /** The people who named `account` as theirs. */
  private ownersOf(account: string | undefined): string[] {
    if (!account) return [];
    return this.cfg.agents.filter((a) => a.kind === "human" && a.accounts?.includes(account)).map((a) => a.name);
  }

  /** GET /api/usage: an admin sees every report, a person those on their own accounts, an agent its own. */
  private usageFor(me: AgentConfig): UsageReport[] {
    const known = new Set(this.cfg.agents.map((a) => a.name));
    const all = [...this.usage.values()].filter((r) => known.has(r.agent));
    if (this.isAdminName(me.name)) return all;
    if (me.kind === "human") return all.filter((r) => r.account && me.accounts?.includes(r.account));
    return all.filter((r) => r.agent === me.name);
  }

  /** PUT /api/me/accounts {emails}: a person names their accounts; only the hashes are kept. Returns how many. */
  private setAccounts(me: AgentConfig, b: Record<string, unknown>): number {
    if (me.kind !== "human") throw new BrokerError("an agent's account comes from its adapter: only people name theirs", 403);
    const hashes = accountHashes(b);
    if (!this.opts.editConfig) throw new BrokerError("the config is read-only in this broker", 403);
    try {
      this.opts.editConfig((raw) => {
        const a = raw.agents?.find((x) => x.name === me.name);
        if (!a) throw new BrokerError(`unknown agent: ${me.name}`, 404);
        if (hashes.length) a.accounts = hashes;
        else delete a.accounts;
      });
    } catch (e) {
      throw e instanceof BrokerError ? e : new BrokerError((e as Error).message);
    }
    this.log(hashes.length ? `${me.name} named ${hashes.length} account(s)` : `${me.name} removed their accounts`);
    return hashes.length;
  }

  // ---------------- agent notebook ----------------

  /** The notebook as its owner reads it (REST and MCP): matching notes, how many there are, the limit. */
  notes(me: string, q: { q?: string | null; topic?: string | null } = {}) {
    return { notes: this.context.notes(me, q), ...this.context.stats(me), max: this.cfg.maxNotes };
  }

  note(me: string, id: number): AgentNote {
    return this.context.note(me, id);
  }

  /** A written note counts as real activity, as a message does. */
  rememberNote(me: string, body: Record<string, unknown>): AgentNote {
    const note = this.context.remember(me, body);
    this.hooks.realActivity(me);
    return note;
  }

  changeNote(me: string, id: number, body: Record<string, unknown>): AgentNote {
    const note = this.context.change(me, id, body);
    this.hooks.realActivity(me);
    return note;
  }

  forgetNote(me: string, id: number) {
    this.context.forget(me, id);
    this.hooks.realActivity(me);
  }

  /** GET /api/notes?q=&topic= (own notes), POST /api/notes, PUT and DELETE /api/notes/<id>. */
  private async onNotesRequest(req: IncomingMessage, url: URL, me: string, reply: (status: number, body: unknown) => void) {
    if (url.pathname === "/api/notes") {
      if (req.method === "GET") {
        return reply(200, this.notes(me, { q: url.searchParams.get("q"), topic: url.searchParams.get("topic") }));
      }
      if (req.method === "POST") {
        return reply(201, { note: this.rememberNote(me, await readJson(req)) });
      }
      return reply(405, { error: "use GET or POST" });
    }
    const m = url.pathname.match(/^\/api\/notes\/(\d+)$/);
    if (!m) return reply(404, { error: "not found" });
    const id = Number(m[1]);
    if (req.method === "GET") return reply(200, { note: this.context.note(me, id) });
    if (req.method === "PUT") return reply(200, { note: this.changeNote(me, id, await readJson(req)) });
    if (req.method === "DELETE") {
      this.forgetNote(me, id);
      return reply(200, { ok: true });
    }
    return reply(405, { error: "use GET, PUT or DELETE" });
  }

  // ---------------- room briefs ----------------

  private async onBriefRequest(req: IncomingMessage, me: string, reply: (status: number, body: unknown) => void, path: RegExpMatchArray) {
    let room: string;
    try {
      room = decodeURIComponent(path[1]);
    } catch {
      throw new BrokerError("invalid room name");
    }
    if (req.method === "GET") return reply(200, { brief: this.roomBrief(me, room) });
    if (req.method === "PUT") return reply(200, { brief: this.setRoomBrief(me, room, (await readJson(req)).text) });
    return reply(405, { error: "use GET or PUT" });
  }

  /** A room's brief, for a member (REST and MCP). */
  roomBrief(me: string, room: string): RoomBrief | null {
    try {
      return this.board.brief(me, room);
    } catch (e) {
      throw e instanceof BoardError ? new BrokerError(e.message, e.status) : e;
    }
  }

  setRoomBrief(me: string, room: string, text: unknown): RoomBrief | null {
    try {
      return this.board.setBrief(me, room, text);
    } catch (e) {
      throw e instanceof BoardError ? new BrokerError(e.message, e.status) : e;
    }
  }

  // ---------------- mini-games ----------------

  private async onGameRequest(req: IncomingMessage, url: URL, me: string, reply: (status: number, body: unknown) => void) {
    try {
      const route = `${req.method} ${url.pathname}`;
      const info = (g: Parameters<Games["info"]>[0]) => this.games.info(g);
      if (req.method === "POST" && this.isKeeper(me)) throw new GameError(`${me} is the keeper: it plays no games`, 403);
      if (route === "GET /api/games/types") return reply(200, { types: this.games.types() });
      if (route === "GET /api/games/ratings") return reply(200, { ratings: this.games.ratings(url.searchParams.get("game") || undefined) });
      if (route === "GET /api/games") {
        const q = { status: url.searchParams.get("status") || undefined, game: url.searchParams.get("game") || undefined };
        return reply(200, { games: this.games.list(q).map(info) });
      }
      if (route === "POST /api/games") return reply(201, { game: info(this.games.create(me, await readJson(req))) });
      const m = url.pathname.match(/^\/api\/games\/(\d+)(?:\/(join|move|resign|draw|card))?$/);
      if (!m) return reply(404, { error: "not found" });
      const id = Number(m[1]);
      if (req.method === "GET" && !m[2]) return reply(200, { game: info(this.games.get(id)) });
      if (req.method === "GET" && m[2] === "card") return reply(200, { card: this.games.card(me, id) });
      if (req.method !== "POST" || !m[2]) return reply(404, { error: "not found" });
      const b = m[2] === "join" || m[2] === "move" ? await readJson(req) : {};
      const g =
        m[2] === "join"
          ? this.games.join(me, id, b.seat)
          : m[2] === "move"
            ? this.games.move(me, id, typeof b.move === "string" ? b.move : "", true)
            : m[2] === "resign"
              ? this.games.resign(me, id)
              : this.games.draw(me, id);
      return reply(200, { game: info(g) });
    } catch (e) {
      if (e instanceof GameError) throw new BrokerError(e.message, e.status);
      throw e;
    }
  }

  // ---------------- web UI and admin API ----------------

  private async serveStatic(pathname: string, res: ServerResponse) {
    const root = resolve(this.opts.webDir ?? DEFAULT_WEB_DIR);
    const notFound = () => {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("not found");
    };
    let rel: string;
    try {
      rel = pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice("/web/".length));
    } catch {
      return notFound();
    }
    const file = resolve(join(root, rel));
    if (!file.startsWith(root + sep)) return notFound();
    let data: Buffer;
    try {
      data = await readFile(file);
    } catch {
      return notFound();
    }
    res.writeHead(200, {
      "content-type": CONTENT_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
      "cache-control": "no-cache",
      "x-content-type-options": "nosniff",
      "content-security-policy":
        "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
    });
    res.end(data);
  }

  private async serveClient(pathname: string, res: ServerResponse) {
    const name = pathname.slice("/client/".length);
    let data: Buffer | undefined;
    if (CLIENT_FILES.has(name))
      data = await readFile(join(this.opts.bundleDir ?? DEFAULT_BUNDLE_DIR, name)).catch(() => undefined);
    if (!data) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      return res.end("not found");
    }
    res.writeHead(200, {
      "content-type": name.endsWith(".json") ? "application/json; charset=utf-8" : "text/javascript; charset=utf-8",
      "content-disposition": `attachment; filename="${name}"`,
      "cache-control": "no-cache",
      "x-content-type-options": "nosniff",
    });
    res.end(data);
  }

  private async onAdminRequest(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    reply: (status: number, body: unknown) => void,
  ) {
    const me = this.adminFor(req.headers.authorization?.replace(/^Bearer\s+/i, ""));
    if (!me) {
      if (!this.admins().length)
        return reply(403, { error: "nobody has admin rights: run `npm run admin -- <person>` on the broker's machine" });
      return reply(401, { error: "this token has no admin rights" });
    }
    /** Refuses changes that would leave the broker without any admin. */
    const keepOneAdmin = (name: string, what: string) => {
      const admins = this.admins();
      if (admins.length === 1 && admins[0] === name)
        throw new BrokerError(`${name} is the only admin: make someone else an admin before you ${what}`, 409);
    };
    const route = `${req.method} ${url.pathname}`;
    const adminAgents = () =>
      this.agents().map((a) => {
        const c = this.cfg.agents.find((x) => x.name === a.name);
        return { ...a, webhook: !!c?.webhook, admin: !!c?.admin };
      });
    if (route === "GET /admin/api/tools") return reply(200, { tools: toolCatalog() });
    if (route === "GET /admin/api/overview")
      return reply(200, {
        me,
        agents: adminAgents(),
        rooms: this.store.rooms(),
        dms: this.store.dms(me.name),
        max_hops: this.cfg.maxHops,
        version: VERSION,
      });
    const edit = (fn: (raw: Partial<BrokerConfig>) => void): BrokerConfig => {
      if (!this.opts.editConfig) throw new BrokerError("the config is read-only in this broker", 403);
      try {
        return this.opts.editConfig(fn);
      } catch (e) {
        throw e instanceof BrokerError ? e : new BrokerError((e as Error).message);
      }
    };
    // ---- updates ----
    if (url.pathname.startsWith("/admin/api/update")) {
      try {
        if (route === "GET /admin/api/update") return reply(200, this.updater.status());
        if (route === "POST /admin/api/update/check") {
          return reply(200, await this.updater.check());
        }
        if (route === "POST /admin/api/update/install") {
          const b = await readJson(req);
          if (typeof b.version !== "string") throw new BrokerError("version is required");
          this.log(`${me.name} installs update ${b.version}`);
          const r = await this.updater.install(b.version);
          return reply(202, r);
        }
        if (route === "DELETE /admin/api/update/failed") {
          this.updater.dismissFailed();
          return reply(200, this.updater.status());
        }
        if (route === "PATCH /admin/api/update/settings") {
          let patch: ReturnType<typeof checkUpdateSettings>;
          try {
            patch = checkUpdateSettings(await readJson(req));
          } catch (e) {
            throw e instanceof BrokerError ? e : new BrokerError((e as Error).message);
          }
          edit((raw) => {
            const u = { ...(raw.updates ?? {}) } as Record<string, unknown>;
            for (const [k, v] of Object.entries(patch)) {
              if (v === "" || v === false) delete u[k];
              else u[k] = v;
            }
            if (Object.keys(u).length) raw.updates = u;
            else delete raw.updates;
          });
          this.log(`update settings changed: ${Object.keys(patch).join(", ")}`);
          this.updater.reset();
          return reply(200, this.updater.status());
        }
      } catch (e) {
        if (e instanceof UpdateError) throw new BrokerError(e.message, e.status);
        throw e;
      }
      return reply(404, { error: "not found" });
    }
    if (route === "PUT /admin/api/intro") {
      const { intro, changed } = this.context.setIntro(me.name, (await readJson(req)).text);
      if (changed) {
        this.log(`${me.name} ${intro.draft ? "cleared" : "changed"} the world intro`);
        // agents online now learn it at once; the others read the new intro when their next session starts
        const head = intro.draft
          ? `${me.name} прибрав збережену вводну AIChat, тепер діє вбудована чернетка:`
          : `${me.name} змінив вводну AIChat. Нова вводна:`;
        for (const agent of this.connectedAgents()) this.notify(agent, `${head}\n\n${intro.text}`);
        this.broadcast({ type: "intro", intro });
      }
      return reply(200, { intro });
    }
    if (route === "GET /admin/api/settings")
      return reply(200, { settings: settingsOf(this.cfg), limits: SETTING_LIMITS, editable: !!this.opts.editConfig });
    if (route === "PATCH /admin/api/settings") {
      let patch: ReturnType<typeof checkSettingsPatch>;
      try {
        patch = checkSettingsPatch(await readJson(req));
      } catch (e) {
        throw e instanceof BrokerError ? e : new BrokerError((e as Error).message);
      }
      const cfg = edit((raw) => Object.assign(raw, patch));
      this.log(`settings changed: ${JSON.stringify(patch)}`);
      return reply(200, { settings: settingsOf(cfg) });
    }

    // ---- people and agents ----
    const setupFor = (a: AgentConfig, token: string) =>
      buildSetup({
        name: a.name,
        kind: a.kind,
        token,
        webhook: a.webhook,
        httpUrl: this.cfg.publicUrl || `http://${req.headers.host ?? `127.0.0.1:${this.cfg.port}`}`,
        projectDir: this.cfg.projectDir || this.opts.defaultProjectDir || "",
        owner: me.name,
      });
    if (route === "GET /admin/api/agents") return reply(200, { agents: adminAgents() });
    if (route === "POST /admin/api/agents") {
      const b = await readJson(req);
      const name = b.name;
      const kind = b.kind ?? "human";
      if (typeof name !== "string" || !NAME_RE.test(name))
        throw new BrokerError("name must be 1-64 characters: letters, digits, _ or -");
      if (typeof kind !== "string" || !NAME_RE.test(kind))
        throw new BrokerError("kind must be 1-64 characters: letters, digits, _ or -");
      let webhook: string | undefined;
      if (b.webhook != null && b.webhook !== "") {
        if (typeof b.webhook !== "string") throw new BrokerError("webhook must be a URL");
        try {
          const u = new URL(b.webhook);
          if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error();
        } catch {
          throw new BrokerError("webhook must be an http(s) URL");
        }
        webhook = b.webhook;
      }
      if (b.description != null && typeof b.description !== "string") throw new BrokerError("description must be a string");
      if (typeof b.description === "string" && b.description.trim().length > MAX_DESCRIPTION_LENGTH)
        throw new BrokerError(`description is longer than ${MAX_DESCRIPTION_LENGTH} characters`);
      const rooms = b.rooms ?? [];
      if (!Array.isArray(rooms) || !rooms.every((r) => typeof r === "string" && ROOM_RE.test(r)))
        throw new BrokerError("rooms must be a list of room names (letters, digits, _ or -)");
      if (this.cfg.agents.some((a) => a.name === name)) throw new BrokerError(`agent ${name} already exists`);
      const agent: AgentConfig = {
        name,
        kind,
        token: newToken(),
        ...(typeof b.description === "string" && b.description.trim() ? { description: b.description.trim() } : {}),
        ...(webhook ? { webhook } : {}),
        ...(rooms.length ? { rooms: [...new Set(rooms as string[])] } : {}),
      };
      edit((raw) => {
        raw.agents ??= [];
        if (raw.agents.some((a) => a.name === name)) throw new BrokerError(`agent ${name} already exists`);
        raw.agents.push(agent);
      });
      for (const r of agent.rooms ?? []) this.store.join(name, r);
      this.log(`${me.name} added ${name} (${kind})`);
      const { token, ...info } = agent;
      this.notifyRooms(name);
      return reply(201, {
        agent: { ...info, webhook: !!webhook, rooms: this.store.roomsOf(name), online: !!webhook },
        token,
        setup: setupFor(agent, token),
      });
    }
    const agentMatch = url.pathname.match(/^\/admin\/api\/agents\/([^/]+)(\/token|\/setup)?$/);
    if (agentMatch) {
      const name = decodeURIComponent(agentMatch[1]);
      const target = this.cfg.agents.find((a) => a.name === name);
      if (!target) throw new BrokerError(`unknown agent: ${name}`, 404);
      if (req.method === "GET" && agentMatch[2] === "/setup") return reply(200, { setup: setupFor(target, TOKEN_PLACEHOLDER) });
      if (req.method === "PATCH" && !agentMatch[2]) {
        const b = await readJson(req);
        const keys = Object.keys(b);
        if (!keys.length || keys.some((k) => k !== "admin" && k !== "description" && k !== "keeper" && k !== "kind"))
          throw new BrokerError("only `admin`, `description`, `keeper` and `kind` can be changed here");
        // An agent's kind only picks its connection instructions and its label, so an admin may correct it; a person
        // stays a person and an agent never becomes one, since admin rights and accounts depend on that.
        let kind: string | undefined;
        const oldKind = target.kind;
        if ("kind" in b) {
          if (typeof b.kind !== "string" || !NAME_RE.test(b.kind))
            throw new BrokerError("kind must be 1-64 characters: letters, digits, _ or -");
          if (target.kind === "human" || b.kind === "human")
            throw new BrokerError(`only an AI agent's kind can be changed, and not to "human"; ${name} is "${target.kind}"`, 403);
          if (b.kind !== target.kind) kind = b.kind;
        }
        if ("admin" in b) {
          if (typeof b.admin !== "boolean") throw new BrokerError("admin must be true or false");
          if (b.admin && target.kind !== "human")
            throw new BrokerError(`only agents of kind "human" can be admins; ${name} is "${target.kind}"`, 403);
          if (!b.admin) keepOneAdmin(name, "remove their rights");
        }
        if ("keeper" in b) {
          if (typeof b.keeper !== "boolean") throw new BrokerError("keeper must be true or false");
          if (b.keeper) {
            if (target.kind === "human" || target.admin || b.admin === true)
              throw new BrokerError(`the keeper must be an AI agent, not a person or an admin; ${name} is not`, 403);
            const other = this.cfg.agents.find((a) => a.keeper && a.name !== name);
            if (other) throw new BrokerError(`${other.name} is already the keeper: only one agent can be`, 409);
            const rooms = this.store.roomsOf(name);
            if (rooms.length)
              throw new BrokerError(`the keeper is in no room: first remove ${name} from ${rooms.map((r) => "#" + r).join(", ")}`, 409);
          }
        }
        let description: string | undefined;
        if ("description" in b) {
          if (typeof b.description !== "string") throw new BrokerError("description must be a string");
          description = b.description.trim();
          if (description.length > MAX_DESCRIPTION_LENGTH)
            throw new BrokerError(`description is longer than ${MAX_DESCRIPTION_LENGTH} characters`);
        }
        edit((raw) => {
          const a = raw.agents?.find((x) => x.name === name);
          if (!a) throw new BrokerError(`unknown agent: ${name}`, 404);
          if (b.admin === true) a.admin = true;
          else if (b.admin === false) delete a.admin;
          if (description) a.description = description;
          else if (description === "") delete a.description;
          if (b.keeper === true) {
            a.keeper = true;
            delete a.rooms;
          } else if (b.keeper === false) delete a.keeper;
          if (kind) a.kind = kind;
        });
        if (b.admin === false) this.disconnectObserver(name, "admin rights removed");
        if ("admin" in b) this.log(`${me.name} ${b.admin ? "made" : "removed"} ${name} ${b.admin ? "an admin" : "from admins"}`);
        if (description !== undefined) this.log(`${me.name} ${description ? "changed" : "removed"} the description of ${name}`);
        if ("keeper" in b) this.log(`${me.name} ${b.keeper ? "made" : "removed"} ${name} ${b.keeper ? "the keeper" : "as the keeper"}`);
        if (kind) this.log(`${me.name} changed the kind of ${name} from ${oldKind} to ${kind}`);
        return reply(200, { agent: adminAgents().find((a) => a.name === name) });
      }
      if (req.method === "POST" && agentMatch[2] === "/token") {
        const token = newToken();
        edit((raw) => {
          const a = raw.agents?.find((x) => x.name === name);
          if (!a) throw new BrokerError(`unknown agent: ${name}`, 404);
          a.token = token;
        });
        this.disconnect(name, "token changed");
        this.log(`${me.name} issued a new token for ${name}`);
        return reply(200, { token, setup: setupFor(target, token) });
      }
      if (req.method === "DELETE" && !agentMatch[2]) {
        keepOneAdmin(name, "remove them");
        edit((raw) => {
          raw.agents = (raw.agents ?? []).filter((x) => x.name !== name);
        });
        this.disconnect(name, "agent removed");
        this.store.forgetAgent(name);
        this.usage.delete(name);
        this.log(`${me.name} removed ${name}`);
        this.notifyObservers({ type: "rooms_changed" });
        return reply(200, { ok: true });
      }
      return reply(404, { error: "not found" });
    }

    // ---- rooms ----
    const roomInfo = (room: string) =>
      this.store.rooms().find((r) => r.name === room) ?? { name: room, members: [], count: 0, last_ts: null };
    /** Adds/removes `room` in an agent's configured rooms so the change survives reconnects and restarts. */
    const setConfiguredRoom = (agents: string[], room: string, member: boolean) =>
      edit((raw) => {
        for (const a of raw.agents ?? []) {
          if (!agents.includes(a.name)) continue;
          const rooms = (a.rooms ?? []).filter((r) => r !== room);
          if (member) rooms.push(room);
          if (rooms.length) a.rooms = rooms;
          else delete a.rooms;
        }
      });
    const memberName = (b: Record<string, unknown>) => {
      const n = b.name ?? b.agent;
      if (typeof n !== "string" || !this.cfg.agents.some((a) => a.name === n))
        throw new BrokerError(`unknown agent: ${String(n)}`, 404);
      return n;
    };
    // ---- games: deleting a game takes its room and every message there with it ----
    const gameDelete = url.pathname.match(/^\/admin\/api\/games\/(\d+)$/);
    if (gameDelete && req.method === "DELETE") {
      const id = Number(gameDelete[1]);
      const deleted = this.store.game(id);
      if (!deleted) throw new BrokerError(`unknown game: ${id}`, 404);
      const room = gameRoom(id);
      const members = this.store.membersOf(room);
      const configured = this.cfg.agents.filter((a) => a.rooms?.includes(room)).map((a) => a.name);
      if (configured.length) setConfiguredRoom(configured, room, false);
      this.store.deleteGame(id);
      this.store.deleteRoom(room, true);
      await this.cleanFiles();
      for (const n of members) this.notifyRooms(n, false);
      this.broadcast({ type: "game_deleted", id });
      this.games.deleted(deleted);
      this.notifyObservers({ type: "rooms_changed" });
      this.log(`${me.name} deleted game ${id} with its room and messages`);
      return reply(200, { ok: true });
    }

    if (route === "GET /admin/api/rooms") return reply(200, { rooms: this.store.rooms() });
    if (route === "POST /admin/api/rooms") {
      const b = await readJson(req);
      const room = b.name;
      if (typeof room !== "string" || !ROOM_RE.test(room))
        throw new BrokerError("room name must be 1-64 characters: letters, digits, _ or -");
      if (GAME_ROOM_RE.test(room)) throw new BrokerError(`${room} is reserved for game rooms`, 409);
      if (this.store.roomExists(room)) throw new BrokerError(`room ${room} already exists`);
      const members = b.members ?? [];
      if (!Array.isArray(members)) throw new BrokerError("members must be a list of agent names");
      const names = [...new Set(members.map((m) => memberName({ name: m })))];
      if (names.length) setConfiguredRoom(names, room, true);
      this.store.createRoom(room);
      for (const n of names) this.store.join(n, room);
      for (const n of names) this.notifyRooms(n, false);
      this.notifyObservers({ type: "rooms_changed" });
      this.log(`admin created room ${room}`);
      return reply(201, { room: roomInfo(room) });
    }
    const roomMatch = url.pathname.match(/^\/admin\/api\/rooms\/([^/]+)(?:\/members(?:\/([^/]+))?)?$/);
    if (roomMatch) {
      const room = decodeURIComponent(roomMatch[1]);
      const isMembers = url.pathname.includes("/members");
      if (!ROOM_RE.test(room)) throw new BrokerError(`invalid room name: ${room}`);
      if (!this.store.roomExists(room)) throw new BrokerError(`unknown room: ${room}`, 404);
      const game = room.match(GAME_ROOM_RE);
      if (game)
        throw new BrokerError(`${room} is the room of game ${game[1]}; manage the game instead (DELETE /admin/api/games/${game[1]})`, 409);
      if (req.method === "DELETE" && !isMembers) {
        const members = this.store.membersOf(room);
        const configured = this.cfg.agents.filter((a) => a.rooms?.includes(room)).map((a) => a.name);
        if (configured.length) setConfiguredRoom(configured, room, false);
        const purge = url.searchParams.get("messages") === "1";
        this.store.deleteRoom(room, purge);
        if (purge) await this.cleanFiles();
        for (const n of members) this.notifyRooms(n, false);
        this.notifyObservers({ type: "rooms_changed" });
        this.log(`admin deleted room ${room}${purge ? " with its messages" : ""}`);
        return reply(200, { ok: true });
      }
      if (req.method === "POST" && isMembers && !roomMatch[2]) {
        const n = memberName(await readJson(req));
        setConfiguredRoom([n], room, true);
        this.store.join(n, room);
        this.notifyRooms(n);
        this.log(`admin added ${n} to ${room}`);
        return reply(200, { room: roomInfo(room) });
      }
      if (req.method === "DELETE" && roomMatch[2]) {
        const n = memberName({ name: decodeURIComponent(roomMatch[2]) });
        setConfiguredRoom([n], room, false);
        this.store.leave(n, room);
        this.notifyRooms(n);
        this.log(`admin removed ${n} from ${room}`);
        return reply(200, { room: roomInfo(room) });
      }
      return reply(404, { error: "not found" });
    }
    if (route === "GET /admin/api/messages") {
      const q = Object.fromEntries(url.searchParams);
      if (!!q.a !== !!q.b) throw new BrokerError("set both `a` and `b` for a direct conversation");
      if (q.room && q.a) throw new BrokerError("set either `room` or `a`+`b`, not both");
      if (q.agent && q.a) throw new BrokerError("`agent` filters the whole history or a room, not a direct conversation");
      const limit = Math.min(Math.max(Number(q.limit) || 100, 1), 500);
      const before = q.before ? Number(q.before) : undefined;
      if (before !== undefined && !(before > 0)) throw new BrokerError("`before` must be a positive message id");
      // admins do not read other people's direct messages
      if (q.a && q.a !== me.name && q.b !== me.name) throw new BrokerError("this is someone else's direct conversation", 403);
      const query = { room: q.room, a: q.a, b: q.b, agent: q.agent, dmsOf: me.name, before, limit };
      return reply(200, { messages: this.store.allMessages(query) });
    }
    if (route === "GET /admin/api/search") return reply(200, { messages: this.search(url.searchParams, { admin: me.name }) });
    const oneMatch = url.pathname.match(/^\/admin\/api\/messages\/(\d+)$/);
    if (req.method === "GET" && oneMatch) {
      const m = this.store.message(Number(oneMatch[1]));
      if (!m || !this.adminCanSee(me.name, m)) throw new BrokerError(`unknown message: ${oneMatch[1]}`, 404);
      return reply(200, { message: m });
    }
    /** The human an admin writes as (the web UI may post only as people, never as AI agents). */
    const humanAs = (name: unknown) => {
      const as = this.cfg.agents.find((a) => a.name === name);
      if (!as) throw new BrokerError(`unknown agent: ${String(name)}`, 404);
      if (as.kind !== "human")
        throw new BrokerError(`the web UI may only post as agents of kind "human"; ${as.name} is "${as.kind}"`, 403);
      return as.name;
    };
    if (route === "POST /admin/api/messages") {
      const b = await readJson(req);
      const m = this.send(humanAs(b.as), {
        to: b.to as string | undefined,
        room: b.room as string | undefined,
        text: b.text as string,
        reply_to: b.reply_to as number | undefined,
        attachments: b.attachments,
      });
      return reply(201, { message: m });
    }
    const thanksMatch = url.pathname.match(/^\/admin\/api\/messages\/(\d+)\/thanks$/);
    if (req.method === "POST" && thanksMatch) {
      const b = await readJson(req);
      return reply(200, { thanked_by: this.thank(humanAs(b.as), Number(thanksMatch[1]), { admin: true }) });
    }
    const reactMatch = url.pathname.match(/^\/admin\/api\/messages\/(\d+)\/reactions$/);
    if (reactMatch && (req.method === "POST" || req.method === "DELETE")) {
      const b = await readJson(req);
      const reactions = this.react(humanAs(b.as), Number(reactMatch[1]), b, req.method === "POST", { admin: true });
      return reply(200, { reactions });
    }
    if (route === "POST /admin/api/files") return reply(201, { file: await this.upload(humanAs(url.searchParams.get("as")), req) });
    const fileMatch = url.pathname.match(/^\/admin\/api\/files\/([^/]+)$/);
    if (req.method === "GET" && fileMatch) {
      const f = this.visibleFile(me.name, decodeURIComponent(fileMatch[1]), true);
      if (!f) return reply(404, { error: "unknown file" });
      return await this.serveFile(f, res);
    }
    // global hooks (the scheduler): admins only
    if (url.pathname === "/admin/api/hooks" || url.pathname.startsWith("/admin/api/hooks/")) {
      try {
        if (route === "GET /admin/api/hooks") return reply(200, { hooks: this.hooks.list() });
        if (route === "POST /admin/api/hooks") {
          const hook = this.hooks.create(await readJson(req), me.name);
          this.log(`${me.name} added hook ${hook.id} (${hook.trigger.type})`);
          return reply(201, { hook });
        }
        const hookMatch = url.pathname.match(/^\/admin\/api\/hooks\/([^/]+)$/);
        if (!hookMatch) return reply(404, { error: "not found" });
        const id = decodeURIComponent(hookMatch[1]);
        if (req.method === "PUT") {
          const hook = this.hooks.replace(id, await readJson(req), me.name);
          this.log(`${me.name} changed hook ${id}`);
          return reply(200, { hook });
        }
        if (req.method === "PATCH") {
          const hook = this.hooks.setEnabled(id, await readJson(req));
          this.log(`${me.name} ${hook.enabled ? "enabled" : "disabled"} hook ${id}`);
          return reply(200, { hook });
        }
        if (req.method === "DELETE") {
          this.hooks.remove(id);
          this.log(`${me.name} removed hook ${id}`);
          return reply(200, { ok: true });
        }
        return reply(405, { error: "use GET, POST, PUT, PATCH or DELETE" });
      } catch (e) {
        if (e instanceof HookError) throw new BrokerError(e.message, e.status);
        throw e;
      }
    }
    const fileLinkMatch = url.pathname.match(/^\/admin\/api\/files\/([^/]+)\/link$/);
    if (req.method === "POST" && fileLinkMatch) {
      const f = this.visibleFile(me.name, decodeURIComponent(fileLinkMatch[1]), true);
      if (!f) return reply(404, { error: "unknown file" });
      return reply(200, this.fileLink(f));
    }
    const exportMatch = url.pathname.match(/^\/admin\/api\/rooms\/([^/]+)\/export$/);
    if (req.method === "POST" && exportMatch) {
      const room = decodeURIComponent(exportMatch[1]);
      if (!this.store.roomExists(room)) throw new BrokerError(`unknown room: ${room}`, 404);
      return reply(200, this.exportLink(room, url.searchParams.get("tz")));
    }
    return reply(404, { error: "not found" });
  }

  // ---------------- lifecycle ----------------

  listen(port = this.cfg.port, host = this.cfg.host): Promise<number> {
    this.http = createServer((req, res) => void this.onRequest(req, res));
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 1_000_000 });
    this.wss.on("connection", (ws) => this.onConnection(ws));
    this.http.on("upgrade", (req, socket, head) => {
      if (new URL(req.url ?? "/", "http://x").pathname !== "/ws") return socket.destroy();
      this.wss!.handleUpgrade(req, socket, head, (ws) => this.wss!.emit("connection", ws, req));
    });
    this.retryTimer = setInterval(() => void this.flushWebhooks(), 30_000);
    // re-read the config now and then even when nobody calls the broker, so stale sockets close soon
    this.configTimer = setInterval(() => void this.cfg, 5_000);
    this.configTimer.unref();
    this.retryTimer.unref();
    void this.flushWebhooks();
    const clean = () => {
      this.mcp.sweep();
      return this.cleanFiles().catch((e) => this.log(`file cleanup failed: ${(e as Error).message}`));
    };
    this.cleanupTimer = setInterval(clean, 60 * 60 * 1000);
    this.cleanupTimer.unref();
    this.activityTimer = setInterval(() => this.expireActivity(), 60 * 1000);
    this.activityTimer.unref();
    this.hooksTimer = setInterval(() => {
      try {
        this.hooks.tick();
      } catch (e) {
        this.log(`hooks failed: ${(e as Error).message}`);
      }
    }, TICK_MS);
    this.hooksTimer.unref();
    void clean();
    return new Promise((resolve) => {
      this.http!.listen(port, host, () => {
        const addr = this.http!.address();
        resolve(typeof addr === "object" && addr ? addr.port : port);
      });
    });
  }

  async close() {
    clearInterval(this.activityTimer);
    clearInterval(this.hooksTimer);
    clearInterval(this.retryTimer);
    clearInterval(this.cleanupTimer);
    clearInterval(this.configTimer);
    this.updater.stop();
    // shutting down counts as leaving: on the way back, the absence is measured from now
    this.closing = true;
    const now = new Date(this.now()).toISOString();
    for (const name of this.sockets.keys()) this.store.setLastSeen(name, now);
    for (const set of this.sockets.values()) for (const ws of set) ws.terminate();
    for (const ws of this.observers.keys()) ws.terminate();
    await this.mcp.close();
    await new Promise<void>((r) => (this.wss ? this.wss.close(() => r()) : r()));
    await new Promise<void>((r) => (this.http ? this.http.close(() => r()) : r()));
    await Promise.all(this.webhookChains.values());
    this.store.close();
  }
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > 1_000_000) throw new BrokerError("body too large", 413);
    chunks.push(chunk);
  }
  // decode once, so a multi-byte UTF-8 character split across chunks stays intact
  const raw = Buffer.concat(chunks).toString("utf8");
  let v: unknown;
  try {
    v = raw ? JSON.parse(raw) : {};
  } catch {
    throw new BrokerError("invalid JSON body");
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new BrokerError("JSON body must be an object");
  return v as Record<string, unknown>;
}

function sameAdapter(a: AdapterInfo | undefined, b: AdapterInfo | undefined): boolean {
  return a?.name === b?.name && a?.version === b?.version && a?.surface === b?.surface && a?.start === b?.start;
}

/**
 * The adapter a client named in `auth`, if it is well formed (short strings); anything else is ignored.
 * `surface` and `start` are kept only with a known value.
 */
function adapterInfo(c: unknown): AdapterInfo | undefined {
  if (!c || typeof c !== "object") return undefined;
  const { name, version, surface, start } = c as Record<string, unknown>;
  const ok = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 64;
  if (!ok(name) || !ok(version)) return undefined;
  return {
    name,
    version,
    ...(surface === "terminal" || surface === "server" ? { surface } : {}),
    ...(start === "resumed" || start === "new" ? { start } : {}),
  };
}
