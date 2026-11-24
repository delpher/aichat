// Stage 4b of the agent manager (AIChat #aichat-manager-dev, 3404-3410): connects an agent the person has already
// created in the broker's web page. The manager never creates agents in the broker (alexey, 3405): the person brings
// the token. The wizard checks it (GET /api/me), keeps it in an owner-only file, downloads the adapter checked
// against the broker's manifest, and lets the adapter's own installer set the folder up (codex, agy, claude); for
// OpenCode, whose plugin has no installer, it lays out the files opencode-alexey described (3409).
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { NAME_RE, ROOM_RE } from "../protocol.js";
import { discover } from "./agents.js";
import { fetchBytes, fetchManifest, makePrivate, readManagerConfig, sha256, type ClientManifest, type Fetch } from "./self.js";
import { SettingError } from "./settings.js";
import { CLAUDE_START_PS1, hasStartScript } from "./claude-start.js";

export type WizardType = "claude" | "codex" | "agy" | "opencode";

const TYPES: WizardType[] = ["claude", "codex", "agy", "opencode"];

/** What the page needs to draw the wizard. `{name}` in the defaults is the agent's name, filled in by the page. */
export interface InstallInfo {
  broker: string | null;
  root: string;
  folders: string[];
  defaults: { codexHome: string; profile: string; attachPort: number };
}

export interface InstallRequest {
  type?: unknown;
  name?: unknown;
  token?: unknown;
  owners?: unknown;
  rooms?: unknown;
  codexHome?: unknown;
  profile?: unknown;
  attachPort?: unknown;
}

export interface InstallResult {
  folder: string;
  /** What was done. */
  steps: string[];
  /** What the person still has to do. */
  next: string[];
}

/** How the wizard runs an adapter's installer: `node <args>` in `cwd`, with its exit code and output. */
export type NodeRunner = (args: string[], cwd: string) => Promise<{ code: number; output: string }>;

export const runNode: NodeRunner = (args, cwd) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd, windowsHide: true });
    let output = "";
    child.stdout.on("data", (c) => (output += c));
    child.stderr.on("data", (c) => (output += c));
    const timer = setTimeout(() => child.kill(), 120000);
    child.on("error", (e) => resolve({ code: -1, output: e.message }));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, output: output.trim() });
    });
  });

export interface WizardDeps {
  get?: Fetch;
  run?: NodeRunner;
  /** Where token files go (~/.secrets). */
  secretsDir?: string;
  home?: string;
}

const brokerOf = (root: string) => readManagerConfig(root).broker ?? discover(root).find((a) => a.agent.brokerUrl)?.agent.brokerUrl ?? null;

export function installInfo(root: string, home = homedir()): InstallInfo {
  let folders: string[] = [];
  try {
    folders = readdirSync(root).filter((n) => !n.startsWith(".") && statSync(join(root, n)).isDirectory());
  } catch {
    // no folder yet: the first agent makes it
  }
  const used = new Set(discover(root).map((a) => a.agent.attachPort).filter((p): p is number => typeof p === "number"));
  let attachPort = 60610;
  while (used.has(attachPort)) attachPort++;
  return {
    broker: brokerOf(root),
    root,
    folders,
    defaults: { codexHome: join(home, ".codex-aichat-{name}"), profile: "aichat-{name}", attachPort },
  };
}

const fail = (message: string, field?: string): never => {
  throw new SettingError(message, field);
};

