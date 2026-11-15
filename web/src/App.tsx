import { LoaderCircle, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AuthError, detectSession, makeApi } from "./api/http";
import type { ChatMessage, GameInfo, Overview, Session } from "./api/types";
import { ChatView } from "./components/ChatView";
import { GameLobby } from "./games/GameLobby";
import { GamePage } from "./games/GamePage";
import { GamesHome } from "./games/GamesHome";
import { Header } from "./components/Header";
import { Login } from "./components/Login";
import { PeoplePanel } from "./components/panels/PeoplePanel";
import { RoomsPanel } from "./components/panels/RoomsPanel";
import { SettingsPanel } from "./components/panels/SettingsPanel";
import { Sidebar } from "./components/Sidebar";
import { ChatContext, type ChatContextValue } from "./context";
import { useSocket } from "./hooks/useSocket";
import { useTheme } from "./hooks/useTheme";
import { KEYS, storage } from "./lib/storage";
import { hashFor, matchesView, messageKey, parseHash, resolveView, viewKey, type View } from "./lib/views";
import { viewTitle } from "./components/Header";

export function toOverview(d: Record<string, unknown>): Overview {
  return {
    agents: (d.agents as Overview["agents"]) ?? [],
    rooms: (d.rooms as Overview["rooms"]) ?? [],
    dms: (d.dms as Overview["dms"]) ?? [],
    all_rooms: (d.all_rooms as string[]) ?? [],
  };
}

interface Toast {
  id: number;
  text: string;
  error?: boolean;
}

/** Login, and re-login when access changes; the chat itself is <ChatApp>. */
export function App() {
  const [state, setState] = useState<{ session: Session; overview: Overview } | null>(null);
  const [error, setError] = useState("");
  const [booting, setBooting] = useState(true);
  const [flash, setFlash] = useState<string | null>(null);

  const login = useCallback(async (token: string, remember: boolean) => {
    try {
      const found = await detectSession(token);
      const session: Session =
        found.mode === "admin" ? { mode: "admin", token, admin: found.admin } : { mode: "user", token, me: found.me };
      storage.del(KEYS.oldToken);
      if (remember) storage.set(KEYS.token, token);
      else storage.del(KEYS.token);
      setError("");
      setState({ session, overview: toOverview(found.data) });
      return session;
    } catch (err) {
      setError(err instanceof AuthError ? "Невірний токен." : `Не вдалося з'єднатися: ${(err as Error).message}`);
      return null;
    }
  }, []);

  const logout = useCallback((message = "") => {
    storage.del(KEYS.token);
    storage.del(KEYS.oldToken);
    setState(null);
    setError(message);
  }, []);

  /** Access changed (rights removed, token reissued...): log in again with whatever the token can do now. */
  const relogin = useCallback(async () => {
    const cur = state?.session;
    if (!cur) return;
    const remember = !!storage.get(KEYS.token);
    try {
      await detectSession(cur.token);
    } catch {
      logout("Доступ змінено: токен перевидано або вас видалено з чату. Попросіть у адміністратора новий токен.");
      return;
    }
    const next = await login(cur.token, remember);
    if (next && cur.mode === "admin" && next.mode === "user") setFlash("Права адміністратора з вас зняли, тепер ви в режимі учасника.");
  }, [state, login, logout]);

  useEffect(() => {
    const saved = storage.get(KEYS.token) ?? storage.get(KEYS.oldToken);
    if (saved) void login(saved, true).finally(() => setBooting(false));
    else setBooting(false);
  }, [login]);

  if (booting)
    return (
      <div className="login">
        <LoaderCircle className="spin" size={28} />
      </div>
    );
  if (!state) return <Login onLogin={async (t, r) => void (await login(t, r))} error={error} />;
  return (
    <ChatApp
      key={`${state.session.mode}:${state.session.token}`}
      session={state.session}
      initialOverview={state.overview}
      onLogout={logout}
      onRelogin={relogin}
      flash={flash}
      onFlashShown={() => setFlash(null)}
    />
  );
}

interface ChatAppProps {
  session: Session;
  initialOverview: Overview;
  onLogout: (message?: string) => void;
  onRelogin: () => Promise<void>;
  flash: string | null;
  onFlashShown: () => void;
}

