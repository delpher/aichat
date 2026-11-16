// Finds new AIChat releases on GitHub and installs them for the launcher (src/launcher.ts) to start.
// See src/updates/layout.ts for the files the two share, and README "Оновлення" for the user's side.
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, sep } from "node:path";
import { gunzipSync } from "node:zlib";
import type { BrokerConfig } from "./config.js";
import { VERSION } from "../version.js";
import {
  ENTRY,
  compareVersions,
  parseVersion,
  paths,
  readCurrent,
  readFailed,
  readPending,
  remove,
  satisfiesNode,
  writeAtomic,
  type Failed,
} from "../updates/layout.js";

export const DEFAULT_UPDATE_REPO = "delpher/aichat";
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
const FIRST_CHECK_MS = 60 * 1000;

/** release.json, written by .github/workflows/release.yml. */
export interface ReleaseManifest {
  schema: number;
  version: string;
  tag: string;
  prerelease?: boolean;
  node?: string;
  root: string;
  entry?: string;
  assets: { name: string; format: string; size: number; sha256: string }[];
}

interface GhAsset {
  name: string;
  url: string;
  size: number;
}
interface GhRelease {
  tag_name: string;
  name: string | null;
  body: string | null;
  html_url: string;
  published_at: string | null;
  prerelease: boolean;
  draft: boolean;
  assets: GhAsset[];
}

export interface LatestRelease {
  version: string;
  tag: string;
  name: string;
  notes: string;
  url: string;
  publishedAt: string | null;
  prerelease: boolean;
  /** Node.js range the release needs, and whether the running Node satisfies it. */
  node?: string;
  nodeOk: boolean;
  /** False when the release has no release.json or no .tar.gz to install. */
  installable: boolean;
}

export interface UpdateStatus {
  current: string;
  /** The broker runs under the launcher, so it can install updates itself. */
  launcher: boolean;
  docker: boolean;
  repo: string;
  hasToken: boolean;
  /** The token comes from AICHAT_UPDATE_TOKEN and cannot be changed from the web UI. */
  tokenFromEnv: boolean;
  prerelease: boolean;
  checking: boolean;
  installing: boolean;
  checkedAt: string | null;
  error: string | null;
  latest: LatestRelease | null;
  updateAvailable: boolean;
  /** The last update the launcher had to roll back. */
  failed: Failed | null;
}

export class UpdateError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

export interface UpdaterOptions {
  config: () => BrokerConfig;
  /** Folder with installed versions; set by the launcher (AICHAT_HOME). Without it updates can only be checked. */
  home?: string;
  version?: string;
  apiBase?: string;
  fetch?: typeof fetch;
  /** Stops the broker so the launcher starts the new version. */
  restart?: () => void | Promise<void>;
  log?: (msg: string) => void;
  /** Node.js version to check releases against (defaults to the running one). */
  node?: string;
}

export class Updater {
  readonly version: string;
  readonly home?: string;
  private apiBase: string;
  private fetch: typeof fetch;
  private log: (msg: string) => void;
  private checkedAt: string | null = null;
  private error: string | null = null;
  private latest: { info: LatestRelease; release: GhRelease; manifest?: ReleaseManifest } | null = null;
  private checking?: Promise<void>;
  private installing = false;
  private timers: NodeJS.Timeout[] = [];

  constructor(private opts: UpdaterOptions) {
    this.version = opts.version ?? VERSION;
    this.home = opts.home;
    this.apiBase = (opts.apiBase ?? "https://api.github.com").replace(/\/+$/, "");
    this.fetch = opts.fetch ?? fetch;
    this.log = opts.log ?? ((m) => console.error(`[update] ${m}`));
  }

  private settings() {
    const u = this.opts.config().updates ?? {};
    const envToken = process.env.AICHAT_UPDATE_TOKEN || undefined;
    return {
      repo: process.env.AICHAT_UPDATE_REPO || u.repo || DEFAULT_UPDATE_REPO,
      token: envToken ?? u.token,
      tokenFromEnv: !!envToken,
      prerelease: !!u.prerelease,
    };
  }

  status(): UpdateStatus {
    const s = this.settings();
    const latest = this.latest?.info ?? null;
    return {
      current: this.version,
      launcher: !!this.home,
      docker: existsSync("/.dockerenv"),
      repo: s.repo,
      hasToken: !!s.token,
      tokenFromEnv: s.tokenFromEnv,
      prerelease: s.prerelease,
      checking: !!this.checking,
      installing: this.installing,
      checkedAt: this.checkedAt,
      error: this.error,
      latest,
      updateAvailable: !!latest && compareVersions(latest.version, this.version) > 0,
      failed: this.home ? (readFailed(this.home) ?? null) : null,
    };
  }

