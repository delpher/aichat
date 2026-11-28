import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startBroker, connect, nextMessage, tok } from "./helpers.js";
import { MCP_IDLE_MS, MCP_SESSIONS_PER_AGENT, type McpEndpoint } from "../broker/mcp.js";

/** An MCP client of the broker's /mcp, as an agent runtime would connect with its token. */
async function mcpClient(http: string, token: string) {
  const client = new Client({ name: "test-agent", version: "0.0.1" });
  const transport = new StreamableHTTPClientTransport(new URL(`${http}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  return { client, transport };
}

const textOf = (r: unknown) => ((r as { content: { text: string }[] }).content ?? []).map((c) => c.text).join("\n");

/** One raw JSON-RPC POST to /mcp, for what an SDK client would not send. */
function rpc(http: string, token: string | undefined, body: unknown, sid?: string) {
  return fetch(`${http}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(sid ? { "mcp-session-id": sid } : {}),
    },
    body: JSON.stringify(body),
  });
}
const INIT = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "0" } },
};

test("mcp: an agent lists the broker's tools and the catalog shows the same ones", async () => {
  const { broker, http } = await startBroker([{ name: "a" }, { name: "boss", kind: "human", admin: true }]);
  const { client } = await mcpClient(http, tok("a"));
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name), [
    "send_message", "read_history", "react", "thank", "list_agents", "set_status",
    "join_room", "leave_room", "room_info", "set_room_brief", "remember", "recall", "forget",
    "list_games", "create_game", "join_game", "world_info",
  ]);
  assert.match(tools[0].description ?? "", /reply_to/);

  for (const [path, token] of [["/api/tools", tok("a")], ["/admin/api/tools", tok("boss")]]) {
    const r = await fetch(`${http}${path}`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(r.status, 200, path);
    const { tools: catalog } = (await r.json()) as { tools: { name: string; group: string; description: string; inputSchema: unknown }[] };
    assert.deepEqual(
      catalog.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      `${path} shows the tools as agents see them`,
    );
    assert.deepEqual([...new Set(catalog.map((t) => t.group))], ["chat", "rooms", "notes", "games", "world"]);
  }
  await client.close();
  await broker.close();
});

test("mcp: a missing or wrong token is refused before any session", async () => {
  const { broker, http } = await startBroker([{ name: "a" }]);
  for (const token of [undefined, "wrong-token-xxxxxxxxxxxxxx"]) {
    const r = await rpc(http, token, INIT);
    assert.equal(r.status, 401);
    assert.match(r.headers.get("www-authenticate") ?? "", /Bearer/);
  }
  await broker.close();
});

test("mcp: send_message and read_history act as the token's participant, with the broker's checks", async () => {
  const { broker, url, http } = await startBroker([{ name: "a", rooms: ["lab"] }, { name: "b", rooms: ["lab"] }, { name: "c" }]);
  const b = await connect(url, "b");
  const { client } = await mcpClient(http, tok("a"));

  const got = nextMessage(b);
  const sent = await client.callTool({ name: "send_message", arguments: { room: "lab", text: "hello from MCP" } });
  const id = Number(/msg_id (\d+)/.exec(textOf(sent))?.[1]);
  const m = await got;
  assert.equal(m.id, id);
  assert.equal(m.from, "a", "the sender is the token's participant, not an argument");

  const reply = await client.callTool({ name: "send_message", arguments: { to: "b", text: "a reply", reply_to: id } });
  assert.ok(!reply.isError, textOf(reply));
  const history = await client.callTool({ name: "read_history", arguments: { room: "lab" } });
  assert.match(textOf(history), new RegExp(`\\[#${id} .*\\] a -> #lab: hello from MCP`));

  // c is not in #lab: the broker refuses, and the model reads why
  const { client: cc } = await mcpClient(http, tok("c"));
  const denied = await cc.callTool({ name: "read_history", arguments: { room: "lab" } });
  assert.equal(denied.isError, true);
  assert.match(textOf(denied), /not in room lab/);
  const none = await cc.callTool({ name: "no_such_tool", arguments: {} });
  assert.equal(none.isError, true);

  b.close();
  await Promise.all([client.close(), cc.close()]);
  await broker.close();
});

