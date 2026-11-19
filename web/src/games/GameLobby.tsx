import { ArrowLeft, LoaderCircle } from "lucide-react";
import { useState } from "react";
import type { GameInfo } from "../api/types";
import { useChat } from "../context";
import { fmtShort, kindLabel } from "../lib/format";
import { hashFor } from "../lib/views";
import { ListSkeleton } from "../components/Skeleton";
import { DeleteGame } from "./DeleteGame";
import { canJoin, FREE_SEAT, gameStatus, seatName, sortGames } from "./gameText";
import { findGame } from "./registry";
import { Rating } from "./Rating";
import { useGameList, useGameTypes, useRatings } from "./useGames";

type Filter = "all" | "open" | "active" | "mine";
const FILTERS: Array<[Filter, string]> = [
  ["all", "Усі"],
  ["open", "Чекають суперника"],
  ["active", "Тривають"],
  ["mine", "Мої"],
];

/** One game's page: start or join a game, watch any, browse the history. Knows nothing about the rules. */
export function GameLobby({ type: typeId }: { type: string }) {
  const { api, overview, sender, fail, go } = useChat();
  const types = useGameTypes();
  const games = useGameList(typeId);
  const ratings = useRatings(typeId);
  const t = types?.find((x) => x.id === typeId);
  const m = findGame(typeId);
  /** Who sits on each seat; "" leaves it open for whoever joins. The first seat defaults to you. */
  const [seats, setSeats] = useState<string[]>([sender]);
  /** How many seats, for a game that allows fewer than all (minSeats); null until picked: the fewest. */
  const [count, setCount] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");

  if (!types)
    return (
      <div className="panel">
        <ListSkeleton avatar={false} label="Завантаження гри" />
      </div>
    );
  if (!t || !m)
    return (
      <div className="panel">
        <div className="empty big">
          <p>Такої гри немає.</p>
          <a className="btn ghost" href={hashFor({ kind: "games" })}>
            <ArrowLeft size={16} /> До всіх ігор
          </a>
        </div>
      </div>
    );

  const n = t.minSeats ? Math.min(Math.max(count ?? t.minSeats, t.minSeats), t.seats.length) : t.seats.length;
  const tableSeats = t.seats.slice(0, n);
  const picked = tableSeats.map((_, i) => seats[i] ?? "");
  const filled = picked.filter(Boolean);
  // Either every seat is taken by different players, or you take one seat and wait for the rest.
  const distinct = new Set(filled).size === filled.length;
  const full = filled.length === n;
  const valid = distinct && (full || (filled.length === 1 && filled[0] === sender));
  const hint = !distinct
    ? "Один гравець не може сидіти на двох місцях."
    : !valid
      ? "Вільні місця можна лишити, лише якщо ви самі займаєте одне з місць, а решта порожні."
      : !full
        ? "Партія чекатиме, поки хтось приєднається."
        : "";

  const players = [...overview.agents].sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
  if (!players.some((p) => p.name === sender)) players.unshift({ name: sender, kind: "human", online: true, rooms: [] });
  const label = (name: string) => {
    const p = players.find((x) => x.name === name)!;
    const r = ratings[name];
    return [name === sender ? `${name} (ви)` : name, r === undefined ? "" : `рейтинг ${r}`, p.kind === "human" ? "" : kindLabel(p.kind), p.online ? "" : "офлайн"]
      .filter(Boolean)
      .join(" · ");
  };

  const start = async () => {
    if (!valid) return;
    setBusy(true);
    try {
      const body = {
        ...(full ? { game: t.id, players: picked } : { game: t.id, seat: tableSeats[picked.indexOf(sender)].id }),
        ...(t.minSeats ? { seats: n } : {}),
      };
      const d = await api.send<{ game: GameInfo }>("POST", "/api/games", body);
      go({ kind: "game", id: d.game.id });
    } catch (e) {
      fail(e, "Не вдалося почати партію");
    } finally {
      setBusy(false);
    }
  };

  const join = async (g: GameInfo) => {
    setBusy(true);
    try {
      await api.send<{ game: GameInfo }>("POST", `/api/games/${g.id}/join`, {});
      go({ kind: "game", id: g.id });
    } catch (e) {
      fail(e, "Не вдалося приєднатися");
    } finally {
      setBusy(false);
    }
  };

  const shown = sortGames(games ?? []).filter((g) =>
    filter === "all" ? true : filter === "mine" ? g.players.includes(sender) || g.created_by === sender : g.status === filter,
  );

  return (
    <div className="panel">
      <div className="lobby-head">
        <a className="btn sm quiet" href={hashFor({ kind: "games" })}>
          <ArrowLeft size={14} /> Усі ігри
        </a>
      </div>
      <form
        className="card"
        onSubmit={(e) => {
          e.preventDefault();
          void start();
        }}
      >
        <h2>Нова партія в {t.title.toLowerCase()}</h2>
        {t.minSeats && (
          <label className="field">
            <span>Гравців</span>
            <select value={n} onChange={(e) => setCount(Number(e.target.value))} disabled={busy}>
              {Array.from({ length: t.seats.length - t.minSeats + 1 }, (_, k) => t.minSeats! + k).map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="form-grid">
          {tableSeats.map((s, i) => (
            <label key={s.id} className="field">
              <span>
                {s.name[0].toUpperCase() + s.name.slice(1)}
                {i === 0 ? " (ходять першими)" : ""}
              </span>
              <select
                value={picked[i]}
                onChange={(e) => setSeats(tableSeats.map((_, k) => (k === i ? e.target.value : picked[k])))}
                disabled={busy}
                aria-label={s.name}
              >
                <option value="">Вільне місце</option>
                {players.map((p) => (
                  <option key={p.name} value={p.name}>
                    {label(p.name)}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>
        <div className="actions">
          <button type="submit" className="btn primary" disabled={busy || !valid}>
            {busy && <LoaderCircle className="spin" size={16} />} Почати партію
          </button>
          {hint && <span className={`status${valid ? "" : " error"}`}>{hint}</span>}
        </div>
        <details className="rules">
          <summary>Як грають агенти і правила</summary>
          <p>
            Грати можуть люди й агенти в будь-якому поєднанні. Партія йде в кімнаті <code>game-&lt;номер&gt;</code>: агенти отримують там
            позицію й відповідають командою <code>move &lt;хід&gt;</code>. Дивитися будь-яку партію може кожен.
          </p>
          <p>{m.rules}</p>
        </details>
      </form>

      <section className="section">
        <div className="section-head">
          <h2>Партії</h2>
          <div className="seg" role="tablist">
            {FILTERS.map(([k, label]) => (
              <button
                key={k}
                type="button"
                role="tab"
                aria-selected={filter === k}
                className={filter === k ? "on" : ""}
                onClick={() => setFilter(k)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        {games === null ? (
          <ListSkeleton avatar={false} label="Завантаження партій" />
        ) : shown.length === 0 ? (
          <p className="muted">{filter === "all" ? "Партій ще немає. Почніть першу вище." : "У цьому списку партій немає."}</p>
        ) : (
          <ul className="game-list">
            {shown.map((g) => {
              return (
                <li key={g.id} className="game-item">
                  <a href={hashFor({ kind: "game", id: g.id })} className={`game-row ${g.status}`}>
                    <span className="game-players">
                      {g.players.map((p, i) => (
                        <span key={i} title={seatName(t, i)}>
                          {i > 0 && <span className="vs"> проти </span>}
                          {p ?? <span className="free-seat">{FREE_SEAT}</span>}
                          {p && <Rating value={ratings[p]} />}
                        </span>
                      ))}
                    </span>
                    <span className="game-state">{gameStatus(g, t)}</span>
                    <span className="game-meta">
                      №{g.id} · {g.moves.length} ход. · {fmtShort(g.updated_ts)}
                    </span>
                  </a>
                  {canJoin(g, sender) && (
                    <button type="button" className="btn sm primary" disabled={busy} onClick={() => void join(g)}>
                      Приєднатися
                    </button>
                  )}
                  <DeleteGame game={g} compact onDeleted={() => {}} />
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
