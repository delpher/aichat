import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { BrokerClient } from "../client/broker-client.js";

/** A broker stand-in: welcomes every auth and lets the test decide what to do with other frames. */
async function fakeBroker(onFrame: (ws: WebSocket, f: Record<string, unknown>, n: number) => void = () => {}) {
  const http = createServer();
  const wss = new WebSocketServer({ server: http, path: "/ws" });
  let connections = 0;
  wss.on("connection", (ws) => {
    const n = ++connections;
    ws.on("message", (data) => {
      const f = JSON.parse(String(data));
      if (f.type === "auth") ws.send(JSON.stringify({ type: "welcome", agent: "bot", rooms: [], ref: f.ref }));
      else onFrame(ws, f, n);
    });
  });
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  const port = (http.address() as { port: number }).port;
  return {
    url: `ws://127.0.0.1:${port}`,
    connections: () => connections,
    close: async () => {
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      http.closeAllConnections();
      await new Promise((r) => http.close(r));
    },
  };
}

const until = async (ok: () => boolean, ms = 5000) => {
  for (const end = Date.now() + ms; !ok() && Date.now() < end; ) await new Promise((r) => setTimeout(r, 20));
  assert.ok(ok(), "timed out");
};

test("a connection the broker went silent on is replaced", async () => {
  // this broker never pings and never answers: the path to it looks dead
  const broker = await fakeBroker();
  const client = new BrokerClient({ url: broker.url, token: "t".repeat(20), staleMs: 300, log: () => {} });
  let connected = 0;
  client.on("connected", () => connected++);
  try {
    await client.connect();
    await until(() => connected >= 2);
    assert.ok(broker.connections() >= 2);
  } finally {
    client.close();
    await broker.close();
  }
});

test("a read is repeated once the connection is back; a send is not, and says why", async () => {
  // the first connection drops on any request; later ones answer
  const broker = await fakeBroker((ws, f, n) => {
    if (n === 1) return ws.terminate();
    if (f.type === "history") ws.send(JSON.stringify({ type: "history", messages: [], ref: f.ref }));
    if (f.type === "send") ws.terminate();
  });
  const client = new BrokerClient({ url: broker.url, token: "t".repeat(20), log: () => {} });
  try {
    await client.connect();
    assert.deepEqual(await client.history({ room: "lobby" }), []);
    assert.equal(broker.connections(), 2);

    await assert.rejects(client.send({ room: "lobby", text: "hi" }), /dropped before it confirmed this; .*check read_history before sending it again/);
  } finally {
    client.close();
    await broker.close();
  }
});
