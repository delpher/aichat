// Which Codex and Antigravity CLIs are installed, for the agent's settings to pick from (alexey, AIChat 3702-3721):
// the Codex desktop app's own CLI in every installed Store version, a path from the adapter's environment variable,
// and whatever is on PATH. Each with its version, so the person sees what they pick. Looking costs a second or two
// (`--version` of each), so the answer is kept for a while.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { win32 } from "node:path";

export interface CliOption {
  /** What goes into aichat.config.json. */
  value: string;
  /** What the page shows: version and where it was found. */
  label: string;
}

export type CliType = "codex" | "agy";

/** The adapters' own environment variable for the path (codex-channel, agy-channel loadConfig). */
export const CLI_ENV: Record<CliType, string> = { codex: "CODEX_APP_RUNTIME_CLI_PATH", agy: "AGY_CLI_PATH" };

export interface CliDeps {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  exists: (path: string) => boolean;
  /** Runs a program and gives its output, or null when it could not. */
  run: (exe: string, args: string[]) => string | null;
}

const systemDeps: CliDeps = {
  platform: process.platform,
  env: process.env,
  exists: existsSync,
  run: (exe, args) => {
    const out = spawnSync(exe, args, { encoding: "utf8", windowsHide: true, timeout: 8000 });
    return out.status === 0 ? out.stdout : null;
  },
};

/** "OpenAI.Codex_26.1120.6357.0_x64__2p2nqsd0c76g0" → [26, 1120, 6357, 0]. */
const storeVersion = (pkg: string) => pkg.split("_")[1].split(".").map(Number);
const newerFirst = (a: string, b: string) => {
  const [x, y] = [storeVersion(a), storeVersion(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (y[i] || 0) - (x[i] || 0);
  return 0;
};

/**
 * The installed CLIs of this kind, newest Store version first. A normal user may not list WindowsApps, so the Store
 * packages come from the registry (no admin rights), as in codex-channel's relocateStoreCodex.
 */
export function findClis(type: CliType, deps: CliDeps = systemDeps): CliOption[] {
  const found: { path: string; where: string }[] = [];
  const win = deps.platform === "win32";
  if (type === "codex" && win) {
    const key = "HKCU\\Software\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\CurrentVersion\\AppModel\\Repository\\Packages";
    const packages = (deps.run("reg.exe", ["query", key]) ?? "")
      .split(/\r?\n/)
      .map((line) => line.trim().split("\\").pop() ?? "")
      .filter((name) => /^OpenAI\.Codex_[\d.]+_[^_]+__[^_]+$/i.test(name))
      .sort(newerFirst);
    // Store paths are Windows ones, whatever runs this (the tests run on Linux too)
    const apps = win32.join(deps.env.ProgramFiles || "C:\\Program Files", "WindowsApps");
    for (const pkg of packages) found.push({ path: win32.join(apps, pkg, "app", "resources", "codex.exe"), where: `Microsoft Store ${storeVersion(pkg).join(".")}` });
  }
  const fromEnv = deps.env[CLI_ENV[type]];
  if (fromEnv) found.push({ path: fromEnv, where: CLI_ENV[type] });
  const name = win ? `${type}.exe` : type;
  for (const line of (deps.run(win ? "where.exe" : "which", win ? [name] : ["-a", name]) ?? "").split(/\r?\n/))
    if (line.trim()) found.push({ path: line.trim(), where: "PATH" });

  const seen = new Set<string>();
  const options: CliOption[] = [];
  for (const f of found) {
    const id = win ? f.path.toLowerCase() : f.path;
    if (seen.has(id) || !deps.exists(f.path)) continue;
    seen.add(id);
    const version = deps.run(f.path, ["--version"])?.trim().split(/\r?\n/)[0];
    options.push({ value: f.path, label: version ? `${version} · ${f.where}` : f.where });
  }
  return options;
}

const cache = new Map<CliType, { at: number; options: CliOption[] }>();
/** How long a look stays good: a Store update or a new install shows up after this, or after the manager restarts. */
export const CLI_CACHE_MS = 5 * 60 * 1000;

export function cachedClis(type: CliType, now = Date.now()): CliOption[] {
  const hit = cache.get(type);
  if (hit && now - hit.at < CLI_CACHE_MS) return hit.options;
  const options = findClis(type);
  cache.set(type, { at: now, options });
  return options;
}

/** What a status.json `binary.source` means, for the page. */
export const CLI_SOURCE: Record<string, string> = {
  config: "з налаштувань агента",
  relocated: "після оновлення Store: шлях у налаштуваннях застарів",
  env: "зі змінної середовища",
  PATH: "з PATH",
};