  /** Checks once a minute after start and then every six hours. */
  start() {
    const run = () => void this.check();
    this.timers.push(setTimeout(run, FIRST_CHECK_MS).unref(), setInterval(run, CHECK_EVERY_MS).unref());
  }

  stop() {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }

  /** Forgets the last check, e.g. after the repository or token changed. */
  reset() {
    this.latest = null;
    this.checkedAt = null;
    this.error = null;
  }

  private async gh(path: string, accept = "application/vnd.github+json"): Promise<Response> {
    const { token } = this.settings();
    const headers: Record<string, string> = { Accept: accept, "User-Agent": "aichat-broker", "X-GitHub-Api-Version": "2022-11-28" };
    if (token) headers.Authorization = `Bearer ${token}`;
    let res: Response;
    try {
      res = await this.fetch(path.startsWith("http") ? path : `${this.apiBase}${path}`, { headers, redirect: "follow" });
    } catch (e) {
      throw new UpdateError(`GitHub is unreachable: ${(e as Error).message}`, 502);
    }
    if (res.ok) return res;
    if (res.status === 401) throw new UpdateError("GitHub rejected the token", 502);
    if (res.status === 403 || res.status === 429)
      throw new UpdateError(token ? "GitHub refused the request (rate limit or token without access)" : "GitHub rate limit reached; set a token", 502);
    if (res.status === 404)
      throw new UpdateError(
        token ? `GitHub: not found (does the token have access to ${this.settings().repo}?)` : "GitHub: not found (a private repository needs a token)",
        502,
      );
    throw new UpdateError(`GitHub answered HTTP ${res.status}`, 502);
  }

  /** Asks GitHub for the newest release. Concurrent calls share one request; a failure ends up in `error`. */
  check(): Promise<UpdateStatus> {
    this.checking ??= this.doCheck()
      .catch(() => {})
      .finally(() => (this.checking = undefined));
    return this.checking.then(() => this.status());
  }

  private async doCheck() {
    const { repo, prerelease } = this.settings();
    try {
      let releases: GhRelease[];
      if (prerelease) releases = (await (await this.gh(`/repos/${repo}/releases?per_page=30`)).json()) as GhRelease[];
      else {
        try {
          releases = [(await (await this.gh(`/repos/${repo}/releases/latest`)).json()) as GhRelease];
        } catch (e) {
          // /releases/latest is 404 both for a missing repository and for one without releases.
          if (!(e instanceof UpdateError) || !/not found/.test(e.message)) throw e;
          await this.gh(`/repos/${repo}`);
          releases = [];
        }
      }
      const best = releases
        .filter((r) => !r.draft && parseVersion(r.tag_name) && (prerelease || !r.prerelease))
        .sort((a, b) => compareVersions(b.tag_name, a.tag_name))[0];
      if (!best) {
        this.latest = null;
      } else {
        const manifestAsset = best.assets.find((a) => a.name === "release.json");
        let manifest: ReleaseManifest | undefined;
        if (manifestAsset) manifest = (await (await this.gh(manifestAsset.url, "application/octet-stream")).json()) as ReleaseManifest;
        const version = manifest?.version ?? best.tag_name.replace(/^v/, "");
        const tgz = manifest?.assets.find((a) => a.format === "tar.gz");
        this.latest = {
          release: best,
          manifest,
          info: {
            version,
            tag: best.tag_name,
            name: best.name || best.tag_name,
            notes: best.body ?? "",
            url: best.html_url,
            publishedAt: best.published_at,
            prerelease: best.prerelease,
            node: manifest?.node,
            nodeOk: satisfiesNode(manifest?.node, this.opts.node),
            installable: !!tgz && best.assets.some((a) => a.name === tgz.name),
          },
        };
      }
      this.error = null;
    } catch (e) {
      this.error = (e as Error).message;
      throw e;
    } finally {
      this.checkedAt = new Date().toISOString();
    }
  }

