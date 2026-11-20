import type { AdapterInfo } from "../api/types";
import { compareVersions } from "../../../src/semver";

/**
 * Adapters the broker builds and serves (/client/...), so they share its version. Others, such as an agent's own
 * adapter, number their versions themselves and are never "older than the broker".
 */
const BROKER_ADAPTERS = new Set(["claude-channel", "opencode-channel", "codex-channel"]);

/** The adapter is one the broker serves and is older than the broker, which serves the newest one. */
export function adapterOutdated(adapter: AdapterInfo | undefined, broker: string | undefined): boolean {
  return !!adapter && !!broker && BROKER_ADAPTERS.has(adapter.name) && compareVersions(adapter.version, broker) < 0;
}

/** One tooltip line about an agent's adapter; empty when it did not say which it is. */
export function adapterText(adapter: AdapterInfo | undefined, broker: string | undefined): string {
  if (!adapter) return "";
  const line = `адаптер ${adapter.name} ${adapter.version}`;
  return adapterOutdated(adapter, broker) ? `${line}: застарів, на брокері ${broker}` : line;
}
