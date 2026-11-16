import { test } from "node:test";
import assert from "node:assert/strict";
import { connect, startBroker, tok } from "./helpers.js";
import type { ChatMessage } from "../protocol.js";

const BOSS = { name: "boss", kind: "human", admin: true };

test("search: any case and script, only what the viewer may read; admins search rooms and their own DMs", async () => {
  const { broker, url, http } = await startBroker([
    { name: "olena", kind: "human", rooms: ["lab"] },
    { name: "bot", rooms: ["lab", "secret"] },
    { name: "c" },
    BOSS,
  ]);
  try {
    const bot = await connect(url, "bot");
    const c = await connect(url, "c");
    await bot.send({ room: "lab", text: "Валідатор ГОТОВИЙ до рев'ю" });
    await bot.send({ room: "secret", text: "валідатор у секретній кімнаті" });
    await bot.send({ to: "olena", text: "Твій валідатор теж" });
    await bot.send({ to: "c", text: "валідатор для c" });
    await c.send({ room: "lab", text: "nothing to see" });
    await bot.send({ to: "boss", text: "валідатор для boss" });

    const get = async (who: string, path: string) => {
      const r = await fetch(`${http}${path}`, { headers: { authorization: `Bearer ${tok(who)}` } });
      return { status: r.status, messages: ((await r.json()) as { messages: ChatMessage[] }).messages };
    };
    let r = await get("olena", "/api/search?q=" + encodeURIComponent("ВАЛІДАТОР"));
    assert.equal(r.status, 200);
    assert.deepEqual(r.messages.map((m) => m.text), ["Твій валідатор теж", "Валідатор ГОТОВИЙ до рев'ю"]); // newest first
    r = await get("olena", "/api/search?q=" + encodeURIComponent("готовий") + "&room=lab");
    assert.equal(r.messages.length, 1);

    r = await get("boss", "/admin/api/search?q=" + encodeURIComponent("валідатор"));
    assert.deepEqual(r.messages.map((m) => m.text), [
      "валідатор для boss",
      "валідатор у секретній кімнаті",
      "Валідатор ГОТОВИЙ до рев'ю",
    ]); // other people's DMs are not searched
    r = await get("boss", "/admin/api/search?q=" + encodeURIComponent("валідатор") + "&agent=c");
    assert.deepEqual(r.messages.map((m) => m.text), []);

    assert.equal((await get("olena", "/api/search?q=a")).status, 400);
    assert.equal((await get("olena", "/admin/api/search?q=abc")).status, 401);

    // the admin history can be narrowed to one participant
    r = await get("boss", "/admin/api/messages?agent=c");
    assert.deepEqual(r.messages.map((m) => m.text), ["nothing to see"]);
    bot.close();
    c.close();
  } finally {
    await broker.close();
  }
});
