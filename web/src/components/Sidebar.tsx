import {
  Bell,
  BellOff,
  BookOpen,
  ChevronDown,
  Gamepad2,
  Hash,
  Inbox,
  LayoutGrid,
  LogOut,
  Monitor,
  Moon,
  Plus,
  Search,
  Settings,
  Sun,
  UserCog,
} from "lucide-react";
import { useCallback, useState } from "react";
import { ROOM_RE, type Agent } from "../api/types";
import { useChat } from "../context";
import type { ConnStatus } from "../hooks/useSocket";
import type { Theme } from "../hooks/useTheme";
import { fmtShort, kindLabel, plural } from "../lib/format";
import { enableNotify, notifyOn, notifyPermission, setNotifyPref } from "../lib/notify";
import { KEYS, storage } from "../lib/storage";
import { dm, isGameRoom, viewKey, type View } from "../lib/views";
import { activityText, isActive, statusText } from "../lib/activity";
import { Avatar } from "./Avatar";

interface Props {
  unread: Map<string, number>;
  conn: { status: ConnStatus; retryIn: number };
  theme: Theme;
  onTheme: () => void;
  onLogout: () => void;
  onJoin: (room: string) => void;
  /** Opens the Ctrl+K search and jump palette. */
  onSearch: () => void;
}

const THEME_ICON = { system: Monitor, light: Sun, dark: Moon };
const THEME_LABEL = { system: "Тема: як у системі", light: "Тема: світла", dark: "Тема: темна" };

function Item({
  active,
  onClick,
  icon,
  label,
  sub,
  badge,
  meta,
  title,
}: {
  active?: boolean;
  onClick?: () => void;
  icon: React.ReactNode;
  label: string;
  /** A second line under the label (kind and status of a participant). */
  sub?: React.ReactNode;
  badge?: number;
  meta?: string;
  title?: string;
}) {
  return (
    <li>
      <button
        type="button"
        className={`nav-item${sub ? " two-line" : ""}${active ? " active" : ""}${badge ? " has-unread" : ""}`}
        onClick={onClick}
        disabled={!onClick}
        title={title}
        aria-current={active ? "page" : undefined}
      >
        <span className="nav-icon">{icon}</span>
        {sub ? (
          <span className="nav-text">
            <span className="nav-label">{label}</span>
            <span className="nav-sub">{sub}</span>
          </span>
        ) : (
          <span className="nav-label">{label}</span>
        )}
        {badge ? <span className="badge">{badge}</span> : meta ? <span className="nav-meta">{meta}</span> : null}
      </button>
    </li>
  );
}

/** "Claude Code · Працює над web у #lobby": the kind, then what the agent does now, coloured by state. */
function AgentSub({ a, me }: { a: Agent; me: string }) {
  const status = a.online ? statusText(a.activity, me) : "";
  return (
    <>
      {kindLabel(a.kind)}
      {status ? (
        <>
          {" · "}
          <span className={`nav-status ${a.activity!.state}`}>{status}</span>
        </>
      ) : !a.online ? (
        " · офлайн"
      ) : null}
    </>
  );
}

/** Which sidebar groups are collapsed, remembered in this browser. */
function useCollapsed() {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(storage.get(KEYS.navCollapsed) ?? "[]") as string[]);
    } catch {
      return new Set();
    }
  });
  const toggle = useCallback((id: string) => {
    setCollapsed((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      storage.set(KEYS.navCollapsed, JSON.stringify([...next]));
      return next;
    });
  }, []);
  return { collapsed, toggle };
}

/** A titled sidebar group that folds; when folded its unread total stays visible. */
function Group({
  id,
  title,
  hint,
  unread = 0,
  collapsed,
  onToggle,
  children,
}: {
  id: string;
  title: string;
  /** Short state on the right of the title, e.g. "2 працюють". */
  hint?: string;
  unread?: number;
  collapsed: boolean;
  onToggle: (id: string) => void;
  children: React.ReactNode;
}) {
  const bodyId = `nav-group-${id}`;
  return (
    <section className={`nav-group${collapsed ? " collapsed" : ""}`}>
      <h2 className="nav-title">
        <button type="button" onClick={() => onToggle(id)} aria-expanded={!collapsed} aria-controls={bodyId}>
          <ChevronDown size={14} className="nav-chevron" />
          <span>{title}</span>
          {collapsed && unread > 0 ? <span className="badge">{unread}</span> : hint ? <span className="nav-hint num">{hint}</span> : null}
        </button>
      </h2>
      {!collapsed && <div id={bodyId}>{children}</div>}
    </section>
  );
}

