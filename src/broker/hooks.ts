// Global hooks, the scheduler (alexey, AIChat-dev-team 2238; decisions 2250/2252, agreed in 2254).
// A hook is "trigger → repeat → action": when an agent comes online, goes offline or stays idle long enough,
// the broker sends a system message. The scheduler decides when and to whom; what the agent does with it is
// the agent's business.
import { randomBytes } from "node:crypto";
import { HOOK_IDLE_MAX_MINUTES, MAX_HOOKS, type HookFields, type HookRule } from "../protocol.js";
import type { Store } from "./store.js";

/** An online or offline change fires only once the agent has kept it this long, so a dropped connection is not news. */
export const PRESENCE_SETTLE_MS = 30_000;
/** After the broker starts, everyone reconnects: presence changes in this time are not events. */
export const STARTUP_GRACE_MS = 2 * 60_000;
/** Busy this long without a break counts as real activity, even with nothing sent. */
export const REAL_BUSY_MS = 2 * 60_000;
/** How often the scheduler looks at the clock. */
export const TICK_MS = 15_000;

export class HookError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

/** What the scheduler needs from the broker. */
export interface HooksHost {
  store: Store;
  now(): number;
  /** Agents hooks fire for and may write to: AI agents, not people, not the keeper. */
  agents(): string[];
  isOnline(agent: string): boolean;
  /** Whether the agent's adapter reports busy / waiting / idle; only those can be idle as far as hooks go. */
  reportsActivity(agent: string): boolean;
  /** A direct message from the system sender. */
  notify(to: string, text: string): void;
  maxTextLength(): number;
  log(line: string): void;
}

interface AgentClock {
  /** When the current idle stretch began, as far as the broker saw it. */
  idleSince?: number;
  /** When the current busy / waiting stretch began, and whether it already counted as real activity. */
  busySince?: number;
  busyCounted?: boolean;
  /** A presence change waiting to settle. */
  pending?: { online: boolean; at: number };
}

export class Hooks {
  private clocks = new Map<string, AgentClock>();
  private readonly startedAt: number;

  constructor(private host: HooksHost) {
    this.startedAt = host.now();
  }

  private clock(agent: string): AgentClock {
    let c = this.clocks.get(agent);
    if (!c) this.clocks.set(agent, (c = {}));
    return c;
  }

  // ---- what the broker tells the scheduler ----

  /** The agent's logical presence changed (not one socket: the broker's online state). */
  presence(agent: string, online: boolean) {
    const c = this.clock(agent);
    c.idleSince = undefined;
    c.busySince = undefined;
    c.busyCounted = false;
    const now = this.host.now();
    // agents coming back after a broker restart never left, as far as hooks go
    if (now - this.startedAt < STARTUP_GRACE_MS) return void (c.pending = undefined);
    // back to the state it had before the change settled: a dropped connection, nothing happened
    if (c.pending && c.pending.online !== online) c.pending = undefined;
    else c.pending = { online, at: now };
  }

  /** The agent's adapter reported its state. */
  activity(agent: string, state: "idle" | "busy" | "waiting") {
    const c = this.clock(agent);
    const now = this.host.now();
    if (state === "idle") {
      c.idleSince ??= now;
      c.busySince = undefined;
      c.busyCounted = false;
    } else {
      c.idleSince = undefined;
      c.busySince ??= now;
    }
  }

  /**
   * The agent did something real: sent a message (a game move too), changed its notebook, set its status, or
   * worked long enough. Hooks that wait for that may fire again, and an idle stretch starts over.
   */
  realActivity(agent: string) {
    this.host.store.clearHookAwaiting(agent);
    const c = this.clocks.get(agent);
    if (c?.idleSince !== undefined) c.idleSince = this.host.now();
  }

  // ---- the clock ----

