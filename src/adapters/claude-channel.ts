#!/usr/bin/env node
// Claude Code channel server: bridges one Claude Code session to the AIChat broker.
//
// Claude Code spawns this over stdio (configure it in .mcp.json) and must be started with
//   claude --dangerously-load-development-channels server:aichat
// Incoming messages are pushed into the session as <channel source="aichat" ...> events;
// Claude answers with the broker's send_message tool, which this adapter passes on to the broker's /mcp.
//
// Env: AICHAT_URL (default ws://127.0.0.1:8787), AICHAT_TOKEN or AICHAT_TOKEN_FILE (a file holding it).
// stdout belongs to MCP, so all logging goes to stderr.
//
// `node claude-channel.mjs install --url ws://host:8787 --token <token>` instead writes .mcp.json in the
// current folder (keeping other servers in it) and exits; see install.ts.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ToolListChangedNotificationSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BrokerClient } from "../client/broker-client.js";
import { textWithAttachments } from "../client/attachments.js";
import { readUpload, saveDownload } from "./core/files.mjs";
import { INLINE_IMAGE_TYPES, type ChatMessage, type ReactionNote } from "../protocol.js";
import { runInstall } from "./install.js";
import { buildInstructions, fetchWorld } from "./instructions.js";
import { ADAPTER_VERSION, compareVersions, newerAdapter, updateNotice } from "./version.js";

if (process.argv[2] === "install") process.exit(await runInstall(process.argv.slice(3), fileURLToPath(import.meta.url)));

/** Where downloaded attachments are saved (AICHAT_FILES_DIR overrides). */
const FILES_DIR = resolve(process.env.AICHAT_FILES_DIR ?? join(tmpdir(), "aichat-attachments"));
/** Images up to this size are also returned to Claude as an image, not only as a saved file. */
const MAX_INLINE_IMAGE = 5 * 1024 * 1024;

const url = process.env.AICHAT_URL ?? "ws://127.0.0.1:8787";
// the token itself, or the file that holds it (AICHAT_TOKEN_FILE: so it need not sit in .mcp.json)
const token =
  process.env.AICHAT_TOKEN ||
  (process.env.AICHAT_TOKEN_FILE ? await readFile(process.env.AICHAT_TOKEN_FILE, "utf8").then((t) => t.trim(), () => "") : "");
if (!token) {
  console.error(
    process.env.AICHAT_TOKEN_FILE
      ? `[aichat-channel] no token in AICHAT_TOKEN_FILE (${process.env.AICHAT_TOKEN_FILE})`
      : "[aichat-channel] neither AICHAT_TOKEN nor AICHAT_TOKEN_FILE is set",
  );
  process.exit(1);
}

const ADAPTER_FILE = "claude-channel.mjs";
/**
 * How the session began. Claude Code keeps the session, not the adapter, so only the start script knows:
 * it runs `claude --continue` (resumed) or `claude` (new) and says so in AICHAT_START.
 */
const START = process.env.AICHAT_START === "resumed" || process.env.AICHAT_START === "new" ? process.env.AICHAT_START : undefined;
const client = new BrokerClient({
  url,
  token,
  client: { name: "claude-channel", version: ADAPTER_VERSION, surface: "terminal", ...(START ? { start: START } : {}) },
  // one id for this process: Claude Code starts the adapter with each session, and the broker greets a new one
  session: randomUUID(),
  log: (m) => console.error(`[aichat-channel] ${m}`),
});

// The world is described by the broker; an older or unreachable broker leaves the 0.2.1 instructions.
// The broker also tells which adapter version is the newest: it builds and serves the adapters.
const [world, newer] = await Promise.all([fetchWorld(client.httpUrl, token), newerAdapter(client.httpUrl)]);
if (!world) console.error("[aichat-channel] no intro from the broker: using the built-in instructions");
/** The newest adapter version the session has been told about. */
let toldNewer = newer;
const notices = newer ? [updateNotice(ADAPTER_FILE, ADAPTER_VERSION, newer, client.httpUrl)] : [];

