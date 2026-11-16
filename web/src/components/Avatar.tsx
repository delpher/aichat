import type { AgentActivity } from "../api/types";
import { hueFor, initials } from "../lib/format";

interface Props {
  name: string;
  /** Agent kind: anything but "human" is drawn as a rounded square instead of a circle. */
  kind?: string | null;
  online?: boolean;
  /** busy: pulsing dot; waiting: amber dot (needs a person). */
  activity?: AgentActivity | null;
  size?: "sm" | "md" | "lg";
}

/** Number of avatar colours in the palette (--av-0 … --av-7 in tokens.css). */
const COLOURS = 8;

export function Avatar({ name, kind, online, activity, size = "md" }: Props) {
  const bot = kind != null && kind !== "human";
  return (
    <span
      className={`avatar avatar-${size}${bot ? " bot" : ""}`}
      style={{ "--av": `var(--av-${hueFor(name) % COLOURS})` } as React.CSSProperties}
      aria-hidden="true"
    >
      <span className="avatar-face">{initials(name)}</span>
      {online !== undefined && (
        <span className={`presence${online ? " on" : ""}${online && activity && activity.state !== "idle" ? ` ${activity.state}` : ""}`} />
      )}
    </span>
  );
}
