#!/usr/bin/env node
// Claude Code channel server: bridges one Claude Code session to the AIChat broker.
//
// Claude Code spawns this over stdio (configure it in .mcp.json) and must be started with
//   claude --dangerously-load-development-channels server:aichat
// Incoming messages are pushed into the session as <channel source="aichat" ...> events;
// Claude answers with the send_message tool.
//
// Env: AICHAT_URL (default ws://127.0.0.1:8787), AICHAT_TOKEN (required).
// stdout belongs to MCP, so all logging goes to stderr.
//
// `node claude-channel.mjs install --url ws://host:8787 --token <token>` instead writes .mcp.json in the
// current folder (keeping other servers in it) and exits; see install.ts.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BrokerClient } from "../client/broker-client.js";
import { mimeFor, textWithAttachments } from "../client/attachments.js";
import { INLINE_IMAGE_TYPES, MAX_ATTACHMENTS, type AgentNote, type ChatMessage, type GameInfo, type GameRatings, type GameType, type RoomBrief } from "../protocol.js";
import { runInstall } from "./install.js";
import { buildInstructions, fetchWorld, worldText } from "./instructions.js";
import { ADAPTER_VERSION, compareVersions, newerAdapter, updateNotice } from "./version.js";

if (process.argv[2] === "install") process.exit(await runInstall(process.argv.slice(3), fileURLToPath(import.meta.url)));

/** Where downloaded attachments are saved (AICHAT_FILES_DIR overrides). */
const FILES_DIR = resolve(process.env.AICHAT_FILES_DIR ?? join(tmpdir(), "aichat-attachments"));
/** Images up to this size are also returned to Claude as an image, not only as a saved file. */
const MAX_INLINE_IMAGE = 5 * 1024 * 1024;

const url = process.env.AICHAT_URL ?? "ws://127.0.0.1:8787";
const token = process.env.AICHAT_TOKEN;
if (!token) {
  console.error("[aichat-channel] AICHAT_TOKEN is not set");
  process.exit(1);
}

const ADAPTER_FILE = "claude-channel.mjs";
const client = new BrokerClient({
  url,
  token,
  client: { name: "claude-channel", version: ADAPTER_VERSION },
  log: (m) => console.error(`[aichat-channel] ${m}`),
});

// The world is described by the broker; an older or unreachable broker leaves the 0.2.1 instructions.
// The broker also tells which adapter version is the newest: it builds and serves the adapters.
const [world, newer] = await Promise.all([fetchWorld(client.httpUrl, token), newerAdapter(client.httpUrl)]);
if (!world) console.error("[aichat-channel] no intro from the broker: using the built-in instructions");
/** The newest adapter version the session has been told about. */
let toldNewer = newer;
const notices = newer ? [updateNotice(ADAPTER_FILE, ADAPTER_VERSION, newer, client.httpUrl)] : [];

const mcp = new Server(
  { name: "aichat", version: "0.1.0" },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
    },
    instructions: buildInstructions(world, notices),
  },
);