  tick() {
    const now = this.host.now();
    const hooks = this.host.store.hooks().filter((h) => h.enabled);
    const agents = new Set(this.host.agents());
    for (const [agent, c] of this.clocks) {
      if (!agents.has(agent)) continue;
      if (c.busySince !== undefined && !c.busyCounted && now - c.busySince >= REAL_BUSY_MS) {
        c.busyCounted = true;
        this.realActivity(agent);
      }
      if (c.pending && now - c.pending.at >= PRESENCE_SETTLE_MS) {
        const { online } = c.pending;
        c.pending = undefined;
        if (this.host.isOnline(agent) === online)
          for (const h of hooks) if (h.trigger.type === (online ? "online" : "offline")) this.fire(h, agent, false);
      }
    }
    for (const h of hooks) {
      if (h.trigger.type !== "idle") continue;
      const after = h.trigger.idleMinutes * 60_000;
      for (const agent of agents) {
        const since = this.clocks.get(agent)?.idleSince;
        if (since === undefined || now - since < after) continue;
        if (!this.host.isOnline(agent) || !this.host.reportsActivity(agent)) continue;
        // one message per idle stretch: the next only after real activity (decision 7)
        if (this.host.store.hookFire(h.id, agent).awaiting) continue;
        this.fire(h, agent, true);
      }
    }
  }

  private fire(h: HookRule, agent: string, awaiting: boolean) {
    if (h.repeat === "once" && this.host.store.hookFire(h.id, agent).fired > 0) return;
    this.host.store.recordHookFire(h.id, agent, awaiting, new Date(this.host.now()).toISOString());
    const everyone = this.host.agents();
    const to =
      h.action.recipient === "participant" ? [agent] : h.action.recipient === "agents" ? everyone : everyone.filter((a) => a !== agent);
    for (const name of to) this.host.notify(name, h.action.text);
    this.host.log(`hook ${h.id} (${h.trigger.type}) fired for ${agent}: ${to.length} message(s)`);
  }

  // ---- what admins do (/admin/api/hooks) ----

  list(): HookRule[] {
    return this.host.store.hooks();
  }

  create(raw: unknown, by: string): HookRule {
    if (this.host.store.hooks().length >= MAX_HOOKS) throw new HookError(`no more than ${MAX_HOOKS} hooks`, 409);
    return this.host.store.saveHook(`h${randomBytes(6).toString("hex")}`, this.check(raw), by);
  }

  replace(id: string, raw: unknown, by: string): HookRule {
    if (!this.host.store.hook(id)) throw new HookError(`unknown hook: ${id}`, 404);
    return this.host.store.saveHook(id, this.check(raw), by);
  }

  setEnabled(id: string, raw: unknown): HookRule {
    const enabled = (raw as { enabled?: unknown } | null)?.enabled;
    if (typeof enabled !== "boolean") throw new HookError("enabled must be true or false");
    const h = this.host.store.setHookEnabled(id, enabled);
    if (!h) throw new HookError(`unknown hook: ${id}`, 404);
    return h;
  }

  remove(id: string) {
    if (!this.host.store.deleteHook(id)) throw new HookError(`unknown hook: ${id}`, 404);
  }

  /** A hook as an admin sent it, checked field by field; anything outside the rule's shape is refused. */
  private check(raw: unknown): Required<HookFields> {
    if (!raw || typeof raw !== "object") throw new HookError("send the hook as a JSON object");
    const b = raw as Record<string, unknown>;
    const t = b.trigger as Record<string, unknown> | undefined;
    const a = b.action as Record<string, unknown> | undefined;
    if (b.enabled !== undefined && typeof b.enabled !== "boolean") throw new HookError("enabled must be true or false");
    let trigger: HookFields["trigger"];
    if (t?.type === "online" || t?.type === "offline") trigger = { type: t.type };
    else if (t?.type === "idle") {
      const m = t.idleMinutes;
      if (!Number.isSafeInteger(m) || (m as number) < 1 || (m as number) > HOOK_IDLE_MAX_MINUTES)
        throw new HookError(`idleMinutes must be a whole number from 1 to ${HOOK_IDLE_MAX_MINUTES}`);
      trigger = { type: "idle", idleMinutes: m as number };
    } else throw new HookError("trigger.type must be online, offline or idle");
    if (b.repeat !== "once" && b.repeat !== "always") throw new HookError("repeat must be once or always");
    if (a?.type !== "system_message") throw new HookError("action.type must be system_message");
    if (a.recipient !== "participant" && a.recipient !== "agents" && a.recipient !== "others")
      throw new HookError("action.recipient must be participant, agents or others");
    if (typeof a.text !== "string" || !a.text.trim()) throw new HookError("action.text must not be empty");
    const text = a.text.trim();
    if (text.length > this.host.maxTextLength()) throw new HookError(`action.text is longer than ${this.host.maxTextLength()} characters`);
    return { enabled: b.enabled !== false, trigger, repeat: b.repeat, action: { type: "system_message", recipient: a.recipient, text } };
  }
}
