import { createContext, useContext } from "react";
import type { Api } from "./api/http";
import type { ChatMessage, GameInfo, GameRatings, Overview, RoomBrief, Session } from "./api/types";
import type { View } from "./lib/views";

export interface ChatContextValue {
  session: Session;
  api: Api;
  overview: Overview;
  reloadOverview: () => Promise<void>;
  view: View;
  go: (v: View) => void;
  /** Who is logged in, and so who messages are sent as. */
  sender: string;
  /** Live messages for the open view; returns an unsubscribe function. */
  subscribe: (fn: (m: ChatMessage) => void) => () => void;
  /** Live game updates; returns an unsubscribe function. */
  subscribeGames: (fn: (g: GameInfo) => void, onDeleted?: (id: number) => void) => () => void;
  /** Live rating changes of a kind of game; returns an unsubscribe function. */
  subscribeRatings: (fn: (game: string, ratings: GameRatings) => void) => () => void;
  /** Delivery receipts (agent `to` received message `id`); returns an unsubscribe function. */
  subscribeDelivered: (fn: (id: number, to: string) => void) => () => void;
  /** Thanks on message `id` (`thankedBy` is the full list); returns an unsubscribe function. */
  subscribeThanks: (fn: (id: number, thankedBy: string[]) => void) => () => void;
  /** Live brief changes of rooms; returns an unsubscribe function. */
  subscribeBoard: (fn: (e: BoardEvent) => void) => () => void;
  /** A message we just sent (the POST answer); applied once even if the socket echoes it. */
  addLive: (m: ChatMessage) => void;
  toast: (text: string, error?: boolean) => void;
  /** Shows an error, or ends the session if the token stopped working. */
  fail: (err: unknown, where: string) => void;
  /** Opens a room from a #room reference: joins it first when a person is not a member yet. */
  openRoom: (room: string) => void;
  /** Opens a message's conversation and scrolls to it (loading older pages if needed). */
  openMessage: (m: ChatMessage) => void;
  /** A message to show once its conversation is open (`key` is the conversation's viewKey). */
  focus: { key: string; id: number } | null;
  clearFocus: () => void;
  /** Replies folded into threads (true) or shown in the feed. */
  threaded: boolean;
  setThreaded: (on: boolean) => void;
}

export type BoardEvent = { kind: "brief"; room: string; brief: RoomBrief | null };

export const ChatContext = createContext<ChatContextValue | null>(null);

export function useChat(): ChatContextValue {
  const c = useContext(ChatContext);
  if (!c) throw new Error("useChat outside ChatContext");
  return c;
}

export const isAdmin = (s: Session) => s.mode === "admin";
export const myName = (s: Session) => (s.mode === "user" ? s.me.name : s.admin.name);
