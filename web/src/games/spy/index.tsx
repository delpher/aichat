import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useChat } from "../../context";
import type { GameModule, PlayProps } from "../types";
import { MAX_CLUE, REASON, ROUNDS, initial, renderBoard, replay, seatLabel, type SpyState } from "./engine";

function safeReplay(moves: string[]): SpyState {
  try {
    return replay(moves);
  } catch {
    return initial();
  }
}

function formatMove(move: string): string {
  const [kind, ...rest] = move.split(" ");
  if (kind === "deal") return "Роздача";
  if (kind === "clue") {
    const text = rest.join(" ");
    return `«${text.length > 22 ? `${text.slice(0, 21)}…` : text}»`;
  }
  if (kind === "vote") {
    const voter = seatLabel(Number(rest[0]));
    return rest[1] !== undefined ? `${voter} → ${seatLabel(Number(rest[1]))}` : `${voter}: голос`;
  }
  if (kind === "reveal") {
    if (rest[0] === "-") return "Нічия";
    const who = seatLabel(Number(rest[0]));
    return rest[1] === "spy" ? `Викрито: ${who} (шпигун)` : `Викрито: ${who} (свій)`;
  }
  if (kind === "guess") return `Здогадка: «${rest.join(" ")}»`;
  if (kind === "out") return `${seatLabel(Number(rest[0]))} вийшов`;
  return move;
}

function spyMoveRows(moves: string[]): Array<Array<{ text: string; ply: number }>> {
  return moves.map((m, i) => [{ text: formatMove(m), ply: i + 1 }]);
}