test("send: a repeat with the same request_id posts once, over MCP and over REST", async () => {
  const { broker, url, http } = await startBroker([{ name: "a", rooms: ["lab"] }, { name: "b", rooms: ["lab"] }]);
  const b = await connect(url, "b");
  const seen: number[] = [];
  b.on("message", (m: { id: number }) => seen.push(m.id));
  const { client } = await mcpClient(http, tok("a"));

  const args = { room: "lab", text: "once", request_id: "intent-1" };
  const first = textOf(await client.callTool({ name: "send_message", arguments: args }));
  const again = textOf(await client.callTool({ name: "send_message", arguments: args }));
  assert.equal(again, first, "the retry gets the first send's msg_id");

  const reused = await client.callTool({ name: "send_message", arguments: { ...args, text: "something else" } });
  assert.equal(reused.isError, true);
  assert.match(textOf(reused), /already used for a different message/);
  const bad = await client.callTool({ name: "send_message", arguments: { ...args, request_id: "no spaces allowed" } });
  assert.equal(bad.isError, true);

  // REST takes the same key: the logic is the broker's, not the endpoint's
  const post = (text: string) =>
    fetch(`${http}/api/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${tok("a")}`, "content-type": "application/json" },
      body: JSON.stringify({ room: "lab", text, request_id: "intent-2" }),
    });
  const r1 = (await (await post("rest once")).json()) as { message: { id: number } };
  const r2 = (await (await post("rest once")).json()) as { message: { id: number } };
  assert.equal(r2.message.id, r1.message.id);
  assert.equal((await post("rest changed")).status, 409);

  await new Promise((r) => setTimeout(r, 200));
  assert.equal(seen.length, 2, "b got each message once");
  b.close();
  await client.close();
  await broker.close();
});

test("mcp: sessions belong to their participant; an unknown one is served without a session, a changed token is 401", async () => {
  const { broker, http, replaceConfig } = await startBroker([{ name: "a" }, { name: "b" }]);
  const r = await rpc(http, tok("a"), INIT);
  assert.equal(r.status, 200);
  const sid = r.headers.get("mcp-session-id")!;
  assert.ok(sid);
  await r.body?.cancel();
  const mcp = (broker as unknown as { mcp: McpEndpoint }).mcp;
  const whoAmI = { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "send_message", arguments: { room: "dev", text: "who?" } } };

  // b with a's session id is b all the same: who calls is the token, never the session id
  const asB = await rpc(http, tok("b"), whoAmI, sid);
  assert.equal(asB.status, 200);
  assert.equal(asB.headers.get("mcp-session-id"), null, "no session is made for it");
  await asB.text();
  assert.equal(broker.history("b", { room: "dev" }).at(-1)?.from, "b");
  assert.equal(mcp.statelessServed, 1);
  // a session the broker never had is served the same way; with no session there is no stream (GET 405)
  const unknown = "0f0e0d0c-0000-4000-8000-000000000000";
  const list = { jsonrpc: "2.0", id: 3, method: "tools/list", params: {} };
  const l = await rpc(http, tok("a"), list, unknown);
  assert.equal(l.status, 200);
  assert.match(await l.text(), /send_message/);
  const get = await fetch(`${http}/mcp`, { headers: { authorization: `Bearer ${tok("a")}`, accept: "text/event-stream", "mcp-session-id": unknown } });
  assert.equal(get.status, 405);
  await get.body?.cancel();

  // a's token changes in agents.json: the open session stops at the next request
  replaceConfig((raw) => {
    raw.agents.find((x) => x.name === "a")!.token = "a-new-token-xxxxxxxxxxxxx";
  });
  assert.equal((await rpc(http, tok("a"), list, sid)).status, 401);
  await broker.close();
});

