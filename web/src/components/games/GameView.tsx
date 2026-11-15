import { ChevronFirst, ChevronLast, ChevronLeft, ChevronRight, Eye, Flag, Handshake, Hash, LoaderCircle, LogIn } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { GameInfo } from "../../api/types";
import { useChat } from "../../context";
import { fmtShort } from "../../lib/format";
import { newGame, opponent, parseMove, play, renderBoard, type CheckersState, type Color, type Move } from "../../../../src/games/checkers";
import { ChatView } from "../ChatView";
import { Board } from "./Board";
import { DeleteGame } from "./DeleteGame";
import { canJoin, COLOR_NAME, FREE_SEAT, gameStatus } from "./gameText";

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

export function GameView({ id }: { id: number }) {
  const { api, session, overview, reloadOverview, go, sender, subscribe, subscribeGames, fail, toast } = useChat();
  const [game, setGame] = useState<GameInfo | null>(null);
  const [missing, setMissing] = useState(false);
  /** Ply shown on the board; null follows the live position. */
  const [ply, setPly] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api
      .get<{ game: GameInfo }>(`/api/games/${id}`)
      .then((d) => setGame(d.game))
      .catch((e) => {
        setMissing(true);
        fail(e, "Не вдалося відкрити партію");
      });
  }, [api, id, fail]);

  useEffect(() => {
    load();
    const offGame = subscribeGames(
      (g) => g.id === id && setGame(g),
      (gone) => {
        if (gone !== id) return;
        toast(`Партію №${id} видалено.`);
        go({ kind: "games" });
      },
    );
    // Moves are messages in the game room too; refetch in case the broker sent no game frame.
    const offMsg = subscribe((m) => {
      if (game && m.room === game.room) load();
    });
    return () => {
      offGame();
      offMsg();
    };
  }, [id, load, subscribe, subscribeGames, game?.room]); // eslint-disable-line react-hooks/exhaustive-deps

  const all = useMemo(() => (game?.game === "checkers" ? positions(game.moves) : positions([])), [game?.game, game?.moves]);

  if (!game)
    return (
      <div className="panel">
        <div className="empty big">{missing ? <p>Партію не знайдено.</p> : <LoaderCircle className="spin" size={24} />}</div>
      </div>
    );

  if (game.game !== "checkers")
    return (
      <div className="panel">
        <div className="empty big">
          <p>
            Гра «{game.game}» поки не має інтерфейсу на сайті. Її хід можна стежити в кімнаті <code>#{game.room}</code>.
          </p>
        </div>
      </div>
    );

  const latest = all.length - 1;
  const shownPly = ply === null ? latest : Math.min(ply, latest);
  const { state, move } = all[shownPly];
  const myColor: Color | null = game.white === sender ? "w" : game.black === sender ? "b" : null;
  const live = game.status === "active" && shownPly === latest;
  const canMove = live && myColor === state.turn ? myColor : null;
  const nameOf = (c: Color) => (c === "w" ? game.white : game.black);
  const opponentName = myColor ? nameOf(opponent(myColor)) : "";
  // Players see their own side at the bottom; spectators see white there.
  const bottom: Color = myColor ?? "w";
  const top = opponent(bottom);

  // People see only rooms they are in; admins see every room. Anyone may join a game room.
  const inRoom = session.mode === "admin" || overview.rooms.some((r) => r.name === game.room);
  const joinRoom = async () => {
    try {
      await api.send("POST", `/api/rooms/${encodeURIComponent(game.room)}/join`);
      await reloadOverview();
    } catch (e) {
      fail(e, "Не вдалося приєднатися до чату партії");
    }
  };

  const act = async (path: string, body?: unknown) => {
    setBusy(true);
    try {
      const d = await api.send<{ game: GameInfo }>("POST", `/api/games/${id}/${path}`, body);
      setGame(d.game);
      setPly(null);
    } catch (e) {
      fail(e, path === "join" ? "Не вдалося приєднатися" : "Хід не прийнято");
      load();
    } finally {
      setBusy(false);
    }
  };

  const drawOfferedToMe = !!game.draw_offer && game.draw_offer !== sender && !!myColor;
  const pairs: Array<[string, string | undefined, number]> = [];
  for (let i = 0; i < game.moves.length; i += 2) pairs.push([game.moves[i], game.moves[i + 1], i]);

  return (
    <div className="panel">
      <div className="game">
        <div className="game-board">
          <PlayerBar name={nameOf(top)} color={top} turn={live && state.turn === top} />
          <Board state={state} bottom={bottom} canMove={busy ? null : canMove} last={move} onMove={(m) => void act("move", { move: m.notation })} />
          <PlayerBar name={nameOf(bottom)} color={bottom} turn={live && state.turn === bottom} />
        </div>

        <aside className="card game-side">
          <div>
            <h2>{gameStatus(game)}</h2>
            <p className="muted small">
              Почато {fmtShort(game.created_ts)} · створив {game.created_by}
            </p>
          </div>
          {game.status === "open" && (
            <p className="turn-hint">
              {canJoin(game, sender) ? "Місце вільне: приєднуйтеся, і партія почнеться." : "Чекаємо, поки хтось приєднається…"}
            </p>
          )}
          {canJoin(game, sender) && (
            <div className="actions">
              <button type="button" className="btn primary" disabled={busy} onClick={() => void act("join", {})}>
                <LogIn size={16} /> Приєднатися за {COLOR_NAME[game.white ? "b" : "w"]}
              </button>
            </div>
          )}
          {!myColor && game.status === "active" && (
            <p className="turn-hint">
              <Eye size={14} /> Ви дивитеся партію як глядач.
            </p>
          )}
          {live && myColor && (
            <p className={`turn-hint${canMove ? " mine" : ""}`}>
              {canMove ? "Ваш хід: натисніть шашку, потім клітинку." : `Чекаємо на хід ${opponentName}…`}
            </p>
          )}
          {game.draw_offer && game.status === "active" && (
            <p className="warn">{game.draw_offer === sender ? "Ви запропонували нічию." : `${game.draw_offer} пропонує нічию.`}</p>
          )}
          {game.status === "active" && myColor && (
            <div className="actions">
              <button type="button" className="btn sm ghost" disabled={busy || game.draw_offer === sender} onClick={() => void act("draw")}>
                <Handshake size={14} /> {drawOfferedToMe ? "Прийняти нічию" : "Запропонувати нічию"}
              </button>
              <button
                type="button"
                className="btn sm danger-text"
                disabled={busy}
                onClick={() => {
                  if (confirm("Здатися в цій партії?")) void act("resign");
                }}
              >
                <Flag size={14} /> Здатися
              </button>
            </div>
          )}

          <div className="moves-head">
            <h3>Ходи</h3>
            <div className="replay" aria-label="Перегляд ходів">
              <button type="button" className="icon-btn sm" onClick={() => setPly(0)} disabled={shownPly === 0} aria-label="На початок">
                <ChevronFirst size={14} />
              </button>
              <button type="button" className="icon-btn sm" onClick={() => setPly(Math.max(0, shownPly - 1))} disabled={shownPly === 0} aria-label="Назад">
                <ChevronLeft size={14} />
              </button>
              <span className="muted small">
                {shownPly}/{latest}
              </span>
              <button type="button" className="icon-btn sm" onClick={() => setPly(shownPly + 1 >= latest ? null : shownPly + 1)} disabled={shownPly === latest} aria-label="Вперед">
                <ChevronRight size={14} />
              </button>
              <button type="button" className="icon-btn sm" onClick={() => setPly(null)} disabled={shownPly === latest} aria-label="До останнього ходу">
                <ChevronLast size={14} />
              </button>
            </div>
          </div>
          <ol className="moves">
            {pairs.map(([w, b, i]) => (
              <li key={i}>
                <span className="muted">{i / 2 + 1}.</span>
                <button type="button" className={shownPly === i + 1 ? "on" : ""} onClick={() => setPly(i + 1)}>
                  {w}
                </button>
                {b && (
                  <button type="button" className={shownPly === i + 2 ? "on" : ""} onClick={() => setPly(i + 2)}>
                    {b}
                  </button>
                )}
              </li>
            ))}
            {!pairs.length && <li className="muted small">Ходів ще не було.</li>}
          </ol>

          <div className="actions">
            <button
              type="button"
              className="btn sm ghost"
              onClick={() => {
                const text = `${gameStatus(game)}\n\n${renderBoard(state)}\n\n${game.moves.join(" ")}`;
                navigator.clipboard.writeText(text).then(
                  () => toast("Дошку й ходи скопійовано."),
                  () => toast("Не вдалося скопіювати.", true),
                );
              }}
            >
              Копіювати як текст
            </button>
          </div>
          <DeleteGame game={game} onDeleted={() => go({ kind: "games" })} />
        </aside>
      </div>

      <section className="card game-chat">
        <div className="card-head">
          <h2>
            <Hash size={15} /> Чат партії
          </h2>
          <button type="button" className="btn sm ghost" onClick={() => go({ kind: "room", room: game.room })} disabled={!inRoom}>
            Відкрити на весь екран
          </button>
        </div>
        {inRoom ? (
          <div className="game-chat-body">
            <ChatView key={game.room} view={{ kind: "room", room: game.room }} />
          </div>
        ) : (
          <div className="actions">
            <span className="muted small">Тут ходи, дошка від брокера й розмови гравців і глядачів.</span>
            <button type="button" className="btn sm primary" onClick={() => void joinRoom()}>
              Приєднатися до чату
            </button>
          </div>
        )}
      </section>
    </div>
  );
}

function PlayerBar({ name, color, turn }: { name: string | null; color: Color; turn: boolean }) {
  return (
    <div className={`player-bar${turn ? " turn" : ""}`}>
      <span className={`piece mini ${color}`} />
      {name ? <b>{name}</b> : <i className="muted">{FREE_SEAT}</i>}
      <span className="muted small">{COLOR_NAME[color]}</span>
      {turn && <span className="turn-dot" title="Зараз ходить" />}
    </div>
  );
}
