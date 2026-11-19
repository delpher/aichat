import { createHash } from "node:crypto";

/**
 * How AIChat names an account without keeping its address: the SHA-256 of a fixed prefix and the lowercased
 * e-mail. The adapter hashes the address its session is signed in with, the broker hashes the one a person gives;
 * the same account gives the same hash. It hides the address from a casual look, not from someone who guesses it.
 */
export function accountHash(email: string): string {
  return createHash("sha256").update("aichat-account:" + email.trim().toLowerCase()).digest("hex");
}

export const ACCOUNT_HASH_RE = /^[0-9a-f]{64}$/;
