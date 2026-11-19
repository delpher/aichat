import { useEffect, useRef, useState } from "react";
import type { AdapterInfo, AgentActivity, ChatMessage, GameInfo, GameRatings, RoomBrief, ServerFrame, Session, UsageReport } from "../api/types";

export type ConnStatus = "connecting" | "online" | "offline";

export interface SocketHandlers {
  onMessage: (m: ChatMessage) => void;
  onPresence: (agent: string, online: boolean, adapter?: AdapterInfo) => void;
  /** Rooms or memberships changed: re-read the overview. */
  onRoomsChanged: () => void;
  /** Reconnected after a drop: refetch to fill the gap. */
  onReconnected: () => void;
  /** The broker closed the socket because access changed (4003) or rejected the token. */
  onAccessChanged: (reason: string) => void;
  onError: (error: string) => void;
  /** A game was created or changed. */
  onGame?: (game: GameInfo) => void;
  /** A game (with its room and messages) was deleted. */
  onGameDeleted?: (id: number) => void;
  /** The players' ratings in one kind of game changed. */
  onRatings?: (game: string, ratings: GameRatings) => void;
  /** An agent started working, waits for a person, or is done. */
  onActivity?: (agent: string, activity: AgentActivity) => void;
  /** Agent `to` received message `id`. */
  onDelivered?: (id: number, to: string) => void;
  onThanks?: (id: number, author: string, thankedBy: string[]) => void;
  /** A room's brief changed (null: removed). */
  onBrief?: (room: string, brief: RoomBrief | null) => void;
  /** An agent reported its account's usage (only to those who may see it). */
  onUsage?: (usage: UsageReport) => void;
}

/**
 * Live connection to the broker. Admins get the observer feed (every message),
 * people their own socket (only their messages). Reconnects with backoff.
 */
export function useSocket(session: Session, handlers: SocketHandlers): { status: ConnStatus; retryIn: number } {
  const [status, setStatus] = useState<ConnStatus>("connecting");
  const [retryIn, setRetryIn] = useState(0);
  const h = useRef(handlers);
  h.current = handlers;

  useEffect(() => {
    let ws: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let retries = 0;
    let stopped = false;
    // An admin asks for the observer feed; without it they would get only their own messages.
    const observer = session.mode === "admin";

    const connect = () => {
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      const sock = new WebSocket(`${proto}//${location.host}/ws`);
      ws = sock;
      let welcomed = false;
      setStatus("connecting");
      sock.onopen = () => sock.send(JSON.stringify({ type: "auth", token: session.token, ...(observer ? { observer: true } : {}) }));
      sock.onmessage = (ev) => {
        let f: ServerFrame;
        try {
          f = JSON.parse(String(ev.data));
        } catch {
          return;
        }
        switch (f.type) {
          case "welcome": {
            const wasRetry = retries > 0;
            welcomed = true;
            retries = 0;
            setStatus("online");
            if (wasRetry) h.current.onReconnected();
            break;
          }
          case "message":
            h.current.onMessage(f.message);
            break;
          case "presence":
            h.current.onPresence(f.agent, f.online, f.adapter);
            break;
          case "game":
            h.current.onGame?.(f.game);
            break;
          case "activity":
            h.current.onActivity?.(f.agent, f.activity);
            break;
          case "delivered":
            h.current.onDelivered?.(f.id, f.to);
            break;
          case "thanks":
            h.current.onThanks?.(f.id, f.author, f.thanked_by);
            break;
          case "brief":
            h.current.onBrief?.(f.room, f.brief);
            break;
          case "usage":
            h.current.onUsage?.(f.usage);
            break;
          case "game_deleted":
            h.current.onGameDeleted?.(f.id);
            break;
          case "ratings":
            h.current.onRatings?.(f.game, f.ratings);
            break;
          case "rooms":
          case "rooms_changed":
            h.current.onRoomsChanged();
            break;
          case "error":
            if (!welcomed) {
              stopped = true;
              sock.close();
              h.current.onAccessChanged(f.error);
            } else h.current.onError(f.error);
            break;
        }
      };
      sock.onclose = (ev) => {
        if (stopped || ws !== sock) return;
        if (ev.code === 4003) {
          stopped = true;
          h.current.onAccessChanged(ev.reason || "access changed");
          return;
        }
        retries += 1;
        const delay = Math.min(15000, 1000 * 2 ** Math.min(retries - 1, 4));
        setStatus("offline");
        setRetryIn(Math.round(delay / 1000));
        timer = setTimeout(connect, delay);
      };
    };
    connect();
    return () => {
      stopped = true;
      clearTimeout(timer);
      ws?.close();
    };
  }, [session]);

  return { status, retryIn };
}
