import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanFileName } from "../broker/broker.js";
import type { ChatMessage, FileInfo } from "../protocol.js";
import { connect, nextMessage, startBroker, tok } from "./helpers.js";

const ADMIN = "admin-token-xxxxxxxxxxxxxxxx";

function upload(http: string, token: string, body: string | Uint8Array, name = "notes.txt", type = "text/plain", path = "/api/files") {
  return fetch(`${http}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": type, "x-filename": encodeURIComponent(name) },
    body: body as unknown as BodyInit,
  });
}

async function uploaded(http: string, name: string, body: string | Uint8Array, file = "notes.txt", type = "text/plain") {
  const r = await upload(http, tok(name), body, file, type);
  assert.equal(r.status, 201);
  return ((await r.json()) as { file: FileInfo }).file;
}

const get = (http: string, token: string, id: string, admin = false) =>
  fetch(`${http}/${admin ? "admin/api" : "api"}/files/${id}`, { headers: { authorization: `Bearer ${token}` } });

test("upload, attach to a message, and download only where the message is visible", async () => {
  const { broker, url, http } = await startBroker([
    { name: "a", rooms: ["team"] },
    { name: "b", rooms: ["team"] },
    { name: "c" },
  ]);
  const f = await uploaded(http, "a", "hello file", "звіт 1.txt");
  assert.equal(f.name, "звіт 1.txt");
  assert.equal(f.mime, "text/plain");
  assert.equal(f.size, 10);

  // before it is attached only the uploader can download it
  assert.equal((await get(http, tok("a"), f.id)).status, 200);
  assert.equal((await get(http, tok("b"), f.id)).status, 404);

  const b = await connect(url, "b");
  const got = nextMessage(b);
  const r = await fetch(`${http}/api/messages`, {
    method: "POST",
    headers: { authorization: `Bearer ${tok("a")}`, "content-type": "application/json" },
    body: JSON.stringify({ room: "team", text: "", attachments: [f.id] }),
  });
  assert.equal(r.status, 201);
  const m: ChatMessage = await got;
  assert.deepEqual(m.attachments, [f]);
  assert.equal(m.text, "");

  const dl = await get(http, tok("b"), f.id);
  assert.equal(dl.status, 200);
  assert.equal(await dl.text(), "hello file");
  assert.equal(dl.headers.get("content-type"), "application/octet-stream");
  assert.match(dl.headers.get("content-disposition") ?? "", /^attachment; filename\*=UTF-8''%D0%B7/);
  assert.equal((await get(http, tok("c"), f.id)).status, 404);

  // history carries the attachments too
  const h = await fetch(`${http}/api/history?room=team`, { headers: { authorization: `Bearer ${tok("c")}` } });
  assert.equal(h.status, 403);
  const hb = await fetch(`${http}/api/history?room=team`, { headers: { authorization: `Bearer ${tok("b")}` } });
  assert.deepEqual(((await hb.json()) as { messages: ChatMessage[] }).messages[0].attachments, [f]);

  // a file can be attached once, and only by its uploader
  const again = await b.send({ room: "team", text: "x", attachments: [f.id] }).catch((e: Error) => e.message);
  assert.match(String(again), /unknown file/);
  b.close();
  await broker.close();
});

test("images are served inline, other types never are; limits apply", async () => {
  const { broker, url, http } = await startBroker([{ name: "a" }, { name: "b" }], { maxFileSizeMB: 1 });
  const png = await uploaded(http, "a", new Uint8Array([137, 80, 78, 71]), "pic.png", "image/png");
  const html = await uploaded(http, "a", "<script>alert(1)</script>", "x.html", "text/html");
  const a = await connect(url, "a");
  await a.send({ to: "b", text: "look", attachments: [png.id, html.id] });
  let r = await get(http, tok("b"), png.id);
  assert.equal(r.headers.get("content-type"), "image/png");
  assert.match(r.headers.get("content-disposition") ?? "", /^inline/);
  assert.match(r.headers.get("content-security-policy") ?? "", /sandbox/);
  r = await get(http, tok("b"), html.id);
  assert.equal(r.headers.get("content-type"), "application/octet-stream");
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");

  assert.equal((await upload(http, tok("a"), new Uint8Array(1024 * 1024 + 1))).status, 413);
  assert.equal((await upload(http, tok("a"), "")).status, 400);
  assert.equal((await upload(http, "bad-token-xxxxxxxxxxxx", "x")).status, 401);
  const weird = await uploaded(http, "a", "x", "../../etc/pass\u0001wd", "not a mime");
  assert.equal(weird.name, "passwd");
  assert.equal(weird.mime, "application/octet-stream");

  const ids = Array.from({ length: 11 }, () => weird.id);
  const many = await Promise.all(Array.from({ length: 11 }, () => uploaded(http, "a", "y")));
  await assert.rejects(a.send({ to: "b", text: "t", attachments: many.map((f) => f.id) }), /at most 10/);
  // duplicates collapse to one
  const one = await a.send({ to: "b", text: "t", attachments: ids });
  assert.ok(one > 0);
  a.close();
  await broker.close();
});

test("admin uploads as a human and downloads any file; stale uploads are cleaned", async () => {
  const { broker, http } = await startBroker(
    [{ name: "me", kind: "human" }, { name: "bot" }],
    { adminToken: ADMIN },
  );
  const as = (path: string) => `/admin/api/files${path}`;
  let r = await upload(http, ADMIN, "from admin", "a.txt", "text/plain", as("?as=bot"));
  assert.equal(r.status, 403);
  r = await upload(http, ADMIN, "from admin", "a.txt", "text/plain", as("?as=me"));
  assert.equal(r.status, 201);
  const f = ((await r.json()) as { file: FileInfo }).file;
  r = await fetch(`${http}/admin/api/messages`, {
    method: "POST",
    headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
    body: JSON.stringify({ as: "me", to: "bot", text: "see file", attachments: [f.id] }),
  });
  assert.equal(r.status, 201);
  assert.equal((await get(http, ADMIN, f.id, true)).status, 200);
  assert.equal((await get(http, tok("bot"), f.id)).status, 200);

  const loose = await uploaded(http, "bot", "never sent");
  assert.equal(await broker.cleanFiles(), 0);
  assert.equal(await broker.cleanFiles(Date.now() + 25 * 60 * 60 * 1000), 1);
  assert.equal((await get(http, tok("bot"), loose.id)).status, 404);
  assert.equal((await get(http, tok("bot"), f.id)).status, 200);
  await broker.close();
});

test("cleanFileName strips paths and control characters", () => {
  assert.equal(cleanFileName("C:\\Users\\x\\photo.jpg"), "photo.jpg");
  assert.equal(cleanFileName(encodeURIComponent("фото.png")), "фото.png");
  assert.equal(cleanFileName(".."), "file");
  assert.equal(cleanFileName(undefined), "file");
  assert.equal(cleanFileName('a"b.txt'), "ab.txt");
});
