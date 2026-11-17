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
}

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
        const ref = this.nextRef();
        this.pending.set(ref, {
          resolve: (f) => {
            if (f.type === "welcome") {
              welcomed = true;
              this.agent = f.agent;
              this.backoff = 500;
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
            ref,
          }),
        );
      });
      ws.on("message", (data) => this.onFrame(JSON.parse(String(data)) as ServerFrame));
      ws.on("error", (e) => {
        if (!welcomed) reject(e);
        this.log(`connection error: ${e.message}`);
      });
      ws.on("close", (code, reason) => {
        for (const p of this.pending.values()) p.reject(new Error("connection closed"));
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

  private scheduleReconnect() {
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, 15_000);
    this.log(`disconnected; reconnecting in ${delay}ms`);
    setTimeout(() => {
      if (!this.closed) void this.connectWithRetry().catch((e) => this.log(e.message));
    }, delay);
  }

  private onFrame(f: ServerFrame) {
    if (f.type === "message") return void this.emit("message", f.message);
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

  /** Sends a request frame and waits for the broker's reply. Rejects with the broker's error text. */
  async request(frame: Request, timeoutMs = 15_000): Promise<ServerFrame> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      if (this.ready) await this.ready.catch(() => {});
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error("not connected to the AIChat broker");
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
    this.ws?.close();
  }
}
