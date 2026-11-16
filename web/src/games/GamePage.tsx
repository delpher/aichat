import { ArrowLeft, ChevronFirst, ChevronLast, ChevronLeft, ChevronRight, Eye, Flag, Handshake, Hash, LoaderCircle, LogIn } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { GameInfo, GameType } from "../api/types";
import { ChatView } from "../components/ChatView";
import { useChat } from "../context";
import { fmtShort } from "../lib/format";
import { hashFor } from "../lib/views";
import { DeleteGame } from "./DeleteGame";
import { canJoin, FREE_SEAT, gameStatus, joinAs, seatName, seatOf } from "./gameText";
import { findGame } from "./registry";
import { useGameTypes } from "./useGames";

/**
 * The page of one game: players, status, draw and resign, stepping through the moves, the game's chat.
 * The board itself is drawn by the game's module; this shell knows nothing about any game's rules.
 */
export function GamePage({ id }: { id: number }) {
  const { api, session, overview, reloadOverview, go, sender, subscribe, subscribeGames, fail, toast } = useChat();
  const types = useGameTypes();
  const [game, setGame] = useState<GameInfo | null>(null);
  const [missing, setMissing] = useState(false);
  /** Moves shown; null follows the live position. */
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

  if (!game || !types)
    return (
      <div className="panel">
        <div className="empty big">{missing ? <p>Партію не знайдено.</p> : <LoaderCircle className="spin" size={24} />}</div>
      </div>
    );

  const t: GameType | undefined = types.find((x) => x.id === game.game);
  const m = findGame(game.game);
  const lobby = hashFor({ kind: "games", game: game.game });

  const latest = game.moves.length;
  const shownPly = ply === null ? latest : Math.min(ply, latest);
  const mySeat = seatOf(game, sender);
  const live = game.status === "active" && shownPly === latest;
  const canMove = live && !busy && mySeat !== null && game.turn === mySeat ? mySeat : null;
  // Players see their own seat nearest them; spectators see the first seat there.
  const bottom = mySeat ?? 0;
  const others = game.players.map((_, i) => i).filter((i) => i !== bottom);
  const waitingFor = live && game.turn != null && game.turn !== mySeat ? game.players[game.turn] : null;

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
      fail(e, path === "join" ? "Не вдалося приєднатися" : path === "move" ? "Хід не прийнято" : "Не вдалося");
      load();
    } finally {
      setBusy(false);
    }
  };

  const drawOfferedToMe = !!game.draw_offer && game.draw_offer !== sender && mySeat !== null;
  const per = Math.max(1, game.players.length);
  const rounds: Array<{ n: number; moves: Array<{ text: string; ply: number }> }> = [];
  game.moves.forEach((text, i) => {
    if (i % per === 0) rounds.push({ n: i / per + 1, moves: [] });
    rounds[rounds.length - 1].moves.push({ text, ply: i + 1 });
  });
  const freeSeat = game.players.findIndex((p) => !p);

  return (
    <div className="panel">
      <div className="lobby-head">
        <a className="btn sm ghost" href={lobby}>
          <ArrowLeft size={14} /> {t?.title ?? "Ігри"}
        </a>
      </div>
      <div className="game">
        <div className="game-board">
          {others.map((i) => (
            <PlayerBar key={i} name={game.players[i]} seat={i} label={seatName(t, i)} turn={live && game.turn === i} />
          ))}
          {m ? (
            <m.Play game={game} ply={shownPly} canMove={canMove} bottom={bottom} onMove={(move) => void act("move", { move })} />
          ) : (
            <div className="empty">
              <p>
                Гра «{t?.title ?? game.game}» поки не має дошки на сайті. Хід партії видно в чаті нижче.
              </p>
            </div>
          )}
          <PlayerBar name={game.players[bottom]} seat={bottom} label={seatName(t, bottom)} turn={live && game.turn === bottom} />
        </div>

        <aside className="card game-side">
          <div>
            <h2>{gameStatus(game, t)}</h2>
            <p className="muted small">
              {t?.title ?? game.game} · почато {fmtShort(game.created_ts)} · створив {game.created_by}
            </p>
          </div>
          {game.status === "open" && (
            <p className="turn-hint">
              {canJoin(game, sender) ? "Місце вільне: приєднуйтеся, і партія почнеться." : "Чекаємо, поки хтось приєднається…"}
            </p>
          )}
          {canJoin(game, sender) && freeSeat >= 0 && (
            <div className="actions">
              <button type="button" className="btn primary" disabled={busy} onClick={() => void act("join", {})}>
                <LogIn size={16} /> Приєднатися за {joinAs(t, freeSeat)}
              </button>
            </div>
          )}
          {mySeat === null && game.status === "active" && (
            <p className="turn-hint">
              <Eye size={14} /> Ви дивитеся партію як глядач.
            </p>
          )}
          {live && mySeat !== null && (
            <p className={`turn-hint${canMove !== null ? " mine" : ""}`}>
              {canMove !== null ? "Ваш хід." : `Чекаємо на хід ${waitingFor ?? "суперника"}…`}
            </p>
          )}
          {game.draw_offer && game.status === "active" && (
            <p className="warn">{game.draw_offer === sender ? "Ви запропонували нічию." : `${game.draw_offer} пропонує нічию.`}</p>
          )}
          {game.status === "active" && mySeat !== null && (
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
              <button
                type="button"
                className="icon-btn sm"
                onClick={() => setPly(shownPly + 1 >= latest ? null : shownPly + 1)}
                disabled={shownPly === latest}
                aria-label="Вперед"
              >
                <ChevronRight size={14} />
              </button>
              <button type="button" className="icon-btn sm" onClick={() => setPly(null)} disabled={shownPly === latest} aria-label="До останнього ходу">
                <ChevronLast size={14} />
              </button>
            </div>
          </div>
          <ol className="moves">
            {rounds.map((r) => (
              <li key={r.n}>
                <span className="muted">{r.n}.</span>
                {r.moves.map((mv) => (
                  <button key={mv.ply} type="button" className={shownPly === mv.ply ? "on" : ""} onClick={() => setPly(mv.ply)}>
                    {mv.text}
                  </button>
                ))}
              </li>
            ))}
            {!rounds.length && <li className="muted small">Ходів ще не було.</li>}
          </ol>

          {m?.toText && (
            <div className="actions">
              <button
                type="button"
                className="btn sm ghost"
                onClick={() => {
                  const text = `${gameStatus(game, t)}\n\n${m.toText!(game.moves.slice(0, shownPly))}`;
                  navigator.clipboard.writeText(text).then(
                    () => toast("Позицію й ходи скопійовано."),
                    () => toast("Не вдалося скопіювати.", true),
                  );
                }}
              >
                Копіювати як текст
              </button>
            </div>
          )}
          <DeleteGame game={game} onDeleted={() => go({ kind: "games", game: game.game })} />
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
            <span className="muted small">Тут ходи, позиція від брокера й розмови гравців і глядачів.</span>
            <button type="button" className="btn sm primary" onClick={() => void joinRoom()}>
              Приєднатися до чату
            </button>
          </div>
        )}
      </section>
    </div>
  );
}

function PlayerBar({ name, seat, label, turn }: { name: string | null; seat: number; label: string; turn: boolean }) {
  return (
    <div className={`player-bar${turn ? " turn" : ""}`}>
      <span className={`seat-dot seat-${seat}`} />
      {name ? <b>{name}</b> : <i className="muted">{FREE_SEAT}</i>}
      <span className="muted small">{label}</span>
      {turn && <span className="turn-dot" title="Зараз ходить" />}
    </div>
  );
}
