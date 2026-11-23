// Types of the broker's REST and WebSocket API, shared with the backend.
export type { AdapterInfo, AgentActivity, AgentInfo, ChatMessage, FileInfo, GameInfo, GameRatings, GameType, RoomBrief, ServerFrame } from "../../../src/protocol";
export { MAX_BRIEF_LENGTH, MAX_DESCRIPTION_LENGTH, MAX_INTRO_LENGTH } from "../../../src/protocol";
export type { AgentNote, UsageReport, UsageWindow, WorldIntro, WorldLimits } from "../../../src/protocol";
import type { AgentInfo } from "../../../src/protocol";

export { GAME_SENDER, SYSTEM_SENDER, isSystemSender } from "../../../src/protocol";
export { REACTIONS, isReaction, type Reaction } from "../../../src/protocol";
export const ROOM_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const MAX_ATTACHMENTS = 10;
export const INLINE_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

/** An agent as the admin API lists it. */
export interface Agent extends AgentInfo {
  webhook?: boolean;
  admin?: boolean;
}

export interface RoomInfo {
  name: string;
  members: string[];
  count: number;
  last_ts: string | null;
}

export interface DmInfo {
  a: string;
  b: string;
  count: number;
  last_ts: string | null;
}

export interface Overview {
  agents: Agent[];
  rooms: RoomInfo[];
  dms: DmInfo[];
  /** User mode only: every room, so the person can join one. */
  all_rooms: string[];
  /** Reply chains stop at this many hops (broker setting maxHops). */
  max_hops?: number;
  /** The broker's version, which is also the newest adapter's: older adapters should be updated. */
  version?: string;
}

export interface Settings {
  maxHops: number;
  ratePerMinute: number;
  maxTextLength: number;
  maxFileSizeMB: number;
  maxNotes: number;
  maxNoteDescription: number;
  maxNoteText: number;
  /** "on": an agent back from a long absence gets the missed room messages as a wake, not as a stream. */
  wakeMode: "off" | "brief" | "on";
  wakeAfterMinutes: number;
  wakeAfterMessages: number;
  publicUrl: string;
  projectDir: string;
}

export interface SetupStep {
  title?: string;
  text?: string;
  code?: string;
  lang?: string;
  download?: { url: string; filename?: string };
  url?: string;
  /** Step-by-step way, folded under "Вручну" below the one-command way. */
  manual?: boolean;
}

export interface Setup {
  /** Agent kind the steps are for: "human", "claude", "openai" or another. */
  kind?: string;
  steps: SetupStep[];
}

/** Who is logged in, always a person by their own token: an admin (sees everything) or a participant. */
export type Session =
  | { mode: "admin"; token: string; admin: { name: string } }
  | { mode: "user"; token: string; me: { name: string; kind: string } };

/** GET /admin/api/update (see src/broker/updater.ts). */
export interface UpdateStatus {
  current: string;
  launcher: boolean;
  docker: boolean;
  repo: string;
  hasToken: boolean;
  tokenFromEnv: boolean;
  prerelease: boolean;
  checking: boolean;
  installing: boolean;
  checkedAt: string | null;
  error: string | null;
  latest: {
    version: string;
    tag: string;
    name: string;
    notes: string;
    url: string;
    publishedAt: string | null;
    prerelease: boolean;
    node?: string;
    nodeOk: boolean;
    installable: boolean;
  } | null;
  updateAvailable: boolean;
  failed: { version: string; previous: string; at?: string; reason: string } | null;
}
export type { HookAction, HookFields, HookRecipient, HookRule, HookTrigger } from "../../../src/protocol";
export { HOOK_IDLE_MAX_MINUTES, MAX_HOOKS } from "../../../src/protocol";
