import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useChat } from "../../context";
import type { GameModule, PlayProps } from "../types";
import {
  MAX_CLUE,
  REASON,
  ROUNDS,
  hasAccused,
  initial,
  pending,
  renderBoard,
  replay,
  seatLabel,
  type Accusation,
  type SpyState,
} from "./engine";

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
  if (kind === "accuse") {
    return `${seatLabel(Number(rest[0]))} звинувачує ${seatLabel(Number(rest[1]))}`;
  }
  if (kind === "ballot") {
    const voter = seatLabel(Number(rest[0]));
    if (rest[1] === undefined) return `${voter}: голос`;
    return `${voter}: ${rest[1] === "yes" ? "так" : "ні"}`;
  }
  if (kind === "vote") {
    const voter = seatLabel(Number(rest[0]));
    return rest[1] !== undefined ? `${voter} → ${seatLabel(Number(rest[1]))}` : `${voter}: голос`;
  }
  if (kind === "verdict") {
    if (rest[0] === "-") return "Не одностайно";
    const who = seatLabel(Number(rest[0]));
    return rest[1] === "spy" ? `Викрито: ${who} (шпигун)` : `Викрито: ${who} (свій)`;
  }
  if (kind === "stop") return `Шпигун: «${rest.slice(1).join(" ")}»`;
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

function verdictText(verdict: Accusation["verdict"]): string {
  if (verdict === "spy") return "одностайно — шпигун";
  if (verdict === "team") return "одностайно — не шпигун";
  return "не одностайно";
}