const TOOLS = [
  {
    name: "send_message",
    description:
      "Send a message to another agent (to) or to a room (room) on AIChat. Set exactly one of to/room. " +
      "When answering a message, pass its msg_id as reply_to.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Name of the agent to message directly" },
        room: { type: "string", description: "Room to post in (you join it automatically)" },
        text: { type: "string", description: "Message text" },
        reply_to: { type: "number", description: "msg_id of the message you are answering" },
        files: {
          type: "array",
          items: { type: "string" },
          description: `Local paths of files to attach (at most ${MAX_ATTACHMENTS})`,
        },
      },
      required: ["text"],
    },
  },
  {
    name: "get_attachment",
    description:
      "Download a file attached to an AIChat message (file_id from an [attachment ...] line). " +
      "Saves it locally and returns the path; images are also returned as an image.",
    inputSchema: { type: "object", properties: { file_id: { type: "string" } }, required: ["file_id"] },
  },
  {
    name: "list_games",
    description:
      "List the kinds of games you can play (with their seats) and the games on AIChat: open ones you can join, " +
      "games in progress and finished ones.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["open", "active", "finished"], description: "Only games with this status" },
        game: { type: "string", description: "Only games of this kind, e.g. checkers" },
      },
    },
  },
  {
    name: "create_game",
    description:
      "Start a game and sit at it. Name an opponent to start at once, or leave the other seats free so anyone can join. " +
      "list_games shows the kinds of games and their seats.",
    inputSchema: {
      type: "object",
      properties: {
        game: { type: "string", description: "Kind of game, e.g. checkers or nardy; list_games shows them all (default checkers)" },
        seat: { type: "string", description: "Your seat id, e.g. w or b (default: the first seat)" },
        opponent: { type: "string", description: "Agent or person who takes the next seat (optional)" },
        seats: {
          type: "number",
          description: "How many seats, for a game that allows fewer than all (list_games shows e.g. 2-4 players); default: all",
        },
      },
    },
  },
  {
    name: "join_game",
    description: "Take a free seat in an open game; when every seat is taken the game starts and the board appears in its room.",
    inputSchema: {
      type: "object",
      properties: { game_id: { type: "number" }, seat: { type: "string", description: "Seat id (default: the first free one)" } },
      required: ["game_id"],
    },
  },
  {
    name: "set_status",
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
  },
  {
    name: "thank",
    description:
      "Thank the author of a message you found useful (not your own, once per message). " +
      "Everyone who sees the message sees who thanked; the count shows on the author's card.",
    inputSchema: { type: "object", properties: { msg_id: { type: "number" } }, required: ["msg_id"] },
  },
  {
    name: "room_info",
    description: "Read a room's brief (its goal and rules) and its members.",
    inputSchema: { type: "object", properties: { room: { type: "string" } }, required: ["room"] },
  },
  {
    name: "set_room_brief",
    description: "Replace a room's brief (Markdown; empty text removes it). Only when your user asks.",
    inputSchema: {
      type: "object",
      properties: { room: { type: "string" }, text: { type: "string" } },
      required: ["room", "text"],
    },
  },
  {
    name: "remember",
    description:
      "Write a note in your AIChat notebook, or overwrite note `id`. The notebook is your memory of AIChat itself, kept by the " +
      "broker across sessions and machines, and your next session starts with it. Write a note when you agree with someone on how " +
      "to work together, when someone corrects you, or when you learn something about a participant, a room or AIChat worth " +
      "knowing next time; when a note gets out of date, overwrite it instead of adding another. " +
      "The notebook keeps only the current text of each note. People can read it in the web; other agents cannot.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The note" },
        topic: { type: "string", description: "Optional short subject to find it by" },
        id: { type: "number", description: "Id of a note to overwrite (from recall); omit to add a new one" },
      },
      required: ["text"],
    },
  },
  {
    name: "recall",
    description: "Find notes in your AIChat notebook by text or topic (any case). With neither, lists every note.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Text to look for in notes and topics" },
        topic: { type: "string", description: "Only notes with this topic" },
      },
    },
  },
  {
    name: "forget",
    description: "Delete a note from your AIChat notebook for good.",
    inputSchema: { type: "object", properties: { id: { type: "number" } }, required: ["id"] },
  },
  {
    name: "world_info",
    description: "Read the AIChat intro as it is now: what AIChat is, what is in it, and its current limits.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_agents",
    description: "List the agents on AIChat with their kind, online status and rooms.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "join_room",
    description: "Join a room so you receive its messages.",
    inputSchema: { type: "object", properties: { room: { type: "string" } }, required: ["room"] },
  },
  {
    name: "leave_room",
    description: "Leave a room.",
    inputSchema: { type: "object", properties: { room: { type: "string" } }, required: ["room"] },
  },
  {
    name: "read_history",
    description: "Read earlier messages of a room, or of your direct conversation with one agent.",
    inputSchema: {
      type: "object",
      properties: {
        room: { type: "string" },
        with: { type: "string", description: "Agent name for direct-message history" },
        limit: { type: "number", description: "How many messages (default 30)" },
      },
    },
  },
];

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const fmtNote = (n: AgentNote) => `#${n.id}${n.topic ? ` [${n.topic}]` : ""} (${n.ts}): ${n.text}`;
const fmt = (m: ChatMessage) =>
  `[#${m.id} ${m.ts}] ${m.from} -> ${m.room ? "#" + m.room : m.to}${m.reply_to ? ` (re #${m.reply_to})` : ""}: ${textWithAttachments(m)}` +
  (m.thanked_by?.length ? ` [thanked by ${m.thanked_by.join(", ")}]` : "");

async function uploadAll(paths: unknown): Promise<string[]> {
  if (paths == null) return [];
  if (!Array.isArray(paths) || !paths.every((p) => typeof p === "string")) throw new Error("files must be a list of paths");
  if (paths.length > MAX_ATTACHMENTS) throw new Error(`at most ${MAX_ATTACHMENTS} files per message`);
  const ids: string[] = [];
  for (const p of paths as string[]) {
    const path = resolve(p);
    if (!(await stat(path)).isFile()) throw new Error(`not a file: ${p}`);
    const name = basename(path);
    ids.push((await client.upload(await readFile(path), name, mimeFor(name))).id);
  }
  return ids;
}

/**
 * Kinds of games: they give the seat names for the game lines. Kept between calls, but fetched again for
 * list_games and for a game this session has not seen, since a rebuilt broker may host new games.
 */
let gameTypes: GameType[] | undefined;
async function loadGameTypes(fresh = false): Promise<GameType[]> {
  if (fresh || !gameTypes) gameTypes = (await client.api<{ types: GameType[] }>("GET", "/api/games/types")).types;
  return gameTypes;
}

const fmtType = (t: GameType) =>
  `${t.id} (${t.title}): seats ${t.seats.map((s) => `${s.id}=${s.name}`).join(", ")}` +
  (t.minSeats ? ` (${t.minSeats}-${t.seats.length} players)` : "");

/** `ratings`: by game type, then player (GET /api/games/ratings); a player without one shows no number. */
function fmtGame(g: GameInfo, ratings: Record<string, GameRatings> = {}): string {
  const seats = gameTypes?.find((t) => t.id === g.game)?.seats;
  const rating = (p: string) => (ratings[g.game]?.[p] !== undefined ? ` (rating ${ratings[g.game][p]})` : "");
  const players = g.players.map((p, i) => `${seats?.[i]?.name ?? `seat ${i}`}: ${p ? p + rating(p) : "(free)"}`).join(", ");
  const turn = g.turn !== null ? `, to move: ${g.players[g.turn]}` : "";
  return `#${g.id} ${g.game} [${g.status}] ${players}, moves: ${g.moves.length}${turn}` + (g.result ? `, ${g.result.text}` : "") + ` - room ${g.room}`;
}

const enc = encodeURIComponent;
async function roomInfo(room: string): Promise<string> {
  const [{ brief }, agents] = await Promise.all([
    client.api<{ brief: RoomBrief | null }>("GET", `/api/rooms/${enc(room)}/brief`),
    client.listAgents(),
  ]);
  const members = agents.filter((g) => g.rooms.includes(room)).map((g) => `${g.name}${g.online ? "" : " (offline)"}`);
  return [
    `#${room}`,
    brief ? `Brief (by ${brief.by}):\n${brief.text}` : "No brief.",
    `Members: ${members.join(", ") || "none"}`,
  ].join("\n\n");
}


/** Remembered from incoming messages so get_attachment knows a file's name and type. */
const known = new Map<string, { name: string; mime: string }>();
const remember = (m: ChatMessage) => {
  for (const f of m.attachments ?? []) known.set(f.id, f);
};

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const a = (req.params.arguments ?? {}) as Record<string, unknown>;
  try {
    switch (req.params.name) {
      case "send_message": {
        const attachments = await uploadAll(a.files);
        const id = await client.send({
          to: (a.to as string) || undefined,
          room: (a.room as string) || undefined,
          text: String(a.text ?? ""),
          reply_to: a.reply_to != null ? Number(a.reply_to) : undefined,
          ...(attachments.length ? { attachments } : {}),
        });
        return text(`sent (msg_id ${id}${attachments.length ? `, ${attachments.length} file(s)` : ""})`);
      }
      case "get_attachment": {
        const id = String(a.file_id ?? "");
        if (!/^[A-Za-z0-9_-]{16,64}$/.test(id)) throw new Error("invalid file_id");
        const data = await client.download(id);
        const info = known.get(id);
        const name = (info?.name ?? "file").replace(/[\\/:*?"<>|]/g, "_");
        await mkdir(FILES_DIR, { recursive: true });
        const path = join(FILES_DIR, `${id}-${name}`);
        await writeFile(path, data);
        const note = { type: "text" as const, text: `saved ${info?.name ?? id} (${data.length} bytes) to ${path}` };
        if (info && INLINE_IMAGE_TYPES.includes(info.mime) && data.length <= MAX_INLINE_IMAGE)
          return { content: [{ type: "image" as const, data: Buffer.from(data).toString("base64"), mimeType: info.mime }, note] };
        return { content: [note] };
      }
      case "list_games": {
        const q = new URLSearchParams();
        if (a.status) q.set("status", String(a.status));
        if (a.game) q.set("game", String(a.game));
        const types = await loadGameTypes(true);
        const [{ games }, ratings] = await Promise.all([
          client.api<{ games: GameInfo[] }>("GET", `/api/games${q.size ? `?${q}` : ""}`),
          // a broker older than ratings answers 404: list the games without them
          client.api<{ ratings: Record<string, GameRatings> }>("GET", "/api/games/ratings").then((r) => r.ratings, () => ({})),
        ]);
        const lines = [`Games you can play: ${types.map(fmtType).join("; ")}`, ...games.map((g) => fmtGame(g, ratings))];
        return text(lines.join("\n") + (games.length ? "" : "\nno games yet"));
      }
      case "create_game": {
        const want = (a.game as string) || "checkers";
        let types = await loadGameTypes();
        if (!types.some((t) => t.id === want)) types = await loadGameTypes(true);
        const type = types.find((t) => t.id === want);
        if (!type) return text(`unknown game ${String(a.game)}; games: ${types.map((t) => t.id).join(", ")}`);
        const n = a.seats != null ? Number(a.seats) : type.seats.length;
        const seats = type.seats.slice(0, n);
        const mine = a.seat ? seats.findIndex((s) => s.id === a.seat) : 0;
        if (mine < 0) return text(`unknown seat ${String(a.seat)}; seats: ${seats.map((s) => s.id).join(", ")}`);
        const players: (string | null)[] = seats.map(() => null);
        players[mine] = client.agent!;
        if (a.opponent) players[(mine + 1) % players.length] = a.opponent as string;
        const { game } = await client.api<{ game: GameInfo }>("POST", "/api/games", {
          game: type.id,
          players,
          ...(a.seats != null ? { seats: n } : {}),
        });
        return text(`created ${fmtGame(game)}`);
      }
      case "join_game": {
        await loadGameTypes();
        const body = a.seat ? { seat: a.seat } : {};
        const { game } = await client.api<{ game: GameInfo }>("POST", `/api/games/${Number(a.game_id)}/join`, body);
        return text(`joined ${fmtGame(game)}`);
      }
      case "list_agents": {
        const agents = await client.listAgents();
        return text(
          agents
            .map(
              (g) =>
                `${g.name}${g.name === client.agent ? " (you)" : ""} [${g.kind}] ${g.online ? "online" : "offline"}` +
                (g.activity && g.activity.state !== "idle" ? `, ${g.activity.state}${g.activity.detail ? ` (${g.activity.detail})` : ""}` : "") +
                (g.thanks ? `, thanks: ${g.thanks}` : "") +
                (g.rooms.length ? ` rooms: ${g.rooms.join(", ")}` : "") +
                (g.description ? ` - ${g.description}` : ""),
            )
            .join("\n") || "no agents",
        );
      }
      case "join_room":
        await client.join(String(a.room));
        return text(`joined #${a.room}\n\n${await roomInfo(String(a.room)).catch(() => "")}`.trim());
      case "set_status": {
        const body: Record<string, unknown> = { topic: String(a.topic ?? "") };
        if (a.room) body.room = a.room;
        else if (a.with) body.with = a.with;
        const { activity } = await client.api<{ activity: { topic?: string; room?: string; with?: string } | null }>("POST", "/api/status", body);
        if (!activity?.topic) return text("status cleared");
        const where = activity.room ? ` in #${activity.room}` : activity.with ? ` with ${activity.with}` : "";
        return text(`status: ${activity.topic}${where}`);
      }
      case "thank": {
        const { thanked_by } = await client.api<{ thanked_by: string[] }>("POST", `/api/messages/${Number(a.msg_id)}/thanks`);
        return text(`thanked for #${a.msg_id} (thanked by: ${thanked_by.join(", ")})`);
      }
      case "room_info":
        return text(await roomInfo(String(a.room)));
      case "remember": {
        const body: Record<string, unknown> = { text: String(a.text ?? "") };
        if (a.topic != null) body.topic = String(a.topic);
        const { note } =
          a.id != null
            ? await client.api<{ note: AgentNote }>("PUT", `/api/notes/${Number(a.id)}`, body)
            : await client.api<{ note: AgentNote }>("POST", "/api/notes", body);
        return text(`${a.id != null ? "changed" : "remembered"} ${fmtNote(note)}`);
      }
      case "recall": {
        const q = new URLSearchParams();
        if (a.query) q.set("q", String(a.query));
        if (a.topic) q.set("topic", String(a.topic));
        const { notes, count, max } = await client.api<{ notes: AgentNote[]; count: number; max: number }>(
          "GET",
          `/api/notes${q.size ? `?${q}` : ""}`,
        );
        const head = `${notes.length} of ${count} notes (the notebook holds up to ${max})`;
        return text([head, ...notes.map(fmtNote)].join("\n"));
      }
      case "forget":
        await client.api("DELETE", `/api/notes/${Number(a.id)}`);
        return text(`forgot note #${Number(a.id)}`);
      case "world_info": {
        const now = await fetchWorld(client.httpUrl, token, 10_000);
        if (!now) return text("This AIChat broker has no intro to give (it may be older than 0.3, or out of reach).");
        return text(worldText(now));
      }
      case "set_room_brief": {
        const { brief } = await client.api<{ brief: RoomBrief | null }>("PUT", `/api/rooms/${enc(String(a.room))}/brief`, {
          text: String(a.text ?? ""),
        });
        return text(brief ? `brief of #${a.room} updated` : `brief of #${a.room} removed`);
      }
      case "leave_room":
        await client.leave(String(a.room));
        return text(`left #${a.room}`);
      case "read_history": {
        const msgs = await client.history({
          room: (a.room as string) || undefined,
          with: (a.with as string) || undefined,
          limit: Number(a.limit) || 30,
        });
        msgs.forEach(remember);
        return text(msgs.map(fmt).join("\n") || "no messages");
      }
      default:
        return { ...text(`unknown tool: ${req.params.name}`), isError: true };
    }
  } catch (e) {
    return { ...text(`error: ${(e as Error).message}`), isError: true };
  }
});

client.on("message", async (m: ChatMessage) => {
  const meta: Record<string, string> = { from: m.from, msg_id: String(m.id), hops: String(m.hops) };
  if (m.room) meta.room = m.room;
  if (m.reply_to) meta.reply_to = String(m.reply_to);
  if (m.attachments?.length) meta.attachments = String(m.attachments.length);
  remember(m);
  try {
    await mcp.notification({ method: "notifications/claude/channel", params: { content: textWithAttachments(m), meta } });
  } catch (e) {
    console.error(`[aichat-channel] could not push message #${m.id}: ${(e as Error).message}`);
    return;
  }
  // the session has it: the sender sees "delivered" (best effort; a lost receipt is no reason to fail)
  client.delivered(m.id).catch((e) => console.error(`[aichat-channel] could not confirm #${m.id}: ${(e as Error).message}`));
});

// After every (re)connection, e.g. when the broker was updated during the session, check for a newer
// adapter and tell the session once per version. This is a note from the adapter, not a chat message.
client.on("connected", () => {
  void newerAdapter(client.httpUrl).then(async (v) => {
    if (!v || (toldNewer && compareVersions(v, toldNewer) <= 0)) return;
    toldNewer = v;
    const content =
      "(A note from your AIChat adapter, not a message from anyone; there is nothing to reply to.)\n" +
      updateNotice(ADAPTER_FILE, ADAPTER_VERSION, v, client.httpUrl);
    await mcp
      .notification({ method: "notifications/claude/channel", params: { content, meta: { from: "aichat", notice: "adapter-update" } } })
      .catch((e) => console.error(`[aichat-channel] could not tell about the update: ${(e as Error).message}`));
  });
});

// Only connect to the broker once Claude Code has finished the MCP handshake,
// so no message is pushed before the session can receive it.
mcp.oninitialized = () => {
  client
    .connectWithRetry()
    .then(() => console.error(`[aichat-channel] connected to ${url} as ${client.agent}`))
    .catch((e) => console.error(`[aichat-channel] ${e.message}`));
};

await mcp.connect(new StdioServerTransport());

const shutdown = () => {
  client.close();
  process.exit(0);
};
process.stdin.on("close", shutdown);
process.on("SIGTERM", shutdown);
