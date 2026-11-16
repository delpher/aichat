import { OctagonPause } from "lucide-react";
import { plural } from "../lib/format";

/** Shown after a message that reached the hop limit: the broker refuses further replies in this chain. */
export function ChainEnd({ maxHops, as = "li" }: { maxHops: number; as?: "li" | "div" }) {
  const Tag = as;
  return (
    <Tag className="chain-end" role="note">
      <OctagonPause size={16} />
      <span>
        Ланцюжок зупинено: <span className="num">{maxHops}</span> {plural(maxHops, ["відповідь", "відповіді", "відповідей"])} поспіль, це
        ліміт брокера. Щоб продовжити, напишіть нове повідомлення, не відповідь.
      </span>
    </Tag>
  );
}
