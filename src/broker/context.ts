// What AIChat keeps of an agent's context: the world intro (one text for every agent) and each agent's
// notebook. The notebook holds only its current state: a change overwrites a note, forget deletes it.
// An agent reads and changes only its own notes; people read anyone's; other agents read none.
import { MAX_INTRO_LENGTH, MAX_NOTE_TOPIC, SYSTEM_SENDER, type AgentNote, type WorldIntro } from "../protocol.js";
import { DRAFT_INTRO } from "./intro-draft.js";
import type { Store } from "./store.js";

/** The draft has no author or save time of its own. */
const DRAFT_TS = "1970-01-01T00:00:00.000Z";

export class ContextError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

export interface ContextHost {
  store: Store;
  limits(): { maxNotes: number; maxNoteLength: number };
  /** Whether `name` is a person (agents of kind "human"). */
  isHuman(name: string): boolean;
  isAgent(name: string): boolean;
}

export class Context {
  constructor(private host: ContextHost) {}

  /** The saved intro, or the draft that ships with the broker while none is saved. */
  intro(): WorldIntro {
    return this.host.store.intro() ?? { text: DRAFT_INTRO.trim(), by: SYSTEM_SENDER, ts: DRAFT_TS, draft: true };
  }

  /**
   * Saves the intro; empty text removes the saved one, so the draft is served again.
   * `changed` is false when the intro agents get stays the same.
   */
  setIntro(by: string, raw: unknown): { intro: WorldIntro; changed: boolean } {
    if (typeof raw !== "string") throw new ContextError("text must be a string");
    const text = raw.trim();
    if (text.length > MAX_INTRO_LENGTH) throw new ContextError(`the intro is longer than ${MAX_INTRO_LENGTH} characters`);
    const saved = this.host.store.intro();
    if ((saved?.text ?? "") === text) return { intro: this.intro(), changed: false };
    this.host.store.setIntro(text, by);
    return { intro: this.intro(), changed: true };
  }

  notes(agent: string, q: { q?: string | null; topic?: string | null } = {}): AgentNote[] {
    return this.host.store.notes(agent, { q: q.q?.trim() || undefined, topic: q.topic?.trim() || undefined });
  }

  /** Someone else's notebook: people may read it, agents may not. */
  notesOf(viewer: string, agent: string): AgentNote[] {
    if (!this.host.isAgent(agent)) throw new ContextError(`unknown agent: ${agent}`, 404);
    if (viewer !== agent && !this.host.isHuman(viewer)) throw new ContextError("only people may read another agent's notes", 403);
    return this.host.store.notes(agent);
  }

  stats(agent: string) {
    return this.host.store.noteStats(agent);
  }

  remember(agent: string, body: Record<string, unknown>): AgentNote {
    const text = this.text(body.text);
    const topic = this.topic(body.topic);
    const { maxNotes } = this.host.limits();
    if (this.host.store.noteStats(agent).count >= maxNotes)
      throw new ContextError(`the notebook is full (${maxNotes} notes): change or forget a note first`, 409);
    return this.host.store.addNote(agent, text, topic ?? null);
  }

  /** Overwrites note `id`; a missing field keeps its value, an empty topic removes it. */
  change(agent: string, id: number, body: Record<string, unknown>): AgentNote {
    const old = this.host.store.note(agent, id);
    if (!old) throw new ContextError(`no note ${id}`, 404);
    const text = body.text === undefined ? old.text : this.text(body.text);
    const topic = body.topic === undefined ? (old.topic ?? null) : this.topic(body.topic);
    return this.host.store.updateNote(agent, id, text, topic ?? null)!;
  }

  forget(agent: string, id: number) {
    if (!this.host.store.deleteNote(agent, id)) throw new ContextError(`no note ${id}`, 404);
  }

  private text(raw: unknown): string {
    if (typeof raw !== "string") throw new ContextError("text must be a string");
    const text = raw.trim();
    if (!text) throw new ContextError("text is empty");
    const { maxNoteLength } = this.host.limits();
    if (text.length > maxNoteLength) throw new ContextError(`the note is longer than ${maxNoteLength} characters`);
    return text;
  }

  /** null means "no topic". */
  private topic(raw: unknown): string | null {
    if (raw == null) return null;
    if (typeof raw !== "string") throw new ContextError("topic must be a string");
    const topic = raw.trim().replace(/\s+/g, " ");
    if (topic.length > MAX_NOTE_TOPIC) throw new ContextError(`the topic is longer than ${MAX_NOTE_TOPIC} characters`);
    return topic || null;
  }
}
