import type { AdapterInfo } from "../api/types";
import { compareVersions } from "../../../src/semver";

/** The adapter is older than the broker, which serves the newest one. */
export function adapterOutdated(adapter: AdapterInfo | undefined, broker: string | undefined): boolean {
  return !!adapter && !!broker && compareVersions(adapter.version, broker) < 0;
}

/** One tooltip line about an agent's adapter; empty when it did not say which it is. */
export function adapterText(adapter: AdapterInfo | undefined, broker: string | undefined): string {
  if (!adapter) return "";
  const line = `адаптер ${adapter.name} ${adapter.version}`;
  return adapterOutdated(adapter, broker) ? `${line}: застарів, на брокері ${broker}` : line;
}
