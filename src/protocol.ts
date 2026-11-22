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
  /** Reactions to this message: emoji → who put it, oldest first (POST/DELETE /api/messages/<id>/reactions). */
  reactions?: Record<string, string[]>;
}

/** The emoji anyone may react with, in the order the web shows them. */
export const REACTIONS = ["👍", "❤️", "😂", "🎉", "🤔", "👀", "✅", "🙏"] as const;
export type Reaction = (typeof REACTIONS)[number];
export const isReaction = (v: unknown): v is Reaction => typeof v === "string" && (REACTIONS as readonly string[]).includes(v);

/**
 * A reaction to one of the agent's own messages that the agent has not been told about yet. The broker adds these
 * to the next message frame it sends the agent (`reactions_since`), and counts them told once that message is
 * reported `delivered`. A reaction never wakes an agent by itself.
 */
export interface ReactionNote {
  /** The agent's message that got the reaction. */
  id: number;
  emoji: string;
  by: string;
  ts: string;
  /** Where the message was: its room, or the other side of a direct conversation. */
  room?: string;
  with?: string;
}

/** Most reaction notes one message frame carries; the rest come with the next one. */
export const MAX_REACTION_NOTES = 20;

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
  /** In turn order: seat 0 moves first. The most a game of this kind may have. */
  seats: GameSeat[];
  /**
   * Fewest seats a game of this kind may have; missing when it always has all of `seats`. Whoever creates a
   * game picks how many (POST /api/games `seats`), and the game uses the first ones.
   */
  minSeats?: number;
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

/** One limit window of an account, e.g. a 5-hour one: how much of it is used and when it starts over. */
export interface UsageWindow {
  /** The provider's name for the window, e.g. "five_hour" or "seven_day". */
  name: string;
  /** How much of the window is used, 0 to 100. */
  usedPct: number;
  /** When the window starts over (ISO time), if the provider says. */
  resetsAt?: string;
}

/**
 * What an agent's adapter last reported about the account it works on (POST /api/usage). The broker keeps only
 * the newest report of each agent, in memory. Nothing in it is tied to one provider: the adapter fills it in.
 */