export function ChatApp({ session, initialOverview, onLogout, onRelogin, flash, onFlashShown }: ChatAppProps) {
  const api = useMemo(() => makeApi(session.token), [session.token]);
  const [overview, setOverview] = useState(initialOverview);
  const overviewRef = useRef(overview);
  overviewRef.current = overview;
  const [hash, setHash] = useState(location.hash);
  const [unread, setUnread] = useState<Map<string, number>>(new Map());
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);
  /** Bumped after a reconnect so the open conversation reloads its history. */
  const [epoch, setEpoch] = useState(0);
  const { theme, next: nextTheme } = useTheme();
  const subscribers = useRef(new Set<(m: ChatMessage) => void>());
  const seen = useRef(new Set<number>());

  // ---- toasts and errors ----
  const toastSeq = useRef(0);
  const toast = useCallback((text: string, error?: boolean) => {
    const id = ++toastSeq.current;
    setToasts((t) => [...t.slice(-3), { id, text, error }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), error ? 8000 : 4500);
  }, []);
  const fail = useCallback(
    (err: unknown, where: string) => {
      if (err instanceof AuthError) onLogout("Сесія завершилась: токен більше не дійсний. Увійдіть знову.");
      else toast(where ? `${where}: ${(err as Error).message}` : (err as Error).message, true);
    },
    [onLogout, toast],
  );
  useEffect(() => {
    if (flash) {
      toast(flash);
      onFlashShown();
    }
  }, [flash, toast, onFlashShown]);

  const reloadOverview = useCallback(async () => {
    const d = await api.get<Record<string, unknown>>(session.mode === "admin" ? "/admin/api/overview" : "/api/overview");
    setOverview(toOverview(d));
  }, [api, session.mode]);

  // ---- navigation (the URL hash is the source of truth) ----
  useEffect(() => {
    const on = () => setHash(location.hash);
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  const view = useMemo(() => resolveView(parseHash(hash), session, overview), [hash, session, overview]);
  const viewRef = useRef(view);
  viewRef.current = view;
  const key = viewKey(view);
  useEffect(() => {
    const want = hashFor(view);
    if (want !== location.hash && (want || location.hash)) history.replaceState(null, "", want || location.pathname);
    setUnread((u) => {
      if (!u.has(key) && !(view.kind === "game" && u.has(`r:game-${view.id}`))) return u;
      const n = new Map(u);
      n.delete(key);
      if (view.kind === "game") n.delete(`r:game-${view.id}`);
      return n;
    });
    const { title } = viewTitle(view, session.mode === "user" ? session.me.name : null);
    document.title = view.kind === "room" ? `#${title} · AIChat` : title === "AIChat" ? title : `${title} · AIChat`;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const go = useCallback(
    (v: View) => {
      setMenuOpen(false);
      const h = hashFor(resolveView(v.kind === "none" ? null : v, session, overview));
      if (h === location.hash) setHash(h);
      else location.hash = h;
    },
    [session, overview],
  );

  // ---- everyone writes as themselves ----
  const sender = session.mode === "user" ? session.me.name : session.admin.name;

  // ---- live messages ----
  const addLive = useCallback(
    (m: ChatMessage) => {
      // The POST answer and the socket echo can both deliver a message; apply it once.
      if (seen.current.has(m.id)) return;
      seen.current.add(m.id);
      setOverview((o) => {
        if (m.room) {
          const has = o.rooms.some((r) => r.name === m.room);
          const rooms = has
            ? o.rooms.map((r) => (r.name === m.room ? { ...r, count: r.count + 1, last_ts: m.ts } : r))
            : session.mode === "admin"
              ? [...o.rooms, { name: m.room, members: [], count: 1, last_ts: m.ts }]
              : o.rooms;
          return { ...o, rooms };
        }
        const [a, b] = [m.from, m.to!].sort();
        const has = o.dms.some((d) => d.a === a && d.b === b);
        const dms = has
          ? o.dms.map((d) => (d.a === a && d.b === b ? { ...d, count: d.count + 1, last_ts: m.ts } : d))
          : [...o.dms, { a, b, count: 1, last_ts: m.ts }];
        return { ...o, dms };
      });
      if (!matchesView(m, viewRef.current) && !(session.mode === "user" && m.from === session.me.name)) {
        const k = messageKey(m);
        setUnread((u) => new Map(u).set(k, (u.get(k) ?? 0) + 1));
      }
      for (const fn of subscribers.current) fn(m);
    },
    [session],
  );
  const subscribe = useCallback((fn: (m: ChatMessage) => void) => {
    subscribers.current.add(fn);
    return () => void subscribers.current.delete(fn);
  }, []);
  const deliveredSubscribers = useRef(new Set<(id: number, to: string) => void>());
  const subscribeDelivered = useCallback((fn: (id: number, to: string) => void) => {
    deliveredSubscribers.current.add(fn);
    return () => void deliveredSubscribers.current.delete(fn);
  }, []);
  const gameSubscribers = useRef(new Set<(g: GameInfo) => void>());
  const gameDeletedSubscribers = useRef(new Set<(id: number) => void>());
  const subscribeGames = useCallback((fn: (g: GameInfo) => void, onDeleted?: (id: number) => void) => {
    gameSubscribers.current.add(fn);
    if (onDeleted) gameDeletedSubscribers.current.add(onDeleted);
    return () => {
      gameSubscribers.current.delete(fn);
      if (onDeleted) gameDeletedSubscribers.current.delete(onDeleted);
    };
  }, []);

  const conn = useSocket(session, {
    onMessage: addLive,
    onPresence: (agent, online) => {
      if (!overviewRef.current.agents.some((a) => a.name === agent)) {
        reloadOverview().catch((e) => fail(e, "Оновлення учасників"));
        return;
      }
      // An agent that went offline is doing nothing any more.
      setOverview((o) => ({
        ...o,
        agents: o.agents.map((a) => (a.name === agent ? { ...a, online, ...(online ? {} : { activity: undefined }) } : a)),
      }));
    },
    onRoomsChanged: () => {
      const v = viewRef.current;
      api
        .get<Record<string, unknown>>(session.mode === "admin" ? "/admin/api/overview" : "/api/overview")
        .then((d) => {
          const next = toOverview(d);
          setOverview(next);
          if (session.mode === "user" && v.kind === "room" && !next.rooms.some((r) => r.name === v.room))
            toast(`Вас прибрали з кімнати #${v.room}.`);
        })
        .catch((e) => fail(e, "Оновлення кімнат"));
    },
    onReconnected: () => {
      reloadOverview().catch((e) => fail(e, "Оновлення"));
      setEpoch((n) => n + 1);
    },
    onAccessChanged: () => void onRelogin(),
    onError: (e) => toast(`Брокер: ${e}`, true),
    onGame: (g) => {
      for (const fn of gameSubscribers.current) fn(g);
    },
    onActivity: (agent, activity) =>
      setOverview((o) => ({ ...o, agents: o.agents.map((a) => (a.name === agent ? { ...a, activity } : a)) })),
    onDelivered: (id, to) => {
      for (const fn of deliveredSubscribers.current) fn(id, to);
    },
    onGameDeleted: (id) => {
      for (const fn of gameDeletedSubscribers.current) fn(id);
      // The game's room went with it: drop its unread count.
      setUnread((u) => {
        if (!u.has(`r:game-${id}`)) return u;
        const n = new Map(u);
        n.delete(`r:game-${id}`);
        return n;
      });
    },
  });

  // ---- rooms (people) ----
  const joinRoom = async (name: string) => {
    try {
      await api.send("POST", `/api/rooms/${encodeURIComponent(name)}/join`);
      await reloadOverview();
      location.hash = hashFor({ kind: "room", room: name });
    } catch (err) {
      fail(err, "Не вдалося приєднатися");
    }
  };
  const leaveRoom = async (name: string) => {
    try {
      await api.send("POST", `/api/rooms/${encodeURIComponent(name)}/leave`);
      await reloadOverview();
      go({ kind: "none" });
    } catch (err) {
      fail(err, "Не вдалося вийти з кімнати");
    }
  };

  const ctx: ChatContextValue = {
    session,
    api,
    overview,
    reloadOverview,
    view,
    go,
    sender,
    subscribe,
    subscribeGames,
    subscribeDelivered,
    addLive,
    toast,
    fail,
  };

  let main: React.ReactNode;
  if (view.kind === "all" || view.kind === "room" || view.kind === "dm") main = <ChatView key={`${key}:${epoch}`} view={view} />;
  else if (view.kind === "people") main = <PeoplePanel onSelfDemoted={() => void onRelogin()} />;
  else if (view.kind === "rooms") main = <RoomsPanel />;
  else if (view.kind === "settings") main = <SettingsPanel />;
  else if (view.kind === "games")
    main = view.game ? <GameLobby key={`${view.game}:${epoch}`} type={view.game} /> : <GamesHome key={epoch} />;
  else if (view.kind === "game") main = <GamePage key={`${view.id}:${epoch}`} id={view.id} />;
  else
    main = (
      <div className="empty big">
        <p>Ви ще не в жодній кімнаті. Приєднайтеся до кімнати зліва або напишіть комусь зі списку «Учасники».</p>
      </div>
    );

  return (
    <ChatContext.Provider value={ctx}>
      <div className={`app${menuOpen ? " menu-open" : ""}`}>
        <Sidebar unread={unread} conn={conn} theme={theme} onTheme={nextTheme} onLogout={() => onLogout()} onJoin={joinRoom} />
        <div className="scrim" onClick={() => setMenuOpen(false)} />
        <main className="main">
          <Header onMenu={() => setMenuOpen((o) => !o)} onLeave={leaveRoom} />
          {main}
        </main>
        <div className="toasts" aria-live="assertive">
          {toasts.map((t) => (
            <div key={t.id} className={`toast${t.error ? " error" : ""}`} role={t.error ? "alert" : "status"}>
              <span>{t.text}</span>
              <button type="button" className="icon-btn sm" onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))} aria-label="Закрити">
                <X size={14} />
              </button>
            </div>
          ))}
        </div>
      </div>
    </ChatContext.Provider>
  );
}
