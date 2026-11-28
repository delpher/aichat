// The adapters' shared core, part 2: talking to the broker (AIChat 3956-3961). The WebSocket every adapter keeps open
// (auth, welcome, heartbeat, reconnect, a rejected token), the HTTP API with errors sorted into "the broker said no"
// and "the result is unknown", the version check and the status file the agent manager reads.
// What to do with a message (deliver it to the model, when to acknowledge it, what to retry) stays in each adapter:
// this module only moves frames and reports what happened.
// Plain JS with node:* imports only, like files.mjs; the WebSocket is Node 22's own (globalThis.WebSocket).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** A request whose result is unknown: it timed out or the connection broke, so it may or may not have happened. */
export class UncertainError extends Error {
  constructor(message) {
    super(message);
    this.name = "UncertainError";
    this.uncertain = true;
  }
}

/** The largest attachment an adapter downloads. */
export const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;

/**
 * The broker's HTTP API with the agent's token. An error the broker answered with has `status`, and `definite` when it
 * is 4xx (the broker refused: repeating will not help); a timeout or a broken connection throws UncertainError.
 * Whether to repeat is the caller's decision. Error messages never carry the token.
 */
export class BrokerHttp {
  constructor({ httpBase, token, timeoutMs = 15_000 }) {
    if (!token) throw new Error("Empty AIChat token");
    this.httpBase = String(httpBase).replace(/\/+$/, "");
    this.token = token;
    this.timeoutMs = timeoutMs;
    /** A short fingerprint of the token, for lock and file names. */
    this.tokenHash = crypto.createHash("sha256").update(token).digest("hex").slice(0, 16);
  }

  /** Reads the token from its file (owner-only, outside the agent's folder). */
  static fromTokenFile(tokenFile, opts) {
    return new BrokerHttp({ ...opts, token: fs.readFileSync(tokenFile, "utf8").trim() });
  }

  redact(value) {
    return String(value).split(this.token).join("[REDACTED]");
  }

