import { useMemo, useState } from "react";
import { colorOf, isDark, isKing, legalMoves, squareName, type CheckersState, type Color, type Move } from "./engine";

interface Props {
  state: CheckersState;
  /** Which side sits at the bottom. */
  bottom: Color;
  /** Side the viewer may move now, if any. */
  canMove: Color | null;
  /** Squares of the last move, highlighted. */
  last?: Move | null;
  onMove?: (move: Move) => void;
}

/**
 * Checkers board. To move: click a piece, then each landing square in turn;
 * a capture through several squares is sent once its path is complete.
 */
export function Board({ state, bottom, canMove, last, onMove }: Props) {
  const legal = useMemo(() => (canMove && canMove === state.turn ? legalMoves(state) : []), [state, canMove]);
  const [path, setPath] = useState<number[]>([]);
  // Moves still possible with the squares picked so far.
  const matching = legal.filter((m) => path.every((s, i) => m.path[i] === s));
  const starts = new Set(legal.map((m) => m.path[0]));
  const targets = new Set(path.length ? matching.map((m) => m.path[path.length]).filter((s) => s !== undefined) : []);
  const lastSquares = new Set(last?.path ?? []);
  const captured = new Set(last?.captures ?? []);

  const click = (i: number) => {
    if (!onMove || !legal.length) return;
    if (starts.has(i) && (path.length === 0 || !targets.has(i))) return setPath([i]);
    if (!targets.has(i)) return setPath([]);
    const next = [...path, i];
    const left = legal.filter((m) => next.every((s, k) => m.path[k] === s));
    const done = left.find((m) => m.path.length === next.length);
    if (done && left.length === 1) {
      setPath([]);
      onMove(done);
    } else setPath(next);
  };

  const ranks = bottom === "w" ? [7, 6, 5, 4, 3, 2, 1, 0] : [0, 1, 2, 3, 4, 5, 6, 7];
  const files = bottom === "w" ? [0, 1, 2, 3, 4, 5, 6, 7] : [7, 6, 5, 4, 3, 2, 1, 0];

  return (
    <div className="board-wrap">
      <div className="board" role="grid" aria-label="Шашкова дошка">
        {ranks.map((r) =>
          files.map((f) => {
            const i = r * 8 + f;
            const cell = state.board[i];
            const dark = isDark(i);
            const cls = [
              "sq",
              dark ? "dark" : "light",
              lastSquares.has(i) ? "last" : "",
              path.includes(i) ? "picked" : "",
              targets.has(i) ? "target" : "",
              path.length === 0 && starts.has(i) ? "movable" : "",
            ]
              .filter(Boolean)
              .join(" ");
            const name = squareName(i);
            const label = cell === "." ? name : `${name}: ${colorOf(cell) === "w" ? "біла" : "чорна"} ${isKing(cell) ? "дамка" : "шашка"}`;
            return (
              <button
                type="button"
                key={i}
                className={cls}
                onClick={() => click(i)}
                disabled={!dark || !legal.length}
                aria-label={label}
                title={dark ? name : undefined}
              >
                {cell !== "." && <span className={`piece ${colorOf(cell)}${isKing(cell) ? " king" : ""}`} />}
                {captured.has(i) && cell === "." && <span className="captured-mark" />}
                {f === files[0] && <span className="coord rank">{r + 1}</span>}
                {r === ranks[7] && <span className="coord file">{String.fromCharCode(97 + f)}</span>}
              </button>
            );
          }),
        )}
      </div>
    </div>
  );
}
