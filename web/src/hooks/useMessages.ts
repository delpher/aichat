import { useCallback, useEffect, useRef, useState } from "react";
import { HttpError } from "../api/http";
import type { ChatMessage } from "../api/types";
import { useChat } from "../context";
import { historyPath, matchesView, viewKey, type View } from "../lib/views";

export const PAGE = 100;

/** Messages of one view: the latest page, older pages on demand, and live ones as they arrive. */
export function useMessages(view: View) {
  const chat = useChat();
  const { api, session, subscribe, subscribeDelivered, subscribeThanks, subscribeReactions } = chat;
  // callbacks that change with every overview update; read through a ref so the history isn't refetched
  const cb = useRef(chat);
  cb.current = chat;
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [hasOlder, setHasOlder] = useState(false);
  const [loading, setLoading] = useState(true);
  /** Bumped when a page of older messages was prepended (the list keeps its scroll position). */
  const [olderLoads, setOlderLoads] = useState(0);
  const seq = useRef(0);
  const key = viewKey(view);
  const viewRef = useRef(view);
  viewRef.current = view;

  const load = useCallback(
    async (before?: number) => {
      const mine = ++seq.current;
      setLoading(true);
      try {
        const data = await api.get<{ messages: ChatMessage[] }>(historyPath(viewRef.current, session, PAGE, before));
        if (mine !== seq.current) return;
        const got = data.messages ?? [];
        setHasOlder(got.length >= PAGE);
        if (before) {
          setMessages((cur) => {
            const ids = new Set(cur.map((m) => m.id));
            return [...got.filter((m) => !ids.has(m.id)), ...cur];
          });
          setOlderLoads((n) => n + 1);
        } else {
          // keep live messages that arrived while the page was loading
          const lastId = got.length ? got[got.length - 1].id : 0;
          setMessages((cur) => [...got, ...cur.filter((m) => m.id > lastId)]);
        }
      } catch (err) {
        if (mine !== seq.current) return;
        if (err instanceof HttpError && err.status === 403 && session.mode === "user") {
          // removed from the room elsewhere: refresh and pick another view
          await cb.current.reloadOverview().catch(() => {});
          cb.current.go({ kind: "none" });
          return;
        }
        cb.current.fail(err, "Завантаження повідомлень");
      } finally {
        if (mine === seq.current) setLoading(false);
      }
    },
    [api, session],
  );

  useEffect(() => {
    setMessages([]);
    setHasOlder(false);
    void load();
    const offMsg = subscribe((m) => {
      if (!matchesView(m, viewRef.current)) return;
      setMessages((cur) => (cur.some((x) => x.id === m.id) ? cur : [...cur, m]));
    });
    const offDelivered = subscribeDelivered((id, to) =>
      setMessages((cur) =>
        cur.some((m) => m.id === id && !m.delivered_to?.includes(to))
          ? cur.map((m) => (m.id === id ? { ...m, delivered_to: [...(m.delivered_to ?? []), to] } : m))
          : cur,
      ),
    );
    const offThanks = subscribeThanks((id, thankedBy) =>
      setMessages((cur) => (cur.some((m) => m.id === id) ? cur.map((m) => (m.id === id ? { ...m, thanked_by: thankedBy } : m)) : cur)),
    );
    const offReactions = subscribeReactions((id, reactions) =>
      setMessages((cur) => (cur.some((m) => m.id === id) ? cur.map((m) => (m.id === id ? { ...m, reactions } : m)) : cur)),
    );
    return () => {
      offMsg();
      offDelivered();
      offThanks();
      offReactions();
    };
    // `key` identifies the view; the object itself changes identity on every navigation
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, load, subscribe, subscribeDelivered, subscribeThanks, subscribeReactions]);

  const loadOlder = useCallback(() => {
    if (!loading && messages.length) void load(messages[0].id);
  }, [loading, messages, load]);

  return { messages, hasOlder, loading, loadOlder, olderLoads, reload: () => load() };
}