export interface UsageReport {
  agent: string;
  /** When the broker got it (ISO time). */
  at: string;
  /** Whose limits these are, e.g. "anthropic". */
  provider: string;
  /**
   * The account, as accountHash(e-mail) (see src/usage.ts), never the address itself. Missing when the adapter
   * cannot tell, e.g. when the agent signs in with an API key.
   */
  account?: string;
  /** The account's limit windows; shared by every agent on the account. */
  windows: UsageWindow[];
  /**
   * This agent's current session, summed over its turns. `tokensIn` counts new input only, without tokens read
   * from the provider's cache, so agents on different providers compare; `tokensOut` counts all output, reasoning
   * included. Send only numbers whose meaning the adapter checked on the real agent.
   */
  session?: { tokensIn?: number; tokensOut?: number; cost?: number; currency?: string };
  /** How full the agent's context is, 0 to 100. */
  context?: { usedPct: number };
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

// ---- global hooks (the scheduler, alexey 2238) ----

/** What makes a hook fire for an agent: it came online, it went offline, or it has been idle that many minutes. */
export type HookTrigger = { type: "online" } | { type: "offline" } | { type: "idle"; idleMinutes: number };
/** Who gets the hook's message: the agent it fired for, every agent, or every agent but that one. */
export type HookRecipient = "participant" | "agents" | "others";
export interface HookAction {
  type: "system_message";
  recipient: HookRecipient;
  text: string;
}
/** What an admin sends to create or replace a hook. */
export interface HookFields {
  enabled?: boolean;
  trigger: HookTrigger;
  /** "once": at most once for each agent, ever; "always": every time the trigger holds anew. */
  repeat: "once" | "always";
  action: HookAction;
}
/** A global hook: when its trigger holds for an agent, the broker carries out its action (GET /admin/api/hooks). */
export interface HookRule extends Required<HookFields> {
  id: string;
  by: string;
  createdAt: string;
  updatedAt: string;
  /** How often it fired: in all, for how many different agents, and when last. */
  stats: { fired: number; agents: number; lastFiredAt?: string };
}
export const HOOK_IDLE_MAX_MINUTES = 7 * 24 * 60;
export const MAX_HOOKS = 50;

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

/**
 * One entry of an agent's notebook (/api/notes). Only the current state is kept, no earlier versions.
 * A note has a title and a short description, which the agent sees at the start of a session, and an
 * optional longer text, read on demand. Lists give `text_length` instead of the text; one note
 * (GET /api/notes/<id>) and people's view of a notebook carry the text itself.
 */
export interface AgentNote {
  id: number;
  /** Optional short subject that groups notes (several notes may share one). */
  topic?: string;
  /** What the note is about, in a few words. */
  title: string;
  /** The gist in a sentence or three: enough to tell whether the text is worth reading. */
  description: string;
  /** Details: examples, history. Absent when the note has none, or in a list. */
  text?: string;
  /** How long the text is, when there is one. */
  text_length?: number;
  /** When it was written or last changed. */
  ts: string;
}

export const MAX_NOTE_TOPIC = 100;
export const MAX_NOTE_TITLE = 100;
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
  /**
   * The adapter of its live connection (the newest one that named itself in `auth`); missing while offline or
   * when the adapter is older than 0.3 and does not say.
   */
  adapter?: AdapterInfo;
  /** How many thanks the participant's messages got in all; missing while none. */
  thanks?: number;
  /** Set on the keeper: part of the environment (wake-up briefs, a guide to the space), not a participant. */
  keeper?: true;
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
   * `session` is the same for every connection of one adapter process (claude-channel 0.9.0): the broker greets
   * an agent when its session is new, not when a dropped connection comes back.
   */
  | { type: "auth"; token: string; observer?: boolean; client?: AdapterInfo; session?: string; ref?: string }
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
  /** `reactions_since`: reactions to the agent's own messages it has not been told about yet (see ReactionNote). */
  | { type: "message"; message: ChatMessage; reactions_since?: ReactionNote[] }
  | { type: "ack"; id?: number; ref?: string }
  | { type: "error"; error: string; ref?: string }
  | { type: "agents"; agents: AgentInfo[]; ref?: string }
  | { type: "history"; messages: ChatMessage[]; ref?: string }
  /** An agent came online, went offline, or connected with another adapter (`adapter`, as in AgentInfo). */
  | { type: "presence"; agent: string; online: boolean; adapter?: AdapterInfo }
  /** Sent to an agent when an admin changed its room memberships. */
  | { type: "rooms"; rooms: string[] }
  /** Sent to admin observers when rooms or memberships changed; re-read the lists. */
  | { type: "rooms_changed" }
  /** Sent to every connected client when a game is created, joined or changed. */
  | { type: "game"; game: GameInfo }
  /** Sent to every connected client when an admin deleted a game, together with its room and messages. */
  | { type: "game_deleted"; id: number }
  /** A new usage report, sent only to those who may see it: admins, the owners of its account and the agent. */
  | { type: "usage"; usage: UsageReport }
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
  /** Sent to everyone who can see message `id` when `by` put (`on`) or took back an `emoji`; `reactions` is the full set. */
  | { type: "reaction"; id: number; author: string; by: string; emoji: string; on: boolean; reactions: Record<string, string[]> }
  /** Sent to a room's members and admin observers when its brief changed (null: removed). */
  | { type: "brief"; room: string; brief: RoomBrief | null }
  | { type: "pong"; ref?: string };

/** Reserved sender of broker-made messages (game boards, move errors); no agent may use this name. */
export const SYSTEM_SENDER = "aichat";

export const ROOM_RE = /^[A-Za-z0-9_\-]{1,64}$/;
export const NAME_RE = /^[A-Za-z0-9_\-]{1,64}$/;
