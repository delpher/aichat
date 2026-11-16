import { X } from "lucide-react";
import { useEffect, useState } from "react";
import type { Agent } from "../api/types";
import { useChat } from "../context";
import { isActive, since, toolText, waitingText, whereText } from "../lib/activity";
import { kindLabel, plural } from "../lib/format";
import { dm } from "../lib/views";
import { Avatar } from "./Avatar";

/**
 * One agent of the room: what it works on, in which conversation, and what it touches right now.
 * The conversation is a link when it is somewhere else than this room.
 */
function AgentCard({ agent: a, room }: { agent: Agent; room: string }) {
  const { go, sender } = useChat();
  const [now, setNow] = useState(() => Date.now());
  const act = a.online ? a.activity : undefined;
  const active = isActive(a.online, act);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(t);
  }, [active]);
  const state = !a.online ? "offline" : (act?.state ?? "idle");
  const where = act ? whereText(act, sender) : "";
  const elsewhere = act && ((act.room && act.room !== room) || act.with);
  const doing = act?.state === "busy" ? toolText(act.detail, act.target) : act?.state === "waiting" ? waitingText(act.detail) : "";
  const time = act && active ? since(act, now) : "";
  return (
    <li className={`agent-card ${state}`}>
      <Avatar name={a.name} kind={a.kind} online={a.online} activity={act} size="sm" />
      <div className="agent-card-body">
        <div className="agent-card-head">
          <span className="agent-card-name">{a.name}</span>
          <span className={`state-chip ${state}`}>{STATE_LABEL[state]}</span>
        </div>
        <span className="muted small">{kindLabel(a.kind)}</span>
        {act?.topic && <span className="agent-card-topic">{act.topic}</span>}
        {(doing || where) && (
          <span className="agent-card-doing small">
            {doing}
            {doing && where && " · "}
            {where &&
              (elsewhere && act ? (
                <button
                  type="button"
                  className="link-btn"
                  onClick={() => go(act.room ? { kind: "room", room: act.room } : dm(a.name, act.with!))}
                >
                  {where}
                </button>
              ) : (
                <span>{where}</span>
              ))}
            {time && <span className="muted num"> · {time}</span>}
          </span>
        )}
        {!a.online && <span className="muted small">Не підключений</span>}
      </div>
    </li>
  );
}

const STATE_LABEL = { busy: "Працює", waiting: "Чекає", idle: "Вільний", offline: "Офлайн" } as const;

/** Side panel of a room's work: what each of its agents does now, and where. */
export function WorkPanel({ room, members, onClose }: { room: string; members: string[]; onClose: () => void }) {
  const { overview } = useChat();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !(e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement)) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // busy and waiting first, then online, then by name
  const agents = overview.agents
    .filter((a) => a.kind !== "human" && members.includes(a.name))
    .sort(
      (x, y) =>
        Number(isActive(y.online, y.activity)) - Number(isActive(x.online, x.activity)) ||
        Number(y.online) - Number(x.online) ||
        x.name.localeCompare(y.name),
    );
  const working = agents.filter((a) => a.online && a.activity?.state === "busy").length;
  const waiting = agents.filter((a) => a.online && a.activity?.state === "waiting").length;
  const crew = [
    working ? `${working} ${plural(working, ["працює", "працюють", "працюють"])}` : "",
    waiting ? `${waiting} ${plural(waiting, ["чекає", "чекають", "чекають"])}` : "",
  ].filter(Boolean);

  return (
    <aside className="drawer" aria-label="Робота">
      <header className="drawer-head">
        <div>
          <h2>Хто що робить</h2>
          <p className="num">
            #{room} · {crew.length ? crew.join(" · ") : "ніхто не працює"}
          </p>
        </div>
        <button type="button" className="icon-btn" onClick={onClose} title="Закрити (Esc)" aria-label="Закрити панель роботи">
          <X size={18} />
        </button>
      </header>
      <div className="drawer-body">
        {agents.length ? (
          <ul className="agent-cards">
            {agents.map((a) => (
              <AgentCard key={a.name} agent={a} room={room} />
            ))}
          </ul>
        ) : (
          <div className="empty">
            <strong>У кімнаті немає агентів</strong>
            <p>Додайте агента до кімнати, і тут буде видно, над чим він працює.</p>
          </div>
        )}
      </div>
    </aside>
  );
}
