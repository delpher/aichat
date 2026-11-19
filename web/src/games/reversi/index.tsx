import { useMemo } from "react";
import type { GameModule, PlayProps } from "../types";
import { Board } from "./Board";
import { PASS, flips, newGame, play, renderBoard, square, type Color, type ReversiState } from "./engine";

/** Seat index -> colour: the broker lists reversi seats as [black, white]. */
const COLORS: Color[] = ["b", "w"];

type Position = { state: ReversiState; last: { square: number; turned: number[] } | null };

/** Every position of the game, with the disc put down and the discs it turned over. */
function positions(moves: string[]): Position[] {
  const out: Position[] = [{ state: newGame(), last: null }];
  for (const text of moves) {
    const prev = out[out.length - 1].state;
    try {
      const next = play(prev, text);
      const last = text === PASS ? null : { square: square(text), turned: flips(prev.board, square(text), prev.turn) };
      out.push({ state: next, last });
    } catch {
      break; // the broker checks moves; a bad one here means stale data, so show what is valid
    }
  }
  return out;
}

function ReversiPlay({ game, ply, canMove, bottom, onMove }: PlayProps) {
  const all = useMemo(() => positions(game.moves), [game.moves]);
  const { state, last } = all[Math.min(ply, all.length - 1)];
  return <Board state={state} bottom={COLORS[bottom] ?? "b"} canMove={canMove === null ? null : COLORS[canMove]} last={last} onMove={onMove} />;
}

function ReversiTile() {
  // the four discs of the start on green felt
  const cells = [".", ".", ".", ".", ".", "w", "b", ".", ".", "b", "w", ".", ".", ".", ".", "."];
  return (
    <div className="tile-board felt" aria-hidden>
      {cells.map((c, i) => (
        <span key={i}>{c !== "." && <span className={`piece ${c}`} />}</span>
      ))}
    </div>
  );
}

export const reversi: GameModule = {
  id: "reversi",
  rules:
    "Ставте фішку так, щоб затиснути між нею і своєю фішкою ряд чужих (по горизонталі, вертикалі чи діагоналі): вони перевертаються. " +
    "Немає ходу — пропуск. Коли не може ходити ніхто, перемагає той, у кого більше фішок. Хід пишуть клітинкою: d3.",
  joinAs: { b: "чорних", w: "білих" },
  Tile: ReversiTile,
  Play: ReversiPlay,
  toText: (moves) => `${renderBoard(positions(moves).at(-1)!.state)}\n\n${moves.join(" ")}`,
};