function AccusationHistory({
  accusations,
  playerName,
}: {
  accusations: Accusation[];
  playerName: (seat: number) => string;
}) {
  if (!accusations.length) return null;
  return (
    <div className="spy-accusations" aria-label="Історія звинувачень">
      <h4>Звинувачення</h4>
      <ul>
        {accusations.map((a, idx) => {
          const ballots = a.ballots.flatMap((b, seat) =>
            typeof b === "boolean" ? [`${playerName(seat)} — ${b ? "так" : "ні"}`] : [],
          );
          return (
            <li key={idx}>
              <div className="spy-accusation-head">
                <span>
                  <b>{playerName(a.by)}</b> → <b>{playerName(a.suspect)}</b>
                </span>
                <span className={`spy-badge${a.verdict === "spy" ? " spy" : a.verdict === "team" ? " accused" : ""}`}>
                  {verdictText(a.verdict)}
                </span>
              </div>
              {ballots.length > 0 && <p className="muted small spy-accusation-ballots">{ballots.join(", ")}</p>}
            </li>
          );
        })}
      </ul>
    </div>
  );
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

  useEffect(() => {
    setClue("");
  }, [state.phase, state.turn, state.round]);

  useEffect(() => {
    setGuess("");
  }, [state.phase]);

  const playerName = (seat: number) => game.players[seat] ?? seatLabel(seat);
  const mySeatIdx = sender ? game.players.indexOf(sender) : -1;
  const mySeat = mySeatIdx >= 0 ? mySeatIdx : null;

  const isSpyCard = card !== null && /^ти\s*[—–-]\s*шпигун/i.test(card);
  const cardWord = !isSpyCard && card !== null ? /«([^»]+)»/.exec(card)?.[1] ?? null : null;

  const live = game.status === "active" && ply === game.moves.length;
  const canActAnytime = live && state.phase === "clue" && mySeat !== null && !state.out[mySeat];
  const alreadyAccused = mySeat !== null && hasAccused(state, mySeat);

  const seats = Array.from({ length: state.seats }, (_, i) => i);
  const rounds = Array.from({ length: ROUNDS }, (_, i) => i + 1);
  const activeSeats = seats.filter((i) => !state.out[i]);
  const activeAccusation = pending(state);
  const completedAccusations = state.accusations.filter((a) => a.verdict !== undefined);

  const accusationVoters = activeAccusation ? activeSeats.filter((i) => i !== activeAccusation.suspect) : [];
  const accusationVotedCount = activeAccusation
    ? accusationVoters.filter((i) => activeAccusation.ballots[i] !== undefined).length
    : 0;
  const votedCount = activeSeats.filter((i) => state.votes[i] !== undefined).length;
  const hasFinalVotes = state.votes.some((v) => v !== undefined);
  const showVotesCol =
    state.phase === "accuse" ||
    state.phase === "vote" ||
    state.phase === "guess" ||
    (state.phase === "over" && hasFinalVotes);
  const showAccuseCol = canActAnytime;

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

  const submitEarlyGuess = (e: FormEvent) => {
    e.preventDefault();
    if (!guessValid) return;
    onMove(`guess ${trimmedGuess}`);
    setGuess("");
  };

  const submitLegacyGuess = (e: FormEvent) => {
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

      {canActAnytime && isSpyCard && !hiddenCard && (
        <form className="spy-controls spy-guess-early" onSubmit={submitEarlyGuess}>
          <label className="small" htmlFor={`spy-early-guess-${game.id}`}>
            Зупинити гру й назвати слово (якщо помилитеся — програєте):
          </label>
          <div className="spy-form">
            <input
              id={`spy-early-guess-${game.id}`}
              type="text"
              className="spy-input"
              value={guess}
              maxLength={MAX_CLUE}
              placeholder="Таємне слово…"
              aria-label="Слово шпигуна"
              onChange={(e) => setGuess(e.target.value)}
            />
            <button type="submit" className="btn primary sm" disabled={!guessValid}>
              Назвати слово
            </button>
          </div>
        </form>
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
          <AccusationHistory accusations={completedAccusations} playerName={playerName} />
        </section>
      )}

      {state.phase !== "deal" && state.phase !== "over" && (
        <p className="spy-phase">
          {state.phase === "clue" && (
            <>
              Коло <b>{state.round}</b> з {ROUNDS} · підказку дає <b>{playerName(state.turn)}</b>
            </>
          )}
          {state.phase === "accuse" && activeAccusation && (
            <>
              Звинувачення: <b>{playerName(activeAccusation.suspect)}</b> (звинувачує{" "}
              <b>{playerName(activeAccusation.by)}</b>) · проголосували <b className="num">{accusationVotedCount}</b> з{" "}
              <b className="num">{accusationVoters.length}</b>
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

      {state.phase === "accuse" && activeAccusation && canMove !== null && (
        <div className="spy-controls" role="group" aria-label="Голосування за звинувачення">
          <p className="small">
            Згодні, що <b>{playerName(activeAccusation.suspect)}</b> — шпигун? Голосування таємне:
          </p>
          <div className="spy-votes">
            <button type="button" className="btn primary sm" onClick={() => onMove("vote так")}>
              Так
            </button>
            <button type="button" className="btn quiet sm" onClick={() => onMove("vote ні")}>
              Ні
            </button>
          </div>
        </div>
      )}

      {state.phase === "accuse" && activeAccusation && canMove === null && mySeat !== null && !state.out[mySeat] && (
        <p className="muted small spy-voted-note">
          {mySeat === activeAccusation.suspect
            ? "Вас звинуватили. Підозрюваний у цьому голосуванні не бере участі…"
            : activeAccusation.ballots[mySeat] !== undefined
              ? "Ваш голос прийнято. Чекаємо, поки проголосують решта гравців…"
              : null}
        </p>
      )}

      {state.phase === "vote" && canMove !== null && (
        <div className="spy-controls" role="group" aria-label="Таємне голосування">
          <p className="small">Хто шпигун? Оберіть таємно (викриття одностайне):</p>
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
        <form className="spy-controls" onSubmit={submitLegacyGuess}>
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
                {showAccuseCol && <th aria-label="Дії" />}
              </tr>
            </thead>
            <tbody>
              {seats.map((seat) => {
                const isTurn = (state.phase === "clue" || state.phase === "guess") && state.turn === seat;
                const isOut = Boolean(state.out[seat]);
                const isSpyKnown = state.spy === seat;
                const isSuspectNow = Boolean(activeAccusation && activeAccusation.suspect === seat);
                const isWrongAccused =
                  (state.accused?.seat === seat && !state.accused.spy) ||
                  state.accusations.some((a) => a.verdict === "team" && a.suspect === seat);
                const vote = state.votes[seat];
                const ballot = activeAccusation?.ballots[seat];
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
                        {isSuspectNow && <span className="spy-badge accused">підозрюваний</span>}
                        {!isSuspectNow && isWrongAccused && <span className="spy-badge accused">викритий</span>}
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
                      <td
                        className={
                          state.phase === "accuse"
                            ? typeof ballot === "boolean"
                              ? "spy-vote-shown"
                              : "spy-empty"
                            : typeof vote === "number"
                              ? "spy-vote-shown"
                              : "spy-empty"
                        }
                      >
                        {isOut
                          ? "вийшов"
                          : state.phase === "accuse" && activeAccusation
                            ? seat === activeAccusation.suspect
                              ? "підозрюваний"
                              : seat === activeAccusation.by
                                ? "так (ініціатор)"
                                : typeof ballot === "boolean"
                                  ? ballot
                                    ? "так"
                                    : "ні"
                                  : ballot === null
                                    ? "проголосував"
                                    : "чекаємо"
                            : typeof vote === "number"
                              ? `→ ${playerName(vote)}`
                              : vote === null
                                ? "проголосував"
                                : state.phase === "vote"
                                  ? "чекаємо"
                                  : "—"}
                      </td>
                    )}
                    {showAccuseCol && (
                      <td className="spy-act-cell">
                        {seat !== mySeat && !isOut && (
                          <button
                            type="button"
                            className="btn quiet sm"
                            disabled={alreadyAccused}
                            title={alreadyAccused ? "Звинувачувати можна лише раз за гру" : `Звинуватити ${playerName(seat)}`}
                            aria-label={`Звинуватити ${playerName(seat)}`}
                            onClick={() => onMove(`accuse ${game.players[seat] ?? seat + 1}`)}
                          >
                            Звинуватити
                          </button>
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {state.phase !== "over" && completedAccusations.length > 0 && (
        <section className="spy-history-card">
          <AccusationHistory accusations={completedAccusations} playerName={playerName} />
        </section>
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
    "Гра для 3–8 гравців із випадковим порядком ходів. Усі, крім одного шпигуна, отримують у приватній картці однакове таємне слово; " +
    "шпигун слова не знає. За два кола кожен по черзі дає одну підказку (слово або коротку фразу до 40 символів, своїм не можна називати саме слово). " +
    "Поки йдуть підказки, кожен гравець раз за гру може звинуватити підозрюваного (move accuse <ім'я> або кнопкою): решта таємно голосують так чи ні. " +
    "Якщо всі «так» — гра завершується (шпигун — перемога своїх, невинний — перемога шпигуна); інакше підказки тривають. " +
    "Також поки йдуть підказки, шпигун може будь-коли таємно зупинити гру й назвати слово (guess <слово>): вгадав — переміг, помилився — програв. " +
    "Після двох кіл — фінальне таємне голосування (vote <ім'я>): викриття лише одностайне, без права шпигуна вгадувати після викриття.",
  Tile: SpyTile,
  Play: SpyPlay,
  moveRows: spyMoveRows,
  toText: (moves) => renderBoard(safeReplay(moves)),
};
