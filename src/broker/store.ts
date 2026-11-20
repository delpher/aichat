import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { AgentNote, ChatMessage, FileInfo, HookFields, HookRule, RoomBrief, WorldIntro } from "../protocol.js";

interface HookRow {
  id: string;
  enabled: number;
  rule: string;
  author: string;
  created_ts: string;
  updated_ts: string;
}
import type { GameOutcome } from "../games/game.js";

interface Row {
  id: number;
  sender: string;
  recipient: string | null;
  room: string | null;
  text: string;
  ts: string;
  reply_to: number | null;
  hops: number;
  attachments: string | null;
}

export interface FileRow extends FileInfo {
  uploader: string;
  created: string;
  message_id: number | null;
}

/** A game as stored: players by seat, `moves` in the game's notation, `result` as the game reported it. */
export interface GameRecord {
  id: number;
  game: string;
  players: (string | null)[];
  created_by: string;
  moves: string[];
  status: "open" | "active" | "finished";
  result: GameOutcome | null;
  draw_offer: string | null;
  created_ts: string;
  updated_ts: string;
}

interface GameRow {
  id: number;
  game: string;
  players: string;
  created_by: string;
  moves: string;
  status: GameRecord["status"];
  result: string | null;
  draw_offer: string | null;
  created_ts: string;
  updated_ts: string;
}

function toGame(r: GameRow): GameRecord {
  return {
    id: r.id,
    game: r.game,
    players: JSON.parse(r.players),
    created_by: r.created_by,
    moves: JSON.parse(r.moves),
    status: r.status,
    result: r.result ? JSON.parse(r.result) : null,
    draw_offer: r.draw_offer,
    created_ts: r.created_ts,
    updated_ts: r.updated_ts,
  };
}

type NoteRow = { id: number; topic: string | null; title: string; description: string; text?: string; text_length: number; ts: string };

/** A row as a note: with the text when it was selected, otherwise only its length. */
function toNote(r: NoteRow): AgentNote {
  return {
    id: r.id,
    ...(r.topic ? { topic: r.topic } : {}),
    title: r.title,
    description: r.description,
    ...(r.text ? { text: r.text } : {}),
    ...(r.text_length ? { text_length: r.text_length } : {}),
    ts: r.ts,
  };
}

/** What a note gets written with; an empty text means "no text". */
export interface NoteFields {
  topic: string | null;
  title: string;
  description: string;
  text: string;
}

/** Description length notes migrated from a single text get (the default limit of descriptions). */
const MIGRATED_DESCRIPTION = 1000;

const NOTE_COLS = "id, topic, title, description, length(text) AS text_length, ts";

/**
 * A note written as one text (before notes had titles, or by an older adapter): its first sentence becomes the
 * title; a text that fits `maxDescription` becomes the description, a longer one stays the text and its start
 * becomes the description.
 */
export function fromOneText(text: string, maxDescription: number): { title: string; description: string; text: string } {
  const firstSentence = text.replace(/\s+/g, " ").trim().split(/(?<=[.!?…]) /)[0];
  const title = clip(firstSentence, 60).replace(/[.!?]$/, "");
  return text.length <= maxDescription ? { title, description: text, text: "" } : { title, description: clip(text, maxDescription), text };
}

/** The start of `s` up to `max` characters, cut after a sentence or a word when one ends late enough. */
export function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  const head = s.slice(0, max - 1);
  const sentence = Math.max(head.lastIndexOf(". "), head.lastIndexOf("! "), head.lastIndexOf("? "), head.lastIndexOf("\n"));
  if (sentence > max / 2) return head.slice(0, sentence + 1).trim();
  const word = head.lastIndexOf(" ");
  return (word > max / 2 ? head.slice(0, word) : head).trim().replace(/[\s,;:—–-]+$/, "") + "…";
}

/** Room messages, and direct messages only where the bound person (twice) is a side. */
const OWN_DMS = "(room IS NOT NULL OR sender = ? OR recipient = ?)";

function toMessage(r: Row): ChatMessage {
  const m: ChatMessage = { id: r.id, from: r.sender, text: r.text, ts: r.ts, hops: r.hops };
  if (r.recipient) m.to = r.recipient;
  if (r.room) m.room = r.room;
  if (r.reply_to != null) m.reply_to = r.reply_to;
  if (r.attachments) m.attachments = JSON.parse(r.attachments) as FileInfo[];
  return m;
}

