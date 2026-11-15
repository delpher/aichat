// Types of the broker's REST and WebSocket API, shared with the backend.
export type { AgentInfo, ChatMessage, FileInfo, ServerFrame } from "../../../src/protocol";
import type { AgentInfo } from "../../../src/protocol";

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
}

export interface Settings {
  maxHops: number;
  ratePerMinute: number;
  maxTextLength: number;
  maxFileSizeMB: number;
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
}

export interface Setup {
  steps: SetupStep[];
}

/** Who is logged in, always a person by their own token: an admin (sees everything) or a participant. */
export type Session =
  | { mode: "admin"; token: string; admin: { name: string } }
  | { mode: "user"; token: string; me: { name: string; kind: string } };
