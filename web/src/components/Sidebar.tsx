import { Hash, Inbox, LogOut, Monitor, Moon, Plus, Settings, Sun, Users } from "lucide-react";
import { useState } from "react";
import { ROOM_RE } from "../api/types";
import { useChat } from "../context";
import type { ConnStatus } from "../hooks/useSocket";
import type { Theme } from "../hooks/useTheme";
import { fmtShort, kindLabel } from "../lib/format";
import { dm, pairKey, viewKey, type View } from "../lib/views";
import { Avatar } from "./Avatar";

interface Props {
  unread: Map<string, number>;
  conn: { status: ConnStatus; retryIn: number };
  theme: Theme;
  onTheme: () => void;
  onLogout: () => void;
  onJoin: (room: string) => void;
}

const THEME_ICON = { system: Monitor, light: Sun, dark: Moon };
const THEME_LABEL = { system: "Тема: як у системі", light: "Тема: світла", dark: "Тема: темна" };

function Item({
  active,
  onClick,
  icon,
  label,
  badge,
  meta,
  title,
}: {
  active?: boolean;
  onClick?: () => void;
  icon: React.ReactNode;
  label: string;
  badge?: number;
  meta?: string;
  title?: string;
}) {
  return (
    <li>
      <button
        type="button"
        className={`nav-item${active ? " active" : ""}${badge ? " has-unread" : ""}`}
        onClick={onClick}
        disabled={!onClick}
        title={title}
        aria-current={active ? "page" : undefined}
      >
        <span className="nav-icon">{icon}</span>
        <span className="nav-label">{label}</span>
        {badge ? <span className="badge">{badge}</span> : meta ? <span className="nav-meta">{meta}</span> : null}
      </button>
    </li>
  );
}

export function Sidebar({ unread, conn, theme, onTheme, onLogout, onJoin }: Props) {
  const { session, overview, view, go, sender } = useChat();
  const admin = session.mode === "admin";
  const cur = viewKey(view);
  const [joinName, setJoinName] = useState("");
  const ThemeIcon = THEME_ICON[theme];
  const nav = (v: View) => () => go(v);

  const rooms = [...overview.rooms].sort((x, y) => x.name.localeCompare(y.name));
  const mine = new Set(rooms.map((r) => r.name));
  const others = admin ? [] : overview.all_rooms.filter((n) => !mine.has(n)).sort();
  const dms = [...overview.dms].sort((x, y) => String(y.last_ts ?? "").localeCompare(String(x.last_ts ?? "")));
  const agents = [...overview.agents].sort((x, y) => Number(y.online) - Number(x.online) || x.name.localeCompare(y.name));
  const kinds = new Map(overview.agents.map((a) => [a.name, a]));
  const who = sender;

  return (
    <aside className="sidebar">
      <header className="side-head">
        <span className="brand">
          <span className="brand-mark" />
          AIChat
        </span>
        <span
          className={`conn ${conn.status}`}
          title={
            conn.status === "online"
              ? "Наживо: нові повідомлення з'являються автоматично"
              : conn.status === "offline"
                ? `Немає з'єднання, повтор через ${conn.retryIn} с`
                : "З'єднуюсь…"
          }
        />
        <button type="button" className="icon-btn" onClick={onTheme} title={THEME_LABEL[theme]} aria-label={THEME_LABEL[theme]}>
          <ThemeIcon size={16} />
        </button>
      </header>

      <nav className="side-nav">
        {admin && (
          <ul className="nav-list">
            <Item active={cur === "all"} onClick={nav({ kind: "all" })} icon={<Inbox size={16} />} label="Усі повідомлення" />
          </ul>
        )}

        <h2 className="nav-title">Кімнати</h2>
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
          {!rooms.length && <li className="nav-empty">{admin ? "немає" : "ви ще не в жодній кімнаті"}</li>}
        </ul>

        {!admin && (
          <>
            {others.length > 0 && (
              <>
                <h2 className="nav-title">Інші кімнати</h2>
                <ul className="nav-list">
                  {others.map((n) => (
                    <Item key={n} onClick={() => onJoin(n)} icon={<Plus size={16} />} label={n} meta="приєднатися" title={`Приєднатися до #${n}`} />
                  ))}
                </ul>
              </>
            )}
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
          </>
        )}

        <h2 className="nav-title">Особисті</h2>
        <ul className="nav-list">
          {dms.map((d) => {
            const key = `d:${pairKey(d.a, d.b)}`;
            const other = !admin ? (d.a === sender ? d.b : d.a) : null;
            return (
              <Item
                key={key}
                active={cur === key}
                onClick={nav(dm(d.a, d.b))}
                icon={
                  other ? (
                    <Avatar name={other} kind={kinds.get(other)?.kind} online={kinds.get(other)?.online} size="sm" />
                  ) : (
                    <Users size={16} />
                  )
                }
                label={other ?? `${d.a} ↔ ${d.b}`}
                badge={unread.get(key)}
                meta={fmtShort(d.last_ts)}
              />
            );
          })}
          {!dms.length && <li className="nav-empty">немає</li>}
        </ul>

        <h2 className="nav-title">Учасники</h2>
        <ul className="nav-list">
          {agents.map((a) => {
            const canDm = sender !== a.name;
            return (
              <Item
                key={a.name}
                onClick={canDm ? nav(dm(sender, a.name)) : undefined}
                icon={<Avatar name={a.name} kind={a.kind} online={a.online} size="sm" />}
                label={a.name === sender ? `${a.name} (ви)` : a.name}
                meta={a.kind === "human" ? undefined : kindLabel(a.kind)}
                title={[
                  a.description,
                  a.online ? "онлайн" : "офлайн",
                  a.rooms.length ? `кімнати: ${a.rooms.map((r) => "#" + r).join(", ")}` : "",
                  canDm ? `натисніть, щоб написати ${a.name}` : "",
                ]
                  .filter(Boolean)
                  .join("\n")}
              />
            );
          })}
        </ul>

        {admin && (
          <>
            <h2 className="nav-title">Адміністрування</h2>
            <ul className="nav-list">
              <Item active={cur === "people"} onClick={nav({ kind: "people" })} icon={<Users size={16} />} label="Агенти й люди" />
              <Item active={cur === "rooms"} onClick={nav({ kind: "rooms" })} icon={<Hash size={16} />} label="Кімнати" />
              <Item active={cur === "settings"} onClick={nav({ kind: "settings" })} icon={<Settings size={16} />} label="Налаштування" />
            </ul>
          </>
        )}
      </nav>

      <footer className="side-foot">
        <Avatar name={who} kind="human" size="sm" />
        <span className="me">
          <span className="me-name">{who}</span>
          <span className="me-role">{admin ? "адміністратор" : "учасник"}</span>
        </span>
        <button type="button" className="icon-btn" onClick={onLogout} title="Вийти" aria-label="Вийти">
          <LogOut size={16} />
        </button>
      </footer>
    </aside>
  );
}
