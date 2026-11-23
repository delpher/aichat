// Short download links (issue #61): a browser or a download manager such as Chrono cannot send the bearer token, so
// the web asks for a link that carries its own proof and works for a few minutes.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { FileInfo } from "../protocol.js";
import { roomMarkdown, stamp } from "../room-export.js";
import { connect, startBroker, tok } from "./helpers.js";

const BOSS = { name: "boss", kind: "human", admin: true };
const auth = (name: string) => ({ authorization: `Bearer ${tok(name)}`, "content-type": "application/json" });

test("a file's download link opens it without a token, only that file and only for five minutes", async (t) => {
  let now = Date.parse("2026-11-20T12:00:00Z");
  const { broker, url, http } = await startBroker([{ name: "a", rooms: ["team"] }, { name: "b", rooms: ["team"] }, { name: "c" }, BOSS], {}, { now: () => now });
  const up = await fetch(`${http}/api/files`, {
    method: "POST",
    headers: { authorization: `Bearer ${tok("a")}`, "content-type": "image/png", "x-filename": encodeURIComponent("план.png") },
    body: new Uint8Array([137, 80, 78, 71]),
  });
  const f = ((await up.json()) as { file: FileInfo }).file;
  const a = await connect(url, "a");
  // also when an assertion fails: an open broker keeps the test run waiting for ever
  t.after(async () => {
    a.close();
    await broker.close();
  });
  await a.send({ room: "team", text: "ось", attachments: [f.id] });

  const link = (who: string, admin = false) => fetch(`${http}/${admin ? "admin/api" : "api"}/files/${f.id}/link`, { method: "POST", headers: auth(who) });
  // only someone who may read the file gets a link
  assert.equal((await link("c")).status, 404);
  const r = await link("b");
  assert.equal(r.status, 200);
  const { url: path, expires } = (await r.json()) as { url: string; expires: string };
  assert.match(path, new RegExp(`^/dl/files/${f.id}\\?exp=\\d+&sig=`));
  assert.equal(expires, new Date(now + 5 * 60_000).toISOString());

  // no token needed, and even an image comes as a file to save
  let dl = await fetch(`${http}${path}`);
  assert.equal(dl.status, 200);
  assert.deepEqual([...new Uint8Array(await dl.arrayBuffer())], [137, 80, 78, 71]);
  assert.equal(dl.headers.get("content-type"), "application/octet-stream");
  assert.match(dl.headers.get("content-disposition") ?? "", /^attachment; filename\*=UTF-8''%D0%BF/);

  // a link for one file does not open another, and a changed signature opens nothing
  assert.equal((await fetch(`${http}${path.replace(f.id, "x".repeat(f.id.length))}`)).status, 403);
  // (a different first character: "Z" was the signature's own one time in 64, and the test failed)
  const tampered = path.replace(/sig=(.)/, (_, c: string) => `sig=${c === "A" ? "B" : "A"}`);
  assert.notEqual(tampered, path);
  assert.equal((await fetch(`${http}${tampered}`)).status, 403);
  // the admin API gives links too
  assert.equal((await link("boss", true)).status, 200);
  // after five minutes the link is dead
  now += 5 * 60_000 + 1;
  dl = await fetch(`${http}${path}`);
  assert.equal(dl.status, 403);
});

test("a room's export link gives its whole conversation as a Markdown file in the viewer's time zone", async (t) => {
  let now = Date.parse("2026-11-20T12:05:00Z");
  const { broker, url, http } = await startBroker([{ name: "a", rooms: ["team"] }, { name: "c" }, BOSS], {}, { now: () => now });
  const a = await connect(url, "a");
  t.after(async () => {
    a.close();
    await broker.close();
  });
  for (let i = 1; i <= 3; i++) await a.send({ room: "team", text: `крок ${i}` });

  const exp = (who: string, room: string, tz: string, admin = false) =>
    fetch(`${http}/${admin ? "admin/api" : "api"}/rooms/${room}/export?tz=${encodeURIComponent(tz)}`, { method: "POST", headers: auth(who) });
  assert.equal((await exp("c", "team", "Europe/Kyiv")).status, 403); // not a member
  assert.equal((await exp("boss", "nope", "UTC", true)).status, 404);
  const r = await exp("a", "team", "Europe/Kyiv");
  assert.equal(r.status, 200);
  const { url: path } = (await r.json()) as { url: string };
  assert.match(path, /^\/dl\/rooms\/team\?tz=Europe%2FKyiv&exp=\d+&sig=/);

  const dl = await fetch(`${http}${path}`);
  assert.equal(dl.status, 200);
  assert.match(dl.headers.get("content-type") ?? "", /^text\/markdown/);
  assert.equal(dl.headers.get("content-disposition"), "attachment; filename*=UTF-8''aichat-team-2026-11-20-1405.md");
  const md = await dl.text();
  assert.ok(md.startsWith("# #team\n\nЕкспортовано з AIChat 2026-11-20 14:05 · повідомлень: 3"));
  assert.ok(md.indexOf("крок 1") < md.indexOf("крок 3"));
  // the time zone is part of what the link signs
  assert.equal((await fetch(`${http}${path.replace("Europe%2FKyiv", "UTC")}`)).status, 403);
  // an unknown time zone falls back to UTC
  const utc = (await (await exp("boss", "team", "Mars/Olympus", true)).json()) as { url: string };
  assert.match(utc.url, /tz=UTC/);
  now += 6 * 60_000;
  assert.equal((await fetch(`${http}${path}`)).status, 403);
});

test("the export file lists the brief and every message with its author, time, number, reply and files", () => {
  const md = roomMarkdown(
    "lobby",
    [
      { id: 1, from: "olena", room: "lobby", text: "Привіт **всім**", ts: "2026-11-20T10:05:00Z", hops: 0 },
      { id: 2, from: "claude", room: "lobby", text: "", ts: "2026-11-20T10:06:00Z", hops: 1, reply_to: 1, attachments: [{ id: "f1", name: "plan.png", mime: "image/png", size: 2048 }] },
    ],
    { room: "lobby", text: "Мета: тест.", by: "alexey", ts: "2026-11-19T09:00:00Z" },
    new Date("2026-11-20T12:05:00Z"),
    "Europe/Kyiv",
  );
  assert.ok(md.includes("## Бриф\n\nМета: тест.\n\n_alexey, 2026-11-19 11:00_"));
  assert.ok(md.includes("**olena** · 2026-11-20 12:05 · #1\n\nПривіт **всім**"));
  assert.ok(md.includes("**claude** · 2026-11-20 12:06 · #2 · у відповідь на #1\n\n_(без тексту)_\n\n- 📎 plan.png (2 КБ, файл f1)"));
  assert.equal(stamp("2026-11-20T23:30:00Z", "Europe/Kyiv"), "2026-11-21 01:30");
  assert.ok(!roomMarkdown("x", [], null, new Date(), "UTC").includes("## Бриф"));
});