export function SpyPlay({ game, ply, canMove, onMove }: PlayProps) {
  const { api, sender } = useChat();
  const shownMoves = useMemo(() => game.moves.slice(0, Math.min(ply, game.moves.length)), [game.moves, ply]);
  const state = useMemo(() => safeReplay(shownMoves), [shownMoves]);

  const [card, setCard] = useState<string | null>(null);
  const [hiddenCard, setHiddenCard] = useState(false);
  const [clue, setClue] = useState("");
  const [guess, setGuess] = useState("");

  const dealt = game.moves.length > 0;
  useEffect(() => {
    setCard(null);
    setHiddenCard(false);
    if (!dealt) return;
    let alive = true;
    api
      .get<{ card: string | null }>(`/api/games/${game.id}/card`)
      .then((d) => {
        if (alive) setCard(d.card);
      })
      .catch(() => {
        if (alive) setCard(null);
      });
    return () => {
      alive = false;
    };
  }, [api, game.id, dealt, sender]);

  // Clear draft inputs whenever the position advances or changes
  useEffect(() => {
    setClue("");
    setGuess("");
  }, [state]);

  const playerName = (seat: number) => game.players[seat] ?? seatLabel(seat);
  const mySeatIdx = sender ? game.players.indexOf(sender) : -1;
  const mySeat = mySeatIdx >= 0 ? mySeatIdx : null;

  const isSpyCard = card !== null && /^ти\s*[—–-]\s*шпигун/i.test(card);
  const cardWord = card !== null ? /«([^»]+)»/.exec(card)?.[1] ?? null : null;

  const seats = Array.from({ length: state.seats }, (_, i) => i);
  const rounds = Array.from({ length: ROUNDS }, (_, i) => i + 1);
  const activeSeats = seats.filter((i) => !state.out[i]);
  const votedCount = activeSeats.filter((i) => state.votes[i] !== undefined).length;
  const showVotesCol = state.phase === "vote" || state.phase === "guess" || state.phase === "over";

  const trimmedClue = clue.trim();
  const clueValid = trimmedClue.length > 0 && trimmedClue.length <= MAX_CLUE && /\p{L}/u.test(trimmedClue);
  const trimmedGuess = guess.trim();
  const guessValid = trimmedGuess.length > 0 && trimmedGuess.length <= MAX_CLUE;

  const submitClue = (e: FormEvent) => {
    e.preventDefault();
    if (!clueValid) return;
    onMove(trimmedClue);
    setClue("");
  };

  const submitGuess = (e: FormEvent) => {
    e.preventDefault();
    if (!guessValid) return;
    onMove(trimmedGuess);
    setGuess("");
  };

  return (
    <div className="spy">
      {card !== null && state.phase !== "deal" && (
        <section className={`spy-card${isSpyCard ? " spy-role" : " word"}`} aria-label="Ваша картка">
          <div className="spy-card-head">
            <span className="muted small">Ваша картка</span>
            <button
              type="button"
              className="btn quiet sm"
              onClick={() => setHiddenCard((v) => !v)}
              aria-pressed={hiddenCard}
            >
              {hiddenCard ? "Показати" : "Сховати"}
            </button>
          </div>
          {hiddenCard ? (
            <p className="muted small spy-card-text">Картку сховано. Натисніть «Показати», щоб переглянути.</p>
          ) : (
            <>
              <div className="spy-card-secret">{isSpyCard ? "Ви — шпигун" : cardWord ? `«${cardWord}»` : "Ваша роль"}</div>
              <p className="spy-card-text">{card}</p>
            </>
          )}
        </section>
      )}

      {state.phase === "deal" && (
        <div className="empty">
          <p>Картки ще не роздано.</p>
        </div>
      )}

      {state.phase === "over" && state.end && (
        <section className="spy-reveal" aria-label="Підсумок партії">
          <div className="spy-reveal-title">{REASON[state.end.reason]}</div>
          {state.end.winners.length > 0 && (
            <p className="spy-reveal-winners">
              {state.end.winners.length === 1 ? "Переміг(-ла): " : "Перемогли: "}
              <b>{state.end.winners.map(playerName).join(", ")}</b>
            </p>
          )}
          <dl className="spy-reveal-facts">
            {state.word !== null && (
              <div>
                <dt>Слово</dt>
                <dd>«{state.word}»</dd>
              </div>
            )}
            {state.spy !== null && (
              <div>
                <dt>Шпигун</dt>
                <dd>{playerName(state.spy)}</dd>
              </div>
            )}
            {state.guess !== undefined && (
              <div>
                <dt>Здогадка шпигуна</dt>
                <dd>«{state.guess}»</dd>
              </div>
            )}
          </dl>
        </section>
      )}

      {state.phase !== "deal" && state.phase !== "over" && (
        <p className="spy-phase">
          {state.phase === "clue" && (
            <>
              Коло <b>{state.round}</b> з {ROUNDS} · підказку дає <b>{playerName(state.turn)}</b>
            </>
          )}
          {state.phase === "vote" && (
            <>
              Таємне голосування · проголосували <b className="num">{votedCount}</b> з{" "}
              <b className="num">{activeSeats.length}</b>
            </>
          )}
          {state.phase === "guess" && (
            <>
              Викрито шпигуна: <b>{playerName(state.turn)}</b>. Остання спроба вгадати слово.
            </>
          )}
        </p>
      )}

      {state.phase === "clue" && canMove !== null && canMove === state.turn && (
        <form className="spy-controls" onSubmit={submitClue}>
          <label className="small" htmlFor={`spy-clue-${game.id}`}>
            Дайте підказку (одне слово або коротка фраза, до {MAX_CLUE} символів):
          </label>
          <div className="spy-form">
            <input
              id={`spy-clue-${game.id}`}
              type="text"
              className="spy-input"
              value={clue}
              maxLength={MAX_CLUE}
              placeholder="Ваша підказка…"
              aria-label="Ваша підказка"
              onChange={(e) => setClue(e.target.value)}
            />
            <button type="submit" className="btn primary sm" disabled={!clueValid}>
              Дати підказку
            </button>
          </div>
          <span className="muted small num">
            {trimmedClue.length}/{MAX_CLUE}
          </span>
        </form>
      )}

      {state.phase === "vote" && canMove !== null && (
        <div className="spy-controls" role="group" aria-label="Таємне голосування">
          <p className="small">Хто шпигун? Оберіть таємно:</p>
          <div className="spy-votes">
            {activeSeats
              .filter((i) => i !== canMove)
              .map((i) => (
                <button
                  key={i}
                  type="button"
                  className="btn quiet sm"
                  onClick={() => onMove(`vote ${game.players[i] ?? i + 1}`)}
                >
                  {playerName(i)}
                </button>
              ))}
          </div>
        </div>
      )}

      {state.phase === "vote" &&
        canMove === null &&
        mySeat !== null &&
        !state.out[mySeat] &&
        state.votes[mySeat] !== undefined && (
          <p className="muted small spy-voted-note">Ваш голос прийнято. Чекаємо, поки проголосують решта гравців…</p>
        )}

      {state.phase === "guess" && canMove !== null && canMove === state.turn && (
        <form className="spy-controls" onSubmit={submitGuess}>
          <label className="small" htmlFor={`spy-guess-${game.id}`}>
            Вас викрили! Назвіть таємне слово, щоб перемогти:
          </label>
          <div className="spy-form">
            <input
              id={`spy-guess-${game.id}`}
              type="text"
              className="spy-input"
              value={guess}
              maxLength={MAX_CLUE}
              placeholder="Слово…"
              aria-label="Слово шпигуна"
              onChange={(e) => setGuess(e.target.value)}
            />
            <button type="submit" className="btn primary sm" disabled={!guessValid}>
              Назвати слово
            </button>
          </div>
        </form>
      )}

      {state.seats > 0 && (
        <div className="spy-table-wrap">
          <table className="spy-table" aria-label="Підказки та голоси">
            <thead>
              <tr>
                <th>Гравець</th>
                {rounds.map((r) => (
                  <th key={r}>Коло {r}</th>
                ))}
                {showVotesCol && <th>Голос</th>}
              </tr>
            </thead>
            <tbody>
              {seats.map((seat) => {
                const isTurn = (state.phase === "clue" || state.phase === "guess") && state.turn === seat;
                const isOut = Boolean(state.out[seat]);
                const isSpyKnown = state.spy === seat;
                const isWrongAccused = state.accused?.seat === seat && !state.accused.spy;
                const vote = state.votes[seat];
                const rowClass = [isTurn ? "turn" : "", isOut ? "out" : "", isSpyKnown ? "spy-row" : ""]
                  .filter(Boolean)
                  .join(" ");
                return (
                  <tr key={seat} className={rowClass || undefined}>
                    <td>
                      <div className="spy-player">
                        <span className="seat-dot seat-num">{seat + 1}</span>
                        <span className="spy-name">{playerName(seat)}</span>
                        {isSpyKnown && <span className="spy-badge spy">шпигун</span>}
                        {isWrongAccused && <span className="spy-badge accused">викритий</span>}
                        {isOut && <span className="spy-badge">вийшов</span>}
                      </div>
                    </td>
                    {rounds.map((r) => {
                      const entry = state.clues.find((c) => c.seat === seat && c.round === r);
                      const thinking = state.phase === "clue" && state.turn === seat && state.round === r;
                      return (
                        <td key={r} className={entry ? "spy-clue" : "spy-empty"}>
                          {entry ? `«${entry.text}»` : thinking ? "думає…" : "—"}
                        </td>
                      );
                    })}
                    {showVotesCol && (
                      <td className={typeof vote === "number" ? "spy-vote-shown" : "spy-empty"}>
                        {isOut
                          ? "вийшов"
                          : typeof vote === "number"
                            ? `→ ${playerName(vote)}`
                            : vote === null
                              ? "проголосував"
                              : state.phase === "vote"
                                ? "чекаємо"
                                : "—"}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function SpyTile() {
  return (
    <div className="spy-tile" aria-hidden>
      <span className="spy-mini-card">А</span>
      <span className="spy-mini-card secret">?</span>
      <span className="spy-mini-card">А</span>
    </div>
  );
}

export const spy: GameModule = {
  id: "spy",
  rules:
    "Гра для 3–8 гравців. Усі, крім одного шпигуна, отримують у приватній картці однакове таємне слово; шпигун слова не знає. " +
    "За два кола кожен по черзі дає одну підказку (слово або коротку фразу до 40 символів, своїм не можна називати саме слово). " +
    "Далі всі таємно голосують, хто шпигун, і голоси відкриваються разом. Якщо викрили шпигуна, його особа відкривається, " +
    "і він має останній шанс вгадати слово (саме слово лишається приватним до кінця партії): вгадав — переміг шпигун, ні — перемогли свої. " +
    "Якщо викрили не шпигуна або вийшла нічия — переміг шпигун. Агенти: move <підказка>, голос особисто для aichat — vote <ім'я>, здогадка — move <слово>.",
  Tile: SpyTile,
  Play: SpyPlay,
  moveRows: spyMoveRows,
  toText: (moves) => renderBoard(safeReplay(moves)),
};
