import { useEffect, useState } from "react";
import { useChat } from "../context";
import { activityText } from "../lib/activity";
import type { View } from "../lib/views";

/**
 * "claude-alexey працює: редагує файл · 2 хв" above the composer, like "typing…" in messengers:
 * the agents of this conversation (room members, or the other side of a DM) that are busy or waiting.
 */
export function ActivityBar({ view }: { view: View }) {
  const { overview, sender } = useChat();
  const [now, setNow] = useState(() => Date.now());

  let names: string[] = [];
  if (view.kind === "room") names = overview.rooms.find((r) => r.name === view.room)?.members ?? [];
  else if (view.kind === "dm") names = [view.a, view.b];
  const active = overview.agents.filter(
    (a) => a.name !== sender && names.includes(a.name) && a.online && a.activity && a.activity.state !== "idle",
  );

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
