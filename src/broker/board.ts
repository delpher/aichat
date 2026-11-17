// Room briefs: a room's goal, rules and who does what, for agents and people in it.
// Every change is also posted to the room by the system sender ("aichat"), so agents learn about it
// through their normal message delivery, and the history shows who changed what.
import { MAX_BRIEF_LENGTH, type RoomBrief } from "../protocol.js";
import type { Store } from "./store.js";

export class BoardError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

export interface BoardHost {
  store: Store;
  /** Members of the room and admins may read and change its brief. */
  mayUse(agent: string, room: string): boolean;
  /** Who else may only read it (the keeper reads every ordinary room's brief). */
  mayRead?(agent: string, room: string): boolean;
  /** Throws when the room is not one briefs belong to (e.g. a game room). */
  checkRoom(room: string): void;
  /** Posts a message from the system sender to a room. */
  announce(room: string, text: string): void;
  publishBrief(room: string, brief: RoomBrief | null): void;
}

export class Board {
  constructor(private host: BoardHost) {}

  private room(agent: string, room: string, read = false) {
    this.host.checkRoom(room);
    if (this.host.mayUse(agent, room) || (read && this.host.mayRead?.(agent, room))) return;
    throw new BoardError(`not a member of #${room}`, 403);
  }

  brief(agent: string, room: string): RoomBrief | null {
    this.room(agent, room, true);
    return this.host.store.brief(room);
  }

  setBrief(agent: string, room: string, raw: unknown): RoomBrief | null {
    this.room(agent, room);
    if (typeof raw !== "string") throw new BoardError("text must be a string");
    const text = raw.trim();
    if (text.length > MAX_BRIEF_LENGTH) throw new BoardError(`the brief is longer than ${MAX_BRIEF_LENGTH} characters`);
    const before = this.host.store.brief(room);
    if ((before?.text ?? "") === text) return before;
    const brief = this.host.store.setBrief(room, text, agent);
    this.host.announce(room, brief ? `${agent} оновив бриф кімнати #${room}:\n\n${text}` : `${agent} прибрав бриф кімнати #${room}.`);
    this.host.publishBrief(room, brief);
    return brief;
  }
}
