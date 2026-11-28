// Tests of the adapters' shared file rules (core/files.mjs): one set for every adapter.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MAX_UPLOAD_BYTES, looksPrivate, mimeFor, nameFromDisposition, readUpload, safeFileName, saveDownload, within } from "./files.mjs";

/** A throwaway agent folder with an outbox, an attachments folder and a folder outside both. */
function sandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aichat-core-files-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dirs = { root, outbox: path.join(root, "agent", "outbox"), files: path.join(root, "files"), outside: path.join(root, "outside") };
  for (const d of [dirs.outbox, dirs.files, dirs.outside]) fs.mkdirSync(d, { recursive: true });
  const put = (dir, name, data = "hello") => {
    const f = path.join(dir, name);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, data);
    return f;
  };
  return { ...dirs, put, roots: [dirs.outbox, dirs.files] };
}

test("mimeFor: one table, by extension, case-insensitive, octet-stream otherwise", () => {
  assert.equal(mimeFor("shot.PNG"), "image/png");
  assert.equal(mimeFor("a.jpeg"), "image/jpeg");
  assert.equal(mimeFor("summary.md"), "text/markdown");
  assert.equal(mimeFor("notes.txt"), "text/plain");
  assert.equal(mimeFor("song.mp3"), "audio/mpeg");
  assert.equal(mimeFor("blob.bin"), "application/octet-stream");
  assert.equal(mimeFor("README"), "application/octet-stream");
  assert.equal(mimeFor(""), "application/octet-stream");
  // no prototype keys as extensions
  assert.equal(mimeFor("x.constructor"), "application/octet-stream");
  // no charset: the broker keeps only the type (cleanMime), so every adapter reports the same one (AIChat 3949)
  assert.ok(!mimeFor("a.txt").includes("charset"));
});

test("nameFromDisposition: RFC 5987 first, then the plain filename, else empty", () => {
  assert.equal(nameFromDisposition(`attachment; filename*=UTF-8''%D0%B7%D0%B2%D1%96%D1%82.txt`), "звіт.txt");
  assert.equal(nameFromDisposition(`inline; filename="a b.png"`), "a b.png");
  assert.equal(nameFromDisposition(`attachment; filename*=UTF-8''%E0%A4%A`), "%E0%A4%A");
  assert.equal(nameFromDisposition(null), "");
  assert.equal(nameFromDisposition("attachment"), "");
});

test("safeFileName: no folders, no characters Windows refuses", () => {
  assert.equal(safeFileName("../../etc/passwd", "x"), "passwd");
  assert.equal(safeFileName("..\\..\\boot.ini", "x"), "boot.ini");
  assert.equal(safeFileName('a<b>:c"|?*.txt', "x"), "a_b__c____.txt");
  assert.equal(safeFileName("..", "fallback"), "fallback");
  assert.equal(safeFileName("", "fallback"), "fallback");
});

test("within and looksPrivate", () => {
  const r = path.resolve("/a/b");
  assert.ok(within(r, path.join(r, "c")));
  assert.ok(within(r, r));
  assert.ok(!within(r, path.resolve("/a/bc")));
  assert.ok(!within(r, path.resolve("/a")));
  for (const p of [".env", ".env.local", "x/.secrets/a", "aichat-bot.token", "api_key.txt", "my-credentials.json", ".ssh/id", ".codex-aichat/auth.json"])
    assert.ok(looksPrivate(p), p);
  for (const p of ["report.md", "shot.png", "keyboard.txt", "monkeys.csv", "tokenizer.py"]) assert.ok(!looksPrivate(p), p);
});

