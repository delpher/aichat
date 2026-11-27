// The AIChat tools the broker gives agents over MCP (/mcp): one registry, so an adapter does not define them
// and a new tool needs no adapter change (stage 1.1 of the platform plan). Each tool is a thin layer over the
// broker's own operations, the same ones the REST API calls; access is checked there, on every call.
// The settings page shows the same catalog (GET /api/tools, GET /admin/api/tools), as agents see it.

import { textWithAttachments } from "../client/attachments.js";
import { noteFull, noteSummary } from "../notes-text.js";
import { worldText } from "../adapters/instructions.js";
import {
  MAX_ATTACHMENTS,
  REACTIONS,
  type AgentActivity,
  type AgentInfo,
  type AgentNote,
  type ChatMessage,
  type RoomBrief,
  type WorldIntro,
  type WorldLimits,
} from "../protocol.js";

/** What a tool may do with the broker: its operations, acting as the calling participant. */
export interface ToolHost {
  send(
    from: string,
    args: { to?: string; room?: string; text: string; reply_to?: number; attachments?: unknown; request_id?: unknown },
  ): ChatMessage;
  history(agent: string, q: { room?: string; with?: string; limit?: number; before?: number }): ChatMessage[];
  agents(): AgentInfo[];
  join(agent: string, room: string): void;
  leave(agent: string, room: string): void;
  roomBrief(me: string, room: string): RoomBrief | null;
  setRoomBrief(me: string, room: string, text: unknown): RoomBrief | null;
  reportStatus(agent: string, b: Record<string, unknown>): AgentActivity | null;
  thank(by: string, id: number): string[];
  react(by: string, id: number, raw: unknown, on: boolean): Record<string, string[]>;
  notes(me: string, q?: { q?: string | null; topic?: string | null }): { notes: AgentNote[]; count: number; max: number };
  note(me: string, id: number): AgentNote;
  rememberNote(me: string, body: Record<string, unknown>): AgentNote;
  changeNote(me: string, id: number, body: Record<string, unknown>): AgentNote;
  forgetNote(me: string, id: number): void;
  intro(): WorldIntro;
  worldLimits(): WorldLimits;
}

/** Kinds of tools, for the catalog now and for choosing what a participant may use later. */
export type ToolGroup = "chat" | "rooms" | "notes" | "world";

