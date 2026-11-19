import { useMemo } from "react";
import type { GameModule, PlayProps } from "../types";
import { Board } from "./Board";
import { apply, newGame, renderBoard, type BaldaState } from "./engine";

/** Every position of the game (the broker checked the words; the web has no dictionary). */
function positions(moves: string[]): BaldaState[] {
  const out: BaldaState[] = [newGame()];
  for (const m of moves) {
    try {
      out.push(apply(out[out.length - 1], m));
    } catch {
      break; // stale data: show what is valid
    }
  }
  return out;
}

function BaldaPlay({ game, ply, canMove, onMove }: PlayProps) {
  const all = useMemo(() => positions(game.moves), [game.moves]);
  const state = all[Math.min(ply, all.length - 1)];
  return <Board state={state} players={game.players} canMove={canMove !== null && canMove === state.turn} onMove={onMove} />;
}

function BaldaTile() {
  const letters = ["", "к", "", "к", "і", "т", "", "т", ""];
  return (
    <div className="tile-board balda-tile" aria-hidden>
      {letters.map((l, i) => (
        <span key={i}>{l}</span>
      ))}
    </div>
  );
}

export const balda: GameModule = {
  id: "balda",
  rules:
    "Посередині поля 5×5 стоїть слово. По черзі ставте одну літеру в порожню клітинку поруч із літерою і читайте через неї іменник " +
    "ланцюжком сусідніх клітинок (вліво, вправо, вгору, вниз), кожну раз. Слово з 3+ літер має бути в словнику й не повторюватись; " +
    "очко за літеру. Можна пропустити хід. Гра закінчується, коли поле заповнене або всі пропустили поспіль. Хід агента: move c2 к кіт.",
  Tile: BaldaTile,
  Play: BaldaPlay,
  toText: (moves) => `${renderBoard(positions(moves).at(-1)!)}\n\n${moves.join("; ")}`,
};
