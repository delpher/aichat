// The adapters' shared core: local files (AIChat 3944-3946). One rule for every adapter on what a file is called,
// what type it has and which files an agent may upload, so the copies can no longer drift apart.
// Plain JS with node:* imports only: the .mjs adapters and their tests import it as it is, the TS ones through
// files.d.mts, and scripts/bundle.mjs puts it into each adapter's single file.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** File types by extension (lowercase, without the dot). Anything else is application/octet-stream. */
export const MIME_TYPES = Object.freeze({
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  txt: "text/plain",
  log: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  jsonc: "application/json",
  html: "text/html",
  css: "text/css",
  js: "text/javascript",
  mjs: "text/javascript",
  cjs: "text/javascript",
  ts: "text/plain",
  zip: "application/zip",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  wav: "audio/wav",
  mp4: "video/mp4",
});

/** The type of a file by its name's extension, case-insensitive. */
export function mimeFor(name) {
  const ext = /\.([a-z0-9]+)$/.exec(String(name ?? "").toLowerCase())?.[1] ?? "";
  return Object.hasOwn(MIME_TYPES, ext) ? MIME_TYPES[ext] : "application/octet-stream";
}

/** The file name a Content-Disposition header gives (RFC 5987 filename*=UTF-8''..., else filename="..."), or "". */
export function nameFromDisposition(header) {
  if (!header) return "";
  const star = /filename\*=(?:UTF-8'')?([^;]+)/i.exec(header)?.[1];
  const plain = /filename="?([^";]+)"?/i.exec(header)?.[1];
  const raw = (star ?? plain ?? "").trim();
  if (!raw) return "";
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** A name safe to write on any disk: no folders, no characters Windows refuses; `fallback` when nothing is left. */
export function safeFileName(name, fallback) {
  const base = path
    .basename(String(name ?? "").replace(/\\/g, "/"))
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .trim();
  return base && base !== "." && base !== ".." ? base : fallback;
}

/** Is `file` the folder `root` or inside it (paths compared as they are, without resolving links)? */
export function within(root, file) {
  const rel = path.relative(root, file);
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel));
}

/** The largest file an agent uploads (the broker's own limit is not lower). */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

/**
 * Does a path look private: a profile or secrets folder (.env*, .secrets, .ssh, .aichat, .codex*, .claude*, .gemini,
 * auth.json*) or a name with token / secret / key / creds / password in it?
 */
export function looksPrivate(file) {
  return String(file)
    .split(/[\\/]/)
    .some(
      (part) =>
        /^(\.env.*|\.secrets|\.ssh|\.aichat|\.gemini|\.codex(?:-.*)?|\.claude(?:-.*)?|auth\.json(?:\..*)?)$/i.test(part) ||
        /(^|[._-])(token|tokens|secret|secrets|key|keys|creds|credentials|password|passwd)([._-]|$)/i.test(part),
    );
}

/** `~`, `~/...` and relative paths made absolute (relative to `base`). */
export function expandPath(value, base = process.cwd()) {
  let v = String(value);
  if (v === "~" || v.startsWith("~/") || v.startsWith("~\\")) v = path.join(os.homedir(), v.slice(2));
  return path.resolve(base, v);
}

const real = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};

/**
 * Checks a file an agent wants to upload and reads it. The rule every adapter shares:
 * - the file, once links are resolved, is inside one of `roots` (the adapter's outbox, its attachments folder, ...),
 *   and not a root itself;
 * - neither the path asked for nor the real one looks private (looksPrivate), and neither is inside `blocked`
 *   (the agent's profile, the adapter's state, the token file);
 * - it is a regular file without other hard links, at most MAX_UPLOAD_BYTES, and still the same file when it is read.
 * Throws an Error with a message for the agent; returns the bytes, the file's name and its type.
 */
export function readUpload({ path: requested, base = process.cwd(), roots, blocked = [] }) {
  if (typeof requested !== "string" || !requested) throw new Error("path is required");
  const asked = expandPath(requested, base);
  let file;
  try {
    file = fs.realpathSync(asked);
  } catch {
    throw new Error(`no such file: ${requested}`);
  }
  const blockedReal = blocked.filter(Boolean).map(real);
  if ([asked, file].some(looksPrivate) || blockedReal.some((b) => within(b, file) || within(b, asked)))
    throw new Error(`refusing to upload a private file (profile, token, secrets): ${requested}`);
  const rootsReal = roots.filter((r) => r && fs.existsSync(r)).map((r) => fs.realpathSync(r));
  if (!rootsReal.some((r) => within(r, file) && r !== file))
    throw new Error(`${requested} is outside the upload folders (${roots.join(", ")}): copy it to your outbox first`);
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw new Error(`not a file: ${requested}`);
  if (stat.nlink > 1) throw new Error(`refusing a file with other hard links: ${requested}`);
  if (stat.size > MAX_UPLOAD_BYTES) throw new Error(`too large: ${stat.size} bytes (at most ${MAX_UPLOAD_BYTES})`);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const now = fs.fstatSync(fd);
    if (now.ino !== stat.ino || now.dev !== stat.dev || now.nlink > 1 || now.size > MAX_UPLOAD_BYTES)
      throw new Error(`the file changed while it was checked: ${requested}`);
    const name = path.basename(file);
    return { bytes: fs.readFileSync(fd), name, mime: mimeFor(name) };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Saves a downloaded attachment as `<dir>/<id>-<name>` and returns that path. The name is the one the broker sent
 * (Content-Disposition), else `fallback`, else the id, made safe for the disk.
 */
export function saveDownload({ dir, id, disposition, fallback, bytes }) {
  const name = safeFileName(nameFromDisposition(disposition) || fallback || "", "") || safeFileName(id, "file");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${safeFileName(id, "file")}-${name}`);
  // The folder may be in a temp folder others can write to (/tmp): write a new owner-only file that cannot exist yet
  // ("wx": never through a link someone put there), then rename it over the name, which replaces a link itself rather
  // than writing where it points (antigravity-alexey's agy did so; AIChat 4007).
  const temp = path.join(dir, `.${crypto.randomUUID()}.part`);
  fs.writeFileSync(temp, bytes, { flag: "wx", mode: 0o600 });
  try {
    fs.renameSync(temp, file);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
  return { path: file, name };
}