// agy, OpenCode and Codex do not open a new session after 404 (AIChat 4001-4006). The client below initialized once
// and is never told to again: it must go on calling tools after the broker forgot its session (codex-alexey, 4005).
test("mcp: a client whose session the broker forgot (idle, restart) goes on without initializing again", async () => {
  const { broker, http } = await startBroker([{ name: "a" }]);
  const mcp = (broker as unknown as { mcp: McpEndpoint }).mcp;
  const { client, transport } = await mcpClient(http, tok("a"));
  const sid = transport.sessionId;
  assert.ok(sid);
  assert.equal(mcp.size, 1);
  assert.match(textOf(await client.callTool({ name: "send_message", arguments: { room: "dev", text: "before" } })), /sent/);

  // the broker restarts (its sessions are in memory) ...
  await mcp.close();
  assert.equal(mcp.size, 0);
  // ... and the same client, with its old session id, carries on
  const after = await client.callTool({ name: "send_message", arguments: { room: "dev", text: "after a restart" } });
  assert.ok(!after.isError, textOf(after));
  assert.equal(transport.sessionId, sid, "the client did not get or need a new session");
  assert.equal(broker.history("a", { room: "dev" }).at(-1)?.text, "after a restart");
  assert.equal((await client.listTools()).tools.length, 17);

  // the same after the idle sweep (a computer asleep for longer than MCP_IDLE_MS)
  const { client: sleeper } = await mcpClient(http, tok("a"));
  mcp.sweep(Date.now() + MCP_IDLE_MS + 1000);
  await new Promise((r) => setTimeout(r, 20));
  const woke = await sleeper.callTool({ name: "read_history", arguments: { room: "dev", limit: 1 } });
  assert.match(textOf(woke), /after a restart/);
  assert.equal(mcp.size, 0, "serving them made no sessions");
  await client.close();
  await sleeper.close();
  await broker.close();
});

test("mcp: each participant has at most MCP_SESSIONS_PER_AGENT sessions; the oldest closes first", async () => {
  const { broker, http } = await startBroker([{ name: "a" }]);
  const sids: string[] = [];
  for (let i = 0; i <= MCP_SESSIONS_PER_AGENT; i++) {
    const r = await rpc(http, tok("a"), INIT);
    sids.push(r.headers.get("mcp-session-id")!);
    await r.body?.cancel();
  }
  const list = { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} };
  await new Promise((r) => setTimeout(r, 50));
  const mcp = (broker as unknown as { mcp: McpEndpoint }).mcp;
  assert.equal(mcp.size, MCP_SESSIONS_PER_AGENT, "the oldest session was closed");
  const oldest = await rpc(http, tok("a"), list, sids[0]);
  assert.equal(oldest.status, 200, "and its client is still served, without a session");
  await oldest.body?.cancel();
  const newest = await rpc(http, tok("a"), list, sids.at(-1));
  assert.equal(newest.status, 200);
  await newest.body?.cancel();
  await broker.close();
});

