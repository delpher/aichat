import { Bot } from "lucide-react";
import { hueFor, initials } from "../lib/format";

interface Props {
  name: string;
  /** Agent kind: anything but "human" gets a small bot badge. */
  kind?: string | null;
  online?: boolean;
  size?: "sm" | "md" | "lg";
}

export function Avatar({ name, kind, online, size = "md" }: Props) {
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
      {online !== undefined && <span className={`presence ${online ? "on" : ""}`} />}
    </span>
  );
}
