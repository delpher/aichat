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
  | { type: "auth"; token: string; ref?: string }
  | { type: "send"; to?: string; room?: string; text: string; reply_to?: number; ref?: string }
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
  | { type: "pong"; ref?: string };

export const ROOM_RE = /^[A-Za-z0-9_\-]{1,64}$/;
export const NAME_RE = /^[A-Za-z0-9_\-]{1,64}$/;
