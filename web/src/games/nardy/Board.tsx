import { useState } from "react";

export type Side = "w" | "b";

/** What the board draws; the shared engine's state has at least these fields. */
export interface NardyView {
  /** Index 0..23 = white's points 1..24; >0 white checkers, <0 black checkers. */
  points: number[];
  /** Checkers borne off: [white, black]. */
  off: [number, number];
  turn: Side;
  /** Dice still to play ([] while waiting for the roll). */
  dice: number[];
  /** The last roll, for showing. */
  roll: [number, number] | null;
}

/** One legal step in the mover's own numbering; to = 0 bears the checker off. */
export interface Step {
  from: number;
  to: number;
  notation: string;
}

interface Props {
  state: NardyView;
  /** Which side sits at the bottom. */
  bottom: Side;
  /** Side the viewer may move now, if any. */
  canMove: Side | null;
  /** Legal steps for the side to move. */
  steps: Step[];
  /** Board indices touched by the last turn, highlighted. */
  last?: Set<number>;
  onMove?: (step: string) => void;
}

/** A point in a side's own numbering (1..24) as a board index (white's point - 1). */
export const toIndex = (side: Side, p: number) => (side === "w" ? p - 1 : (p + 11) % 24);
/** A board index as a point in a side's own numbering. */
const ownNum = (side: Side, idx: number) => (side === "w" ? idx + 1 : ((idx + 12) % 24) + 1);

/** The dice of the last roll (four on a double), and how many of them are spent. */
function diceShown(state: NardyView): { faces: number[]; spent: number } {
  if (!state.roll) return { faces: [], spent: 0 };
  const [a, b] = state.roll;
  const faces = a === b ? [a, a, a, a] : [a, b];
  return { faces, spent: Math.max(0, faces.length - state.dice.length) };
}

/**
 * Long nardy board. To move: click a point with your checker, then where it goes (or "Зняти").
 * Each step is sent on its own; the turn passes when no legal step is left.
 */
export function Board({ state, bottom, canMove, steps, last, onMove }: Props) {
  const mine = canMove && canMove === state.turn && onMove ? canMove : null;
  const legal = mine ? steps : [];
  const [from, setFrom] = useState<number | null>(null);

  const starts = new Set(legal.map((s) => s.from));
  const picked = from !== null && starts.has(from) ? from : null;
  const targets = legal.filter((s) => s.from === picked);
  const offStep = targets.find((s) => s.to === 0);

  const send = (s: Step) => {
    setFrom(null);
    onMove!(s.notation);
  };

  const clickPoint = (idx: number) => {
    if (!mine) return;
    const p = ownNum(mine, idx);
    const hit = targets.find((s) => s.to === p);
    if (hit) return send(hit);
    setFrom(starts.has(p) && picked !== p ? p : null);
  };

  // Board indices row by row, left to right, as the viewer sees them. White moves 24 → 1 counter-clockwise:
  // its head (24) is top right, its home (1..6) bottom right.
  const topW = Array.from({ length: 12 }, (_, i) => 12 + i); // white 13..24
  const botW = Array.from({ length: 12 }, (_, i) => 11 - i); // white 12..1
  const top = bottom === "w" ? topW : [...botW].reverse();
  const bot = bottom === "w" ? botW : [...topW].reverse();

  const point = (idx: number, up: boolean) => {
    const n = state.points[idx];
    const count = Math.abs(n);
    const color: Side | null = n > 0 ? "w" : n < 0 ? "b" : null;
    const p = mine ? ownNum(mine, idx) : null;
    const isTarget = p !== null && targets.some((s) => s.to === p);
    const cls = [
      "nd-point",
      up ? "up" : "down",
      idx % 2 ? "odd" : "even",
      last?.has(idx) ? "last" : "",
      p !== null && picked === null && starts.has(p) ? "movable" : "",
      p !== null && picked === p ? "picked" : "",
      isTarget ? "target" : "",
    ]
      .filter(Boolean)
      .join(" ");
    const num = ownNum(bottom, idx);
    const label = color ? `${num}: ${count} ${color === "w" ? "білих" : "чорних"}` : `${num}: порожньо`;
    return (
      <button
        type="button"
        key={idx}
        className={cls}
        onClick={() => clickPoint(idx)}
        disabled={!mine || (!starts.has(p!) && !isTarget)}
        aria-label={label}
        title={String(num)}
      >
        <span className="nd-stack">
          {Array.from({ length: Math.min(count, 5) }, (_, k) => (
            <span key={k} className={`piece ${color}${k === Math.min(count, 5) - 1 ? " outer" : ""}`} />
          ))}
          {count > 5 && <span className="nd-count">{count}</span>}
        </span>
        <span className="nd-num">{num}</span>
      </button>
    );
  };

  const row = (idxs: number[], up: boolean) => (
    <div className={`nd-row ${up ? "bottom" : "top"}`}>
      {idxs.slice(0, 6).map((i) => point(i, up))}
      <span className="nd-bar" />
      {idxs.slice(6).map((i) => point(i, up))}
    </div>
  );

  const offOf = (s: Side) => state.off[s === "w" ? 0 : 1];
  const topSide: Side = bottom === "w" ? "b" : "w";
  const { faces, spent } = diceShown(state);

  return (
    <div className="board-wrap nd-wrap">
      <div className="nd-board" role="group" aria-label="Дошка для нард">
        {row(top, false)}
        <div className="nd-mid">
          <span className="nd-off" title="Знято з дошки">
            <span className={`piece mini ${topSide}`} /> {offOf(topSide)}/15
          </span>
          <span className="nd-dice" aria-label={faces.length ? `Кубики: ${state.roll!.join(" і ")}` : "Кубики ще не кинуто"}>
            {faces.map((d, i) => (
              <span key={i} className={`nd-die${i < spent ? " used" : ""}`}>
                {d}
              </span>
            ))}
          </span>
          {offStep && (
            <button type="button" className="btn sm" onClick={() => send(offStep)}>
              Зняти
            </button>
          )}
          <span className="nd-off" title="Знято з дошки">
            <span className={`piece mini ${bottom}`} /> {offOf(bottom)}/15
          </span>
        </div>
        {row(bot, true)}
      </div>
    </div>
  );
}
