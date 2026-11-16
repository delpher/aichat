import { render } from "@testing-library/react";
import { vi } from "vitest";
import type { Api } from "../api/http";
import type { ChatMessage, Overview, Session } from "../api/types";
import { ChatContext, type ChatContextValue } from "../context";

export const userSession: Session = { mode: "user", token: "t", me: { name: "olena", kind: "human" } };
export const adminSession: Session = { mode: "admin", token: "t", admin: { name: "alexey" } };

export const overview: Overview = {
  agents: [
    { name: "olena", kind: "human", online: true, rooms: ["lobby"] },
    { name: "alexey", kind: "human", online: false, rooms: ["lobby"], admin: true },
    { name: "claude", kind: "claude", online: true, rooms: ["lobby"], description: "Claude agent" },
  ],
  rooms: [{ name: "lobby", members: ["alexey", "claude", "olena"], count: 2, last_ts: "2026-11-15T09:00:00Z" }],
  dms: [],
  all_rooms: ["lobby", "random"],
};

export function msg(p: Partial<ChatMessage> & { id: number }): ChatMessage {
  return { from: "claude", room: "lobby", text: "hi", ts: "2026-11-15T09:00:00Z", hops: 0, ...p };
}

export function fakeApi(over: Record<string, unknown> = {}): Api {
  return {
    get: vi.fn(async () => ({ messages: [] })),
    send: vi.fn(async () => ({})),
    upload: vi.fn(async (_p: string, f: File) => ({ id: `id-${f.name}`, name: f.name, mime: f.type, size: f.size })),
    blob: vi.fn(async () => new Blob(["x"])),
    ...over,
  } as Api;
}

export function renderWithChat(ui: React.ReactNode, over: Partial<ChatContextValue> = {}) {
  const value: ChatContextValue = {
    session: userSession,
    api: fakeApi(),
    overview,
    reloadOverview: vi.fn(async () => {}),
    view: { kind: "room", room: "lobby" },
    go: vi.fn(),
    sender: "olena",
    subscribe: () => () => {},
    subscribeGames: () => () => {},
    subscribeDelivered: () => () => {},
    addLive: vi.fn(),
    toast: vi.fn(),
    fail: vi.fn(),
    ...over,
  };
  return { ...render(<ChatContext.Provider value={value}>{ui}</ChatContext.Provider>), ctx: value };
}
