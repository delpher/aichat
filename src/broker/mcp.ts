// The broker's MCP endpoint (POST/GET/DELETE /mcp, Streamable HTTP): agents list and call the AIChat tools
// of tools.ts here with their usual bearer token. Each MCP session belongs to the participant that opened it;
// the token is checked on every request, so a removed or changed token stops the session at once.
//
// Sessions live in memory and are cheap: idle ones close and each participant has a cap. A request with a session
// the broker no longer knows (it closed, or the broker restarted) is still served, without a session (see handle).

import type { IncomingMessage, ServerResponse } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "node:crypto";
import { callTool, toolList, type ToolHost } from "./tools.js";

/** An MCP session nobody used for this long is closed. */
export const MCP_IDLE_MS = 60 * 60 * 1000;
/** Open MCP sessions per participant; a new one past the cap closes the least recently used. */
export const MCP_SESSIONS_PER_AGENT = 16;

interface Session {
  agent: string;
  transport: StreamableHTTPServerTransport;
  server: Server;
  last: number;
}

export class McpEndpoint {
  private sessions = new Map<string, Session>();

  constructor(
    private o: { host: ToolHost; version: string; now: () => number; log: (m: string) => void },
  ) {}

  /** How many sessions are open (for tests and the log). */
  get size(): number {
    return this.sessions.size;
  }

  /** Serves one request of an authenticated participant. `body` is the parsed JSON of a POST. */
  async handle(req: IncomingMessage, res: ServerResponse, agent: string, body: unknown): Promise<void> {
    const sid = req.headers["mcp-session-id"];
    if (typeof sid === "string" && sid) {
      const s = this.sessions.get(sid);
      if (s && s.agent === agent) {
        s.last = this.o.now();
        return s.transport.handleRequest(req, res, body);
      }
      // A session the broker no longer knows: it closed while idle (a computer asleep), or the broker restarted (every
      // release). agy, OpenCode and Codex do not open a new one after 404 and lose every AIChat tool until a reload
      // (AIChat 4001-4006), so a POST is served without a session: who calls is the token, checked on every request,
      // and the tools need nothing from the session. Another participant's id is as unknown to this caller.
      // Without a session there is no stream for the broker to push into: GET is 405, DELETE has nothing to end.
      if (req.method === "POST") return this.stateless(req, res, agent, body);
      if (req.method === "GET") return rpcError(res, 405, -32000, "Method not allowed: no stream without a session");
      return rpcError(res, 404, -32001, "Session not found");
    }
    if (req.method !== "POST" || !isInitializeRequest(body))
      return rpcError(res, 400, -32000, "Bad Request: no Mcp-Session-Id, and this is not an initialize request");
    const s = this.open(agent);
    await s.server.connect(s.transport);
    return s.transport.handleRequest(req, res, body);
  }

  /** How many requests were served without a session (for tests and the log). */
  statelessServed = 0;

  /** One request on a server of its own, with no session; both are gone when the answer is sent. */
  private async stateless(req: IncomingMessage, res: ServerResponse, agent: string, body: unknown): Promise<void> {
    const server = this.server(agent);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => void server.close().catch(() => {}));
    this.statelessServed++;
    await server.connect(transport);
    return transport.handleRequest(req, res, body);
  }

  /** The MCP server of one participant: the broker's tools, called as that participant. */
  private server(agent: string): Server {
    const server = new Server({ name: "aichat", version: this.o.version }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolList() }));
    server.setRequestHandler(CallToolRequestSchema, async (req) =>
      callTool(agent, req.params.name, req.params.arguments as Record<string, unknown> | undefined, this.o.host),
    );
    return server;
  }

  private open(agent: string): Session {
    const server = this.server(agent);
    const s: Session = {
      agent,
      server,
      last: this.o.now(),
      transport: new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          this.sessions.set(id, s);
          this.capSessions(agent);
        },
      }),
    };
    s.transport.onclose = () => {
      const id = s.transport.sessionId;
      if (id && this.sessions.get(id) === s) this.sessions.delete(id);
    };
    return s;
  }

  private capSessions(agent: string) {
    const own = [...this.sessions.values()].filter((s) => s.agent === agent).sort((a, b) => a.last - b.last);
    for (const s of own.slice(0, Math.max(0, own.length - MCP_SESSIONS_PER_AGENT))) void this.closeSession(s);
  }

  /** Closes sessions idle for MCP_IDLE_MS. */
  sweep(now = this.o.now()) {
    for (const s of [...this.sessions.values()]) if (now - s.last > MCP_IDLE_MS) void this.closeSession(s);
  }

  async close() {
    await Promise.all([...this.sessions.values()].map((s) => this.closeSession(s)));
  }

  private async closeSession(s: Session) {
    const id = s.transport.sessionId;
    if (id) this.sessions.delete(id);
    await s.server.close().catch((e) => this.o.log(`mcp session close failed: ${(e as Error).message}`));
  }
}

function rpcError(res: ServerResponse, status: number, code: number, message: string) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }));
}
