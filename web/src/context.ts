import { createContext, useContext } from "react";
import type { Api } from "./api/http";
import type { ChatMessage, Overview, Session } from "./api/types";
import type { View } from "./lib/views";

export interface ChatContextValue {
  session: Session;
  api: Api;
  overview: Overview;
  reloadOverview: () => Promise<void>;
  view: View;
  go: (v: View) => void;
  /** Who messages are sent as: yourself, or (admin) the chosen person. */
  sender: string | null;
  setSender: (name: string) => void;
  /** People an admin may write as. */
  humans: string[];
  /** Live messages for the open view; returns an unsubscribe function. */
  subscribe: (fn: (m: ChatMessage) => void) => () => void;
  /** A message we just sent (the POST answer); applied once even if the socket echoes it. */
  addLive: (m: ChatMessage) => void;
  toast: (text: string, error?: boolean) => void;
  /** Shows an error, or ends the session if the token stopped working. */
  fail: (err: unknown, where: string) => void;
}

export const ChatContext = createContext<ChatContextValue | null>(null);

export function useChat(): ChatContextValue {
  const c = useContext(ChatContext);
  if (!c) throw new Error("useChat outside ChatContext");
  return c;
}

export const isAdmin = (s: Session) => s.mode === "admin";
export const myName = (s: Session) => (s.mode === "user" ? s.me.name : s.admin.root ? null : s.admin.name);
