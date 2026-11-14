import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ChatMessage } from "../protocol.js";

interface Row {
  id: number;
  sender: string;
  recipient: string | null;
  room: string | null;
  text: string;
  ts: string;
  reply_to: number | null;
  hops: number;
}

function toMessage(r: Row): ChatMessage {
  const m: ChatMessage = { id: r.id, from: r.sender, text: r.text, ts: r.ts, hops: r.hops };
  if (r.recipient) m.to = r.recipient;
  if (r.room) m.room = r.room;
  if (r.reply_to != null) m.reply_to = r.reply_to;
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
      CREATE TABLE IF NOT EXISTS cursors (
        agent TEXT PRIMARY KEY,
        last_id INTEGER NOT NULL
      );
    `);
  }

  close() {
    this.db.close();
  }

  insert(m: Omit<ChatMessage, "id" | "ts">): ChatMessage {
    const ts = new Date().toISOString();
    const res = this.db
      .prepare(
        "INSERT INTO messages (sender, recipient, room, text, ts, reply_to, hops) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(m.from, m.to ?? null, m.room ?? null, m.text, ts, m.reply_to ?? null, m.hops);
    return { ...m, id: Number(res.lastInsertRowid), ts };
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

  roomHistory(room: string, limit: number): ChatMessage[] {
    const rows = this.db
      .prepare("SELECT * FROM (SELECT * FROM messages WHERE room = ? ORDER BY id DESC LIMIT ?) ORDER BY id")
      .all(room, limit) as unknown as Row[];
    return rows.map(toMessage);
  }

  /** Any messages for the admin view: one room, one DM pair, or everything; paged backwards with `before`. */
  allMessages(q: { room?: string; a?: string; b?: string; before?: number; limit: number }): ChatMessage[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (q.room) {
      where.push("room = ?");
      args.push(q.room);
    } else if (q.a && q.b) {
      where.push("((sender = ? AND recipient = ?) OR (sender = ? AND recipient = ?))");
      args.push(q.a, q.b, q.b, q.a);
    }
    if (q.before) {
      where.push("id < ?");
      args.push(q.before);
    }
    const sql = `SELECT * FROM (SELECT * FROM messages ${where.length ? "WHERE " + where.join(" AND ") : ""}
                 ORDER BY id DESC LIMIT ?) ORDER BY id`;
    return (this.db.prepare(sql).all(...args, q.limit) as unknown as Row[]).map(toMessage);
  }

  /** Every room that has members or messages, with message count and last activity. */
  rooms(): { name: string; members: string[]; count: number; last_ts: string | null }[] {
    const rows = this.db
      .prepare(
        `SELECT r.room AS name, COUNT(m.id) AS count, MAX(m.ts) AS last_ts
         FROM (SELECT room FROM memberships UNION SELECT room FROM messages WHERE room IS NOT NULL) r
         LEFT JOIN messages m ON m.room = r.room
         GROUP BY r.room ORDER BY r.room`,
      )
      .all() as { name: string; count: number; last_ts: string | null }[];
    return rows.map((r) => ({ name: r.name, members: this.membersOf(r.name).sort(), count: r.count, last_ts: r.last_ts }));
  }

  /** Every pair of agents that exchanged direct messages; `a` sorts before `b`. */
  dms(): { a: string; b: string; count: number; last_ts: string }[] {
    return this.db
      .prepare(
        `SELECT MIN(sender, recipient) AS a, MAX(sender, recipient) AS b, COUNT(*) AS count, MAX(ts) AS last_ts
         FROM messages WHERE recipient IS NOT NULL GROUP BY a, b ORDER BY last_ts DESC`,
      )
      .all() as { a: string; b: string; count: number; last_ts: string }[];
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
