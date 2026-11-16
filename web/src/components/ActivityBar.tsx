import { useEffect, useState } from "react";
import type { AgentActivity } from "../api/types";
import { useChat } from "../context";
import { activityText, isActive } from "../lib/activity";
import type { View } from "../lib/views";

/** Whether an agent's activity happens in this conversation: its room, or a direct chat between these two. */
function worksHere(name: string, a: AgentActivity, view: View): boolean {
  if (view.kind === "room") return a.room === view.room;
  if (view.kind === "dm") return (name === view.a && a.with === view.b) || (name === view.b && a.with === view.a);
  return false;
}

/**
 * "claude-a працює над web: редагує App.tsx · 2 хв" above the composer, like "typing…" in messengers:
 * the agents that are busy or waiting in this conversation. Work elsewhere shows in the sidebar instead.
 */
export function ActivityBar({ view }: { view: View }) {
  const { overview, sender } = useChat();
  const [now, setNow] = useState(() => Date.now());

  const active = overview.agents.filter((a) => a.name !== sender && isActive(a.online, a.activity) && worksHere(a.name, a.activity!, view));

  // keep "· 2 хв" fresh while someone is working
  useEffect(() => {
    if (!active.length) return;
    const t = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(t);
  }, [active.length]);

  if (!active.length) return null;
  return (
    <div className="activity-bar" role="status" aria-live="polite">
      {active.map((a) => (
        <span key={a.name} className={a.activity!.state}>
          {a.activity!.state === "busy" && (
            <span className="activity-dots" aria-hidden>
              <i />
              <i />
              <i />
            </span>
          )}
          {activityText(a.name, a.activity!, now)}
        </span>
      ))}
    </div>
  );
}