const list = (raw: unknown, field: string, re: RegExp): string[] => {
  if (raw === undefined || raw === null || raw === "") return [];
  const items = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/[\s,]+/) : fail(`${field}: список`, field);
  const out = [...new Set(items.map((x) => String(x).trim().replace(/^[#@]/, "")).filter(Boolean))];
  const bad = out.find((x) => !re.test(x));
  if (bad !== undefined) fail(`${field}: «${bad}» не підходить`, field);
  return out;
};

/** The broker's WebSocket address for an adapter's config (ws(s)://host:port). */
const wsOf = (broker: string) => broker.replace(/^http(s?):/, "ws$1:");

/** Checks a downloaded client file against the broker's manifest. */
function checked(name: string, data: Buffer, manifest: ClientManifest): Buffer {
  const entry = manifest.files[name];
  if (!entry) fail(`у manifest.json брокера немає ${name}`);
  if (sha256(data) !== entry!.sha256) fail(`${name}: SHA-256 не збігається з manifest.json брокера`);
  return data;
}

/**
 * One installation at a time: a rollback decides what it owns by what existed before it began, so two installs
 * sharing a CODEX_HOME or a profile must not overlap (codex-alexey, 3415). The manager is the only writer here.
 */
let busy = false;

export async function installAgent(root: string, req: InstallRequest, deps: WizardDeps = {}): Promise<InstallResult> {
  if (busy) fail("уже триває інше встановлення: дочекайтеся його кінця");
  busy = true;
  try {
    return await installOne(root, req, deps);
  } finally {
    busy = false;
  }
}

async function installOne(root: string, req: InstallRequest, deps: WizardDeps): Promise<InstallResult> {
  const get = deps.get ?? fetchBytes;
  const run = deps.run ?? runNode;
  const home = deps.home ?? homedir();

  // 1. what to install, and where
  const type = req.type as WizardType;
  if (!TYPES.includes(type)) fail("тип: claude, codex, agy або opencode", "type");
  const name = typeof req.name === "string" ? req.name.trim() : "";
  if (!NAME_RE.test(name)) fail("ім'я: латинські літери, цифри, - і _, до 64 знаків", "name");
  const dir = join(root, name);
  if (existsSync(dir) && readdirSync(dir).length) fail(`тека ${dir} уже є і не порожня`, "name");
  const token = typeof req.token === "string" ? req.token.trim() : "";
  if (!token) fail("потрібен токен агента з вебу брокера", "token");
  const owners = list(req.owners, "owners", NAME_RE);
  const rooms = list(req.rooms, "rooms", ROOM_RE);
  let attachPort: number | undefined;
  if ((type === "codex" || type === "agy") && req.attachPort !== undefined && req.attachPort !== null && req.attachPort !== "") {
    attachPort = Number(req.attachPort);
    if (!Number.isInteger(attachPort) || attachPort < 1024 || attachPort > 65535) fail("attachPort: ціле число від 1024 до 65535", "attachPort");
    const taken = discover(root).find((a) => a.agent.attachPort === attachPort);
    if (taken) fail(`attachPort: порт ${attachPort} уже має ${taken.agent.folder}`, "attachPort");
  }
  const codexHome = type === "codex" ? (typeof req.codexHome === "string" && req.codexHome.trim() ? req.codexHome.trim() : join(home, `.codex-aichat-${name}`)) : "";
  if (type === "codex" && existsSync(join(codexHome, "config.toml"))) fail(`у ${codexHome} уже є config.toml: оберіть інший CODEX_HOME`, "codexHome");
  const profile = type === "agy" ? (typeof req.profile === "string" && req.profile.trim() ? req.profile.trim() : `aichat-${name}`) : "";
  if (type === "agy" && (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{1,63}$/.test(profile) || profile === "antigravity-cli"))
    fail("профіль: латинські літери, цифри, . _ -, не antigravity-cli", "profile");

  // 2. the broker, and whether the token is this agent's
  const broker = brokerOf(root);
  if (!broker) fail("невідомо, який брокер: встановіть менеджер командою з вебу брокера");
  let me: { name?: string };
  try {
    const res = await fetch(`${broker}/api/me`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10000) });
    if (res.status === 401 || res.status === 403) fail("брокер не прийняв цей токен", "token");
    if (!res.ok) fail(`брокер відповів ${res.status} на перевірку токена`, "token");
    me = (await res.json()) as { name?: string };
  } catch (e) {
    if (e instanceof SettingError) throw e;
    return fail(`брокер ${broker} не відповідає: ${(e as Error).message}`);
  }
  if (me.name !== name) fail(`це токен агента «${me.name}», а не «${name}»`, "token");

  // 3. everything the adapter needs, checked before anything is written
  const manifest = await fetchManifest(broker!, get).catch((e: Error) => fail(e.message));
  const files: Record<WizardType, string[]> = {
    claude: ["claude-channel.mjs", "aichat-hook.mjs"],
    codex: ["codex-channel.mjs"],
    agy: ["agy-channel.mjs"],
    opencode: ["opencode-channel.js"],
  };
  const downloads: [string, Buffer][] = [];
  for (const file of files[type]) downloads.push([file, checked(file, await get(`${broker}/client/${file}`), manifest)]);

  // 4. the token file (owner-only) and the folder
  const secrets = deps.secretsDir ?? join(home, ".secrets");
  const tokenFile = join(secrets, `aichat-${name}.token`);
  if (existsSync(tokenFile) && readFileSync(tokenFile, "utf8").trim() !== token) fail(`${tokenFile} уже є, з іншим токеном: приберіть його вручну`, "token");
  const createdToken = !existsSync(tokenFile);
  const createdDir = !existsSync(dir);
  // profiles outside the agent folder that the installers set up: a rollback takes back only what this run made
  // (codex-alexey, 3413). CODEX_HOME has no config.toml yet (checked above); agy's profile lives in ~/.gemini/<profile>.
  const codexHomeNew = type === "codex" && !existsSync(codexHome);
  const agyProfile = type === "agy" ? join(home, ".gemini", profile) : "";
  const agyProfileNew = type === "agy" && !existsSync(agyProfile);
  const steps: string[] = [`Токен перевірено: він належить «${name}» на ${broker}.`];
  try {
    mkdirSync(secrets, { recursive: true });
    writeFileSync(tokenFile, token + "\n", { mode: 0o600 });
    makePrivate(tokenFile);
    steps.push(`Токен збережено в ${tokenFile} (доступ лише власнику).`);
    mkdirSync(dir, { recursive: true });
    for (const [file, data] of downloads) {
      const target = type === "opencode" ? join(dir, ".opencode", "plugins", "aichat-channel", "index.js") : join(dir, file);
      mkdirSync(join(target, ".."), { recursive: true });
      writeFileSync(target, data);
    }
    steps.push(`Адаптер ${manifest.version} завантажено, SHA-256 збігається з manifest.json брокера.`);

    // 5. the adapter's own installer
    const installer = async (args: string[]) => {
      const r = await run(args, dir);
      if (r.code !== 0) fail(`інсталятор адаптера завершився з кодом ${r.code}: ${r.output.slice(-600)}`);
    };
    if (type === "claude")
      await installer([join(dir, "claude-channel.mjs"), "install", "--url", wsOf(broker!), "--token-file", tokenFile, "--dir", dir]);
    if (type === "codex") {
      const args = [join(dir, "codex-channel.mjs"), "install", "--dir", dir, "--home", codexHome, "--token-file", tokenFile, "--url", broker!];
      if (owners.length) args.push("--owners", owners.join(","));
      if (rooms.length) args.push("--rooms", rooms.join(","));
      await installer(args);
    }
    if (type === "agy") {
      const args = [join(dir, "agy-channel.mjs"), "install", "--dir", dir, "--profile", profile, "--token-file", tokenFile, "--url", broker!];
      if (owners.length) args.push("--owners", owners.join(","));
      if (rooms.length) args.push("--rooms", rooms.join(","));
      await installer(args);
    }
    if (type === "opencode") {
      const config: Record<string, unknown> = { url: `${wsOf(broker!)}/ws`, tokenFile, wake: "always", delivery: "steer", paused: true, session: "resume", rooms };
      if (owners.length) config.owners = owners;
      writeFileSync(join(dir, "aichat.config.json"), JSON.stringify(config, null, 2) + "\n");
    }
    steps.push(type === "opencode" ? "Записано aichat.config.json (на паузі)." : "Інсталятор адаптера налаштував теку.");
    if (attachPort !== undefined) {
      const file = join(dir, "aichat.config.json");
      const cfg = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      cfg.attachPort = attachPort;
      writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n");
      steps.push(`Порт інтерактивної сесії: ${attachPort}.`);
    }
    // Claude Code keeps the session, not the adapter: the start script resumes it and tells the adapter how it began
    // (the Claude command itself stays "claude" until the person changes it in the settings)
    if (type === "claude" && !hasStartScript(dir)) {
      writeFileSync(join(dir, "start.ps1"), CLAUDE_START_PS1);
      steps.push("Додано start.ps1: «Запустити» продовжує останню сесію (або нову з -Fresh).");
    }
  } catch (e) {
    // a half-made agent is worse than none: take back what this run made
    if (createdDir) rmSync(dir, { recursive: true, force: true });
    if (createdToken) rmSync(tokenFile, { force: true });
    if (codexHomeNew) rmSync(codexHome, { recursive: true, force: true });
    else if (type === "codex") rmSync(join(codexHome, "config.toml"), { force: true });
    if (agyProfileNew) rmSync(agyProfile, { recursive: true, force: true });
    throw e;
  }

  const next: Record<WizardType, string[]> = {
    claude: ["Натисніть «Запустити»: відкриється вкладка Windows Terminal з Claude Code у теці агента."],
    codex: [
      `Увійдіть у Codex для цього профілю: у PowerShell $env:CODEX_HOME='${codexHome.replace(/'/g, "''")}'; codex login`,
      "Зніміть паузу: «Налаштування» → «На паузі» → ні.",
      "Натисніть «Запустити».",
    ],
    agy: [
      `Один раз увійдіть в Antigravity з профілем «${profile}».`,
      "Зніміть паузу: «Налаштування» → «На паузі» → ні.",
      "Натисніть «Запустити».",
    ],
    opencode: ["Зніміть паузу: «Налаштування» → «На паузі» → ні.", "Натисніть «Запустити»: відкриється opencode у теці агента."],
  };
  return { folder: name, steps, next: next[type] };
}