  /**
   * `binary`: the body as a Buffer, at most `limit` bytes; with `withHeaders`, `{ bytes, contentDisposition }`.
   * Otherwise the JSON answer ({} for 204). A Buffer body is sent as it is, anything else as JSON.
   */
  async request(route, { method = "GET", body, headers = {}, binary = false, withHeaders = false, limit = MAX_DOWNLOAD_BYTES } = {}) {
    let response;
    try {
      response = await fetch(this.httpBase + route, {
        method,
        redirect: "error",
        headers: {
          Authorization: `Bearer ${this.token}`,
          ...(body === undefined || Buffer.isBuffer(body) || body instanceof Uint8Array ? {} : { "Content-Type": "application/json" }),
          ...headers,
        },
        body: body === undefined ? undefined : Buffer.isBuffer(body) || body instanceof Uint8Array ? body : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new UncertainError(this.redact(`${method} ${route}: ${error.message}`));
    }
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      const error = new Error(this.redact(`AIChat HTTP ${response.status}: ${text.slice(0, 1000)}`));
      error.status = response.status;
      error.definite = response.status >= 400 && response.status < 500;
      throw error;
    }
    if (binary) {
      if (Number(response.headers.get("content-length") || 0) > limit) throw new Error("Attachment too large");
      const parts = [];
      let size = 0;
      try {
        for await (const part of response.body) {
          size += part.length;
          if (size > limit) {
            await response.body.cancel().catch(() => {});
            throw new Error("Attachment too large");
          }
          parts.push(part);
        }
      } catch (error) {
        if (error.message === "Attachment too large") throw error;
        throw new UncertainError(this.redact(`${method} ${route}: ${error.message}`));
      }
      const bytes = Buffer.concat(parts);
      return withHeaders ? { bytes, contentDisposition: response.headers.get("content-disposition") || "" } : bytes;
    }
    if (response.status === 204) return {};
    return response.json();
  }
}

/** Is `available` a newer x.y.z than `installed`? Anything that is not x.y.z is never newer. */
export function newerVersion(installed, available) {
  const parse = (v) => (/^\d+\.\d+\.\d+$/.test(v || "") ? v.split(".").map(Number) : null);
  const a = parse(installed);
  const b = parse(available);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return b[i] > a[i];
  return false;
}

const RETRY_DELAYS = [20, 50, 100, 200, 400];
const sleepCell = new Int32Array(new SharedArrayBuffer(4));

/**
 * Writes JSON so that a reader never sees half of it: a temporary file, then a rename. On Windows a reader (the
 * agent manager) may hold the file for a moment, so EPERM / EACCES / EBUSY are tried again a few times.
 */
export function atomicJSON(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${crypto.randomBytes(3).toString("hex")}.tmp`;
  for (const op of [
    () => fs.writeFileSync(temp, JSON.stringify(data, null, 2), { mode: 0o600, flush: true }),
    () => fs.renameSync(temp, file),
  ]) {
    for (let attempt = 0; ; attempt++) {
      try {
        op();
        break;
      } catch (error) {
        if (!["EPERM", "EACCES", "EBUSY"].includes(error.code) || attempt >= RETRY_DELAYS.length) {
          try {
            fs.unlinkSync(temp);
          } catch {}
          throw error;
        }
        Atomics.wait(sleepCell, 0, 0, RETRY_DELAYS[attempt]);
      }
    }
  }
}

/** The adapter's state for the agent manager: `<runtime>/status.json` (runtime is the agent's `.aichat` folder). */
export function writeStatus(runtime, status) {
  atomicJSON(path.join(runtime, "status.json"), status);
}

/** Close code the broker uses for a token it does not accept: reconnecting cannot help. */
export const TOKEN_REJECTED = 4003;

/**
 * The WebSocket to the broker, kept open:
 * - on open it sends `{ type: "auth", ...auth() }` (the adapter's token, client and session) and gives the broker
 *   `authTimeoutMs` to answer with `welcome`, else closes and tries again;
 * - frames are handed to `onFrame(frame)` strictly one after another, `welcome` too: the next waits for the previous.
 *   `welcome` makes the socket ready before its handler runs, so the handler can join rooms and acknowledge;
 *   a handler that throws ends everything: `onFatal(error)` (the adapter stops, its state is not certain any more);
 * - every `heartbeatMs` it sends `ping` and closes a socket that has been silent for `silenceMs`;
 * - a closed socket is opened again after a delay that doubles up to `maxDelayMs`, back to the start on `welcome`;
 *   close code 4003 (the token was rejected) stops for good: `onPhase("halted")`.
 * `onPhase(phase, detail)` tells the adapter what happened: "connected" (after the welcome handler), "reconnecting",
 * "halted", "stopped". Which messages to acknowledge and when is the adapter's: ack(id) only sends the frame.
 */
export class BrokerSocket {
  constructor({
    url,
    auth,
    onFrame,
    onPhase = () => {},
    onFatal = () => {},
    log = () => {},
    authTimeoutMs = 10_000,
    heartbeatMs = 30_000,
    silenceMs = 75_000,
    firstDelayMs = 1000,
    maxDelayMs = 30_000,
  }) {
    Object.assign(this, { url, auth, onFrame, onPhase, onFatal, log, authTimeoutMs, heartbeatMs, silenceMs, firstDelayMs, maxDelayMs });
    this.socket = null;
    this.ready = false;
    this.stopped = true;
    this.halted = false;
    this.delay = firstDelayMs;
    this.lastFrame = 0;
    this.chain = Promise.resolve();
  }

  /** Opens the socket (and keeps it open until stop() or a rejected token). */
  start() {
    if (this.halted) return;
    this.stopped = false;
    this.open();
  }

  open() {
    if (this.stopped || this.halted || this.socket) return;
    const socket = new globalThis.WebSocket(this.url);
    this.socket = socket;
    this.ready = false;
    this.lastFrame = Date.now();
    const authTimer = setTimeout(() => {
      if (this.socket === socket && !this.ready) {
        this.log("auth_timeout");
        socket.close();
      }
    }, this.authTimeoutMs);

    socket.addEventListener("open", () => {
      if (this.socket === socket) socket.send(JSON.stringify({ type: "auth", ...this.auth() }));
    });
    socket.addEventListener("message", (event) => {
      if (this.socket !== socket) return;
      this.lastFrame = Date.now();
      this.chain = this.chain.then(async () => {
        if (this.socket !== socket) return;
        let frame;
        try {
          frame = JSON.parse(String(event.data));
        } catch {
          frame = null;
        }
        if (!frame || typeof frame.type !== "string") return this.log("invalid_broker_frame");
        if (frame.type === "welcome") {
          clearTimeout(authTimer);
          this.ready = true;
          this.delay = this.firstDelayMs;
        }
        try {
          await this.onFrame(frame);
        } catch (error) {
          this.fail(error);
          return;
        }
        if (frame.type === "welcome" && this.socket === socket) this.onPhase("connected", { welcome: frame });
      });
    });
    socket.addEventListener("error", () => this.log("websocket_error"));
    socket.addEventListener("close", (event) => {
      clearTimeout(authTimer);
      clearInterval(this.heartbeat);
      if (this.socket !== socket) return;
      this.socket = null;
      this.ready = false;
      if (event.code === TOKEN_REJECTED) {
        this.halted = true;
        this.onPhase("halted", { reason: "token rejected" });
        return;
      }
      if (this.stopped || this.halted) return;
      this.onPhase("reconnecting", { code: event.code, delayMs: this.delay });
      this.reconnectTimer = setTimeout(() => this.open(), this.delay);
      this.delay = Math.min(this.delay * 2, this.maxDelayMs);
    });

    clearInterval(this.heartbeat);
    this.heartbeat = setInterval(() => {
      if (this.socket !== socket || socket.readyState !== 1) return;
      if (Date.now() - this.lastFrame > this.silenceMs) {
        this.log("heartbeat_timeout");
        socket.close();
      } else if (this.ready) socket.send(JSON.stringify({ type: "ping" }));
    }, this.heartbeatMs);
  }

  /** A frame handler failed: stop for good and let the adapter end. */
  fail(error) {
    this.halted = true;
    this.close();
    this.onFatal(error);
  }

  /** Sends a frame if the socket is open; false when it is not (nothing is queued). */
  send(frame) {
    if (!this.socket || this.socket.readyState !== 1) return false;
    this.socket.send(JSON.stringify(frame));
    return true;
  }

  /** Tells the broker a message was taken in (✓✓), when the socket is ready. When to do it is the adapter's call. */
  ack(id) {
    return this.ready && this.send({ type: "delivered", id });
  }

  /** Closes the socket without reconnecting; start() opens it again. */
  stop() {
    if (this.stopped && !this.socket) return;
    this.stopped = true;
    this.close();
    this.onPhase("stopped", {});
  }

  close() {
    clearTimeout(this.reconnectTimer);
    clearInterval(this.heartbeat);
    const socket = this.socket;
    this.socket = null;
    this.ready = false;
    socket?.close();
  }
}