  /**
   * Downloads `version`, checks it against release.json, unpacks it into the versions folder, makes it
   * current and restarts the broker. Resolves before the restart, so the caller can still answer.
   */
  async install(version: string): Promise<{ version: string; restarting: boolean }> {
    const home = this.home;
    if (!home) throw new UpdateError("the broker was not started by the launcher (node dist/launcher.js), so it cannot update itself", 409);
    if (this.installing) throw new UpdateError("an update is already being installed", 409);
    this.installing = true;
    try {
      if (this.latest?.info.version !== version) {
        await this.check();
        if (this.error) throw new UpdateError(this.error, 502);
      }
      const latest = this.latest;
      if (!latest || latest.info.version !== version) throw new UpdateError(`version ${version} is not the latest release`, 409);
      if (compareVersions(version, this.version) <= 0) throw new UpdateError(`version ${version} is not newer than ${this.version}`, 409);
      const { manifest, release } = latest;
      if (!manifest) throw new UpdateError(`release ${release.tag_name} has no release.json`, 409);
      if (!latest.info.nodeOk)
        throw new UpdateError(`version ${version} needs Node.js ${manifest.node}, this broker runs on ${this.opts.node ?? process.versions.node}`, 409);
      const meta = manifest.assets.find((a) => a.format === "tar.gz");
      const asset = meta && release.assets.find((a) => a.name === meta.name);
      if (!meta || !asset) throw new UpdateError(`release ${release.tag_name} has no .tar.gz archive`, 409);

      this.log(`downloading ${asset.name}`);
      const data = Buffer.from(await (await this.gh(asset.url, "application/octet-stream")).arrayBuffer());
      const sum = createHash("sha256").update(data).digest("hex");
      if (sum !== meta.sha256) throw new UpdateError(`${asset.name}: checksum mismatch (expected ${meta.sha256}, got ${sum})`, 502);

      mkdirSync(home, { recursive: true });
      const tmp = join(home, `.tmp-${version}-${randomBytes(4).toString("hex")}`);
      try {
        extractTarGz(data, tmp);
        const root = join(tmp, manifest.root || "aichat");
        if (!existsSync(join(root, manifest.entry ?? ENTRY))) throw new UpdateError(`${asset.name} has no ${manifest.root}/${manifest.entry ?? ENTRY}`, 502);
        const target = paths(home).version(version);
        remove(target);
        renameSync(root, target);
      } finally {
        remove(tmp);
      }
      const p = paths(home);
      writeAtomic(p.pending, JSON.stringify({ version, previous: this.version, at: new Date().toISOString() }, null, 2) + "\n");
      writeAtomic(p.current, version + "\n");
      this.log(`installed ${version}; restarting`);
      const restart = this.opts.restart;
      if (restart) setTimeout(() => void restart(), 300);
      return { version, restarting: !!restart };
    } finally {
      this.installing = false;
    }
  }

  /**
   * Called once the broker is listening. Confirms a pending update to the launcher (so it is not rolled back)
   * and removes versions that are neither this one nor the one before it.
   */
  confirmStartup() {
    const home = this.home;
    if (!home) return;
    const pending = readPending(home);
    if (pending?.version !== this.version) return;
    const p = paths(home);
    remove(p.pending);
    remove(p.failed);
    this.log(`updated from ${pending.previous} to ${this.version}`);
    const keep = new Set([this.version, pending.previous, readCurrent(home)]);
    for (const name of readdirSync(home)) {
      if (name.startsWith(".tmp-") || (parseVersion(name) && !keep.has(name))) remove(join(home, name));
    }
  }

  /** Hides the notice about a rolled-back update. */
  dismissFailed() {
    if (this.home) remove(paths(this.home).failed);
  }
}

/**
 * Unpacks a .tar.gz into `dest`: regular files and folders only (symlinks such as node_modules/.bin are skipped).
 * Understands ustar, GNU long names and pax path headers, which is what `tar -czf` on the release runner writes.
 */
export function extractTarGz(gz: Buffer, dest: string) {
  const buf = gunzipSync(gz);
  const str = (o: number, n: number) => {
    const s = buf.subarray(o, o + n);
    const z = s.indexOf(0);
    return s.subarray(0, z < 0 ? n : z).toString("utf8");
  };
  const target = (name: string) => {
    const rel = normalize(name.replace(/\\/g, "/"));
    if (!rel || rel === "." || isAbsolute(rel) || rel.split(sep).includes("..") || /^[A-Za-z]:/.test(rel))
      throw new UpdateError(`unsafe path in archive: ${name}`, 502);
    return join(dest, rel);
  };
  mkdirSync(dest, { recursive: true });
  let off = 0;
  let longName: string | undefined;
  while (off + 512 <= buf.length) {
    if (buf.subarray(off, off + 512).every((b) => b === 0)) break;
    const size = parseInt(str(off + 124, 12).trim() || "0", 8);
    const type = String.fromCharCode(buf[off + 156] || 48);
    const prefix = str(off + 257, 6).startsWith("ustar") ? str(off + 345, 155) : "";
    let name = longName ?? (prefix ? `${prefix}/${str(off, 100)}` : str(off, 100));
    longName = undefined;
    const body = buf.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === "L") {
      longName = body.toString("utf8").replace(/\0+$/, "");
      continue;
    }
    if (type === "x") {
      const m = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(body.toString("utf8"));
      if (m) longName = m[1];
      continue;
    }
    if (type === "g") continue;
    name = name.replace(/^\.\//, "");
    if (!name || name === ".") continue;
    if (type === "5") mkdirSync(target(name), { recursive: true });
    else if (type === "0" || type === "7") {
      const file = target(name);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, body);
    }
  }
}
