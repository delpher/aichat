import { DoorOpen, Gamepad2, Hash, Inbox, Menu, Settings, Users } from "lucide-react";
import { useChat } from "../context";
import type { View } from "../lib/views";
import { Avatar } from "./Avatar";

export function viewTitle(v: View, me: string | null): { title: string; sub: string } {
  switch (v.kind) {
    case "all":
      return { title: "Усі повідомлення", sub: "Кімнати й особисті повідомлення всіх учасників" };
    case "room":
      return { title: v.room, sub: "" };
    case "dm":
      return me && (v.a === me || v.b === me)
        ? { title: v.a === me ? v.b : v.a, sub: "Особисті повідомлення" }
        : { title: `${v.a} ↔ ${v.b}`, sub: "Особиста розмова двох учасників" };
    case "people":
      return { title: "Агенти й люди", sub: "Хто може підключатися до брокера" };
    case "rooms":
      return { title: "Кімнати", sub: "Створення кімнат і учасники" };
    case "settings":
      return { title: "Налаштування", sub: "Ліміти й адреси брокера" };
    case "games":
      return { title: "Міні-ігри", sub: "Люди й агенти грають разом, ходи йдуть через брокер" };
    case "game":
      return { title: `Партія №${v.id}`, sub: "Міні-ігри" };
    default:
      return { title: "AIChat", sub: "" };
  }
}

export function Header({ onMenu, onLeave }: { onMenu: () => void; onLeave: (room: string) => void }) {
  const { view, overview, session, sender } = useChat();
  const me = session.mode === "user" ? session.me.name : sender;
  const { title, sub: baseSub } = viewTitle(view, session.mode === "user" ? session.me.name : null);
  let sub = baseSub;
  let icon: React.ReactNode = null;
  if (view.kind === "room") {
    const r = overview.rooms.find((x) => x.name === view.room);
    const online = new Set(overview.agents.filter((a) => a.online).map((a) => a.name));
    sub = r ? `${r.members.length} учасн. · ${r.members.filter((m) => online.has(m)).length} онлайн` : "";
    icon = <Hash size={18} />;
  } else if (view.kind === "dm") {
    const other = me && (view.a === me || view.b === me) ? (view.a === me ? view.b : view.a) : null;
    const a = other ? overview.agents.find((x) => x.name === other) : undefined;
    if (a) {
      icon = <Avatar name={a.name} kind={a.kind} online={a.online} size="sm" />;
      sub = [a.online ? "онлайн" : "офлайн", a.description].filter(Boolean).join(" · ");
    } else icon = <Users size={18} />;
  } else if (view.kind === "all") icon = <Inbox size={18} />;
  else if (view.kind === "people") icon = <Users size={18} />;
  else if (view.kind === "rooms") icon = <Hash size={18} />;
  else if (view.kind === "settings") icon = <Settings size={18} />;
  else if (view.kind === "games" || view.kind === "game") icon = <Gamepad2 size={18} />;

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
      {session.mode === "user" && view.kind === "room" && (
        <button type="button" className="btn ghost" onClick={() => onLeave(view.room)} title="Вийти з кімнати">
          <DoorOpen size={16} /> <span className="hide-sm">Вийти з кімнати</span>
        </button>
      )}
    </header>
  );
}
