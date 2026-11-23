import type { AdapterInfo } from "../api/types";
import { compareVersions } from "../../../src/semver";

/**
 * Adapters the broker builds and serves (/client/...), so they share its version. Others, such as an agent's own
 * adapter, number their versions themselves and are never "older than the broker".
 */
const BROKER_ADAPTERS = new Set(["claude-channel", "opencode-channel", "codex-channel", "agy-channel"]);

/** The adapter is one the broker serves and is older than the broker, which serves the newest one. */
export function adapterOutdated(adapter: AdapterInfo | undefined, broker: string | undefined): boolean {
  return !!adapter && !!broker && BROKER_ADAPTERS.has(adapter.name) && compareVersions(adapter.version, broker) < 0;
}

/** Where the adapter lives, as people read it; empty when older adapters do not report it. */
export function surfaceText(surface: AdapterInfo["surface"], compact = false): string {
  if (surface === "server") return compact ? "сервер" : "сервер, без термінала";
  if (surface === "terminal") return compact ? "термінал" : "у терміналі";
  return "";
}

/** How the agent's session started on this adapter process; empty when unreported. */
export function startText(start: AdapterInfo["start"]): string {
  if (start === "resumed") return "продовжена сесія";
  if (start === "new") return "нова сесія";
  return "";
}

/** One tooltip line about an agent's adapter; empty when it did not say which it is. */
export function adapterText(adapter: AdapterInfo | undefined, broker: string | undefined): string {
  if (!adapter) return "";
  const base = `адаптер ${adapter.name} ${adapter.version}`;
  const head = adapterOutdated(adapter, broker) ? `${base}: застарів, на брокері ${broker}` : base;
  const extra = [surfaceText(adapter.surface), startText(adapter.start)].filter(Boolean);
  return extra.length ? `${head} · ${extra.join(" · ")}` : head;
}
