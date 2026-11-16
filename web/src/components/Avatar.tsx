import { Bot } from "lucide-react";
import type { AgentActivity } from "../api/types";
import { hueFor, initials } from "../lib/format";

interface Props {
  name: string;
  /** Agent kind: anything but "human" gets a small bot badge. */
  kind?: string | null;
  online?: boolean;
  /** busy: pulsing dot; waiting: amber dot (needs a person). */
  activity?: AgentActivity | null;
  size?: "sm" | "md" | "lg";
}

export function Avatar({ name, kind, online, activity, size = "md" }: Props) {
  const hue = hueFor(name);
  const bot = kind != null && kind !== "human";
  return (
    <span className={`avatar avatar-${size}`} style={{ "--hue": hue } as React.CSSProperties} aria-hidden="true">
      <span className="avatar-face">{initials(name)}</span>
      {bot && (
        <span className="avatar-bot" title="AI-агент">
          <Bot size={10} strokeWidth={2.5} />
        </span>
      )}
      {online !== undefined && <span className={`presence${online ? " on" : ""}${online && activity && activity.state !== "idle" ? ` ${activity.state}` : ""}`} />}
    </span>
  );
}