/** Message history, room membership and per-agent delivery cursors in SQLite. */
export class Store {
  private db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sender TEXT NOT NULL,
        recipient TEXT,
        room TEXT,
        text TEXT NOT NULL,
        ts TEXT NOT NULL,
        reply_to INTEGER,
        hops INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_messages_room ON messages(room, id);
      CREATE INDEX IF NOT EXISTS idx_messages_recipient ON messages(recipient, id);
      CREATE TABLE IF NOT EXISTS memberships (
        agent TEXT NOT NULL,
        room TEXT NOT NULL,
        joined_after INTEGER NOT NULL,
        PRIMARY KEY (agent, room)
      );
      CREATE TABLE IF NOT EXISTS rooms (
        name TEXT PRIMARY KEY,
        created TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS cursors (
        agent TEXT PRIMARY KEY,
        last_id INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS last_seen (
        agent TEXT PRIMARY KEY,
        ts TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        agent TEXT PRIMARY KEY,
        session TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS files (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        mime TEXT NOT NULL,
        size INTEGER NOT NULL,
        uploader TEXT NOT NULL,
        created TEXT NOT NULL,
        message_id INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_files_message ON files(message_id);
      CREATE TABLE IF NOT EXISTS deliveries (
        message_id INTEGER NOT NULL,
        agent TEXT NOT NULL,
        ts TEXT NOT NULL,
        PRIMARY KEY (message_id, agent)
      );
      CREATE TABLE IF NOT EXISTS thanks (
        message_id INTEGER NOT NULL,
        by TEXT NOT NULL,
        ts TEXT NOT NULL,
        PRIMARY KEY (message_id, by)
      );
      CREATE TABLE IF NOT EXISTS games (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        game TEXT NOT NULL,
        players TEXT NOT NULL DEFAULT '[]',
        created_by TEXT NOT NULL,
        moves TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL,
        result TEXT,
        draw_offer TEXT,
        created_ts TEXT NOT NULL,
        updated_ts TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_games_status ON games(status, id);
      CREATE TABLE IF NOT EXISTS briefs (
        room TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        author TEXT NOT NULL,
        ts TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS intro (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        text TEXT NOT NULL,
        author TEXT NOT NULL,
        ts TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent TEXT NOT NULL,
        topic TEXT,
        title TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL DEFAULT '',
        text TEXT NOT NULL,
        ts TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_notes_agent ON notes(agent, id);
      CREATE TABLE IF NOT EXISTS hooks (
        id TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL,
        rule TEXT NOT NULL,
        author TEXT NOT NULL,
        created_ts TEXT NOT NULL,
        updated_ts TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS hook_fires (
        hook_id TEXT NOT NULL,
        agent TEXT NOT NULL,
        fired INTEGER NOT NULL DEFAULT 0,
        last_ts TEXT,
        awaiting INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (hook_id, agent)
      );
    `);
    // Case-insensitive search for any script: SQLite's own lower()/LIKE fold only ASCII.
    this.db.function("fold", { deterministic: true }, (t) => (t == null ? null : String(t).toLocaleLowerCase()));
    // databases created before attachments existed
    const cols = this.db.prepare("PRAGMA table_info(messages)").all() as { name: string }[];
    if (!cols.some((c) => c.name === "attachments")) this.db.exec("ALTER TABLE messages ADD COLUMN attachments TEXT");
    this.migrateGameSeats();
    this.migrateNotes();
  }

  /**
   * Notes written before they had a title and a description were one text. The title becomes its first
   * words; a text that fits a description becomes the description, a longer one keeps the full text and
   * its start becomes the description.
   */
  private migrateNotes() {
    const cols = this.db.prepare("PRAGMA table_info(notes)").all() as { name: string }[];
    if (cols.some((c) => c.name === "title")) return;
    this.db.exec("ALTER TABLE notes ADD COLUMN title TEXT NOT NULL DEFAULT ''; ALTER TABLE notes ADD COLUMN description TEXT NOT NULL DEFAULT ''");
    const rows = this.db.prepare("SELECT id, text FROM notes").all() as { id: number; text: string }[];
    const set = this.db.prepare("UPDATE notes SET title = ?, description = ?, text = ? WHERE id = ?");
    this.db.exec("BEGIN");
    try {
      for (const r of rows) {
        const n = fromOneText(r.text, MIGRATED_DESCRIPTION);
        set.run(n.title, n.description, n.text, r.id);
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  /**
   * Games stored before seats existed had `white` / `black` columns and results with winner "w" / "b".
   * They were all checkers: white is seat 0, black seat 1. The old columns stay, unused.
   */
  private migrateGameSeats() {
    const cols = this.db.prepare("PRAGMA table_info(games)").all() as { name: string }[];
    if (cols.some((c) => c.name === "players")) return;
    this.db.exec("ALTER TABLE games ADD COLUMN players TEXT NOT NULL DEFAULT '[]'");
    const rows = this.db.prepare("SELECT id, white, black, result FROM games").all() as {
      id: number;
      white: string | null;
      black: string | null;
      result: string | null;
    }[];
    const update = this.db.prepare("UPDATE games SET players = ?, result = ? WHERE id = ?");
    for (const r of rows) {
      let result = r.result;
      if (result) {
        const old = JSON.parse(result) as { winner: string | null; reason: string };
        result = JSON.stringify({ winner: old.winner === "w" ? 0 : old.winner === "b" ? 1 : null, reason: old.reason });
      }
      update.run(JSON.stringify([r.white, r.black]), result, r.id);
    }
  }

  close() {
    this.db.close();
  }

  insert(m: Omit<ChatMessage, "id" | "ts">): ChatMessage {
    const ts = new Date().toISOString();
    const res = this.db
      .prepare(
        "INSERT INTO messages (sender, recipient, room, text, ts, reply_to, hops, attachments) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        m.from,
        m.to ?? null,
        m.room ?? null,
        m.text,
        ts,
        m.reply_to ?? null,
        m.hops,
        m.attachments?.length ? JSON.stringify(m.attachments) : null,
      );
    const id = Number(res.lastInsertRowid);
    for (const f of m.attachments ?? []) this.db.prepare("UPDATE files SET message_id = ? WHERE id = ?").run(id, f.id);
    const out: ChatMessage = { ...m, id, ts };
    if (!out.attachments?.length) delete out.attachments;
    return out;
  }

  // ---- files ----

  addFile(f: FileInfo & { uploader: string }) {
    this.db
      .prepare("INSERT INTO files (id, name, mime, size, uploader, created) VALUES (?, ?, ?, ?, ?, ?)")
      .run(f.id, f.name, f.mime, f.size, f.uploader, new Date().toISOString());
  }

  file(id: string): FileRow | undefined {
    return this.db.prepare("SELECT * FROM files WHERE id = ?").get(id) as FileRow | undefined;
  }

  /** Files never attached to a message and older than `before` (ISO), plus files whose message is gone. */
  staleFiles(before: string): string[] {
    return (
      this.db
        .prepare(
          `SELECT id FROM files WHERE (message_id IS NULL AND created < ?)
             OR (message_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.id = files.message_id))`,
        )
        .all(before) as { id: string }[]
    ).map((r) => r.id);
  }

  deleteFile(id: string) {
    this.db.prepare("DELETE FROM files WHERE id = ?").run(id);
  }

  // ---- room briefs ----

  brief(room: string): RoomBrief | null {
    const r = this.db.prepare("SELECT room, text, author, ts FROM briefs WHERE room = ?").get(room) as
      | { room: string; text: string; author: string; ts: string }
      | undefined;
    return r ? { room: r.room, text: r.text, by: r.author, ts: r.ts } : null;
  }

  /** Stores a room's brief; empty text removes it. */
  setBrief(room: string, text: string, by: string): RoomBrief | null {
    if (!text) {
      this.db.prepare("DELETE FROM briefs WHERE room = ?").run(room);
      return null;
    }
    const ts = new Date().toISOString();
    this.db
      .prepare("INSERT INTO briefs (room, text, author, ts) VALUES (?, ?, ?, ?) ON CONFLICT(room) DO UPDATE SET text = ?, author = ?, ts = ?")
      .run(room, text, by, ts, text, by, ts);
    return { room, text, by, ts };
  }

  // ---- global hooks ----

  /** Every hook with its firing counts, oldest first. */
  hooks(): HookRule[] {
    const rows = this.db.prepare("SELECT * FROM hooks ORDER BY created_ts, id").all() as unknown as HookRow[];
    return rows.map((r) => this.hookOf(r));
  }

  hook(id: string): HookRule | undefined {
    const r = this.db.prepare("SELECT * FROM hooks WHERE id = ?").get(id) as unknown as HookRow | undefined;
    return r ? this.hookOf(r) : undefined;
  }

  private hookOf(r: HookRow): HookRule {
    const rule = JSON.parse(r.rule) as Omit<HookFields, "enabled">;
    const s = this.db
      .prepare("SELECT COALESCE(SUM(fired), 0) AS fired, COUNT(*) AS agents, MAX(last_ts) AS last FROM hook_fires WHERE hook_id = ? AND fired > 0")
      .get(r.id) as { fired: number; agents: number; last: string | null };
    return {
      id: r.id,
      enabled: !!r.enabled,
      trigger: rule.trigger,
      repeat: rule.repeat,
      action: rule.action,
      by: r.author,
      createdAt: r.created_ts,
      updatedAt: r.updated_ts,
      stats: { fired: Number(s.fired), agents: Number(s.agents), ...(s.last ? { lastFiredAt: s.last } : {}) },
    };
  }

  /** Creates a hook, or replaces one's rule (its firing history stays: alexey, 2238). */
  saveHook(id: string, fields: Required<HookFields>, by: string): HookRule {
    const ts = new Date().toISOString();
    const rule = JSON.stringify({ trigger: fields.trigger, repeat: fields.repeat, action: fields.action });
    this.db
      .prepare(
        `INSERT INTO hooks (id, enabled, rule, author, created_ts, updated_ts) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled, rule = excluded.rule, author = excluded.author, updated_ts = excluded.updated_ts`,
      )
      .run(id, fields.enabled ? 1 : 0, rule, by, ts, ts);
    return this.hook(id)!;
  }

  setHookEnabled(id: string, enabled: boolean): HookRule | undefined {
    this.db.prepare("UPDATE hooks SET enabled = ?, updated_ts = ? WHERE id = ?").run(enabled ? 1 : 0, new Date().toISOString(), id);
    return this.hook(id);
  }

  deleteHook(id: string): boolean {
    this.db.prepare("DELETE FROM hook_fires WHERE hook_id = ?").run(id);
    return Number(this.db.prepare("DELETE FROM hooks WHERE id = ?").run(id).changes) > 0;
  }

  /** How a hook stands for one agent: how often it fired for it, and whether it waits for real activity first. */
  hookFire(id: string, agent: string): { fired: number; awaiting: boolean } {
    const r = this.db.prepare("SELECT fired, awaiting FROM hook_fires WHERE hook_id = ? AND agent = ?").get(id, agent) as
      | { fired: number; awaiting: number }
      | undefined;
    return { fired: r?.fired ?? 0, awaiting: !!r?.awaiting };
  }

  /** Records that a hook fired for an agent; `awaiting`: it may fire for it again only after real activity. */
  recordHookFire(id: string, agent: string, awaiting: boolean, ts = new Date().toISOString()) {
    this.db
      .prepare(
        `INSERT INTO hook_fires (hook_id, agent, fired, last_ts, awaiting) VALUES (?, ?, 1, ?, ?)
         ON CONFLICT(hook_id, agent) DO UPDATE SET fired = fired + 1, last_ts = excluded.last_ts, awaiting = excluded.awaiting`,
      )
      .run(id, agent, ts, awaiting ? 1 : 0);
  }

  /** The agent did something real: every hook waiting for that may fire for it again. */
  clearHookAwaiting(agent: string) {
    this.db.prepare("UPDATE hook_fires SET awaiting = 0 WHERE agent = ? AND awaiting = 1").run(agent);
  }

  // ---- world intro ----

  intro(): WorldIntro | null {
    const r = this.db.prepare("SELECT text, author, ts FROM intro WHERE id = 1").get() as
      | { text: string; author: string; ts: string }
      | undefined;
    return r ? { text: r.text, by: r.author, ts: r.ts } : null;
  }

  /** Stores the intro; empty text removes it. */
  setIntro(text: string, by: string): WorldIntro | null {
    if (!text) {
      this.db.prepare("DELETE FROM intro WHERE id = 1").run();
      return null;
    }
    const ts = new Date().toISOString();
    this.db
      .prepare("INSERT INTO intro (id, text, author, ts) VALUES (1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET text = ?, author = ?, ts = ?")
      .run(text, by, ts, text, by, ts);
    return { text, by, ts };
  }

  // ---- agent notebooks: only the current state, a change overwrites, forget deletes ----

  /**
   * An agent's notes, oldest first, without their texts (each says how long its text is) unless `full`.
   * `q` matches the title, description, text or topic (any case), `topic` the topic exactly (any case).
   */
  notes(agent: string, q: { q?: string; topic?: string } = {}, full = false): AgentNote[] {
    const where = ["agent = ?"];
    const args: string[] = [agent];
    if (q.q) {
      where.push("(" + ["title", "description", "text", "COALESCE(topic, '')"].map((c) => `instr(fold(${c}), ?) > 0`).join(" OR ") + ")");
      const t = q.q.toLocaleLowerCase();
      args.push(t, t, t, t);
    }
    if (q.topic) {
      where.push("fold(topic) = ?");
      args.push(q.topic.toLocaleLowerCase());
    }
    const cols = full ? `${NOTE_COLS}, text` : NOTE_COLS;
    const rows = this.db.prepare(`SELECT ${cols} FROM notes WHERE ${where.join(" AND ")} ORDER BY id`).all(...args) as NoteRow[];
    return rows.map(toNote);
  }

  /** One note with its text. */
  note(agent: string, id: number): AgentNote | undefined {
    const r = this.db.prepare(`SELECT ${NOTE_COLS}, text FROM notes WHERE agent = ? AND id = ?`).get(agent, id) as NoteRow | undefined;
    return r && toNote(r);
  }

  /** How many notes an agent has and when the latest change was. */
  noteStats(agent: string): { count: number; last_ts: string | null } {
    return this.db.prepare("SELECT COUNT(*) AS count, MAX(ts) AS last_ts FROM notes WHERE agent = ?").get(agent) as {
      count: number;
      last_ts: string | null;
    };
  }

  addNote(agent: string, f: NoteFields): AgentNote {
    const ts = new Date().toISOString();
    const res = this.db
      .prepare("INSERT INTO notes (agent, topic, title, description, text, ts) VALUES (?, ?, ?, ?, ?, ?)")
      .run(agent, f.topic, f.title, f.description, f.text, ts);
    return this.note(agent, Number(res.lastInsertRowid))!;
  }

  /** Overwrites a note in place: the old version is gone. */
  updateNote(agent: string, id: number, f: NoteFields): AgentNote | undefined {
    const ts = new Date().toISOString();
    const res = this.db
      .prepare("UPDATE notes SET topic = ?, title = ?, description = ?, text = ?, ts = ? WHERE agent = ? AND id = ?")
      .run(f.topic, f.title, f.description, f.text, ts, agent, id);
    return Number(res.changes) ? this.note(agent, id) : undefined;
  }

  deleteNote(agent: string, id: number): boolean {
    return Number(this.db.prepare("DELETE FROM notes WHERE agent = ? AND id = ?").run(agent, id).changes) > 0;
  }

  // ---- games ----

  createGame(g: Omit<GameRecord, "id" | "created_ts" | "updated_ts">): GameRecord {
    const ts = new Date().toISOString();
    const res = this.db
      .prepare(
        `INSERT INTO games (game, players, created_by, moves, status, result, draw_offer, created_ts, updated_ts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(g.game, JSON.stringify(g.players), g.created_by, JSON.stringify(g.moves), g.status, g.result ? JSON.stringify(g.result) : null, g.draw_offer, ts, ts);
    return this.game(Number(res.lastInsertRowid))!;
  }

  game(id: number): GameRecord | undefined {
    const r = this.db.prepare("SELECT * FROM games WHERE id = ?").get(id) as GameRow | undefined;
    return r && toGame(r);
  }

  /** Forgets a game record (its room is deleted separately, with deleteRoom). Ids are never reused. */
  deleteGame(id: number) {
    this.db.prepare("DELETE FROM games WHERE id = ?").run(id);
  }

  games(q: { status?: string; game?: string; limit?: number } = {}): GameRecord[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (q.status) where.push("status = ?"), args.push(q.status);
    if (q.game) where.push("game = ?"), args.push(q.game);
    const rows = this.db
      .prepare(`SELECT * FROM games ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`)
      .all(...args, q.limit ?? 200) as unknown as GameRow[];
    return rows.map(toGame);
  }

  /** Every finished game, in the order they finished (a finished game is not updated again). */
  finishedGames(): GameRecord[] {
    const rows = this.db.prepare("SELECT * FROM games WHERE status = 'finished' ORDER BY updated_ts, id").all() as unknown as GameRow[];
    return rows.map(toGame);
  }

  updateGame(g: GameRecord): GameRecord {
    this.db
      .prepare("UPDATE games SET players = ?, moves = ?, status = ?, result = ?, draw_offer = ?, updated_ts = ? WHERE id = ?")
      .run(JSON.stringify(g.players), JSON.stringify(g.moves), g.status, g.result ? JSON.stringify(g.result) : null, g.draw_offer, new Date().toISOString(), g.id);
    return this.game(g.id)!;
  }

  get(id: number): ChatMessage | undefined {
    const r = this.db.prepare("SELECT * FROM messages WHERE id = ?").get(id) as Row | undefined;
    return r ? toMessage(r) : undefined;
  }

  maxId(): number {
    const r = this.db.prepare("SELECT COALESCE(MAX(id), 0) AS m FROM messages").get() as { m: number };
    return r.m;
  }

  join(agent: string, room: string) {
    this.db
      .prepare("INSERT OR IGNORE INTO memberships (agent, room, joined_after) VALUES (?, ?, ?)")
      .run(agent, room, this.maxId());
  }

  leave(agent: string, room: string) {
    this.db.prepare("DELETE FROM memberships WHERE agent = ? AND room = ?").run(agent, room);
  }

  roomsOf(agent: string): string[] {
    return (this.db.prepare("SELECT room FROM memberships WHERE agent = ? ORDER BY room").all(agent) as { room: string }[]).map(
      (r) => r.room,
    );
  }

  membersOf(room: string): string[] {
    return (this.db.prepare("SELECT agent FROM memberships WHERE room = ?").all(room) as { agent: string }[]).map(
      (r) => r.agent,
    );
  }

  isMember(agent: string, room: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM memberships WHERE agent = ? AND room = ?").get(agent, room);
  }

  cursor(agent: string): number {
    const r = this.db.prepare("SELECT last_id FROM cursors WHERE agent = ?").get(agent) as { last_id: number } | undefined;
    return r?.last_id ?? 0;
  }

  setCursor(agent: string, id: number) {
    this.db
      .prepare(
        "INSERT INTO cursors (agent, last_id) VALUES (?, ?) ON CONFLICT(agent) DO UPDATE SET last_id = MAX(last_id, excluded.last_id)",
      )
      .run(agent, id);
  }

  /** When the agent's last connection closed; undefined if it was never seen leaving. */
  lastSeen(agent: string): string | undefined {
    return (this.db.prepare("SELECT ts FROM last_seen WHERE agent = ?").get(agent) as { ts: string } | undefined)?.ts;
  }

  setLastSeen(agent: string, ts = new Date().toISOString()) {
    this.db.prepare("INSERT INTO last_seen (agent, ts) VALUES (?, ?) ON CONFLICT(agent) DO UPDATE SET ts = excluded.ts").run(agent, ts);
  }

  /** Records the adapter session an agent connected with; true when it differs from the last one (a new session). */
  newSession(agent: string, session: string): boolean {
    const last = (this.db.prepare("SELECT session FROM sessions WHERE agent = ?").get(agent) as { session: string } | undefined)?.session;
    if (last === session) return false;
    this.db.prepare("INSERT INTO sessions (agent, session) VALUES (?, ?) ON CONFLICT(agent) DO UPDATE SET session = excluded.session").run(agent, session);
    return true;
  }

  /** Thanks `author` got after `since` (an ISO time), oldest first. */
  thanksSince(author: string, since: string): { id: number; by: string }[] {
    return this.db
      .prepare(
        `SELECT t.message_id AS id, t.by AS by FROM thanks t JOIN messages m ON m.id = t.message_id
         WHERE m.sender = ? AND t.ts > ? ORDER BY t.ts, t.by`,
      )
      .all(author, since)
      .map((r) => ({ id: Number((r as { id: number }).id), by: String((r as { by: string }).by) }));
  }

  /** Messages addressed to `agent` (directly or via its rooms) that it has not received yet. */
  pendingFor(agent: string, limit = 500): ChatMessage[] {
    const rows = this.db
      .prepare(
        `SELECT m.* FROM messages m
         WHERE m.id > ? AND m.sender != ?
           AND (m.recipient = ?
                OR EXISTS (SELECT 1 FROM memberships s WHERE s.agent = ? AND s.room = m.room AND m.id > s.joined_after))
         ORDER BY m.id LIMIT ?`,
      )
      .all(this.cursor(agent), agent, agent, agent, limit) as unknown as Row[];
    return rows.map(toMessage);
  }

  /**
   * Messages whose text contains `text` (any case), newest first. `viewer` limits the search to what that
   * agent may read: its rooms and its direct messages. `dmsOf` (an admin) keeps every room but only that
   * person's direct messages. `room` / `agent` narrow it further.
   */
  search(q: {
    text: string;
    viewer?: string;
    dmsOf?: string;
    room?: string;
    agent?: string;
    before?: number;
    limit: number;
  }): ChatMessage[] {
    const where = ["instr(fold(text), ?) > 0"];
    const args: (string | number)[] = [q.text.toLocaleLowerCase()];
    if (q.viewer) {
      where.push(
        "((room IS NOT NULL AND room IN (SELECT room FROM memberships WHERE agent = ?)) OR (room IS NULL AND (sender = ? OR recipient = ?)))",
      );
      args.push(q.viewer, q.viewer, q.viewer);
    }
    if (q.dmsOf) {
      where.push(OWN_DMS);
      args.push(q.dmsOf, q.dmsOf);
    }
    if (q.room) {
      where.push("room = ?");
      args.push(q.room);
    }
    if (q.agent) {
      where.push("(sender = ? OR recipient = ?)");
      args.push(q.agent, q.agent);
    }
    if (q.before) {
      where.push("id < ?");
      args.push(q.before);
    }
    const sql = `SELECT * FROM messages WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT ?`;
    return (this.db.prepare(sql).all(...args, q.limit) as unknown as Row[]).map(toMessage);
  }

  roomHistory(room: string, limit: number): ChatMessage[] {
    const rows = this.db
      .prepare("SELECT * FROM (SELECT * FROM messages WHERE room = ? ORDER BY id DESC LIMIT ?) ORDER BY id")
      .all(room, limit) as unknown as Row[];
    return rows.map(toMessage);
  }

  /**
   * Any messages for the admin view: one room, one DM pair, or everything; paged backwards with `before`.
   * `dmsOf` drops direct messages that person is not part of.
   */
  allMessages(q: {
    room?: string;
    a?: string;
    b?: string;
    agent?: string;
    dmsOf?: string;
    before?: number;
    limit: number;
  }): ChatMessage[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (q.dmsOf) {
      where.push(OWN_DMS);
      args.push(q.dmsOf, q.dmsOf);
    }
    if (q.room) {
      where.push("room = ?");
      args.push(q.room);
    } else if (q.a && q.b) {
      where.push("((sender = ? AND recipient = ?) OR (sender = ? AND recipient = ?))");
      args.push(q.a, q.b, q.b, q.a);
    }
    if (q.agent) {
      // everything the agent wrote, and the direct messages it received
      where.push("(sender = ? OR recipient = ?)");
      args.push(q.agent, q.agent);
    }
    if (q.before) {
      where.push("id < ?");
      args.push(q.before);
    }
    const sql = `SELECT * FROM (SELECT * FROM messages ${where.length ? "WHERE " + where.join(" AND ") : ""}
                 ORDER BY id DESC LIMIT ?) ORDER BY id`;
    return this.withDeliveries((this.db.prepare(sql).all(...args, q.limit) as unknown as Row[]).map(toMessage));
  }

  /** Records that `agent`'s session received message `id`; false if it was already recorded. */
  markDelivered(id: number, agent: string): boolean {
    const res = this.db
      .prepare("INSERT OR IGNORE INTO deliveries (message_id, agent, ts) VALUES (?, ?, ?)")
      .run(id, agent, new Date().toISOString());
    return Number(res.changes) > 0;
  }

  /** Records that `by` thanked the author of message `id`; false if they already had. */
  addThanks(id: number, by: string): boolean {
    const res = this.db.prepare("INSERT OR IGNORE INTO thanks (message_id, by, ts) VALUES (?, ?, ?)").run(id, by, new Date().toISOString());
    return Number(res.changes) > 0;
  }

  /** Who thanked the author of message `id`, oldest first. */
  thanksFor(id: number): string[] {
    return (this.db.prepare("SELECT by FROM thanks WHERE message_id = ? ORDER BY ts, by").all(id) as { by: string }[]).map((r) => r.by);
  }

  /** Thanks each author got in all, for messages that still exist. */
  thanksReceived(): Map<string, number> {
    const rows = this.db
      .prepare("SELECT m.sender AS name, COUNT(*) AS n FROM thanks t JOIN messages m ON m.id = t.message_id GROUP BY m.sender")
      .all() as { name: string; n: number }[];
    return new Map(rows.map((r) => [r.name, Number(r.n)]));
  }

  /** Fills `delivered_to` on messages that someone received and `thanked_by` on messages someone thanked for. */
  private withDeliveries(messages: ChatMessage[]): ChatMessage[] {
    if (!messages.length) return messages;
    const rows = this.db
      .prepare(
        `SELECT message_id, agent FROM deliveries WHERE message_id BETWEEN ? AND ? ORDER BY ts, agent`,
      )
      .all(messages[0].id, messages[messages.length - 1].id) as { message_id: number; agent: string }[];
    const by = new Map<number, string[]>();
    for (const r of rows) by.set(r.message_id, [...(by.get(r.message_id) ?? []), r.agent]);
    const thanks = this.db
      .prepare("SELECT message_id, by FROM thanks WHERE message_id BETWEEN ? AND ? ORDER BY ts, by")
      .all(messages[0].id, messages[messages.length - 1].id) as { message_id: number; by: string }[];
    const thankedBy = new Map<number, string[]>();
    for (const r of thanks) thankedBy.set(r.message_id, [...(thankedBy.get(r.message_id) ?? []), r.by]);
    for (const m of messages) {
      const to = by.get(m.id);
      if (to) m.delivered_to = to;
      const th = thankedBy.get(m.id);
      if (th) m.thanked_by = th;
    }
    return messages;
  }

  /** Rooms with members or messages (only `agent`'s rooms if given), with message count and last activity. */
  rooms(agent?: string): { name: string; members: string[]; count: number; last_ts: string | null }[] {
    const rows = this.db
      .prepare(
        `SELECT r.room AS name, COUNT(m.id) AS count, MAX(m.ts) AS last_ts
         FROM (SELECT room FROM memberships UNION SELECT room FROM messages WHERE room IS NOT NULL UNION SELECT name FROM rooms) r
         LEFT JOIN messages m ON m.room = r.room
         ${agent ? "WHERE r.room IN (SELECT room FROM memberships WHERE agent = ?)" : ""}
         GROUP BY r.room ORDER BY r.room`,
      )
      .all(...(agent ? [agent] : [])) as { name: string; count: number; last_ts: string | null }[];
    return rows.map((r) => ({ name: r.name, members: this.membersOf(r.name).sort(), count: r.count, last_ts: r.last_ts }));
  }

  /** Names of every room that has members or messages. */
  allRoomNames(): string[] {
    return (
      this.db
        .prepare(
          "SELECT room FROM memberships UNION SELECT room FROM messages WHERE room IS NOT NULL UNION SELECT name FROM rooms ORDER BY room",
        )
        .all() as { room: string }[]
    ).map((r) => r.room);
  }

  /** Pairs of agents that exchanged direct messages (only pairs with `agent` if given); `a` sorts before `b`. */
  dms(agent?: string): { a: string; b: string; count: number; last_ts: string }[] {
    return this.db
      .prepare(
        `SELECT MIN(sender, recipient) AS a, MAX(sender, recipient) AS b, COUNT(*) AS count, MAX(ts) AS last_ts
         FROM messages WHERE recipient IS NOT NULL ${agent ? "AND (sender = ? OR recipient = ?)" : ""}
         GROUP BY a, b ORDER BY last_ts DESC`,
      )
      .all(...(agent ? [agent, agent] : [])) as { a: string; b: string; count: number; last_ts: string }[];
  }

  roomExists(room: string): boolean {
    return !!this.db
      .prepare(
        `SELECT 1 FROM rooms WHERE name = ? UNION SELECT 1 FROM memberships WHERE room = ?
         UNION SELECT 1 FROM messages WHERE room = ? LIMIT 1`,
      )
      .get(room, room, room);
  }

  /** Records an (possibly empty) room so it shows up in lists before anyone joins. */
  createRoom(room: string) {
    this.db.prepare("INSERT OR IGNORE INTO rooms (name, created) VALUES (?, ?)").run(room, new Date().toISOString());
  }

  /** Removes a room's members and its record; with `messages` also its history and brief. */
  deleteRoom(room: string, messages: boolean) {
    this.db.prepare("DELETE FROM memberships WHERE room = ?").run(room);
    this.db.prepare("DELETE FROM rooms WHERE name = ?").run(room);
    if (messages) {
      // the room is gone for good: its deliveries and brief go with its history
      this.db.prepare("DELETE FROM deliveries WHERE message_id IN (SELECT id FROM messages WHERE room = ?)").run(room);
      this.db.prepare("DELETE FROM thanks WHERE message_id IN (SELECT id FROM messages WHERE room = ?)").run(room);
      this.db.prepare("DELETE FROM messages WHERE room = ?").run(room);
      this.db.prepare("DELETE FROM briefs WHERE room = ?").run(room);
    }
  }

  /** Drops a removed agent's memberships, delivery cursor and notebook; its messages stay in the history. */
  forgetAgent(agent: string) {
    this.db.prepare("DELETE FROM memberships WHERE agent = ?").run(agent);
    this.db.prepare("DELETE FROM cursors WHERE agent = ?").run(agent);
    this.db.prepare("DELETE FROM last_seen WHERE agent = ?").run(agent);
    this.db.prepare("DELETE FROM sessions WHERE agent = ?").run(agent);
    this.db.prepare("DELETE FROM notes WHERE agent = ?").run(agent);
  }

  dmHistory(a: string, b: string, limit: number): ChatMessage[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM (SELECT * FROM messages
           WHERE (sender = ? AND recipient = ?) OR (sender = ? AND recipient = ?)
           ORDER BY id DESC LIMIT ?) ORDER BY id`,
      )
      .all(a, b, b, a, limit) as unknown as Row[];
    return rows.map(toMessage);
  }
}
