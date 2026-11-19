import { useMemo } from "react";
import { counts, flips, legalSquares, outcome, squareName, type Color, type ReversiState } from "./engine";

interface Props {
  state: ReversiState;
  /** Which side's home rank is drawn at the bottom: black has rank 1 there. */
  bottom: Color;
  /** Side the viewer may move now, if any. */
  canMove: Color | null;
  /** Square of the last move, highlighted, and the discs it turned over. */
  last?: { square: number; turned: number[] } | null;
  onMove?: (square: string) => void;
}

const NAME: Record<Color, string> = { b: "чорна", w: "біла" };

/** Reversi board: the squares the viewer may play are marked; one click plays. */
export function Board({ state, bottom, canMove, last, onMove }: Props) {
  const legal = useMemo(
    () => new Set(canMove && canMove === state.turn && !outcome(state).over ? legalSquares(state) : []),
    [state, canMove],
  );
  const { black, white } = counts(state);
  const ranks = bottom === "b" ? [7, 6, 5, 4, 3, 2, 1, 0] : [0, 1, 2, 3, 4, 5, 6, 7];
  const files = bottom === "b" ? [0, 1, 2, 3, 4, 5, 6, 7] : [7, 6, 5, 4, 3, 2, 1, 0];
  const turned = new Set(last?.turned ?? []);

  return (
    <div className="reversi">
      <div className="board-wrap">
        <div className="board reversi-board" role="grid" aria-label="Дошка реверсі">
          {ranks.map((r) =>
            files.map((f) => {
              const i = r * 8 + f;
              const cell = state.board[i];
              const name = squareName(i);
              const cls = ["sq", "felt", last?.square === i ? "last" : "", legal.has(i) ? "target" : ""].filter(Boolean).join(" ");
              const label =
                cell !== "." ? `${name}: ${NAME[cell]}` : legal.has(i) ? `${name}: можна поставити, перевернеться ${flips(state.board, i, state.turn).length}` : name;
              return (
                <button
                  type="button"
                  key={i}
                  className={cls}
                  onClick={() => legal.has(i) && onMove?.(name)}
                  disabled={!legal.has(i)}
                  aria-label={label}
                  title={name}
                >
                  {cell !== "." && <span className={`piece ${cell}${turned.has(i) ? " flipped" : ""}`} />}
                  {f === files[0] && <span className="coord rank">{r + 1}</span>}
                  {r === ranks[7] && <span className="coord file">{String.fromCharCode(97 + f)}</span>}
                </button>
              );
            }),
          )}
        </div>
      </div>
      <p className="reversi-score num" aria-live="polite">
        <span className="piece mini b" /> {black} <span className="piece mini w" /> {white}
      </p>
    </div>
  );
}
