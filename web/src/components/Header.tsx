import { DoorOpen, Hash, ListTree, Menu } from "lucide-react";
import { useChat } from "../context";
import type { View } from "../lib/views";
import { activityText } from "../lib/activity";
import { Avatar } from "./Avatar";

export function viewTitle(v: View, me: string | null): { title: string; sub: string } {
  switch (v.kind) {
    case "all":
      return { title: v.agent ? `Усі повідомлення · ${v.agent}` : "Усі повідомлення", sub: "" };
    case "room":
      return { title: v.room, sub: "" };
    case "dm":
      return me && (v.a === me || v.b === me) ? { title: v.a === me ? v.b : v.a, sub: "" } : { title: `${v.a} і ${v.b}`, sub: "" };
    case "people":
      return { title: "Агенти й люди", sub: "" };
    case "rooms":
      return { title: "Керування кімнатами", sub: "" };
    case "settings":
      return { title: "Налаштування", sub: "" };
    case "intro":
      return { title: "Вводна світу", sub: "" };
    case "games":
      return { title: "Міні-ігри", sub: "" };
    case "game":
      return { title: `Партія №${v.id}`, sub: "" };
    default:
      return { title: "AIChat", sub: "" };
  }
}

/** How many faces the room header shows before "+N". */
const FACES = 5;

export function Header({ onMenu, onLeave }: { onMenu: () => void; onLeave: (room: string) => void }) {
  const { view, overview, session, sender, threaded, setThreaded } = useChat();
  const isChat = view.kind === "room" || view.kind === "dm" || view.kind === "all";
  const me = session.mode === "user" ? session.me.name : sender;
  const { title } = viewTitle(view, session.mode === "user" ? session.me.name : null);
  const agents = new Map(overview.agents.map((a) => [a.name, a]));
  let sub = "";
  let icon: React.ReactNode = null;
  let people: React.ReactNode = null;

  if (view.kind === "room") {
    icon = <Hash size={18} />;
    const r = overview.rooms.find((x) => x.name === view.room);
    if (r?.members.length) {
      const members = [...r.members].sort(
        (x, y) => Number(!!agents.get(y)?.online) - Number(!!agents.get(x)?.online) || x.localeCompare(y),
      );
      const online = members.filter((m) => agents.get(m)?.online).length;
      people = (
        <div className="head-people" title={members.map((m) => `${m}${agents.get(m)?.online ? " · онлайн" : ""}`).join("\n")}>
          <span className="head-faces">
            {members.slice(0, FACES).map((m) => (
              <Avatar key={m} name={m} kind={agents.get(m)?.kind} online={agents.get(m)?.online} size="sm" />
            ))}
          </span>
          <span className="num hide-sm">
            {online} з {members.length} онлайн
          </span>
        </div>
      );
    }
  } else if (view.kind === "dm") {
    const other = me && (view.a === me || view.b === me) ? (view.a === me ? view.b : view.a) : null;
    const a = other ? agents.get(other) : undefined;
    if (a) {
      icon = <Avatar name={a.name} kind={a.kind} online={a.online} activity={a.activity} size="sm" />;
      const doing = a.online && a.activity && a.activity.state !== "idle" ? activityText(a.name, a.activity) : null;
      sub = [doing ?? (a.online ? "онлайн" : "офлайн"), a.description].filter(Boolean).join(" · ");
    }
  }

  return (
    <header className="main-head">
      <button type="button" className="icon-btn menu" onClick={onMenu} aria-label="Меню">
        <Menu size={18} />
      </button>
      {icon && <span className="head-icon">{icon}</span>}
      <div className="head-title">
        <h1>{title}</h1>
        {sub && <p>{sub}</p>}
      </div>
      {people}
      {isChat && (
        <button
          type="button"
          className={`icon-btn toggle${threaded ? " on" : ""}`}
          onClick={() => setThreaded(!threaded)}
          aria-pressed={threaded}
          aria-label="Згортати відповіді в треди"
          title={threaded ? "Відповіді згорнуто в треди. Натисніть, щоб показати всі в стрічці" : "Згорнути відповіді в треди"}
        >
          <ListTree size={18} />
        </button>
      )}
      {session.mode === "user" && view.kind === "room" && (
        <button type="button" className="btn ghost sm" onClick={() => onLeave(view.room)} title="Вийти з кімнати">
          <DoorOpen size={16} className="show-sm" /> <span className="hide-sm">Вийти з кімнати</span>
        </button>
      )}
    </header>
  );
}