test("readUpload: an ordinary file in the outbox or the attachments folder", (t) => {
  const s = sandbox(t);
  const f = s.put(s.outbox, "report.md", "# hi");
  assert.deepEqual(readUpload({ path: f, roots: s.roots }), { bytes: Buffer.from("# hi"), name: "report.md", mime: "text/markdown" });
  // relative to the agent's folder
  assert.equal(readUpload({ path: "outbox/report.md", base: path.dirname(s.outbox), roots: s.roots }).name, "report.md");
  const g = s.put(path.join(s.files, "sub"), "shot.png", "png");
  assert.equal(readUpload({ path: g, roots: s.roots }).mime, "image/png");
});

test("readUpload: refuses what is outside the roots, private, blocked, a folder or missing", (t) => {
  const s = sandbox(t);
  assert.throws(() => readUpload({ path: s.put(s.outside, "a.txt"), roots: s.roots }), /outside the upload folders .*outbox/);
  assert.throws(() => readUpload({ path: s.put(s.outbox, ".env"), roots: s.roots }), /private/);
  assert.throws(() => readUpload({ path: s.put(s.outbox, "aichat-bot.token"), roots: s.roots }), /private/);
  const blocked = path.join(s.outbox, "state");
  assert.throws(() => readUpload({ path: s.put(blocked, "x.json"), roots: s.roots, blocked: [blocked] }), /private/);
  assert.throws(() => readUpload({ path: s.outbox, roots: s.roots }), /outside the upload folders/);
  assert.throws(() => readUpload({ path: path.join(s.outbox, "sub"), roots: s.roots }), /no such file/);
  fs.mkdirSync(path.join(s.outbox, "dir"));
  assert.throws(() => readUpload({ path: path.join(s.outbox, "dir"), roots: s.roots }), /not a file/);
  assert.throws(() => readUpload({ path: path.join(s.outbox, "none.txt"), roots: s.roots }), /no such file/);
  assert.throws(() => readUpload({ path: "", roots: s.roots }), /path is required/);
  assert.throws(() => readUpload({ path: 42, roots: s.roots }), /path is required/);
});

test("readUpload: a hard link, even renamed, is refused (codex-alexey, 3947)", (t) => {
  const s = sandbox(t);
  const secret = s.put(s.outside, "notes.txt", "private");
  const link = path.join(s.outbox, "harmless.txt");
  fs.linkSync(secret, link);
  assert.throws(() => readUpload({ path: link, roots: s.roots }), /hard links/);
});

test("readUpload: a symlink from the outbox to a file outside is refused (codex-alexey, 3947)", (t) => {
  const s = sandbox(t);
  const target = s.put(s.outside, "data.txt", "outside");
  const link = path.join(s.outbox, "data.txt");
  try {
    fs.symlinkSync(target, link, "file");
  } catch (e) {
    return t.skip(`no symlinks here: ${e.code}`); // Windows without developer mode
  }
  assert.throws(() => readUpload({ path: link, roots: s.roots }), /outside the upload folders/);
});

test("readUpload: a file over the limit is refused", (t) => {
  const s = sandbox(t);
  const f = path.join(s.outbox, "big.bin");
  fs.writeFileSync(f, "");
  fs.truncateSync(f, MAX_UPLOAD_BYTES + 1);
  assert.throws(() => readUpload({ path: f, roots: s.roots }), /too large/);
});

test("saveDownload: <id>-<name> with the broker's name, else the fallback, else the id", (t) => {
  const s = sandbox(t);
  const a = saveDownload({ dir: s.files, id: "abc123", disposition: `attachment; filename*=UTF-8''..%2F..%2Fevil.txt`, bytes: Buffer.from("x") });
  assert.equal(a.name, "evil.txt");
  assert.equal(a.path, path.join(s.files, "abc123-evil.txt"));
  assert.equal(fs.readFileSync(a.path, "utf8"), "x");
  assert.equal(saveDownload({ dir: s.files, id: "abc123", disposition: null, fallback: "f.png", bytes: Buffer.from("") }).name, "f.png");
  assert.equal(saveDownload({ dir: s.files, id: "abc123", disposition: null, bytes: Buffer.from("") }).name, "abc123");
});
