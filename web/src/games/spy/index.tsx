import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useChat } from "../../context";
import type { GameModule, PlayProps } from "../types";
import {
  MAX_CLUE,
  MAX_TEXT,
  REASON,
  ROUNDS,
  TRIES,
  hasAccused,
  initial,
  openQuestion,
  pending,
  renderBoard,
  replay,
  seatLabel,
  talking,
  type Accusation,
  type Exchange,
  type SpyState,
} from "./engine";

function safeReplay(moves: string[]): SpyState {
  try {
    return replay(moves);
  } catch {
    return initial();
  }
}

function clip(text: string, max = 22): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function formatMove(move: string): string {
  const [kind, ...rest] = move.split(" ");
  if (kind === "deal") return "Роздача";
  if (kind === "ask") {
    const to = seatLabel(Number(rest[0]));
    return `→ ${to}: «${clip(rest.slice(1).join(" "), 18)}»`;
  }
  if (kind === "answer") return `«${clip(rest.join(" "))}»`;
  if (kind === "pass") return `Передача → ${seatLabel(Number(rest[0]))}`;
  if (kind === "clue") return `«${clip(rest.join(" "))}»`;
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

function QaFeed({ items, playerName }: { items: Exchange[]; playerName: (seat: number) => string }) {
  return (
    <section className="spy-qa" aria-label="Питання та відповіді">
      <h4>Питання та відповіді</h4>
      {items.length === 0 ? (
        <p className="muted small spy-qa-empty">Питань ще не було.</p>
      ) : (
        <ol className="spy-qa-list">
          {items.map((q, idx) => (
            <li key={idx} className={q.question === undefined ? "spy-qa-pass" : "spy-qa-item"}>
              <span className="muted small num spy-qa-num">{idx + 1}.</span>
              <div className="spy-qa-body">
                {q.question === undefined ? (
                  <p className="spy-qa-line">
                    <b>{playerName(q.by)}</b> передає хід <b>{playerName(q.to)}</b>
                    {q.free && <span className="spy-badge">без спроби</span>}
                  </p>
                ) : (
                  <>
                    <p className="spy-qa-line">
                      <b>{playerName(q.by)}</b> → <b>{playerName(q.to)}</b>: «{q.question}»
                    </p>
                    <p className={`spy-qa-answer${typeof q.answer === "string" ? "" : " muted"}`}>
                      {q.answer === undefined ? (
                        "Чекаємо на відповідь…"
                      ) : q.answer === null ? (
                        "Без відповіді (гравець вийшов)"
                      ) : (
                        <>
                          <b>{playerName(q.to)}:</b> «{q.answer}»
                        </>
                      )}
                    </p>
                  </>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
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
  const [askTarget, setAskTarget] = useState<number | null>(null);
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");

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

  const isTalking = talking(state);
  const isLegacyGuess = state.phase === "guess";
  useEffect(() => {
    setClue("");
    setQuestion("");
    setAnswer("");
  }, [state.phase, state.turn, state.round, state.qa.length]);

  useEffect(() => {
    setGuess("");
  }, [isTalking, isLegacyGuess]);

  const playerName = (seat: number) => game.players[seat] ?? seatLabel(seat);
  const mySeatIdx = sender ? game.players.indexOf(sender) : -1;
  const mySeat = mySeatIdx >= 0 ? mySeatIdx : null;

  const isSpyCard = card !== null && /^ти\s*[—–-]\s*шпигун/i.test(card);
  const cardWord = !isSpyCard && card !== null ? /«([^»]+)»/.exec(card)?.[1] ?? null : null;

  const live = game.status === "active" && ply === game.moves.length;
  const canActAnytime = live && isTalking && mySeat !== null && !state.out[mySeat];
  const alreadyAccused = mySeat !== null && hasAccused(state, mySeat);

  const seats = Array.from({ length: state.seats }, (_, i) => i);
  const rounds = Array.from({ length: ROUNDS }, (_, i) => i + 1);
  const activeSeats = seats.filter((i) => !state.out[i]);
  const activeAccusation = pending(state);
  const completedAccusations = state.accusations.filter((a) => a.verdict !== undefined);
  const currentQuestion = openQuestion(state);

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

  const askTargets =
    state.phase === "ask" && canMove !== null ? activeSeats.filter((i) => i !== canMove && i !== state.noAsk) : [];
  const passTargets =
    state.phase === "ask" && canMove !== null ? activeSeats.filter((i) => i !== canMove && state.tries[i] > 0) : [];
  const effectiveAskTarget =
    askTarget !== null && askTargets.includes(askTarget) ? askTarget : (askTargets[0] ?? null);
  const myTries = state.phase === "ask" && canMove !== null ? (state.tries[canMove] ?? 0) : 0;

  const trimmedClue = clue.trim();
  const clueValid = trimmedClue.length > 0 && trimmedClue.length <= MAX_CLUE && /\p{L}/u.test(trimmedClue);
  const trimmedQuestion = question.trim();
  const askValid =
    effectiveAskTarget !== null &&
    trimmedQuestion.length > 0 &&
    trimmedQuestion.length <= MAX_TEXT &&
    /\p{L}/u.test(trimmedQuestion);
  const trimmedAnswer = answer.trim();
  const answerValid = trimmedAnswer.length > 0 && trimmedAnswer.length <= MAX_TEXT && /\p{L}/u.test(trimmedAnswer);
  const trimmedGuess = guess.trim();
  const guessValid = trimmedGuess.length > 0 && trimmedGuess.length <= MAX_CLUE;

  const submitClue = (e: FormEvent) => {
    e.preventDefault();
    if (!clueValid) return;
    onMove(trimmedClue);
    setClue("");
  };

  const submitAsk = (e: FormEvent) => {
    e.preventDefault();
    if (!askValid || effectiveAskTarget === null) return;
    onMove(`ask ${game.players[effectiveAskTarget] ?? effectiveAskTarget + 1} ${trimmedQuestion}`);
    setQuestion("");
  };

  const submitAnswer = (e: FormEvent) => {
    e.preventDefault();
    if (!answerValid) return;
    onMove(`answer ${trimmedAnswer}`);
    setAnswer("");
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
          {state.phase === "ask" &&
            (state.tries[state.turn] > 0 ? (
              <>
                Питає <b>{playerName(state.turn)}</b> · спроб: <b className="num">{state.tries[state.turn]}</b>
                {state.noAsk >= 0 && (
                  <>
                    {" "}
                    · не можна питати <b>{playerName(state.noAsk)}</b>
                  </>
                )}
              </>
            ) : (
              <>
                У <b>{playerName(state.turn)}</b> спроб не лишилось — безкоштовна передача ходу
              </>
            ))}
          {state.phase === "answer" && (
            <>
              Відповідає <b>{playerName(state.turn)}</b>
              {currentQuestion && (
                <>
                  {" "}
                  на питання від <b>{playerName(currentQuestion.by)}</b>
                </>
              )}
            </>
          )}
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

      {state.phase === "ask" && canMove !== null && canMove === state.turn && (
        <div className="spy-controls">
          {myTries > 0 && askTargets.length > 0 && (
            <form className="spy-ask-form" onSubmit={submitAsk}>
              <div className="spy-ask-row">
                <label className="small" htmlFor={`spy-ask-target-${game.id}`}>
                  Кого спитати:
                </label>
                <select
                  id={`spy-ask-target-${game.id}`}
                  className="spy-select"
                  aria-label="Кого спитати"
                  value={effectiveAskTarget ?? ""}
                  onChange={(e) => setAskTarget(Number(e.target.value))}
                >
                  {askTargets.map((i) => (
                    <option key={i} value={i}>
                      {playerName(i)}
                    </option>
                  ))}
                </select>
                {state.noAsk >= 0 && (
                  <span className="muted small">({playerName(state.noAsk)} щойно питав(-ла) вас)</span>
                )}
              </div>
              <div className="spy-form">
                <input
                  id={`spy-ask-text-${game.id}`}
                  type="text"
                  className="spy-input"
                  value={question}
                  maxLength={MAX_TEXT}
                  placeholder="Ваше питання…"
                  aria-label="Ваше питання"
                  onChange={(e) => setQuestion(e.target.value)}
                />
                <button type="submit" className="btn primary sm" disabled={!askValid}>
                  Спитати
                </button>
              </div>
              <span className="muted small num">
                {trimmedQuestion.length}/{MAX_TEXT}
              </span>
            </form>
          )}

          {passTargets.length > 0 && (
            <div className="spy-pass-row" role="group" aria-label="Передати хід">
              <p className="small">
                {myTries > 0
                  ? "Або передати хід (списує 1 спробу):"
                  : "Спроб не лишилось — передайте хід безкоштовно тому, в кого вони є:"}
              </p>
              <div className="spy-votes">
                {passTargets.map((i) => (
                  <button
                    key={i}
                    type="button"
                    className="btn quiet sm"
                    aria-label={`Передати хід ${playerName(i)}`}
                    onClick={() => onMove(`pass ${game.players[i] ?? i + 1}`)}
                  >
                    Передати хід: {playerName(i)} ({state.tries[i]})
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {state.phase === "answer" && canMove !== null && canMove === state.turn && (
        <form className="spy-controls" onSubmit={submitAnswer}>
          {currentQuestion && (
            <p className="small spy-open-q">
              <b>{playerName(currentQuestion.by)}</b> питає вас: «{currentQuestion.question}»
            </p>
          )}
          <div className="spy-form">
            <input
              id={`spy-answer-${game.id}`}
              type="text"
              className="spy-input"
              value={answer}
              maxLength={MAX_TEXT}
              placeholder="Ваша відповідь…"
              aria-label="Ваша відповідь"
              onChange={(e) => setAnswer(e.target.value)}
            />
            <button type="submit" className="btn primary sm" disabled={!answerValid}>
              Відповісти
            </button>
          </div>
          <span className="muted small num">
            {trimmedAnswer.length}/{MAX_TEXT}
          </span>
        </form>
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

      {state.mode === "qa" && state.phase !== "deal" && <QaFeed items={state.qa} playerName={playerName} />}

      {state.seats > 0 && (
        <div className="spy-table-wrap">
          <table className="spy-table" aria-label={state.mode === "qa" ? "Гравці, спроби та голоси" : "Підказки та голоси"}>
            <thead>
              <tr>
                <th>Гравець</th>
                {state.mode === "qa" ? (
                  <th>Спроби</th>
                ) : (
                  rounds.map((r) => <th key={r}>Коло {r}</th>)
                )}
                {showVotesCol && <th>Голос</th>}
                {showAccuseCol && <th aria-label="Дії" />}
              </tr>
            </thead>
            <tbody>
              {seats.map((seat) => {
                const isTurn = (isTalking || state.phase === "guess") && state.turn === seat;
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
                    {state.mode === "qa" ? (
                      <td className={`num${isOut ? " spy-empty" : ""}`}>
                        {isOut ? "—" : `${state.tries[seat] ?? 0}/${TRIES}`}
                      </td>
                    ) : (
                      rounds.map((r) => {
                        const entry = state.clues.find((c) => c.seat === seat && c.round === r);
                        const thinking = state.phase === "clue" && state.turn === seat && state.round === r;
                        return (
                          <td key={r} className={entry ? "spy-clue" : "spy-empty"}>
                            {entry ? `«${entry.text}»` : thinking ? "думає…" : "—"}
                          </td>
                        );
                      })
                    )}
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
    "шпигун слова не знає. У кожного по 2 спроби: поставити питання іншому гравцю (move ask <ім'я> <питання>) або передати хід (move pass <ім'я>). " +
    "Відповідь (move <текст>) спроби не списує; хто відповів, питає далі (крім того, хто щойно питав його), а без спроб передає хід безкоштовно. " +
    "Поки йде розмова, кожен раз за гру може звинуватити підозрюваного (move accuse <ім'я> або кнопкою) для таємного голосування так/ні, " +
    "а шпигун може будь-коли таємно зупинити гру й назвати слово (guess <слово>): вгадав — переміг, помилився — програв. " +
    "Коли спроби скінчились у всіх — фінальне таємне голосування (vote <ім'я>): викриття лише одностайне, без здогадки після викриття.",
  Tile: SpyTile,
  Play: SpyPlay,
  moveRows: spyMoveRows,
  toText: (moves) => renderBoard(safeReplay(moves)),
};
