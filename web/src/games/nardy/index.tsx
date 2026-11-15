import { useMemo } from "react";
import type { GameModule, PlayProps } from "../types";
import { Board, toIndex, type Side } from "./Board";
import { legalSteps, renderBoard, replay } from "./engine";

/** Seat index -> colour: the broker lists nardy seats as [white, black]. */
const COLORS: Side[] = ["w", "b"];

/** A player's steps ("24-18", "24-18 18-15", "3-off"); other entries are the broker's ("first 5-3", "roll 6-3", "pass"). */
const isStep = (text: string) => /^\d+-(\d+|off)( \d+-(\d+|off))*$/.test(text);

/** Board indices touched by the steps of the last turn played before `ply` (past a later roll or pass). */
function lastTurn(moves: string[], ply: number): Set<number> {
  const out = new Set<number>();
  let end = ply;
  while (end > 0 && /^(roll|pass)/.test(moves[end - 1])) end--;
  let k = end;
  while (k > 0 && isStep(moves[k - 1])) k--;
  if (k === end) return out;
  const side = replay(moves.slice(0, k)).turn as Side;
  for (const text of moves.slice(k, end).flatMap((m) => m.split(" "))) {
    const [f, t] = text.split("-");
    out.add(toIndex(side, Number(f)));
    if (t !== "off") out.add(toIndex(side, Number(t)));
  }
  return out;
}

/** One row per roll: the dice, then the steps played with them ("6-3: 24-18 18-15"). */
function moveRows(moves: string[]): Array<Array<{ text: string; ply: number }>> {
  const rows: Array<Array<{ text: string; ply: number }>> = [];
  moves.forEach((text, i) => {
    const roll = /^(first|roll) (\d-\d)$/.exec(text);
    if (roll || !rows.length) rows.push([]);
    const shown = roll ? (roll[1] === "first" ? `перший кидок ${roll[2]}` : `${roll[2]}:`) : text === "pass" ? "немає ходу" : text;
    rows[rows.length - 1].push({ text: shown, ply: i + 1 });
  });
  return rows;
}

function NardyPlay({ game, ply, canMove, bottom, onMove }: PlayProps) {
  const n = Math.min(ply, game.moves.length);
  const state = useMemo(() => replay(game.moves.slice(0, n)), [game.moves, n]);
  const last = useMemo(() => lastTurn(game.moves, n), [game.moves, n]);
  const mine = canMove === null ? null : COLORS[canMove];
  const steps = useMemo(() => (mine && state.turn === mine ? legalSteps(state) : []), [state, mine]);
  return <Board state={state} bottom={COLORS[bottom] ?? "w"} canMove={mine} steps={steps} last={last} onMove={onMove} />;
}

function NardyTile() {
  // A strip of six points with a few stacks
  const stacks = [2, 0, 1, 0, 3, 0];
  return (
    <div className="tile-nardy" aria-hidden>
      {stacks.map((c, i) => (
        <span key={i} className={i % 2 ? "odd" : "even"}>
          {Array.from({ length: c }, (_, k) => (
            <span key={k} className={`piece mini ${i < 3 ? "w" : "b"}`} />
          ))}
        </span>
      ))}
    </div>
  );
}

export const nardy: GameModule = {
  id: "nardy",
  rules:
    "Довгі нарди: по 15 шашок з «голови», обидва ходять проти годинникової стрілки, бити не можна. " +
    "З голови — одна шашка за хід (на першому кидку 6-6, 4-4 чи 3-3 — дві). Кубики кидає брокер. " +
    "Хід пишуть кроками: 24-18, зняття — 3-off.",
  joinAs: { w: "білих", b: "чорних" },
  Tile: NardyTile,
  Play: NardyPlay,
  moveRows,
  toText: (moves) => `${renderBoard(replay(moves))}\n\n${moves.join(" ")}`,
};