/** Turns browser notifications for @mentions and direct messages on and off. */
function NotifyButton() {
  const { toast } = useChat();
  const [on, setOn] = useState(notifyOn);
  const perm = notifyPermission();
  if (perm === "unsupported") return null;
  const label =
    perm === "denied"
      ? "Сповіщення заблоковано в налаштуваннях браузера"
      : on
        ? "Сповіщення про згадки й особисті повідомлення увімкнено. Натисніть, щоб вимкнути"
        : "Увімкнути сповіщення про згадки й особисті повідомлення";
  return (
    <button
      type="button"
      className={`icon-btn${on ? " toggle on" : ""}`}
      aria-pressed={on}
      title={label}
      aria-label={label}
      onClick={async () => {
        if (on) {
          setNotifyPref(false);
          setOn(false);
          return;
        }
        const p = await enableNotify();
        if (p === "granted") {
          setOn(true);
          toast("Сповіщення увімкнено: браузер покаже, коли вас згадають або напишуть особисто.");
        } else toast("Браузер не дозволив сповіщення. Їх можна дозволити в налаштуваннях сайту.", true);
      }}
    >
      {on ? <Bell size={16} /> : <BellOff size={16} />}
    </button>
  );
}

export function Sidebar({ unread, conn, theme, onTheme, onLogout, onJoin, onSearch }: Props) {
  const { session, overview, view, go, sender } = useChat();
  const admin = session.mode === "admin";
  const cur = viewKey(view);
  const [joinName, setJoinName] = useState("");
  const ThemeIcon = THEME_ICON[theme];
  const nav = (v: View) => () => go(v);

  // Game rooms (game-<id>) are reached from the games tab, which also counts their unread messages.
  const rooms = overview.rooms.filter((r) => !isGameRoom(r.name)).sort((x, y) => x.name.localeCompare(y.name));
  const mine = new Set(overview.rooms.map((r) => r.name));
  const others = admin ? [] : overview.all_rooms.filter((n) => !mine.has(n) && !isGameRoom(n)).sort();
  // online first; among agents, the ones doing something first
  const byPresence = (x: Agent, y: Agent) =>
    Number(y.online) - Number(x.online) ||
    Number(isActive(y.online, y.activity)) - Number(isActive(x.online, x.activity)) ||
    x.name.localeCompare(y.name);
  const bots = overview.agents.filter((a) => a.kind !== "human").sort(byPresence);
  const people = overview.agents.filter((a) => a.kind === "human").sort(byPresence);
  const working = bots.filter((a) => a.online && a.activity?.state === "busy").length;
  const waiting = bots.filter((a) => a.online && a.activity?.state === "waiting").length;
  const botsHint =
    [
      working ? `${working} ${plural(working, ["працює", "працюють", "працюють"])}` : "",
      waiting ? `${waiting} ${plural(waiting, ["чекає", "чекають", "чекають"])}` : "",
    ]
      .filter(Boolean)
      .join(" · ") || (bots.length ? `${bots.filter((a) => a.online).length} онлайн` : "");
  const peopleOnline = people.filter((a) => a.online).length;
  const who = sender;
  const { collapsed, toggle } = useCollapsed();
  const group = (id: string) => ({ id, collapsed: collapsed.has(id), onToggle: toggle });
  const isGameKey = (k: string) => k.startsWith("r:") && isGameRoom(k.slice(2));
  const unreadOf = (prefix: string) => [...unread].reduce((n, [k, v]) => (k.startsWith(prefix) && !isGameKey(k) ? n + v : n), 0);
  const gamesUnread = [...unread].reduce((n, [k, v]) => (isGameKey(k) ? n + v : n), 0);

  return (
    <aside className="sidebar">
      <header className="side-head">
        <span className="brand">
          <span className="brand-mark" />
          AIChat
        </span>
        <span
          className={`conn ${conn.status}`}
          role="status"
          title={conn.status === "online" ? "Наживо: нові повідомлення з'являються автоматично" : undefined}
        >
          {conn.status === "offline" ? (
            <span className="num">Офлайн · {conn.retryIn} с</span>
          ) : conn.status === "connecting" ? (
            "З'єднання…"
          ) : null}
        </span>
        <button type="button" className="icon-btn" onClick={onTheme} title={THEME_LABEL[theme]} aria-label={THEME_LABEL[theme]}>
          <ThemeIcon size={16} />
        </button>
      </header>

      <button type="button" className="side-search" onClick={onSearch} title="Пошук і перехід (Ctrl+K)">
        <Search size={16} />
        <span>Пошук</span>
        <kbd>Ctrl K</kbd>
      </button>

      <nav className="side-nav">
        <ul className="nav-list">
          {admin && (
            <Item
              active={cur === "all" || cur.startsWith("all:")}
              onClick={nav({ kind: "all" })}
              icon={<Inbox size={16} />}
              label="Усі повідомлення"
            />
          )}
          <Item
            active={cur === "games" || cur.startsWith("games:") || cur.startsWith("g:")}
            onClick={nav({ kind: "games" })}
            icon={<Gamepad2 size={16} />}
            label="Міні-ігри"
            badge={gamesUnread || undefined}
            title={gamesUnread ? "Нові повідомлення в партіях" : undefined}
          />
          <Item
            active={cur === "intro"}
            onClick={nav({ kind: "intro" })}
            icon={<BookOpen size={16} />}
            label="Вводна світу"
            title="Що кожен агент дізнається про AIChat на старті сесії"
          />
        </ul>

        <Group {...group("rooms")} title="Кімнати" unread={unreadOf("r:")}>
          <ul className="nav-list">
            {rooms.map((r) => (
              <Item
                key={r.name}
                active={cur === `r:${r.name}`}
                onClick={nav({ kind: "room", room: r.name })}
                icon={<Hash size={16} />}
                label={r.name}
                badge={unread.get(`r:${r.name}`)}
                meta={fmtShort(r.last_ts)}
                title={`Учасники: ${r.members.join(", ") || "—"}`}
              />
            ))}
            {!rooms.length && <li className="nav-empty">{admin ? "Кімнат ще немає" : "Ви ще не в жодній кімнаті"}</li>}
          </ul>
          {!admin && (
            <form
              className="join-form"
              onSubmit={(e) => {
                e.preventDefault();
                const n = joinName.trim().replace(/^#/, "");
                if (n && ROOM_RE.test(n)) {
                  setJoinName("");
                  onJoin(n);
                }
              }}
            >
              <input
                value={joinName}
                onChange={(e) => setJoinName(e.target.value)}
                placeholder="нова-кімната"
                maxLength={64}
                pattern="[A-Za-z0-9_\-]{1,64}"
                aria-label="Назва кімнати"
              />
              <button type="submit" className="icon-btn" title="Приєднатися до кімнати або створити її" aria-label="Приєднатися">
                <Plus size={16} />
              </button>
            </form>
          )}
        </Group>

        {!admin && others.length > 0 && (
          <Group {...group("other-rooms")} title="Можна приєднатися">
            <ul className="nav-list">
              {others.map((n) => (
                <Item
                  key={n}
                  onClick={() => onJoin(n)}
                  icon={<Plus size={16} />}
                  label={n}
                  meta="приєднатися"
                  title={`Приєднатися до #${n}`}
                />
              ))}
            </ul>
          </Group>
        )}

        <Group
          {...group("agents")}
          title="Агенти"
          hint={botsHint}
        >
          <ul className="nav-list">
            {bots.map((a) => (
              <Item
                key={a.name}
                onClick={nav(dm(sender, a.name))}
                icon={<Avatar name={a.name} kind={a.kind} online={a.online} activity={a.activity} size="sm" />}
                label={a.name}
                sub={<AgentSub a={a} me={sender} />}
                title={[
                  a.description,
                  a.online ? (isActive(a.online, a.activity) ? activityText(a.name, a.activity) : "онлайн") : "офлайн",
                  a.rooms.length ? `кімнати: ${a.rooms.map((r) => "#" + r).join(", ")}` : "",
                  `натисніть, щоб написати ${a.name}`,
                ]
                  .filter(Boolean)
                  .join("\n")}
              />
            ))}
            {!bots.length && <li className="nav-empty">Агентів ще немає</li>}
          </ul>
        </Group>

        <Group {...group("people")} title="Люди" hint={people.length ? `${peopleOnline} онлайн` : ""}>
          <ul className="nav-list">
            {people.map((a) => {
              const self = a.name === sender;
              return (
                <Item
                  key={a.name}
                  onClick={self ? undefined : nav(dm(sender, a.name))}
                  icon={<Avatar name={a.name} kind={a.kind} online={a.online} size="sm" />}
                  label={a.name}
                  sub={a.online ? "онлайн" : "офлайн"}
                  meta={self ? "ви" : undefined}
                  title={self ? undefined : `натисніть, щоб написати ${a.name}`}
                />
              );
            })}
          </ul>
        </Group>

        {admin && (
          <Group {...group("admin")} title="Адміністрування">
            <ul className="nav-list">
              <Item active={cur === "people"} onClick={nav({ kind: "people" })} icon={<UserCog size={16} />} label="Агенти й люди" />
              <Item active={cur === "rooms"} onClick={nav({ kind: "rooms" })} icon={<LayoutGrid size={16} />} label="Керування кімнатами" />
              <Item active={cur === "settings"} onClick={nav({ kind: "settings" })} icon={<Settings size={16} />} label="Налаштування" />
            </ul>
          </Group>
        )}
      </nav>

      <footer className="side-foot">
        <Avatar name={who} kind="human" />
        <span className="me">
          <span className="me-name">{who}</span>
          <span className="me-role">{admin ? "адміністратор" : "учасник"}</span>
        </span>
        <NotifyButton />
        <button type="button" className="icon-btn" onClick={onLogout} title="Вийти" aria-label="Вийти">
          <LogOut size={16} />
        </button>
      </footer>
    </aside>
  );
}
