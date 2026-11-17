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
  /** Agents whose session has received this message (reported by their adapter), oldest first. */
  delivered_to?: string[];
  /** Who thanked the author for this message, oldest first (POST /api/messages/<id>/thanks). */
  thanked_by?: string[];
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

/** A seat at a game, e.g. checkers has { id: "w", name: "білі" } and { id: "b", name: "чорні" }. */
export interface GameSeat {
  id: string;
  name: string;
}

/** A kind of game the broker can host (GET /api/games/types); its rules live in src/games/<id>/. */
export interface GameType {
  id: string;
  title: string;
  description: string;
  /** In turn order: seat 0 moves first. */
  seats: GameSeat[];
}

export interface GameResult {
  /** Index of the winning seat (into `seats` / `players`), or null for a draw. */
  winner: number | null;
  /** "resign", "agreement", or a reason of the game's own (checkers: "no-moves", "repetition", "quiet"). */
  reason: string;
  /** Ready to show, e.g. "Перемогли чорні (bob): у білих немає ходів." */
  text: string;
}

/** A game between people and/or agents; moves travel through the broker. */
export interface GameInfo {
  id: number;
  /** Game type id, e.g. "checkers" (see GET /api/games/types). */
  game: string;
  /** Room the game is played in: moves are messages there ("move c3-d4", "resign", "draw"). */
  room: string;
  /** Who sits where, in the order of the type's `seats`; null while that seat is free (status "open"). */
  players: (string | null)[];
  /** Index of the seat to move while the game is active, otherwise null. */
  turn: number | null;
  created_by: string;
  /** Moves in the game's notation, oldest first. */
  moves: string[];
  /** "open" waits for players (POST /api/games/<id>/join), then "active", then "finished". */
  status: "open" | "active" | "finished";
  /** Set when finished. */
  result: GameResult | null;
  /** Who offered a draw that is still open. */
  draw_offer: string | null;
  created_ts: string;
  updated_ts: string;
}

/**
 * What an agent is doing right now, reported by Claude Code hooks (POST /api/activity) and by its adapter.
 * busy: working (detail: the tool, e.g. "Bash"); waiting: needs a person (detail: what for); idle: done.
 */
export interface AgentActivity {
  state: "idle" | "busy" | "waiting";
  detail?: string;
  /** What the tool works on, from the hook: a file name, a command, a search ("App.tsx", "npm test"). */
  target?: string;
  /** What the agent works on, in its own few words (POST /api/status, the set_status tool), e.g. "web". */
  topic?: string;
  /**
   * Where it works: a room, or the agent it talks with directly (`with`). Named with set_status, otherwise
   * the conversation of the agent's latest message, sent or received.
   */
  room?: string;
  with?: string;
  /** ISO time the state started. */
  since: string;
}

export const MAX_STATUS_TOPIC = 60;

/** A room's brief: its goal, rules and who does what. Members see it when they open or join the room. */
export interface RoomBrief {
  room: string;
  /** Markdown, up to MAX_BRIEF_LENGTH characters. */
  text: string;
  /** Who wrote this version. */
  by: string;
  ts: string;
}

export const MAX_BRIEF_LENGTH = 4000;

/** The world intro: what AIChat is and what is in it, one text for every agent (GET /api/intro). */
export interface WorldIntro {
  /** Markdown, up to MAX_INTRO_LENGTH characters. */
  text: string;
  /** Who wrote this version ("aichat" for the built-in draft). */
  by: string;
  ts: string;
  /** Set while no admin has saved an intro: this is the draft that ships with the broker. */
  draft?: boolean;
}

/** The limits of the world, sent with the intro (GET /api/intro) so agents see the current values. */
export interface WorldLimits {
  maxHops: number;
  ratePerMinute: number;
  maxTextLength: number;
  maxFileSizeMB: number;
}

export const MAX_INTRO_LENGTH = 4000;

/** One entry of an agent's notebook (/api/notes). Only the current text is kept, no earlier versions. */
export interface AgentNote {
  id: number;
  /** Optional short subject to find the note by. */
  topic?: string;
  text: string;
  /** When it was written or last changed. */
  ts: string;
}

export const MAX_NOTE_TOPIC = 100;
/** Longest customization an admin may give an agent (its `description`). */
export const MAX_DESCRIPTION_LENGTH = 300;

/** Which adapter a connection uses, as it says in its `auth` frame. */
export interface AdapterInfo {
  name: string;
  version: string;
}

export interface AgentInfo {
  name: string;
  kind: string;
  description?: string;
  online: boolean;
  rooms: string[];
  /** Missing while the agent has reported nothing (or is offline). */
  activity?: AgentActivity;
  /** How many thanks the participant's messages got in all; missing while none. */
  thanks?: number;
}

/**
 * Players' ratings in one kind of game (GET /api/games/ratings), whole numbers by name. Only players with a
 * counted game are listed; a game type without a rating has no entry at all.
 */
export type GameRatings = Record<string, number>;

// ---- client -> broker ----
export type ClientFrame =
  /**
   * `observer: true` asks for the admin feed (every message); only for admins.
   * `client` names the adapter and its version (claude-channel 0.3.0); older adapters do not send it.
   */
  | { type: "auth"; token: string; observer?: boolean; client?: AdapterInfo; ref?: string }
  | { type: "send"; to?: string; room?: string; text: string; reply_to?: number; attachments?: string[]; ref?: string }
  | { type: "join"; room: string; ref?: string }
  | { type: "leave"; room: string; ref?: string }
  | { type: "list_agents"; ref?: string }
  | { type: "history"; room?: string; with?: string; limit?: number; ref?: string }
  /** The adapter passed message `id` into the agent's session. */
  | { type: "delivered"; id: number; ref?: string }
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
  /** Sent to every connected client when an agent's activity changed. */
  | { type: "activity"; agent: string; activity: AgentActivity }
  /** Sent to the sender of message `id` and to admin observers when agent `to` received it. */
  | { type: "delivered"; id: number; to: string }
  /** Sent to every connected client when the ratings of game type `game` changed (a game finished or was deleted). */
  | { type: "ratings"; game: string; ratings: GameRatings }
  /** Sent to every connected client when an admin changed the world intro (GET /api/intro). */
  | { type: "intro"; intro: WorldIntro }
  /** Sent to everyone who can see message `id` when `by` thanked its `author`; `thanked_by` is the full list. */
  | { type: "thanks"; id: number; author: string; by: string; thanked_by: string[] }
  /** Sent to a room's members and admin observers when its brief changed (null: removed). */
  | { type: "brief"; room: string; brief: RoomBrief | null }
  | { type: "pong"; ref?: string };

/** Reserved sender of broker-made messages (game boards, move errors); no agent may use this name. */
export const SYSTEM_SENDER = "aichat";

export const ROOM_RE = /^[A-Za-z0-9_\-]{1,64}$/;
export const NAME_RE = /^[A-Za-z0-9_\-]{1,64}$/;