/**
 * The broker's tools (/mcp, AIChat 0.29+): this adapter defines none of them, it lists and calls them on the broker,
 * so a new AIChat tool needs no adapter change (stage 1.1 of the platform plan). Only the two file tools are its own:
 * they read and write this machine's disk.
 */
const toolsOnBroker = await fetch(`${client.httpUrl}/api/tools`, {
  headers: { authorization: `Bearer ${token}` },
  signal: AbortSignal.timeout(5000),
}).then(
  (r) => r.ok,
  () => false,
);
if (!toolsOnBroker) {
  console.error("[aichat-channel] the broker has no /mcp (older than 0.29.0): only the file tools are available");
  notices.push(
    "Your AIChat broker is older than 0.29.0 and does not give its tools to this adapter: messages arrive, but you cannot " +
      "answer through AIChat tools. Tell your user to update the broker.",
  );
}

const mcp = new Server(
  { name: "aichat", version: "0.1.0" },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: { listChanged: true },
    },
    instructions: buildInstructions(world, notices),
  },
);

/**
 * Folders upload_file takes files from: the agent's outbox and the attachments folder, plus any the person names in
 * AICHAT_UPLOAD_DIRS. Not the whole temp folder: other programs' files there have ordinary names (codex-alexey, 3947).
 */
const OUTBOX = join(process.cwd(), "outbox");
const UPLOAD_DIRS = [OUTBOX, FILES_DIR, ...(process.env.AICHAT_UPLOAD_DIRS ?? "").split(delimiter).filter(Boolean)].map((d) =>
  resolve(d),
);

const LOCAL_TOOLS = [
  {
    name: "upload_file",
    description:
      "Upload a local file to AIChat and get its file_id, to attach with send_message(attachments=[file_id, ...]). " +
      `Only files in your outbox folder (${OUTBOX}) or the attachments folder (${FILES_DIR}) can be uploaded: copy a file ` +
      "into the outbox first. Private files (tokens, keys, .env, profiles) are refused.",
    inputSchema: { type: "object" as const, properties: { path: { type: "string", description: "Local path of the file" } }, required: ["path"] },
  },
  {
    name: "get_attachment",
    description:
      "Download a file attached to an AIChat message (file_id from an [attachment ...] line). " +
      "Saves it locally and returns the path; images are also returned as an image.",
    inputSchema: { type: "object" as const, properties: { file_id: { type: "string" } }, required: ["file_id"] },
  },
];
const LOCAL = new Set(LOCAL_TOOLS.map((t) => t.name));

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

/** Reactions to the agent's own messages that came since it last heard: one line, after the message. */
const reactionLine = (notes: ReactionNote[]) =>
  notes.length
    ? `\n\n[reactions to your messages since last time: ${notes
        .map((n) => `#${n.id} ${n.emoji} ${n.by}${n.room ? ` in #${n.room}` : ""}`)
        .join("; ")}]`
    : "";

/** The shared rule (core/files.mjs): inside the upload folders, nothing private, no hard links, size limit. */
async function uploadFile(p: unknown): Promise<string> {
  const { bytes, name, mime } = readUpload({ path: p, roots: UPLOAD_DIRS, blocked: [process.env.AICHAT_TOKEN_FILE] });
  const f = await client.upload(bytes, name, mime);
  return `uploaded ${f.name} (${f.size} bytes): file_id ${f.id}`;
}

/** Remembered from incoming messages: a file's name and type when the download does not say. */
const known = new Map<string, { name: string; mime: string }>();
const remember = (m: ChatMessage) => {
  for (const f of m.attachments ?? []) known.set(f.id, f);
};

async function getAttachment(raw: unknown) {
  const id = String(raw ?? "");
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(id)) throw new Error("invalid file_id");
  const r = await fetch(`${client.httpUrl}/api/files/${encodeURIComponent(id)}`, { headers: { authorization: `Bearer ${token}` } });
  if (!r.ok) {
    const body = (await r.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `download failed: HTTP ${r.status}`);
  }
  const data = Buffer.from(await r.arrayBuffer());
  const mime = (r.headers.get("content-type") ?? "").split(";")[0].trim();
  const image = INLINE_IMAGE_TYPES.includes(mime) ? mime : known.get(id)?.mime;
  const { path, name } = saveDownload({
    dir: FILES_DIR,
    id,
    disposition: r.headers.get("content-disposition"),
    fallback: known.get(id)?.name,
    bytes: data,
  });
  const note = { type: "text" as const, text: `saved ${name} (${data.length} bytes) to ${path}` };
  if (image && INLINE_IMAGE_TYPES.includes(image) && data.length <= MAX_INLINE_IMAGE)
    return { content: [{ type: "image" as const, data: data.toString("base64"), mimeType: image }, note] };
  return { content: [note] };
}

/** The MCP client of the broker's /mcp; opened on first use, and again when the broker forgot the session. */
let brokerMcp: Client | undefined;
let opening: Promise<Client> | undefined;
function brokerClient(): Promise<Client> {
  if (brokerMcp) return Promise.resolve(brokerMcp);
  opening ??= (async () => {
    const c = new Client({ name: "claude-channel", version: ADAPTER_VERSION });
    // the broker's tool list changed: Claude Code asks this adapter for the list again
    c.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      await mcp.sendToolListChanged().catch(() => {});
    });
    await c.connect(
      new StreamableHTTPClientTransport(new URL(`${client.httpUrl}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }),
    );
    brokerMcp = c;
    return c;
  })().finally(() => (opening = undefined));
  return opening;
}

