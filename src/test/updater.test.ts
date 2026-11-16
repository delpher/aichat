import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validate } from "../broker/config.js";
import { Updater } from "../broker/updater.js";
import { compareVersions, satisfiesNode } from "../updates/layout.js";
import { startBroker, tok } from "./helpers.js";

const tmp = () => mkdtempSync(join(tmpdir(), "aichat-upd-"));
const LONG = "node_modules/" + "a-rather-long-package-name/".repeat(5) + "index.js";

/** Builds aichat-<version>.tar.gz the way the release workflow does (tar -czf of an aichat/ folder). */
function buildArchive(version: string) {
  const dir = tmp();
  const root = join(dir, "aichat");
  mkdirSync(join(root, "dist", "broker"), { recursive: true });
  writeFileSync(join(root, "dist", "broker", "main.js"), "// broker\n");
  writeFileSync(join(root, "package.json"), JSON.stringify({ version }));
  mkdirSync(join(root, LONG, ".."), { recursive: true });
  writeFileSync(join(root, LONG), "module.exports = 1;\n");
  const file = join(dir, `aichat-${version}.tar.gz`);
  execFileSync("tar", ["-czf", file, "aichat"], { cwd: dir });
  return readFileSync(file);
}

/** A fake GitHub API with one release. */
async function fakeGitHub(opts: { version: string; archive: Buffer; sha256?: string; token?: string; node?: string }) {
  const name = `aichat-${opts.version}.tar.gz`;
  const manifest = {
    schema: 1,
    version: opts.version,
    tag: `v${opts.version}`,
    node: opts.node ?? ">=22.13",
    root: "aichat",
    entry: "dist/broker/main.js",
    assets: [{ name, format: "tar.gz", size: opts.archive.length, sha256: opts.sha256 ?? createHash("sha256").update(opts.archive).digest("hex") }],
  };
  const seen: string[] = [];
  let base = "";
  const server: Server = createServer((req, res) => {
    seen.push(`${req.url} ${req.headers.authorization ?? "-"}`);
    if (opts.token && req.headers.authorization !== `Bearer ${opts.token}`) return void res.writeHead(404).end("{}");
    const release = {
      tag_name: `v${opts.version}`,
      name: `AIChat ${opts.version}`,
      body: "## What's Changed\n* things",
      html_url: `https://github.com/o/r/releases/tag/v${opts.version}`,
      published_at: "2026-11-16T19:47:55Z",
      prerelease: false,
      draft: false,
      assets: [
        { name: "release.json", url: `${base}/assets/release.json`, size: 1 },
        { name, url: `${base}/assets/${name}`, size: opts.archive.length },
      ],
    };
    if (req.url === "/repos/o/r/releases/latest") return void res.writeHead(200).end(JSON.stringify(release));
    if (req.url?.startsWith("/repos/o/r/releases?")) return void res.writeHead(200).end(JSON.stringify([release]));
    if (req.url === "/assets/release.json") return void res.writeHead(200).end(JSON.stringify(manifest));
    if (req.url === `/assets/${name}`) return void res.writeHead(200).end(opts.archive);
    res.writeHead(404).end("{}");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { base, seen, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}

const cfgWith = (updates: Record<string, unknown> = {}) => validate({ agents: [], updates: { repo: "o/r", ...updates } });

test("versions compare by semver, prereleases first", () => {
  assert.ok(compareVersions("0.2.0", "0.1.9") > 0);
  assert.ok(compareVersions("0.10.0", "0.9.0") > 0);
  assert.ok(compareVersions("1.0.0-rc.1", "1.0.0") < 0);
  assert.ok(compareVersions("1.0.0-rc.10", "1.0.0-rc.2") > 0);
  assert.equal(compareVersions("v1.2.3", "1.2.3"), 0);
  assert.ok(satisfiesNode(">=22.13", "24.1.0"));
  assert.ok(!satisfiesNode(">=22.13", "22.12.0"));
  assert.ok(satisfiesNode(undefined, "18.0.0"));
});

test("check finds a newer release and its notes", async () => {
  const gh = await fakeGitHub({ version: "0.2.0", archive: buildArchive("0.2.0"), token: "secret-token" });
  const u = new Updater({ config: () => cfgWith({ token: "secret-token" }), version: "0.1.0", apiBase: gh.base, log: () => {} });
  const s = await u.check();
  assert.equal(s.error, null);
  assert.equal(s.updateAvailable, true);
  assert.equal(s.latest?.version, "0.2.0");
  assert.equal(s.latest?.installable, true);
  assert.match(s.latest!.notes, /What's Changed/);
  assert.equal(s.launcher, false);
  assert.ok(gh.seen.every((l) => l.endsWith("Bearer secret-token")));
  await gh.close();
});

test("check without a token on a private repository explains why", async () => {
  const gh = await fakeGitHub({ version: "0.2.0", archive: buildArchive("0.2.0"), token: "secret-token" });
  const u = new Updater({ config: () => cfgWith(), version: "0.1.0", apiBase: gh.base, log: () => {} });
  const s = await u.check();
  assert.match(s.error!, /private repository needs a token/);
  assert.equal(s.updateAvailable, false);
  await gh.close();
});

test("install unpacks the release, makes it current and restarts", async () => {
  const gh = await fakeGitHub({ version: "0.2.0", archive: buildArchive("0.2.0") });
  const home = tmp();
  let restarted = false;
  const u = new Updater({ config: () => cfgWith(), version: "0.1.0", home, apiBase: gh.base, log: () => {}, restart: () => void (restarted = true) });
  const r = await u.install("0.2.0");
  assert.deepEqual(r, { version: "0.2.0", restarting: true });
  assert.ok(existsSync(join(home, "0.2.0", "dist", "broker", "main.js")));
  assert.ok(existsSync(join(home, "0.2.0", LONG)), "GNU long names are unpacked");
  assert.equal(readFileSync(join(home, "current"), "utf8").trim(), "0.2.0");
  assert.deepEqual(
    (({ version, previous }) => ({ version, previous }))(JSON.parse(readFileSync(join(home, "pending.json"), "utf8"))),
    { version: "0.2.0", previous: "0.1.0" },
  );
  await new Promise((r) => setTimeout(r, 400));
  assert.ok(restarted);
  await gh.close();
});

test("install refuses an archive whose checksum does not match", async () => {
  const gh = await fakeGitHub({ version: "0.2.0", archive: buildArchive("0.2.0"), sha256: "0".repeat(64) });
  const home = tmp();
  const u = new Updater({ config: () => cfgWith(), version: "0.1.0", home, apiBase: gh.base, log: () => {} });
  await assert.rejects(u.install("0.2.0"), /checksum mismatch/);
  assert.ok(!existsSync(join(home, "current")));
  assert.ok(!existsSync(join(home, "0.2.0")));
  await gh.close();
});

test("install needs the launcher, a newer version and a suitable Node.js", async () => {
  const gh = await fakeGitHub({ version: "0.2.0", archive: buildArchive("0.2.0"), node: ">=99" });
  const noHome = new Updater({ config: () => cfgWith(), version: "0.1.0", apiBase: gh.base, log: () => {} });
  await assert.rejects(noHome.install("0.2.0"), /launcher/);
  const old = new Updater({ config: () => cfgWith(), version: "0.1.0", home: tmp(), apiBase: gh.base, log: () => {} });
  assert.equal((await old.check()).latest?.nodeOk, false);
  await assert.rejects(old.install("0.2.0"), /needs Node.js >=99/);
  const same = new Updater({ config: () => cfgWith(), version: "0.2.0", home: tmp(), apiBase: gh.base, log: () => {}, node: "99.0.0" });
  await assert.rejects(same.install("0.2.0"), /not newer/);
  await gh.close();
});

test("a confirmed start clears pending.json and old versions", () => {
  const home = tmp();
  for (const v of ["0.0.9", "0.1.0", "0.2.0"]) mkdirSync(join(home, v));
  mkdirSync(join(home, ".tmp-0.2.0-abcd"));
  writeFileSync(join(home, "current"), "0.2.0\n");
  writeFileSync(join(home, "pending.json"), JSON.stringify({ version: "0.2.0", previous: "0.1.0" }));
  writeFileSync(join(home, "failed.json"), JSON.stringify({ version: "0.1.5", previous: "0.1.0", reason: "x" }));
  new Updater({ config: () => cfgWith(), version: "0.2.0", home, log: () => {} }).confirmStartup();
  assert.ok(!existsSync(join(home, "pending.json")));
  assert.ok(!existsSync(join(home, "failed.json")));
  assert.ok(!existsSync(join(home, "0.0.9")));
  assert.ok(!existsSync(join(home, ".tmp-0.2.0-abcd")));
  assert.ok(existsSync(join(home, "0.1.0")) && existsSync(join(home, "0.2.0")));
});

test("admin API: status, update settings without exposing the token", async () => {
  const { broker, http, cfg } = await startBroker([{ name: "boss", kind: "human", admin: true }, { name: "bob" }]);
  const h = (n: string) => ({ authorization: `Bearer ${tok(n)}`, "content-type": "application/json" });
  let r = await fetch(`${http}/admin/api/update`, { headers: h("boss") });
  const s = await r.json();
  assert.equal(s.launcher, false);
  assert.equal(s.repo, "delpher/aichat");
  assert.equal(s.hasToken, false);
  r = await fetch(`${http}/admin/api/update`, { headers: h("bob") });
  assert.equal(r.status, 401);
  r = await fetch(`${http}/admin/api/update/settings`, { method: "PATCH", headers: h("boss"), body: JSON.stringify({ repo: "o/r", token: "ghp_abc", prerelease: true }) });
  const after = await r.json();
  assert.equal(r.status, 200);
  assert.equal(after.hasToken, true);
  assert.equal(after.repo, "o/r");
  assert.ok(!JSON.stringify(after).includes("ghp_abc"));
  assert.deepEqual(cfg().updates, { repo: "o/r", token: "ghp_abc", prerelease: true });
  r = await fetch(`${http}/admin/api/update/settings`, { method: "PATCH", headers: h("boss"), body: JSON.stringify({ token: "", prerelease: false }) });
  assert.deepEqual(cfg().updates, { repo: "o/r" });
  r = await fetch(`${http}/admin/api/update/settings`, { method: "PATCH", headers: h("boss"), body: JSON.stringify({ repo: "nope" }) });
  assert.equal(r.status, 400);
  r = await fetch(`${http}/admin/api/update/install`, { method: "POST", headers: h("boss"), body: JSON.stringify({ version: "9.9.9" }) });
  assert.equal(r.status, 409);
  assert.match((await r.json()).error, /launcher/);
  await broker.close();
});

// ---- launcher ----

const LAUNCHER = resolve(fileURLToPath(import.meta.url), "..", "..", "launcher.js");

/** Installs a fake version whose "broker" runs `code` (CommonJS) with `home` as a variable. */
function fakeVersion(home: string, version: string, code: string) {
  const dir = join(home, version, "dist", "broker");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "main.js"), `const home = process.env.AICHAT_HOME; const fs = require("fs"); const path = require("path");\n${code}\n`);
}
const mark = (name: string) => `fs.appendFileSync(path.join(home, "ran.log"), ${JSON.stringify(name)} + "\\n");`;

function runLauncher(home: string, env: Record<string, string> = {}) {
  return new Promise<number | null>((done) => {
    const p = spawn(process.execPath, [LAUNCHER], { env: { ...process.env, AICHAT_HOME: home, ...env }, stdio: "ignore" });
    p.on("exit", (code) => done(code));
  });
}
const ran = (home: string) => readFileSync(join(home, "ran.log"), "utf8").trim().split("\n");

test("launcher starts the new version after the broker asks for a restart", async () => {
  const home = tmp();
  fakeVersion(home, "8.0.0", `${mark("8")} fs.writeFileSync(path.join(home, "current"), "9.0.0"); process.exit(75);`);
  fakeVersion(home, "9.0.0", `${mark("9")} process.exit(0);`);
  writeFileSync(join(home, "current"), "8.0.0\n");
  assert.equal(await runLauncher(home), 0);
  assert.deepEqual(ran(home), ["8", "9"]);
});

test("launcher rolls back an update that crashes before confirming", async () => {
  const home = tmp();
  fakeVersion(home, "8.0.0", `${mark("8")} process.exit(0);`);
  fakeVersion(home, "9.0.0", `${mark("9")} process.exit(1);`);
  writeFileSync(join(home, "current"), "9.0.0\n");
  writeFileSync(join(home, "pending.json"), JSON.stringify({ version: "9.0.0", previous: "8.0.0" }));
  assert.equal(await runLauncher(home), 0);
  assert.deepEqual(ran(home), ["9", "8"]);
  assert.equal(readFileSync(join(home, "current"), "utf8").trim(), "8.0.0");
  const failed = JSON.parse(readFileSync(join(home, "failed.json"), "utf8"));
  assert.equal(failed.version, "9.0.0");
  assert.match(failed.reason, /code 1/);
  assert.ok(!existsSync(join(home, "pending.json")));
});

test("launcher rolls back an update that never confirms its start", async () => {
  const home = tmp();
  fakeVersion(home, "8.0.0", `${mark("8")} process.exit(0);`);
  fakeVersion(home, "9.0.0", `${mark("9")} setInterval(() => {}, 1000);`);
  writeFileSync(join(home, "current"), "9.0.0\n");
  writeFileSync(join(home, "pending.json"), JSON.stringify({ version: "9.0.0", previous: "8.0.0" }));
  assert.equal(await runLauncher(home, { AICHAT_CONFIRM_MS: "300" }), 0);
  assert.deepEqual(ran(home), ["9", "8"]);
  assert.match(JSON.parse(readFileSync(join(home, "failed.json"), "utf8")).reason, /did not start in time/);
});

test("launcher keeps a confirmed update", async () => {
  const home = tmp();
  fakeVersion(home, "9.0.0", `${mark("9")} fs.rmSync(path.join(home, "pending.json")); setTimeout(() => process.exit(0), 500);`);
  writeFileSync(join(home, "current"), "9.0.0\n");
  writeFileSync(join(home, "pending.json"), JSON.stringify({ version: "9.0.0", previous: "8.0.0" }));
  assert.equal(await runLauncher(home, { AICHAT_CONFIRM_MS: "200" }), 0);
  assert.deepEqual(ran(home), ["9"]);
  assert.ok(!existsSync(join(home, "failed.json")));
});
