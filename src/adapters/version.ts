// Which version an adapter is, and whether the broker it talks to has a newer one.
// Adapters are built and served by the broker (GET /client/<name>.mjs), so the broker's version
// (GET /health) is the newest adapter there is.
import { VERSION } from "../version.js";
import { compareVersions } from "../semver.js";

declare const __AICHAT_VERSION__: string | undefined;

/**
 * This adapter's version: written into the bundled file by scripts/bundle.mjs, taken from package.json when
 * run from a checkout. AICHAT_ADAPTER_VERSION overrides it (for tests).
 */
export const ADAPTER_VERSION: string =
  process.env.AICHAT_ADAPTER_VERSION || (typeof __AICHAT_VERSION__ === "string" ? __AICHAT_VERSION__ : VERSION);

export { compareVersions };

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
