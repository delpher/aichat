import { ChevronRight, UserPlus } from "lucide-react";
import { useChat } from "../../context";
import { kindLabel } from "../../lib/format";
import { Avatar } from "../Avatar";
import { ListSkeleton } from "../Skeleton";
import { Status } from "./Status";
import { byKindAndName, useAgents } from "./useAgents";

/** Everyone, one line each; a click opens the participant's own page. */
export function PeoplePanel() {
  const { session, overview, go } = useChat();
  const { list, editable, error } = useAgents();
  const me = session.mode === "admin" ? session.admin.name : null;
  const online = new Map(overview.agents.map((a) => [a.name, a.online]));
  const sorted = [...(list ?? [])].sort(byKindAndName);

  return (
    <div className="panel">
      <section className="section">
        <div className="section-head">
          <h2>Учасники{list && <span className="count">{list.length}</span>}</h2>
          <button type="button" className="btn primary" disabled={!editable} onClick={() => go({ kind: "people-new" })}>
            <UserPlus size={16} /> Додати агента або людину
          </button>
        </div>
        <Status value={error ? { text: error, error: true } : !editable ? { text: "Брокер запущено без файлу конфігурації, тому список змінювати не можна." } : null} />
        {!list && <ListSkeleton label="Завантаження учасників" />}
        <ul className="people">
          {sorted.map((a) => {
            const isOn = online.get(a.name) ?? a.online;
            return (
              <li key={a.name}>
                <button type="button" className="person person-link" onClick={() => go({ kind: "person", name: a.name })}>
                  <Avatar name={a.name} kind={a.kind} online={isOn} />
                  <span className="person-info">
                    <span className="person-name">
                      {a.name}
                      {a.name === me && <span className="muted small">ви</span>}
                    </span>
                    <span className="person-meta">
                      {[kindLabel(a.kind), a.admin ? "адміністратор" : "", a.keeper ? "keeper" : "", isOn ? "онлайн" : "офлайн"]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                    {a.description && <span className="person-desc">{a.description}</span>}
                  </span>
                  <ChevronRight size={16} className="muted" aria-hidden />
                </button>
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}
