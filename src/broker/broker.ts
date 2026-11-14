import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { Store } from "./store.js";
import type { AgentConfig, BrokerConfig } from "./config.js";
import { NAME_RE, ROOM_RE, type AgentInfo, type ChatMessage, type ClientFrame, type ServerFrame } from "../protocol.js";

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
}

interface SendArgs {
  to?: string;
  room?: string;
  text: string;
  reply_to?: number;
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
  private sockets = new Map<string, Set<WebSocket>>();
  private sent = new Map<string, number[]>();
  private webhookChains = new Map<string, Promise<void>>();
  private retryTimer?: NodeJS.Timeout;
  private http?: Server;
  private wss?: WebSocketServer;
  private log: (msg: string) => void;

  constructor(private opts: BrokerOptions) {
    this.store = opts.store ?? new Store(opts.config().db);
    this.log = opts.log ?? ((m) => console.error(`[broker] ${m}`));
    this.syncConfiguredRooms();
  }

  private get cfg() {
    return this.opts.config();
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

  // ---------------- core operations ----------------

  send(from: string, args: SendArgs): ChatMessage {
    const cfg = this.cfg;
    const text = typeof args.text === "string" ? args.text : "";
    if (!text.trim()) throw new BrokerError("text is empty");
    if (text.length > cfg.maxTextLength) throw new BrokerError(`text is longer than ${cfg.maxTextLength} characters`);
    if (!!args.to === !!args.room) throw new BrokerError("set exactly one of `to` (agent) or `room`");
    if (args.to) {
      if (!cfg.agents.some((a) => a.name === args.to)) throw new BrokerError(`unknown agent: ${args.to}`, 404);
      if (args.to === from) throw new BrokerError("cannot send a message to yourself");
    }
    if (args.room) {
      if (!ROOM_RE.test(args.room)) throw new BrokerError(`invalid room name: ${args.room}`);
      this.store.join(from, args.room);
    }

    let hops = 0;
    if (args.reply_to != null) {
      const parent = this.store.get(Number(args.reply_to));
      if (!parent || !this.canSee(from, parent)) throw new BrokerError(`unknown message: ${args.reply_to}`, 404);
      hops = parent.hops + 1;
      if (hops > cfg.maxHops)
        throw new BrokerError(
          `hop limit reached (${cfg.maxHops}): this conversation was stopped to prevent an endless agent loop. ` +
            "Start a new message without reply_to only if a human asked you to continue.",
          429,
        );
    }

    this.checkRate(from);
    const msg = this.store.insert({ from, to: args.to, room: args.room, text, reply_to: args.reply_to, hops });
    this.log(`#${msg.id} ${from} -> ${msg.to ?? "#" + msg.room} (hops ${hops})`);
    this.deliver(msg);
    return msg;
  }

  private canSee(agent: string, m: ChatMessage) {
    if (m.room) return this.store.isMember(agent, m.room);
    return m.from === agent || m.to === agent;
  }

  private checkRate(agent: string) {
    const now = Date.now();
    const recent = (this.sent.get(agent) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= this.cfg.ratePerMinute)
      throw new BrokerError(`rate limit: at most ${this.cfg.ratePerMinute} messages per minute`, 429);
    recent.push(now);
    this.sent.set(agent, recent);
  }

  join(agent: string, room: string) {
    if (!ROOM_RE.test(room)) throw new BrokerError(`invalid room name: ${room}`);
    this.store.join(agent, room);
  }

  leave(agent: string, room: string) {
    this.store.leave(agent, room);
  }

  agents(): AgentInfo[] {
    return this.cfg.agents.map((a) => ({
      name: a.name,
      kind: a.kind,
      ...(a.description ? { description: a.description } : {}),
      online: (this.sockets.get(a.name)?.size ?? 0) > 0 || !!a.webhook,
      rooms: this.store.roomsOf(a.name),
    }));
  }

  history(agent: string, q: { room?: string; with?: string; limit?: number }): ChatMessage[] {
    const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 500);
    if (q.room) {
      if (!this.store.isMember(agent, q.room)) throw new BrokerError(`you are not in room ${q.room}`, 403);
      return this.store.roomHistory(q.room, limit);
    }
    if (q.with) {
      if (!NAME_RE.test(q.with)) throw new BrokerError(`invalid agent name: ${q.with}`);
      return this.store.dmHistory(agent, q.with, limit);
    }
    throw new BrokerError("set `room` or `with`");
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

  private deliver(m: ChatMessage) {
    for (const name of this.recipients(m)) {
      const socks = this.sockets.get(name);
      if (socks?.size) {
        for (const ws of socks) this.sendFrame(ws, { type: "message", message: m });
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

  private broadcastPresence(agent: string, online: boolean) {
    for (const set of this.sockets.values()) for (const ws of set) this.sendFrame(ws, { type: "presence", agent, online });
  }

  // ---------------- WebSocket ----------------

  private onConnection(ws: WebSocket) {
    let agent: AgentConfig | undefined;
    const authTimer = setTimeout(() => !agent && ws.close(4001, "auth timeout"), 10_000);
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
      if (!agent) {
        if (f.type !== "auth") return this.sendFrame(ws, { type: "error", error: "authenticate first", ref });
        agent = this.authenticate(f.token);
        if (!agent) {
          this.sendFrame(ws, { type: "error", error: "invalid token", ref });
          return ws.close(4003, "invalid token");
        }
        clearTimeout(authTimer);
        const name = agent.name;
        const wasOnline = (this.sockets.get(name)?.size ?? 0) > 0;
        this.sendFrame(ws, { type: "welcome", agent: name, rooms: this.store.roomsOf(name), ref });
        const pending = this.store.pendingFor(name);
        for (const m of pending) this.sendFrame(ws, { type: "message", message: m });
        if (pending.length) this.store.setCursor(name, pending[pending.length - 1].id);
        if (!this.sockets.has(name)) this.sockets.set(name, new Set());
        this.sockets.get(name)!.add(ws);
        if (!wasOnline) this.broadcastPresence(name, true);
        this.log(`${name} connected`);
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
      if (!agent) return;
      const set = this.sockets.get(agent.name);
      set?.delete(ws);
      if (set && set.size === 0) {
        this.sockets.delete(agent.name);
        this.broadcastPresence(agent.name, false);
      }
      this.log(`${agent.name} disconnected`);
    });
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
      if (url.pathname === "/health") return reply(200, { ok: true });
      if (!url.pathname.startsWith("/api/")) return reply(404, { error: "not found" });
      const token = req.headers.authorization?.replace(/^Bearer\s+/i, "");
      const agent = this.authenticate(token);
      if (!agent) return reply(401, { error: "invalid or missing bearer token" });
      const me = agent.name;

      const body = async (): Promise<Record<string, unknown>> => {
        let raw = "";
        for await (const chunk of req) {
          raw += chunk;
          if (raw.length > 1_000_000) throw new BrokerError("body too large", 413);
        }
        try {
          return raw ? JSON.parse(raw) : {};
        } catch {
          throw new BrokerError("invalid JSON body");
        }
      };

      const route = `${req.method} ${url.pathname}`;
      const roomMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/(join|leave)$/);
      if (route === "GET /api/me") return reply(200, { name: me, kind: agent.kind, rooms: this.store.roomsOf(me) });
      if (route === "GET /api/agents") return reply(200, { agents: this.agents() });
      if (route === "POST /api/messages") {
        const b = await body();
        const m = this.send(me, b as unknown as SendArgs);
        return reply(201, { message: m });
      }
      if (route === "GET /api/inbox") return reply(200, { messages: this.inbox(me) });
      if (route === "GET /api/history") {
        const q = Object.fromEntries(url.searchParams);
        return reply(200, { messages: this.history(me, { room: q.room, with: q.with, limit: Number(q.limit) || 50 }) });
      }
      if (req.method === "POST" && roomMatch) {
        const room = decodeURIComponent(roomMatch[1]);
        roomMatch[2] === "join" ? this.join(me, room) : this.leave(me, room);
        return reply(200, { ok: true, rooms: this.store.roomsOf(me) });
      }
      return reply(404, { error: "not found" });
    } catch (e) {
      const status = e instanceof BrokerError ? e.status : 500;
      if (status === 500) this.log(`HTTP error: ${(e as Error).stack}`);
      return reply(status, { error: (e as Error).message });
    }
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
    this.retryTimer.unref();
    void this.flushWebhooks();
    return new Promise((resolve) => {
      this.http!.listen(port, host, () => {
        const addr = this.http!.address();
        resolve(typeof addr === "object" && addr ? addr.port : port);
      });
    });
  }

  async close() {
    clearInterval(this.retryTimer);
    for (const set of this.sockets.values()) for (const ws of set) ws.terminate();
    await new Promise<void>((r) => (this.wss ? this.wss.close(() => r()) : r()));
    await new Promise<void>((r) => (this.http ? this.http.close(() => r()) : r()));
    await Promise.all(this.webhookChains.values());
    this.store.close();
  }
}
