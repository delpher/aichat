import { EventEmitter } from "node:events";
import { WebSocket } from "ws";
import type { AdapterInfo, AgentInfo, ChatMessage, ClientFrame, FileInfo, ServerFrame } from "../protocol.js";

type Request = ClientFrame extends infer F ? (F extends { type: string } ? Omit<F, "ref"> : never) : never;

export interface BrokerClientOptions {
  url: string;
  token: string;
  /** Reconnect after the connection drops (default true). */
  reconnect?: boolean;
  /** Admins only: receive every message (read-only feed) instead of connecting as a participant. */
  observer?: boolean;
  log?: (msg: string) => void;
  /** Sent with `auth` so the broker knows which adapter and version this is. */
  client?: AdapterInfo;
  /** Sent with `auth`: one id per adapter process, so the broker greets a new session but not a reconnect. */
  session?: string;
  /**
   * A connection that has heard nothing from the broker (not even its ping, sent every 30 s) for this long
   * is taken to be dead and is replaced (default 75 s). A network path can die without either side being
   * told; the broker notices by its pings, this is how the client notices.
   */
  staleMs?: number;
}

/** Requests that do the same thing when sent twice: safe to repeat once the connection is back. */
const IDEMPOTENT = new Set(["history", "list_agents", "join", "leave", "delivered", "ping"]);
const CLOSED = "connection closed";

/**
 * WebSocket client for the broker, shared by every adapter.
 * Events: "message" (ChatMessage), "presence" ({agent, online}), "connected" (agent name), "disconnected".
 */
export class BrokerClient extends EventEmitter {
  agent?: string;
  private ws?: WebSocket;
  private seq = 0;
  private pending = new Map<string, { resolve: (f: ServerFrame) => void; reject: (e: Error) => void }>();
  private closed = false;
  private backoff = 500;
  private ready?: Promise<void>;
  private log: (msg: string) => void;
  /** When the broker was last heard from on the current connection. */
  private lastHeard = 0;
  private watchdog?: NodeJS.Timeout;

  constructor(private opts: BrokerClientOptions) {
    super();
    this.log = opts.log ?? ((m) => console.error(`[aichat] ${m}`));
  }

  /** Connects and authenticates. Resolves once the broker has welcomed us. */
  connect(): Promise<void> {
    this.ready = new Promise((resolve, reject) => {
      const url = this.opts.url.replace(/\/?$/, "").replace(/\/ws$/, "") + "/ws";
      const ws = new WebSocket(url);
      this.ws = ws;
      let welcomed = false;
      ws.on("open", () => {
        this.hear();
        const ref = this.nextRef();
        this.pending.set(ref, {
          resolve: (f) => {
            if (f.type === "welcome") {
              welcomed = true;
              this.agent = f.agent;
              this.backoff = 500;
              this.watch(ws);
              this.emit("connected", f.agent);
              resolve();
            } else reject(new Error(f.type === "error" ? f.error : "unexpected reply to auth"));
          },
          reject,
        });
        ws.send(
          JSON.stringify({
            type: "auth",
            token: this.opts.token,
            ...(this.opts.observer ? { observer: true } : {}),
            ...(this.opts.client ? { client: this.opts.client } : {}),
            ...(this.opts.session ? { session: this.opts.session } : {}),
            ref,
          }),
        );
      });
      ws.on("message", (data) => {
        this.hear();
        this.onFrame(JSON.parse(String(data)) as ServerFrame);
      });
      ws.on("ping", () => this.hear());
      ws.on("pong", () => this.hear());
      ws.on("error", (e) => {
        if (!welcomed) reject(e);
        this.log(`connection error: ${e.message}`);
      });
      ws.on("close", (code, reason) => {
        if (this.ws === ws) clearInterval(this.watchdog);
        for (const p of this.pending.values()) p.reject(new Error(CLOSED));
        this.pending.clear();
        if (welcomed) this.emit("disconnected");
        if (code === 4003) {
          this.closed = true;
          reject(new Error(`broker rejected the token (${reason})`));
          return;
        }
        if (!this.closed && this.opts.reconnect !== false && welcomed) this.scheduleReconnect();
      });
    });
    return this.ready;
  }

  /** Connects, retrying with backoff until the broker is reachable. */
  async connectWithRetry(): Promise<void> {
    for (;;) {
      try {
        return await this.connect();
      } catch (e) {
        if (this.closed) throw e;
        this.log(`cannot reach broker at ${this.opts.url}: ${(e as Error).message}; retrying in ${this.backoff}ms`);
        await new Promise((r) => setTimeout(r, this.backoff));
        this.backoff = Math.min(this.backoff * 2, 15_000);
      }
    }
  }

  private hear() {
    this.lastHeard = Date.now();
  }

  /** Replaces a connection the broker has gone silent on: its close event brings the reconnect. */
  private watch(ws: WebSocket) {
    clearInterval(this.watchdog);
    const stale = this.opts.staleMs ?? 75_000;
    this.watchdog = setInterval(() => {
      if (this.ws !== ws || ws.readyState !== WebSocket.OPEN) return;
      if (Date.now() - this.lastHeard < stale) return;
      this.log(`nothing from the broker for ${Math.round((Date.now() - this.lastHeard) / 1000)} s; reconnecting`);
      ws.terminate();
    }, Math.max(50, Math.min(15_000, stale / 3)));
    this.watchdog.unref?.();
  }

