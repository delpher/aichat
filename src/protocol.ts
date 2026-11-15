// Wire protocol shared by the broker and every adapter.
// Transport: JSON text frames over WebSocket (ws://host:port/ws).
// Requests from a client may carry `ref`; the broker echoes it on the matching
// `ack`, `error`, `agents` or `history` frame so clients can correlate.

export interface ChatMessage {
  id: number;
  from: string;
  /** Recipient agent for a direct message. Exactly one of `to` / `room` is set. */
  to?: string;
  /** Room name for a group message. */
  room?: string;
  text: string;
  /** ISO timestamp set by the broker. */
  ts: string;
  /** Id of the message this one answers, if any. */
  reply_to?: number;
  /** Length of the reply chain this message is part of (0 = new conversation). */
  hops: number;
  /** Files sent with the message; download each with GET /api/files/<id>. */
  attachments?: FileInfo[];
}

/** An uploaded file (POST /api/files), attached to at most one message. */
export interface FileInfo {
  id: string;
  name: string;
  mime: string;
  size: number;
}

/** Most files one message may carry. */
export const MAX_ATTACHMENTS = 10;
/** Image types the web UI shows inline; everything else is served as a download. */
export const INLINE_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

/** A mini-game between two players (people or agents); moves travel through the broker. */
export interface GameInfo {
  id: number;
  /** Rules name; only "checkers" for now (src/games/checkers.ts). */
  game: string;
  /** Room the game is played in: moves are messages there ("move c3-d4", "resign", "draw"). */
  room: string;
  /** Who plays white (moves first) and black; null while that seat is free (status "open"). */
  white: string | null;
  black: string | null;
  created_by: string;
  /** Moves in notation, oldest first; replay them for the position. */
  moves: string[];
  /** "open" waits for a second player (POST /api/games/<id>/join), then "active", then "finished". */
  status: "open" | "active" | "finished";
  /** Set when finished: winner "w" / "b", or null for a draw. */
  result?: { winner: "w" | "b" | null; reason: "no-moves" | "repetition" | "quiet" | "resign" | "agreement" } | null;
  /** Who offered a draw that is still open. */
  draw_offer?: string | null;
  created_ts: string;
  updated_ts: string;
}

export interface AgentInfo {
  name: string;
  kind: string;
  description?: string;
  online: boolean;
  rooms: string[];
}

// ---- client -> broker ----
export type ClientFrame =
  /** `observer: true` asks for the admin feed (every message); only for admins. */
  | { type: "auth"; token: string; observer?: boolean; ref?: string }
  | { type: "send"; to?: string; room?: string; text: string; reply_to?: number; attachments?: string[]; ref?: string }
  | { type: "join"; room: string; ref?: string }
  | { type: "leave"; room: string; ref?: string }
  | { type: "list_agents"; ref?: string }
  | { type: "history"; room?: string; with?: string; limit?: number; ref?: string }
  | { type: "ping"; ref?: string };

// ---- broker -> client ----
export type ServerFrame =
  | { type: "welcome"; agent: string; rooms: string[]; observer?: boolean; ref?: string }
  | { type: "message"; message: ChatMessage }
  | { type: "ack"; id?: number; ref?: string }
  | { type: "error"; error: string; ref?: string }
  | { type: "agents"; agents: AgentInfo[]; ref?: string }
  | { type: "history"; messages: ChatMessage[]; ref?: string }
  | { type: "presence"; agent: string; online: boolean }
  /** Sent to an agent when an admin changed its room memberships. */
  | { type: "rooms"; rooms: string[] }
  /** Sent to admin observers when rooms or memberships changed; re-read the lists. */
  | { type: "rooms_changed" }
  /** Sent to every connected client when a game is created, joined or changed. */
  | { type: "game"; game: GameInfo }
  /** Sent to every connected client when an admin deleted a game, together with its room and messages. */
  | { type: "game_deleted"; id: number }
  | { type: "pong"; ref?: string };

/** Reserved sender of broker-made messages (game boards, move errors); no agent may use this name. */
export const SYSTEM_SENDER = "aichat";

export const ROOM_RE = /^[A-Za-z0-9_\-]{1,64}$/;
export const NAME_RE = /^[A-Za-z0-9_\-]{1,64}$/;
