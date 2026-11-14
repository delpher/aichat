import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { Store } from "./store.js";
import {
  SETTING_LIMITS,
  checkSettingsPatch,
  newToken,
  settingsOf,
  type AgentConfig,
  type BrokerConfig,
} from "./config.js";
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
  /**
   * Applies `fn` to the raw config, saves it and returns the new config. Used by the web UI to change
   * settings and manage people. Without it those admin endpoints answer 403.
   */
  editConfig?: (fn: (raw: Partial<BrokerConfig>) => void) => BrokerConfig;
  /** Folder with the web UI (index.html, app.js, ...). Defaults to `web/` in the package root. */
  webDir?: string;
}

const DEFAULT_WEB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "web");

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
};

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
  /** Admin sockets (web UI) that see every message and presence change. */
  private observers = new Set<WebSocket>();
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

  isAdmin(token: string | undefined): boolean {
    const admin = this.cfg.adminToken;
    return !!token && !!admin && safeEqual(admin, token);
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

  /** What one agent may see: its rooms, its direct conversations, everyone's presence. */
  overview(agent: AgentConfig) {
    return {
      me: { name: agent.name, kind: agent.kind },
      agents: this.agents(),
      rooms: this.store.rooms(agent.name),
      dms: this.store.dms(agent.name),
      all_rooms: this.store.allRoomNames(),
    };
  }

  /** Drops every live connection of an agent (after its token changed or it was removed). */
  private disconnect(name: string, reason: string) {
    for (const ws of this.sockets.get(name) ?? []) ws.close(4003, reason);
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
    for (const ws of this.observers) this.sendFrame(ws, { type: "message", message: m });
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
    const f: ServerFrame = { type: "presence", agent, online };
    for (const set of this.sockets.values()) for (const ws of set) this.sendFrame(ws, f);
    for (const ws of this.observers) this.sendFrame(ws, f);
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
        if (this.isAdmin(f.token)) {
          observer = true;
          clearTimeout(authTimer);
          this.observers.add(ws);
          this.sendFrame(ws, { type: "welcome", agent: "admin", rooms: [], observer: true, ref });
          this.log("admin observer connected");
          return;
        }
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
      this.observers.delete(ws);
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
      if (req.method === "GET" && (url.pathname === "/" || url.pathname.startsWith("/web/")))
        return await this.serveStatic(url.pathname, res);
      if (url.pathname.startsWith("/admin/api/")) return await this.onAdminRequest(req, url, reply);
      if (!url.pathname.startsWith("/api/")) return reply(404, { error: "not found" });
      const token = req.headers.authorization?.replace(/^Bearer\s+/i, "");
      const agent = this.authenticate(token);
      if (!agent) return reply(401, { error: "invalid or missing bearer token" });
      const me = agent.name;

      const body = () => readJson(req);

      const route = `${req.method} ${url.pathname}`;
      const roomMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/(join|leave)$/);
      if (route === "GET /api/me") return reply(200, { name: me, kind: agent.kind, rooms: this.store.roomsOf(me) });
      if (route === "GET /api/overview") return reply(200, this.overview(agent));
      if (route === "GET /api/agents") return reply(200, { agents: this.agents() });
      if (route === "POST /api/messages") {
        const b = await body();
        const m = this.send(me, b as unknown as SendArgs);
        return reply(201, { message: m });
      }
      if (route === "GET /api/inbox") return reply(200, { messages: this.inbox(me) });
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
      const status = e instanceof BrokerError ? e.status : 500;
      if (status === 500) this.log(`HTTP error: ${(e as Error).stack}`);
      return reply(status, { error: (e as Error).message });
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
        "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; frame-ancestors 'none'",
    });
    res.end(data);
  }

  private async onAdminRequest(req: IncomingMessage, url: URL, reply: (status: number, body: unknown) => void) {
    if (!this.cfg.adminToken)
      return reply(403, { error: "admin access is off: run `npm run admin-token` to create a token" });
    if (!this.isAdmin(req.headers.authorization?.replace(/^Bearer\s+/i, "")))
      return reply(401, { error: "invalid or missing admin token" });
    const route = `${req.method} ${url.pathname}`;
    if (route === "GET /admin/api/overview")
      return reply(200, { agents: this.agents(), rooms: this.store.rooms(), dms: this.store.dms() });
    const edit = (fn: (raw: Partial<BrokerConfig>) => void): BrokerConfig => {
      if (!this.opts.editConfig) throw new BrokerError("the config is read-only in this broker", 403);
      try {
        return this.opts.editConfig(fn);
      } catch (e) {
        throw e instanceof BrokerError ? e : new BrokerError((e as Error).message);
      }
    };
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

    // ---- people ----
    if (route === "GET /admin/api/agents")
      return reply(200, {
        agents: this.agents().map((a) => ({ ...a, webhook: !!this.cfg.agents.find((c) => c.name === a.name)?.webhook })),
      });
    if (route === "POST /admin/api/agents") {
      const b = await readJson(req);
      const name = b.name;
      const kind = b.kind ?? "human";
      if (typeof name !== "string" || !NAME_RE.test(name))
        throw new BrokerError("name must be 1-64 characters: letters, digits, _ or -");
      if (kind !== "human") throw new BrokerError('the web UI may only add agents of kind "human"', 403);
      if (b.description != null && typeof b.description !== "string") throw new BrokerError("description must be a string");
      const rooms = b.rooms ?? [];
      if (!Array.isArray(rooms) || !rooms.every((r) => typeof r === "string" && ROOM_RE.test(r)))
        throw new BrokerError("rooms must be a list of room names (letters, digits, _ or -)");
      if (this.cfg.agents.some((a) => a.name === name)) throw new BrokerError(`agent ${name} already exists`);
      const agent: AgentConfig = {
        name,
        kind,
        token: newToken(),
        ...(typeof b.description === "string" && b.description.trim() ? { description: b.description.trim() } : {}),
        ...(rooms.length ? { rooms: [...new Set(rooms as string[])] } : {}),
      };
      edit((raw) => {
        raw.agents ??= [];
        if (raw.agents.some((a) => a.name === name)) throw new BrokerError(`agent ${name} already exists`);
        raw.agents.push(agent);
      });
      for (const r of agent.rooms ?? []) this.store.join(name, r);
      this.log(`admin added ${name} (${kind})`);
      const { token, ...info } = agent;
      return reply(201, { agent: { ...info, rooms: this.store.roomsOf(name), online: false }, token });
    }
    const agentMatch = url.pathname.match(/^\/admin\/api\/agents\/([^/]+)(\/token)?$/);
    if (agentMatch) {
      const name = decodeURIComponent(agentMatch[1]);
      const target = this.cfg.agents.find((a) => a.name === name);
      if (!target) throw new BrokerError(`unknown agent: ${name}`, 404);
      const humanOnly = () => {
        if (target.kind !== "human")
          throw new BrokerError(`the web UI may only manage agents of kind "human"; ${name} is "${target.kind}"`, 403);
      };
      if (req.method === "POST" && agentMatch[2]) {
        humanOnly();
        const token = newToken();
        edit((raw) => {
          const a = raw.agents?.find((x) => x.name === name);
          if (!a) throw new BrokerError(`unknown agent: ${name}`, 404);
          a.token = token;
        });
        this.disconnect(name, "token changed");
        this.log(`admin issued a new token for ${name}`);
        return reply(200, { token });
      }
      if (req.method === "DELETE" && !agentMatch[2]) {
        humanOnly();
        edit((raw) => {
          raw.agents = (raw.agents ?? []).filter((x) => x.name !== name);
        });
        this.disconnect(name, "agent removed");
        this.store.forgetAgent(name);
        this.log(`admin removed ${name}`);
        return reply(200, { ok: true });
      }
    }
    if (route === "GET /admin/api/messages") {
      const q = Object.fromEntries(url.searchParams);
      if (!!q.a !== !!q.b) throw new BrokerError("set both `a` and `b` for a direct conversation");
      if (q.room && q.a) throw new BrokerError("set either `room` or `a`+`b`, not both");
      const limit = Math.min(Math.max(Number(q.limit) || 100, 1), 500);
      const before = q.before ? Number(q.before) : undefined;
      if (before !== undefined && !(before > 0)) throw new BrokerError("`before` must be a positive message id");
      return reply(200, { messages: this.store.allMessages({ room: q.room, a: q.a, b: q.b, before, limit }) });
    }
    if (route === "POST /admin/api/messages") {
      const b = await readJson(req);
      const as = this.cfg.agents.find((a) => a.name === b.as);
      if (!as) throw new BrokerError(`unknown agent: ${String(b.as)}`, 404);
      if (as.kind !== "human")
        throw new BrokerError(`the web UI may only post as agents of kind "human"; ${as.name} is "${as.kind}"`, 403);
      const m = this.send(as.name, {
        to: b.to as string | undefined,
        room: b.room as string | undefined,
        text: b.text as string,
        reply_to: b.reply_to as number | undefined,
      });
      return reply(201, { message: m });
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
    for (const ws of this.observers) ws.terminate();
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
