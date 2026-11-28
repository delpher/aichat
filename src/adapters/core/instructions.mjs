// The adapters' shared core, part 3: what an adapter tells its model (stage 1.2, AIChat 4024-4033). One text of rules
// for every agent comes from the broker (GET /api/instructions, edited by admins); the adapter adds a short block on
// its own runtime (how messages arrive, what its tools are called) and the owner's local rules, which come last and win
// where they differ. Each adapter hands the result to its model its own way (MCP instructions, developerInstructions,
// systemPrompt.append, an instructions file): this module only fetches and composes.
// A broker without /api/instructions (before 0.32) gives nothing: the adapter then uses the text it had before.
// Plain JS with node:* imports only, like files.mjs and broker.mjs.

/**
 * Asks the broker for the rules and who this agent is. null when the broker has none to give (an older broker answers
 * 404), does not answer in time, cannot be reached or answers something else: the adapter keeps its own text then.
 */
export async function fetchInstructions({ httpBase, token, timeoutMs = 3000 }) {
  try {
    const r = await fetch(`${String(httpBase).replace(/\/+$/, "")}/api/instructions`, {
      headers: { authorization: `Bearer ${token}` },
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) return null;
    return parseInstructions(await r.json());
  } catch {
    return null;
  }
}

/**
 * The answer of GET /api/instructions checked and cut to what is used, or null when it is not one. For an adapter
 * that asks the broker its own way (agy through BrokerHttp, which its tests replace).
 */
export function parseInstructions(data) {
  const rules = data?.rules;
  if (!rules || typeof rules.text !== "string" || !rules.text.trim() || typeof data.self?.name !== "string") return null;
  return {
    rules: { text: rules.text, by: String(rules.by ?? ""), ts: String(rules.ts ?? ""), ...(rules.draft ? { draft: true } : {}) },
    self: { name: data.self.name, ...(typeof data.self.description === "string" && data.self.description ? { description: data.self.description } : {}) },
  };
}

/** Which rules these are: the broker's draft, or who saved them and when. */
export function rulesVersion(rules) {
  return rules.draft ? "the broker's built-in draft" : `${rules.ts}, by ${rules.by}`;
}

/** Who the agent is: its name and what an admin wrote about it. */
export function selfText(self) {
  const lines = [`You are ${self.name} on AIChat.`];
  if (self.description) lines.push(`An AIChat admin wrote about you: ${self.description}`);
  return lines.join("\n");
}

export const RUNTIME_HEADING = "## How your runtime connects you to AIChat";
export const LOCAL_HEADING = "## Local rules from your owner (they win where they differ from the rules above)";

/**
 * The model's instructions, in this order: the rules from the broker, who the agent is, the adapter's block on its
 * runtime, the adapter's notices (a newer adapter is out, ...), the owner's local rules last.
 * `fetched` is what fetchInstructions gave; without it the adapter's `fallback` text stands in for the rules and who
 * the agent is, so an older broker gets what it got before.
 * Returns the text and its parts (where each came from, and which version), for the agent manager to show.
 */
export function composeInstructions({ fetched, runtime = "", notices = [], local = "", fallback = "" }) {
  const parts = [];
  const blocks = [];
  if (fetched) {
    blocks.push(fetched.rules.text.trim(), selfText(fetched.self));
    parts.push({ source: "broker", version: rulesVersion(fetched.rules) });
  } else if (fallback.trim()) {
    blocks.push(fallback.trim());
    parts.push({ source: "fallback", version: "built into the adapter" });
  }
  if (runtime.trim()) {
    blocks.push(fetched ? `${RUNTIME_HEADING}\n${runtime.trim()}` : runtime.trim());
    parts.push({ source: "adapter" });
  }
  for (const n of notices) if (n && n.trim()) blocks.push(n.trim());
  if (local.trim()) {
    blocks.push(`${LOCAL_HEADING}\n${local.trim()}`);
    parts.push({ source: "local" });
  }
  return { text: blocks.join("\n\n"), parts };
}