/** Runs `fn` on the broker; when the broker forgot the session (a restart: 404), once more on a new one. */
async function onBroker<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = await brokerClient();
  try {
    return await fn(c);
  } catch (e) {
    if (brokerMcp === c) brokerMcp = undefined;
    void c.close().catch(() => {});
    // 404: the request never ran, so repeating it cannot do anything twice
    if (!/\b404\b|session not found/i.test((e as Error).message)) throw e;
    return fn(await brokerClient());
  }
}

mcp.setRequestHandler(ListToolsRequestSchema, async () => {
  if (!toolsOnBroker) return { tools: LOCAL_TOOLS };
  try {
    const { tools } = await onBroker((c) => c.listTools());
    return { tools: [...tools.filter((t) => !LOCAL.has(t.name)), ...LOCAL_TOOLS] };
  } catch (e) {
    console.error(`[aichat-channel] could not list the broker's tools: ${(e as Error).message}`);
    return { tools: LOCAL_TOOLS };
  }
});

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const a = (req.params.arguments ?? {}) as Record<string, unknown>;
  try {
    if (req.params.name === "upload_file") return text(await uploadFile(a.path));
    if (req.params.name === "get_attachment") return await getAttachment(a.file_id);
    if (!toolsOnBroker)
      return { ...text("this AIChat broker is older than 0.29.0 and gives no tools: ask your user to update it"), isError: true };
    return (await onBroker((c) => c.callTool({ name: req.params.name, arguments: a }))) as CallToolResult;
  } catch (e) {
    return { ...text(`error: ${(e as Error).message}`), isError: true };
  }
});

client.on("message", async (m: ChatMessage, reactions: ReactionNote[] = []) => {
  const meta: Record<string, string> = { from: m.from, msg_id: String(m.id), hops: String(m.hops) };
  if (m.room) meta.room = m.room;
  if (m.reply_to) meta.reply_to = String(m.reply_to);
  if (m.attachments?.length) meta.attachments = String(m.attachments.length);
  remember(m);
  try {
    const content = textWithAttachments(m) + reactionLine(reactions);
    await mcp.notification({ method: "notifications/claude/channel", params: { content, meta } });
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

// `.aichat/stop` in the session's folder takes the agent off AIChat, the same way for every adapter. Claude Code
// itself stays open: the adapter cannot close it, so it only leaves (offline) and removes the file.
const STOP_FILE = join(process.cwd(), ".aichat", "stop");
const stopWatch = setInterval(() => {
  void stat(STOP_FILE).then(
    async () => {
      clearInterval(stopWatch);
      console.error("[aichat-channel] .aichat/stop found: leaving AIChat");
      await rm(STOP_FILE, { force: true }).catch(() => {});
      shutdown();
    },
    () => {},
  );
}, 1000);
stopWatch.unref();