  /** Waits until a connection is welcomed again (after a drop), or gives up after `timeoutMs`. */
  private whenConnected(timeoutMs: number): Promise<boolean> {
    if (this.ws?.readyState === WebSocket.OPEN && this.agent) return Promise.resolve(true);
    // without reconnecting nothing will come back; before the first welcome, wait for connect() as before
    if (this.closed || (this.opts.reconnect === false && this.agent)) return Promise.resolve(false);
    return new Promise((resolve) => {
      const done = (ok: boolean) => {
        clearTimeout(timer);
        this.off("connected", onConnected);
        resolve(ok);
      };
      const onConnected = () => done(true);
      const timer = setTimeout(() => done(false), timeoutMs);
      this.on("connected", onConnected);
    });
  }

  private scheduleReconnect() {
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, 15_000);
    this.log(`disconnected; reconnecting in ${delay}ms`);
    setTimeout(() => {
      if (!this.closed) void this.connectWithRetry().catch((e) => this.log(e.message));
    }, delay);
  }

  private onFrame(f: ServerFrame) {
    if (f.type === "message") return void this.emit("message", f.message, f.reactions_since ?? []);
    if (f.type === "presence") return void this.emit("presence", { agent: f.agent, online: f.online });
    const ref = "ref" in f ? f.ref : undefined;
    if (ref && this.pending.has(ref)) {
      const p = this.pending.get(ref)!;
      this.pending.delete(ref);
      p.resolve(f);
    } else if (f.type === "error") this.log(`broker error: ${f.error}`);
  }

  private nextRef() {
    return `r${++this.seq}`;
  }

  /**
   * Sends a request frame and waits for the broker's reply. Rejects with the broker's error text.
   * While the connection is being replaced it waits for the new one. A request that only reads (or does the
   * same thing twice) is repeated once if the connection drops before the answer; a `send` is not, since the
   * broker may already have delivered it.
   */
  async request(frame: Request, timeoutMs = 15_000): Promise<ServerFrame> {
    try {
      return await this.requestOnce(frame, timeoutMs);
    } catch (e) {
      if ((e as Error).message !== CLOSED) throw e;
      if (!IDEMPOTENT.has(frame.type)) {
        throw new Error(
          "the connection to the AIChat broker dropped before it confirmed this; it may have gone through: check read_history before sending it again",
        );
      }
      return await this.requestOnce(frame, timeoutMs);
    }
  }

  private async requestOnce(frame: Request, timeoutMs: number): Promise<ServerFrame> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.agent) {
      if (!(await this.whenConnected(Math.min(timeoutMs, 10_000)))) throw new Error("not connected to the AIChat broker");
    }
    const ref = this.nextRef();
    const reply = await new Promise<ServerFrame>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(ref);
        reject(new Error("broker did not answer in time"));
      }, timeoutMs);
      this.pending.set(ref, {
        resolve: (f) => (clearTimeout(timer), resolve(f)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
      this.ws!.send(JSON.stringify({ ...frame, ref }));
    });
    if (reply.type === "error") throw new Error(reply.error);
    return reply;
  }

  async send(args: { to?: string; room?: string; text: string; reply_to?: number; attachments?: string[] }): Promise<number> {
    const f = await this.request({ type: "send", ...args });
    return f.type === "ack" ? f.id! : -1;
  }

  /** Tells the broker this agent's session has received message `id` (its sender then sees it delivered). */
  async delivered(id: number): Promise<void> {
    await this.request({ type: "delivered", id });
  }

  /** The broker's HTTP address, derived from the WebSocket URL. */
  get httpUrl(): string {
    return this.opts.url.replace(/\/?$/, "").replace(/\/ws$/, "").replace(/^ws(s?):/, "http$1:");
  }

  /** Uploads a file over REST; attach the returned id with send({ attachments: [id] }). */
  async upload(data: Uint8Array, name: string, mime = "application/octet-stream"): Promise<FileInfo> {
    const r = await fetch(`${this.httpUrl}/api/files`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.opts.token}`, "content-type": mime, "x-filename": encodeURIComponent(name) },
      body: data as unknown as BodyInit,
    });
    const body = (await r.json().catch(() => ({}))) as { file?: FileInfo; error?: string };
    if (!r.ok || !body.file) throw new Error(body.error ?? `upload failed: HTTP ${r.status}`);
    return body.file;
  }

  /** Calls the broker's REST API with this agent's token; throws with the broker's error text. */
  async api<T>(method: string, path: string, body?: unknown): Promise<T> {
    const r = await fetch(`${this.httpUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.opts.token}`, "content-type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const data = (await r.json().catch(() => ({}))) as T & { error?: string };
    if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`);
    return data;
  }

  /** Downloads an attachment the agent may see. */
  async download(id: string): Promise<Uint8Array> {
    const r = await fetch(`${this.httpUrl}/api/files/${encodeURIComponent(id)}`, {
      headers: { authorization: `Bearer ${this.opts.token}` },
    });
    if (!r.ok) {
      const body = (await r.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? `download failed: HTTP ${r.status}`);
    }
    return new Uint8Array(await r.arrayBuffer());
  }

  async listAgents(): Promise<AgentInfo[]> {
    const f = await this.request({ type: "list_agents" });
    return f.type === "agents" ? f.agents : [];
  }

  async history(q: { room?: string; with?: string; limit?: number }): Promise<ChatMessage[]> {
    const f = await this.request({ type: "history", ...q });
    return f.type === "history" ? f.messages : [];
  }

  async join(room: string) {
    await this.request({ type: "join", room });
  }

  async leave(room: string) {
    await this.request({ type: "leave", room });
  }

  close() {
    this.closed = true;
    clearInterval(this.watchdog);
    this.ws?.close();
  }
}
