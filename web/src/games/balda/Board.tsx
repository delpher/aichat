import { useEffect, useMemo, useState } from "react";
import { LETTERS, MIN_WORD, cellName, neighbours, openCells, outcome, seatLabel, type BaldaState } from "./engine";

interface Props {
  state: BaldaState;
  /** Who sits where, for the scores. */
  players: (string | null)[];
  /** Whether the viewer may move now. */
  canMove: boolean;
  /** Sends "<cell> <letter> <cell> <cell> ..." or "pass". */
  onMove?: (move: string) => void;
}

/**
 * Balda board. To move: click an empty cell next to a letter, pick the letter, then click the word's cells in
 * order (through the new letter; clicking the last cell again takes it back) and send it. Or pass.
 */
export function Board({ state, players, canMove, onMove }: Props) {
  const live = canMove && !outcome(state).over;
  const open = useMemo(() => new Set(live ? openCells(state) : []), [state, live]);
  const [at, setAt] = useState<number | null>(null);
  const [letter, setLetter] = useState("");
  const [path, setPath] = useState<number[]>([]);
  const reset = () => {
    setAt(null);
    setLetter("");
    setPath([]);
  };
  // a new position (the other player moved, or stepping through the game) starts the move over
  useEffect(reset, [state]);

  const board = useMemo(() => {
    const b = [...state.board];
    if (at !== null && letter) b[at] = letter;
    return b;
  }, [state.board, at, letter]);
  const word = path.map((i) => board[i]).join("");
  const ready = word.length >= MIN_WORD && at !== null && path.includes(at);
  const lastPath = new Set(state.last?.path ?? []);

  const click = (i: number) => {
    if (!live) return;
    if (!letter) {
      if (open.has(i)) {
        setAt(i);
        setPath([]);
      }
      return;
    }
    if (path.at(-1) === i) return setPath(path.slice(0, -1));
    if (!board[i] || path.includes(i)) return;
    if (path.length && !neighbours(path.at(-1)!).includes(i)) return setPath([i]);
    setPath([...path, i]);
  };

  // typing a letter picks it, Escape starts over
  useEffect(() => {
    if (!live || at === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const k = e.key.toLowerCase();
      if (e.key === "Escape") reset();
      else if (!letter && k.length === 1 && LETTERS.includes(k)) setLetter(k);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [live, at, letter]);

  const send = () => {
    if (!ready || at === null) return;
    onMove?.(`${cellName(at)} ${letter} ${path.map(cellName).join(" ")}`);
    reset();
  };

  return (
    <div className="balda">
      <div className="balda-board" role="grid" aria-label="Поле Балди">
        {[4, 3, 2, 1, 0].map((r) =>
          [0, 1, 2, 3, 4].map((f) => {
            const i = r * 5 + f;
            const ch = board[i];
            const cls = [
              "bd-cell",
              ch ? "filled" : "",
              i === at ? "new" : "",
              path.includes(i) ? "picked" : "",
              !letter && open.has(i) ? "open" : "",
              !path.length && lastPath.has(i) ? "last" : "",
            ]
              .filter(Boolean)
              .join(" ");
            const name = cellName(i);
            return (
              <button
                type="button"
                key={i}
                className={cls}
                onClick={() => click(i)}
                disabled={!live || (!letter ? !open.has(i) : !ch)}
                aria-label={ch ? `${name}: ${ch}` : name}
                title={name}
              >
                {ch && <span className="bd-letter">{ch}</span>}
                {path.includes(i) && <span className="bd-step">{path.indexOf(i) + 1}</span>}
              </button>
            );
          }),
        )}
      </div>

      {live && (
        <div className="bd-controls">
          {at === null ? (
            <p className="muted small">Оберіть порожню клітинку поруч із літерою.</p>
          ) : !letter ? (
            <>
              <p className="muted small">Яку літеру поставити на {cellName(at)}?</p>
              <div className="bd-letters" role="group" aria-label="Літера">
                {[...LETTERS].map((l) => (
                  <button type="button" key={l} className="btn quiet sm" onClick={() => setLetter(l)}>
                    {l}
                  </button>
                ))}
              </div>
            </>
          ) : (
            <p className="muted small">
              Клацайте клітинки слова по черзі, через нову літеру.{" "}
              {word ? (
                <>
                  Слово: <b className="bd-word">{word}</b>
                </>
              ) : null}
            </p>
          )}
          <div className="actions">
            {letter && (
              <button type="button" className="btn primary sm" disabled={!ready} onClick={send}>
                Походити{word ? ` «${word}»` : ""}
              </button>
            )}
            {at !== null && (
              <button type="button" className="btn quiet sm" onClick={reset}>
                Скинути
              </button>
            )}
            <button type="button" className="btn ghost sm" onClick={() => onMove?.("pass")}>
              Пропустити хід
            </button>
          </div>
        </div>
      )}

      {state.seats > 0 && (
        <div className="bd-side">
          <ol className="bd-scores">
            {state.scores.map((p, i) => (
              <li key={i} className={`${state.turn === i && !outcome(state).over ? "turn" : ""}${state.out[i] ? " out" : ""}`}>
                <span>{players[i] ?? seatLabel(i)}</span>
                <b className="num">{p}</b>
              </li>
            ))}
          </ol>
          <p className="bd-words small">
            {state.words.map((w, k) => (
              <span key={k} title={w.seat === null ? "стартове слово" : players[w.seat] ?? seatLabel(w.seat)}>
                {w.word}
              </span>
            ))}
          </p>
        </div>
      )}
    </div>
  );
}
