import { test } from "node:test";
import assert from "node:assert/strict";
import { connect, nextMessage, startBroker, tok } from "./helpers.js";
import type { RoomBrief } from "../protocol.js";

const BOSS = { name: "boss", kind: "human", admin: true };

function api(http: string, who: string) {
  return async <T = Record<string, unknown>>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> => {
    const r = await fetch(`${http}${path}`, {
      method,
      headers: { authorization: `Bearer ${tok(who)}`, "content-type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: r.status, data: (await r.json()) as T };
  };
}

test("room brief: members read and write it, every change is announced to the room", async () => {
  const { broker, url, http } = await startBroker([
    { name: "olena", kind: "human", rooms: ["lab"] },
    { name: "bot", rooms: ["lab"] },
    { name: "outsider" },
    BOSS,
  ]);
  try {
    const olena = api(http, "olena");
    const bot = await connect(url, "bot");

    assert.deepEqual((await olena("GET", "/api/rooms/lab/brief")).data, { brief: null });
    const got = nextMessage(bot);
    let r = await olena<{ brief: RoomBrief }>("PUT", "/api/rooms/lab/brief", { text: "  Мета: зробити валідацію.\nbot пише код.  " });
    assert.equal(r.status, 200);
    assert.equal(r.data.brief.text, "Мета: зробити валідацію.\nbot пише код.");
    assert.equal(r.data.brief.by, "olena");
    const note = await got;
    assert.equal(note.from, "aichat");
    assert.equal(note.room, "lab");
    assert.match(note.text, /olena оновив бриф кімнати #lab:\n\nМета: зробити валідацію/);

    // the same text again changes nothing and announces nothing
    r = await olena("PUT", "/api/rooms/lab/brief", { text: "Мета: зробити валідацію.\nbot пише код." });
    assert.equal(r.status, 200);

    // outsiders may not; admins may; unknown and game rooms are refused
    const outsider = api(http, "outsider");
    assert.equal((await outsider("GET", "/api/rooms/lab/brief")).status, 403);
    assert.equal((await api(http, "boss")("GET", "/api/rooms/lab/brief")).status, 200);
    assert.equal((await olena("GET", "/api/rooms/nope/brief")).status, 404); // room names are public (all_rooms)
    assert.equal((await api(http, "boss")("GET", "/api/rooms/nope/brief")).status, 404);
    assert.equal((await olena("PUT", "/api/rooms/lab/brief", { text: "x".repeat(4001) })).status, 400);

    const cleared = nextMessage(bot);
    r = await olena("PUT", "/api/rooms/lab/brief", { text: "" });
    assert.deepEqual(r.data, { brief: null });
    assert.match((await cleared).text, /olena прибрав бриф/);
    bot.close();
  } finally {
    await broker.close();
  }
});

test("deleting a room with its messages also removes its brief", async () => {
  const { broker, http } = await startBroker([{ name: "olena", kind: "human", rooms: ["lab"] }, BOSS]);
  try {
    const boss = api(http, "boss");
    await boss("PUT", "/api/rooms/lab/brief", { text: "goal" });
    assert.equal((await boss("DELETE", "/admin/api/rooms/lab?messages=1")).status, 200);
    await boss("POST", "/admin/api/rooms", { name: "lab" });
    assert.deepEqual((await boss("GET", "/api/rooms/lab/brief")).data, { brief: null });
  } finally {
    await broker.close();
  }
});
