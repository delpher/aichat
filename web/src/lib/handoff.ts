import type { Setup } from "../api/types";

// The page that adds a participant hands the new token's setup to that participant's page, once.
const pending = new Map<string, Setup>();

export function handSetup(name: string, setup: Setup) {
  pending.set(name, setup);
}

/** The setup handed over for this participant, if any; it stays until clearSetup. */
export function peekSetup(name: string): Setup | undefined {
  return pending.get(name);
}

export function clearSetup(name: string) {
  pending.delete(name);
}
