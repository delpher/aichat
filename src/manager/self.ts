// Stage 4a of the agent manager (AIChat #aichat-manager-dev, 3371-3378): the manager as one file the broker serves
// (/client/aichat-manager.mjs), installed with one command, and updating itself from the broker. Files of the manager
// live in <root>/.manager: the program, its settings (config.json: which broker) and the page key (key).
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { ADAPTER_VERSION, compareVersions } from "../adapters/version.js";

/** This manager's version: the broker's version it was built with (scripts/bundle.mjs), package.json in a checkout. */
export const MANAGER_VERSION = ADAPTER_VERSION;
export const MANAGER_FILE = "aichat-manager.mjs";

/** What the broker says about its client files (GET /client/manifest.json, written by scripts/bundle.mjs). */
export interface ClientManifest {
  version: string;
  files: Record<string, { sha256: string; size: number }>;
}

export interface ManagerConfig {
  /** The broker the manager was installed from and updates from (http origin). */
  broker?: string;
}

export const managerDir = (root: string) => join(root, ".manager");

export function readManagerConfig(root: string): ManagerConfig {
  try {
    return JSON.parse(readFileSync(join(managerDir(root), "config.json"), "utf8")) as ManagerConfig;
  } catch {
    return {};
  }
}

export const sha256 = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");

/** "http://host:port/anything" as "http://host:port"; null for anything else than http(s). */
export function brokerHttpOrigin(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (u.protocol === "ws:" || u.protocol === "wss:") u.protocol = u.protocol === "wss:" ? "https:" : "http:";
    return u.protocol === "http:" || u.protocol === "https:" ? u.origin : null;
  } catch {
    return null;
  }
}

/**
 * Makes `file` readable by its owner only (Windows ACL; mode 0600 elsewhere). The full path of icacls: under Git Bash
 * another tool of that name may come first in PATH.
 */
