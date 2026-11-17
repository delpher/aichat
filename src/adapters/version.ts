// Which version an adapter is, and whether the broker it talks to has a newer one.
// Adapters are built and served by the broker (GET /client/<name>.mjs), so the broker's version
// (GET /health) is the newest adapter there is.
import { VERSION } from "../version.js";

declare const __AICHAT_VERSION__: string | undefined;

/**
 * This adapter's version: written into the bundled file by scripts/bundle.mjs, taken from package.json when
 * run from a checkout. AICHAT_ADAPTER_VERSION overrides it (for tests).
 */
export const ADAPTER_VERSION: string =
  process.env.AICHAT_ADAPTER_VERSION || (typeof __AICHAT_VERSION__ === "string" ? __AICHAT_VERSION__ : VERSION);

const SEMVER_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/;

/** Semver order: negative if a < b, 0 if equal or either cannot be read, positive if a > b. */
export function compareVersions(a: string, b: string): number {
  const x = SEMVER_RE.exec(a.trim());
  const y = SEMVER_RE.exec(b.trim());
  if (!x || !y) return 0;
  for (let i = 1; i <= 3; i++) if (Number(x[i]) !== Number(y[i])) return Number(x[i]) - Number(y[i]);
  // a release is newer than its prereleases (1.2.0-rc.1 < 1.2.0)
  if (!x[4] || !y[4]) return x[4] ? -1 : y[4] ? 1 : 0;
  const p = x[4].split(".");
  const q = y[4].split(".");
  for (let i = 0; i < Math.max(p.length, q.length); i++) {
    if (p[i] === undefined) return -1;
    if (q[i] === undefined) return 1;
    const n = /^\d+$/.test(p[i]);
    const m = /^\d+$/.test(q[i]);
    if (n && m && Number(p[i]) !== Number(q[i])) return Number(p[i]) - Number(q[i]);
    if (n !== m) return n ? -1 : 1;
    if (!n && p[i] !== q[i]) return p[i] < q[i] ? -1 : 1;
  }
  return 0;
}

/** The broker's version from GET /health, or null when it does not answer in time. */
export async function brokerVersion(httpUrl: string, timeoutMs = 3000): Promise<string | null> {
  try {
    const r = await fetch(`${httpUrl}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    const data = (await r.json()) as { version?: unknown };
    return r.ok && typeof data.version === "string" ? data.version : null;
  } catch {
    return null;
  }
}

/** The broker's version when it is newer than this adapter, otherwise null. */
export async function newerAdapter(httpUrl: string, own = ADAPTER_VERSION, timeoutMs = 3000): Promise<string | null> {
  const broker = await brokerVersion(httpUrl, timeoutMs);
  return broker && compareVersions(broker, own) > 0 ? broker : null;
}

/** What the agent is told when a newer adapter is out: offer the update to the user, do not do it alone. */
export function updateNotice(file: string, own: string, newer: string, httpUrl: string): string {
  return (
    `AIChat adapter update: this adapter (${file}) is version ${own}, the broker has ${newer}. ` +
    `Suggest to your user that they update it: download ${httpUrl}/client/${file} over the adapter file that ` +
    `.mcp.json points to, then restart Claude Code. Do not update it yourself.`
  );
}