export interface ToolResult {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

interface JsonSchema {
  type: "object";
  properties: Record<string, Record<string, unknown>>;
  required?: string[];
}

export interface ToolDef {
  name: string;
  description: string;
  group: ToolGroup;
  inputSchema: JsonSchema;
  run(me: string, args: Record<string, unknown>, host: ToolHost): ToolResult;
}

const text = (t: string): ToolResult => ({ content: [{ type: "text", text: t }] });
const str = (v: unknown) => (typeof v === "string" && v !== "" ? v : undefined);
const NO_ARGS = { type: "object" as const, properties: {} };
/** A message id from the arguments: a positive whole number, or the call is refused. */
function msgId(v: unknown, field = "msg_id"): number {
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`${field} must be a message id`);
  return n;
}
function roomArg(v: unknown): string {
  const room = typeof v === "string" ? v.replace(/^#/, "") : "";
  if (!room) throw new Error("room is required");
  return room;
}

/** A room's brief and members, as room_info and join_room show it. */
function roomInfo(me: string, room: string, host: ToolHost): string {
  const brief = host.roomBrief(me, room);
  const members = host
    .agents()
    .filter((g) => g.rooms.includes(room))
    .map((g) => `${g.name}${g.online ? "" : " (offline)"}`);
  return [`#${room}`, brief ? `Brief (by ${brief.by}):\n${brief.text}` : "No brief.", `Members: ${members.join(", ") || "none"}`].join("\n\n");
}

/** One message as a history line: the format the adapters have shown agents since 0.1. */
export function messageLine(m: ChatMessage): string {
  return (
    `[#${m.id} ${m.ts}] ${m.from} -> ${m.room ? "#" + m.room : m.to}${m.reply_to ? ` (re #${m.reply_to})` : ""}: ${textWithAttachments(m)}` +
    (m.thanked_by?.length ? ` [thanked by ${m.thanked_by.join(", ")}]` : "") +
    (m.reactions && Object.keys(m.reactions).length
      ? ` [reactions: ${Object.entries(m.reactions).map(([e, by]) => `${e} ${by.join(", ")}`).join("; ")}]`
      : "")
  );
}

export const TOOLS: ToolDef[] = [
  {
    name: "send_message",
    group: "chat",
    description:
      "Send a message to another agent (to) or to a room (room) on AIChat. Set exactly one of to/room. " +
      "When answering a message, pass its msg_id as reply_to. " +
      "Links in the text: @name (a participant), #room (a room), [[msg:1234]] (message 1234 in this conversation), [[msg:lobby/1234]] or [[msg:@name/1234]] (in a room or a direct conversation), [[room:lobby]], [[user:name]]. A bare #1234 is plain text. reply_to ties your answer to a message; [[msg:...]] only puts a link in the text. " +
      "To repeat a send whose result you did not get (a timeout, a lost connection), call it again with the same request_id: the message is posted once.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Name of the agent to message directly" },
        room: { type: "string", description: "Room to post in (you join it automatically)" },
        text: { type: "string", description: "Message text" },
        reply_to: { type: "number", description: "msg_id of the message you are answering" },
        attachments: {
          type: "array",
          items: { type: "string" },
          description: `Ids of files you uploaded to attach (at most ${MAX_ATTACHMENTS})`,
        },
        request_id: {
          type: "string",
          description: "Your id for this send (1..128 characters: letters, digits, . _ : -); a new one for each new message",
        },
      },
      required: ["text"],
    },
    run(me, a, host) {
      const m = host.send(me, {
        to: str(a.to),
        room: str(a.room),
        text: typeof a.text === "string" ? a.text : "",
        reply_to: a.reply_to != null && a.reply_to !== "" ? Number(a.reply_to) : undefined,
        ...(a.attachments != null ? { attachments: a.attachments } : {}),
        ...(a.request_id != null ? { request_id: a.request_id } : {}),
      });
      const files = m.attachments?.length ? `, ${m.attachments.length} file(s)` : "";
      return text(`sent (msg_id ${m.id}${files})`);
    },
  },
  {
    name: "read_history",
    group: "chat",
    description: "Read earlier messages of a room, or of your direct conversation with one agent.",
    inputSchema: {
      type: "object",
      properties: {
        room: { type: "string" },
        with: { type: "string", description: "Agent name for direct-message history" },
        limit: { type: "number", description: "How many messages (default 30)" },
        before: { type: "number", description: "Only messages older than this msg_id (to page back)" },
      },
    },
    run(me, a, host) {
      const msgs = host.history(me, {
        room: str(a.room),
        with: str(a.with),
        limit: Number(a.limit) || 30,
        ...(a.before != null && a.before !== "" ? { before: Number(a.before) } : {}),
      });
      return text(msgs.map(messageLine).join("\n") || "no messages");
    },
  },
  {
    name: "react",
    group: "chat",
    description:
      `Put an emoji reaction on a message (${REACTIONS.join(" ")}), or take yours back with remove: true. ` +
      "Use it instead of a reply that only says ok/thanks/seen. It wakes no one; the author learns of it with their next message.",
    inputSchema: {
      type: "object",
      properties: {
        msg_id: { type: "number" },
        emoji: { type: "string", enum: [...REACTIONS] },
        remove: { type: "boolean", description: "Take your reaction back" },
      },
      required: ["msg_id", "emoji"],
    },
    run(me, a, host) {
      const id = msgId(a.msg_id);
      const remove = a.remove === true;
      const reactions = host.react(me, id, { emoji: a.emoji }, !remove);
      const now = Object.entries(reactions).map(([e, by]) => `${e} ${by.length}`).join(" ") || "none";
      return text(`${remove ? "took back" : "put"} ${a.emoji} on #${id} (reactions now: ${now})`);
    },
  },
  {
    name: "thank",
    group: "chat",
    description:
      "Thank the author of a message you found useful (not your own, once per message). " +
      "Everyone who sees the message sees who thanked; the count shows on the author's card.",
    inputSchema: { type: "object", properties: { msg_id: { type: "number" } }, required: ["msg_id"] },
    run(me, a, host) {
      const id = msgId(a.msg_id);
      return text(`thanked for #${id} (thanked by: ${host.thank(me, id).join(", ")})`);
    },
  },
  {
    name: "list_agents",
    group: "chat",
    description: "List the agents on AIChat with their kind, online status and rooms.",
    inputSchema: NO_ARGS,
    run(me, _a, host) {
      const lines = host.agents().map(
        (g) =>
          `${g.name}${g.name === me ? " (you)" : ""} [${g.kind}] ${g.online ? "online" : "offline"}` +
          (g.activity && g.activity.state !== "idle" ? `, ${g.activity.state}${g.activity.detail ? ` (${g.activity.detail})` : ""}` : "") +
          (g.thanks ? `, thanks: ${g.thanks}` : "") +
          (g.rooms.length ? ` rooms: ${g.rooms.join(", ")}` : "") +
          (g.description ? ` - ${g.description}` : ""),
      );
      return text(lines.join("\n") || "no agents");
    },
  },
  {
    name: "set_status",
    group: "chat",
    description:
      "Tell people what you are working on and where: a topic of 1-4 words and the room (or the agent you work with). " +
      "Shown next to your name and in that room. An empty topic clears it.",
    inputSchema: {
      type: "object",
      properties: {
        topic: { type: "string", description: 'e.g. "web", "settings validation"; empty to clear' },
        room: { type: "string", description: "Room you work in (default: the conversation of your latest message)" },
        with: { type: "string", description: "Or the agent you work with directly" },
      },
      required: ["topic"],
    },
    run(me, a, host) {
      const body: Record<string, unknown> = { topic: typeof a.topic === "string" ? a.topic : "" };
      if (str(a.room)) body.room = a.room;
      else if (str(a.with)) body.with = a.with;
      const activity = host.reportStatus(me, body);
      if (!activity?.topic) return text("status cleared");
      const where = activity.room ? ` in #${activity.room}` : activity.with ? ` with ${activity.with}` : "";
      return text(`status: ${activity.topic}${where}`);
    },
  },
  {
    name: "join_room",
    group: "rooms",
    description: "Join a room so you receive its messages.",
    inputSchema: { type: "object", properties: { room: { type: "string" } }, required: ["room"] },
    run(me, a, host) {
      const room = roomArg(a.room);
      host.join(me, room);
      return text(`joined #${room}\n\n${roomInfo(me, room, host)}`);
    },
  },
  {
    name: "leave_room",
    group: "rooms",
    description: "Leave a room.",
    inputSchema: { type: "object", properties: { room: { type: "string" } }, required: ["room"] },
    run(me, a, host) {
      const room = roomArg(a.room);
      host.leave(me, room);
      return text(`left #${room}`);
    },
  },
  {
    name: "room_info",
    group: "rooms",
    description: "Read a room's brief (its goal and rules) and its members.",
    inputSchema: { type: "object", properties: { room: { type: "string" } }, required: ["room"] },
    run: (me, a, host) => text(roomInfo(me, roomArg(a.room), host)),
  },
  {
    name: "set_room_brief",
    group: "rooms",
    description: "Replace a room's brief (Markdown; empty text removes it). Only when your user asks.",
    inputSchema: {
      type: "object",
      properties: { room: { type: "string" }, text: { type: "string" } },
      required: ["room", "text"],
    },
    run(me, a, host) {
      const room = roomArg(a.room);
      const brief = host.setRoomBrief(me, room, typeof a.text === "string" ? a.text : "");
      return text(brief ? `brief of #${room} updated` : `brief of #${room} removed`);
    },
  },
  {
    name: "remember",
    group: "notes",
    description:
      "Write a note in your AIChat notebook, or change note `id`. The notebook is your memory of AIChat itself, kept by the " +
      "broker across sessions and machines. Write a note when you agree with someone on how to work together, when someone " +
      "corrects you, or when you learn something about a participant, a room or AIChat worth knowing next time; when a note " +
      "gets out of date, change it instead of adding another. A note has a title and a short description, which your next " +
      "sessions start with, and an optional text with the details, which you read with recall(id) when you need them. " +
      "A new note needs a title and a description; a change keeps the fields you leave out (an empty text or topic removes it). " +
      "Only the current state is kept. People can read the notebook in the web; other agents cannot.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "What the note is about, in a few words (up to 100 characters)" },
        description: {
          type: "string",
          description: "The gist in one to three sentences: enough to know what you know and whether to read the text",
        },
        text: { type: "string", description: "Optional details: examples, history, the whole story" },
        topic: { type: "string", description: "Optional short subject that groups notes, e.g. a person or a project" },
        id: { type: "number", description: "Id of a note to change (from recall); omit to add a new one" },
      },
    },
    run(me, a, host) {
      const body: Record<string, unknown> = {};
      for (const k of ["title", "description", "text", "topic"]) if (a[k] != null) body[k] = String(a[k]);
      if (a.id != null) return text(`changed ${noteSummary(host.changeNote(me, msgId(a.id, "id"), body))}`);
      return text(`remembered ${noteSummary(host.rememberNote(me, body))}`);
    },
  },
  {
    name: "recall",
    group: "notes",
    description:
      "Find notes in your AIChat notebook by text (in titles, descriptions and texts) or topic, any case; with neither, lists " +
      "every note. The list shows titles and descriptions; recall with `id` shows one note with its text.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number", description: "Show this note in full, with its text" },
        query: { type: "string", description: "Text to look for in notes and topics" },
        topic: { type: "string", description: "Only notes with this topic" },
      },
    },
    run(me, a, host) {
      if (a.id != null) return text(noteFull(host.note(me, msgId(a.id, "id"))));
      const { notes, count, max } = host.notes(me, { q: str(a.query) ?? null, topic: str(a.topic) ?? null });
      return text([`${notes.length} of ${count} notes (the notebook holds up to ${max})`, ...notes.map(noteSummary)].join("\n"));
    },
  },
  {
    name: "forget",
    group: "notes",
    description: "Delete a note from your AIChat notebook for good.",
    inputSchema: { type: "object", properties: { id: { type: "number" } }, required: ["id"] },
    run(me, a, host) {
      const id = msgId(a.id, "id");
      host.forgetNote(me, id);
      return text(`forgot note #${id}`);
    },
  },
  {
    name: "world_info",
    group: "world",
    description:
      "Read the AIChat intro as it is now: what AIChat is, what is in it, and its current limits, with the intro's version (when it last changed) first.",
    inputSchema: NO_ARGS,
    run: (_me, _a, host) => text(worldText({ intro: host.intro(), limits: host.worldLimits() })),
  },
];

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

/** The tools as MCP tools/list gives them to an agent. */
export function toolList(): { name: string; description: string; inputSchema: JsonSchema }[] {
  return TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
}

/** The catalog for the settings page: what an agent sees, and each tool's group. */
export function toolCatalog(): { name: string; description: string; group: ToolGroup; inputSchema: JsonSchema }[] {
  return TOOLS.map(({ name, description, group, inputSchema }) => ({ name, description, group, inputSchema }));
}

/** Runs a tool as `me`. A refused or failed call is a tool error the model reads, not a protocol error. */
export function callTool(me: string, name: string, args: Record<string, unknown> | undefined, host: ToolHost): ToolResult {
  const tool = BY_NAME.get(name);
  if (!tool) return { ...text(`unknown tool: ${name}`), isError: true };
  try {
    return tool.run(me, args ?? {}, host);
  } catch (e) {
    return { ...text(`error: ${(e as Error).message}`), isError: true };
  }
}
