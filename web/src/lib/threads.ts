// Reply chains as threads: a message and every loaded message that answers it, directly or down the chain.
import type { ChatMessage } from "../api/types";
import { isGameRoom } from "./views";

export interface Thread {
  /** The first loaded message of the chain; it stays in the feed and carries the summary. */
  root: ChatMessage;
  /** Every reply in the chain, oldest first (the root not included). */
  replies: ChatMessage[];
  /** Who wrote the replies, in order of first reply. */
  participants: string[];
  /** The newest message of the thread. */
  last: ChatMessage;
}

export interface Threads {
  /** Root id of every loaded message (a message that starts nothing is its own root). */
  rootOf: Map<number, number>;
  /** Threads by root id: only roots that have at least one loaded reply. */
  byRoot: Map<number, Thread>;
}

/**
 * Groups messages (oldest first) into threads. A reply whose parent is not loaded (older than the
 * loaded page, or in another conversation) starts a thread of its own and shows its quote as before.
 */
export function buildThreads(messages: ChatMessage[]): Threads {
  const rootOf = new Map<number, number>();
  const byId = new Map<number, ChatMessage>();
  const byRoot = new Map<number, Thread>();
  for (const m of messages) {
    byId.set(m.id, m);
    const parentRoot = m.reply_to != null ? rootOf.get(m.reply_to) : undefined;
    if (parentRoot === undefined) {
      rootOf.set(m.id, m.id);
      continue;
    }
    rootOf.set(m.id, parentRoot);
    let t = byRoot.get(parentRoot);
    if (!t) {
      t = { root: byId.get(parentRoot)!, replies: [], participants: [], last: m };
      byRoot.set(parentRoot, t);
    }
    t.replies.push(m);
    t.last = m;
    if (!t.participants.includes(m.from)) t.participants.push(m.from);
  }
  return { rootOf, byRoot };
}

/** The thread a message belongs to, if it is part of one (as the root or as a reply). */
export function threadOf(threads: Threads, id: number): Thread | undefined {
  const root = threads.rootOf.get(id);
  return root === undefined ? undefined : threads.byRoot.get(root);
}

/**
 * Whether a message ends its chain: the broker refuses replies to it once its hops reached maxHops.
 * Game rooms have no such limit (the game bounds the moves).
 */
export function atHopLimit(m: ChatMessage, maxHops: number | undefined): boolean {
  return maxHops !== undefined && m.hops >= maxHops && !(m.room && isGameRoom(m.room));
}