test("mcp: notebook, reactions, rooms, status and intro tools act as the caller, with the broker's checks", async () => {
  const { broker, url, http } = await startBroker([{ name: "a", rooms: ["lab"] }, { name: "b", rooms: ["lab"] }, { name: "c" }]);
  const b = await connect(url, "b");
  const { client: a } = await mcpClient(http, tok("a"));
  const { client: c } = await mcpClient(http, tok("c"));
  const call = async (client: Client, name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args });
    return { error: r.isError === true, text: textOf(r) };
  };

  // notebook: a's own, invisible to c
  const saved = await call(a, "remember", { title: "Lab rules", description: "Short answers in #lab.", topic: "lab" });
  assert.match(saved.text, /^remembered #(\d+) \[lab\] Lab rules/);
  const id = Number(/#(\d+)/.exec(saved.text)![1]);
  assert.match((await call(a, "recall", { query: "short" })).text, /^1 of 1 notes .*\n#\d+ \[lab\] Lab rules/s);
  assert.match((await call(a, "remember", { id, description: "Very short answers in #lab." })).text, /^changed/);
  assert.match((await call(a, "recall", { id })).text, /Very short answers/);
  assert.equal((await call(c, "recall", { id })).error, true, "another participant's note is unknown");
  assert.match((await call(a, "forget", { id })).text, /forgot note/);
  assert.match((await call(a, "recall")).text, /^0 of 0 notes/);

  // reactions and thanks on b's message; c does not see it
  const m = await b.send({ room: "lab", text: "a useful message" });
  assert.equal((await call(a, "react", { msg_id: m, emoji: "👍" })).text, `put 👍 on #${m} (reactions now: 👍 1)`);
  assert.match((await call(a, "react", { msg_id: m, emoji: "👍", remove: true })).text, /took back/);
  assert.match((await call(a, "thank", { msg_id: m })).text, /thanked by: a/);
  assert.equal((await call(c, "thank", { msg_id: m })).error, true);
  assert.equal((await call(a, "react", { msg_id: "x", emoji: "👍" })).error, true, "a non-id is refused before the broker");

  // rooms and briefs
  assert.match((await call(a, "set_room_brief", { room: "lab", text: "# Lab\nBe brief." })).text, /brief of #lab updated/);
  const joined = await call(c, "join_room", { room: "#lab" });
  assert.match(joined.text, /^joined #lab\n\n#lab\n\nBrief \(by a\):\n# Lab\nBe brief\.\n\nMembers: .*c/s);
  assert.match((await call(c, "room_info", { room: "lab" })).text, /Members: .*a.*b.*c/);
  assert.match((await call(c, "leave_room", { room: "lab" })).text, /left #lab/);
  assert.equal((await call(c, "room_info", { room: "lab" })).error, true, "a non-member does not read the brief");

  // status, the participant list, the intro
  assert.match((await call(a, "set_status", { topic: "mcp tools", room: "lab" })).text, /status: mcp tools in #lab/);
  assert.match((await call(a, "set_status", { topic: "" })).text, /status cleared/);
  assert.equal((await call(c, "set_status", { topic: "x", room: "lab" })).error, true, "c is no longer in #lab");
  assert.match((await call(a, "list_agents")).text, /^a \(you\) \[test\]/m);
  assert.match((await call(a, "world_info")).text, /^Intro version: [\s\S]*Limits now: a reply chain stops after 8 replies/);

  b.close();
  await Promise.all([a.close(), c.close()]);
  await broker.close();
});

test("mcp: games: list, create with an opponent or open, join; the broker's rules apply", async () => {
  const { broker, http } = await startBroker([{ name: "a" }, { name: "b" }, { name: "c" }]);
  const clients = await Promise.all(["a", "b", "c"].map((n) => mcpClient(http, tok(n))));
  const [a, b, c] = clients.map((x) => x.client);
  const call = async (client: Client, name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args });
    return { error: r.isError === true, text: textOf(r) };
  };

  const empty = await call(a, "list_games");
  assert.match(empty.text, /^Games you can play: .*checkers \(/);
  assert.match(empty.text, /no games yet$/);

  const vs = await call(a, "create_game", { game: "checkers", opponent: "b" });
  assert.match(vs.text, /^created #(\d+) checkers \[active\] .*a.*b.* - room game-\d+$/);
  const open = await call(c, "create_game", { game: "checkers" });
  assert.match(open.text, /^created #(\d+) checkers \[open\] .*\(free\)/);
  const openId = Number(/#(\d+)/.exec(open.text)![1]);

  assert.ok((await call(b, "list_games", { status: "open" })).text.includes(`#${openId} checkers [open]`));
  assert.match((await call(b, "join_game", { game_id: openId })).text, /^joined #\d+ checkers \[active\]/);
  assert.equal((await call(a, "join_game", { game_id: openId })).error, true, "a started game takes no one");
  assert.match((await call(a, "create_game", { game: "no-such-game" })).text, /^unknown game no-such-game; games: /);

  await Promise.all(clients.map((x) => x.client.close()));
  await broker.close();
});
