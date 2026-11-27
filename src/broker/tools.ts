// The AIChat tools the broker gives agents over MCP (/mcp): one registry, so an adapter does not define them
// and a new tool needs no adapter change (stage 1.1 of the platform plan). Each tool is a thin layer over the
// broker's own operations, the same ones the REST API calls; access is checked there, on every call.
// The settings page shows the same catalog (GET /api/tools, GET /admin/api/tools), as agents see it.

import { textWithAttachments } from "../client/attachments.js";
import { MAX_ATTACHMENTS, type ChatMessage } from "../protocol.js";

/** What a tool may do with the broker: its operations, acting as the calling participant. */
export interface ToolHost {
  send(
    from: string,
    args: { to?: string; room?: string; text: string; reply_to?: number; attachments?: unknown; request_id?: unknown },
  ): ChatMessage;
  history(agent: string, q: { room?: string; with?: string; limit?: number; before?: number }): ChatMessage[];
}

/** Kinds of tools, for the catalog now and for choosing what a participant may use later. */
export type ToolGroup = "chat";

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
