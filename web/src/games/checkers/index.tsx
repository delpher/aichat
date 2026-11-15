import { useMemo } from "react";
import type { GameModule, PlayProps } from "../types";
import { Board } from "./Board";
import { newGame, parseMove, play, renderBoard, type CheckersState, type Color, type Move } from "./engine";

/** Seat index -> colour: the broker lists checkers seats as [white, black]. */
const COLORS: Color[] = ["w", "b"];

/** Every position of the game, with the move that led to it. */
function positions(moves: string[]): Array<{ state: CheckersState; move: Move | null }> {
  const out: Array<{ state: CheckersState; move: Move | null }> = [{ state: newGame(), move: null }];
  for (const text of moves) {
    const prev = out[out.length - 1].state;
    try {
      const move = parseMove(prev, text);
      out.push({ state: play(prev, move.notation), move });
    } catch {
      break; // the broker validates moves; a bad one here means stale data, so show what is valid
    }
  }
  return out;
}

function CheckersPlay({ game, ply, canMove, bottom, onMove }: PlayProps) {
  const all = useMemo(() => positions(game.moves), [game.moves]);
  const { state, move } = all[Math.min(ply, all.length - 1)];
  return (
    <Board
      state={state}
      bottom={COLORS[bottom] ?? "w"}
      canMove={canMove === null ? null : COLORS[canMove]}
      last={move}
      onMove={(m) => onMove(m.notation)}
    />
  );
}

function CheckersTile() {
  // 4x4 corner of a board with a few pieces
  const cells = [".", "b", ".", "b", "b", ".", "w", ".", ".", "w", ".", "w", "w", ".", "w", "."];
  return (
    <div className="tile-board" aria-hidden>
      {cells.map((c, i) => (
        <span key={i} className={(Math.floor(i / 4) + i) % 2 ? "dark" : "light"}>
          {c !== "." && <span className={`piece ${c}`} />}
        </span>
      ))}
    </div>
  );
}

export const checkers: GameModule = {
  id: "checkers",
  rules: "Українські шашки: обов'язкове взяття, прості б'ють назад, дамка ходить далеко. Хід пишуть як c3-d4, взяття як c3:e5.",
  joinAs: { w: "білих", b: "чорних" },
  Tile: CheckersTile,
  Play: CheckersPlay,
  toText: (moves) => `${renderBoard(positions(moves).at(-1)!.state)}\n\n${moves.join(" ")}`,
};