export function makePrivate(file: string): void {
  if (process.platform !== "win32") {
    // a file written earlier keeps its mode on rewrite: set it, not only on creation
    try {
      chmodSync(file, 0o600);
    } catch {
      // as below
    }
    return;
  }
  const icacls = join(process.env.SystemRoot || "C:\\Windows", "System32", "icacls.exe");
  const user = process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}` : process.env.USERNAME;
  if (!user) return;
  try {
    execFileSync(icacls, [file, "/inheritance:r", "/grant:r", `${user}:F`], { stdio: "ignore", windowsHide: true });
  } catch {
    // a file nobody else can reach is still the common case; the key only guards a loopback page
  }
}

/** The page key: kept in <root>/.manager/key so an open tab still works after the manager restarts or updates. */
export function pageKey(root: string): string {
  const file = join(managerDir(root), "key");
  try {
    const key = readFileSync(file, "utf8").trim();
    if (/^[0-9a-f]{32,}$/.test(key)) return key;
  } catch {
    // none yet
  }
  const key = randomBytes(16).toString("hex");
  try {
    mkdirSync(managerDir(root), { recursive: true });
    writeFileSync(file, key, { mode: 0o600 });
    makePrivate(file);
  } catch {
    // a key for this run only
  }
  return key;
}

export type Fetch = (url: string) => Promise<Buffer>;

export const fetchBytes: Fetch = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`${url}: ${res.status} ${res.statusText}`);
  return Buffer.from(await res.arrayBuffer());
};

export async function fetchManifest(broker: string, get: Fetch = fetchBytes): Promise<ClientManifest> {
  const m = JSON.parse((await get(`${broker}/client/manifest.json`)).toString("utf8")) as ClientManifest;
  if (typeof m?.version !== "string" || typeof m.files !== "object") throw new Error("брокер віддав незрозумілий manifest.json");
  return m;
}

/** The version written into a manager file by the bundler (`true ? "x.y.z"`). */
export function fileVersion(text: string): string | null {
  return /\btrue \? "(\d+\.\d+\.\d+[\w.-]*)"/.exec(text)?.[1] ?? null;
}

/** Checks a downloaded manager against the broker's manifest: its hash, and the version written in it. */
export function verifyManager(data: Buffer, manifest: ClientManifest): string {
  const entry = manifest.files[MANAGER_FILE];
  if (!entry) throw new Error(`у manifest.json брокера немає ${MANAGER_FILE}: брокер старший за менеджер?`);
  if (sha256(data) !== entry.sha256) throw new Error(`${MANAGER_FILE}: SHA-256 не збігається з manifest.json брокера`);
  const version = fileVersion(data.toString("utf8"));
  if (version !== manifest.version) throw new Error(`${MANAGER_FILE}: усередині версія ${version ?? "невідома"}, а брокер має ${manifest.version}`);
  return version;
}

/** The installed manager file, when this process runs from one (not from a checkout's dist/). */
export function installedFile(argv1 = process.argv[1] ?? ""): string | null {
  return basename(argv1) === MANAGER_FILE ? resolve(argv1) : null;
}

export interface UpdateInfo {
  version: string;
  broker: string | null;
  latest: string | null;
  updateAvailable: boolean;
  /** Runs from an installed file it can replace; false in a checkout. */
  canUpdate: boolean;
  error?: string;
}

export async function updateInfo(root: string, fallbackBroker: string | null, get: Fetch = fetchBytes, self = installedFile()): Promise<UpdateInfo> {
  const broker = readManagerConfig(root).broker ?? fallbackBroker;
  const info: UpdateInfo = { version: MANAGER_VERSION, broker, latest: null, updateAvailable: false, canUpdate: self !== null };
  if (!broker) return { ...info, error: "невідомо, з якого брокера оновлюватись" };
  try {
    const m = await fetchManifest(broker, get);
    info.latest = m.files[MANAGER_FILE] ? m.version : null;
    info.updateAvailable = info.latest !== null && compareVersions(info.latest, MANAGER_VERSION) > 0;
  } catch (e) {
    info.error = (e as Error).message;
  }
  return info;
}

/**
 * Downloads the broker's manager, checks it, keeps the running file as <file>.bak-<version> and puts the new one in
 * its place. The caller restarts the process; agents and .manager.json are not touched.
 */
export async function updateSelf(root: string, fallbackBroker: string | null, self: string | null, get: Fetch = fetchBytes): Promise<string> {
  if (!self) throw new Error("менеджер запущено не з встановленого файлу (наприклад, із клону): оновлюйте його через git");
  const broker = readManagerConfig(root).broker ?? fallbackBroker;
  if (!broker) throw new Error("невідомо, з якого брокера оновлюватись");
  const manifest = await fetchManifest(broker, get);
  const data = await get(`${broker}/client/${MANAGER_FILE}`);
  const version = verifyManager(data, manifest);
  const tmp = `${self}.download`;
  writeFileSync(tmp, data);
  const bak = `${self}.bak-${MANAGER_VERSION}`;
  if (existsSync(bak)) rmSync(bak, { force: true });
  copyFileSync(self, bak);
  renameSync(tmp, self);
  return version;
}

/**
 * `aichat-manager.mjs install --broker <url>`: run from the file the install command downloaded into
 * <root>/.manager. Checks it against the broker's manifest, remembers the broker and adds <root>/aichat-manager.cmd.
 */
export async function install(root: string, brokerArg: string, self: string | null, get: Fetch = fetchBytes): Promise<string[]> {
  const broker = brokerHttpOrigin(brokerArg);
  if (!broker) throw new Error(`--broker: потрібна адреса брокера http(s)://…, а не «${brokerArg}»`);
  if (!self) throw new Error(`install запускається з завантаженого файлу ${MANAGER_FILE}`);
  const manifest = await fetchManifest(broker, get);
  verifyManager(readFileSync(self), manifest);
  const dir = managerDir(root);
  mkdirSync(dir, { recursive: true });
  const target = join(dir, MANAGER_FILE);
  if (resolve(self).toLowerCase() !== resolve(target).toLowerCase()) copyFileSync(self, target);
  writeFileSync(join(dir, "config.json"), JSON.stringify({ ...readManagerConfig(root), broker }, null, 2) + "\n");
  const cmd = writeLauncher(root, broker);
  return [
    `Менеджер ${manifest.version} встановлено з ${broker}: ${target}`,
    `SHA-256 збігається з manifest.json брокера.`,
    `Запускати потім: ${cmd}`,
  ];
}


/**
 * The command that starts the manager later, next to the agents' folders: aichat-manager.cmd on Windows,
 * aichat-manager.sh (executable) elsewhere (AIChat 3539-3544).
 */
export function writeLauncher(root: string, broker: string, platform = process.platform): string {
  if (platform === "win32") {
    const cmd = join(root, "aichat-manager.cmd");
    writeFileSync(cmd, `@echo off\r\nrem Starts the AIChat agent manager (installed from ${broker}).\r\nnode "%~dp0.manager\\${MANAGER_FILE}" %*\r\n`);
    return cmd;
  }
  const sh = join(root, "aichat-manager.sh");
  writeFileSync(sh, `#!/bin/sh\n# Starts the AIChat agent manager (installed from ${broker}).\nexec node "$(dirname "$0")/.manager/${MANAGER_FILE}" "$@"\n`, { mode: 0o755 });
  chmodSync(sh, 0o755);
  return sh;
}

/**
 * Opens the manager's page in the person's browser after an install: `start` on Windows, `open` on macOS, xdg-open on
 * a Linux desktop. A server with no display (SSH) gets nothing opened; the printed link is enough there.
 */
export function openInBrowser(url: string, platform = process.platform, env = process.env): boolean {
  const run = (cmd: string, args: string[]) => {
    try {
      spawn(cmd, args, { stdio: "ignore", detached: true, windowsHide: true }).on("error", () => {}).unref();
      return true;
    } catch {
      return false;
    }
  };
  if (platform === "win32") return run("cmd", ["/c", "start", "", url]);
  if (platform === "darwin") return run("open", [url]);
  if (!env.DISPLAY && !env.WAYLAND_DISPLAY) return false;
  return run("xdg-open", [url]);
}
