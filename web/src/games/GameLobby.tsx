import { ArrowLeft, Eye, Gamepad2, LoaderCircle, LogIn, Play } from "lucide-react";
import { useState } from "react";
import type { GameInfo } from "../api/types";
import { useChat } from "../context";
import { fmtShort, kindLabel } from "../lib/format";
import { hashFor } from "../lib/views";
import { DeleteGame } from "./DeleteGame";
import { canJoin, FREE_SEAT, gameStatus, seatName, sortGames } from "./gameText";
import { findGame } from "./registry";
import { useGameList, useGameTypes } from "./useGames";

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
  const t = types?.find((x) => x.id === typeId);
  const m = findGame(typeId);
  /** Who sits on each seat; "" leaves it open for whoever joins. The first seat defaults to you. */
  const [seats, setSeats] = useState<string[]>([sender]);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");

  if (!types)
    return (
      <div className="panel">
        <div className="empty big">
          <LoaderCircle className="spin" size={24} />
        </div>
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

  const picked = t.seats.map((_, i) => seats[i] ?? "");
  const filled = picked.filter(Boolean);
  // Either every seat is taken by different players, or you take one seat and wait for the rest.
  const distinct = new Set(filled).size === filled.length;
  const full = filled.length === t.seats.length;
  const valid = distinct && (full || (filled.length === 1 && filled[0] === sender));
  const hint = !distinct
    ? "Один гравець не може сидіти на двох місцях."
    : !valid
      ? "Вільні місця можна лишити, лише якщо ви самі займаєте одне з місць, а решта порожні."
      : !full
        ? "Партія з'явиться в списку «Чекають суперника», і до неї зможе приєднатися будь-яка людина чи агент."
        : "";

  const players = [...overview.agents].sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
  if (!players.some((p) => p.name === sender)) players.unshift({ name: sender, kind: "human", online: true, rooms: [] });
  const label = (name: string) => {
    const p = players.find((x) => x.name === name)!;
    return `${name === sender ? `${name} (ви)` : name} · ${kindLabel(p.kind)}${p.online ? "" : " · офлайн"}`;
  };

  const start = async () => {
    if (!valid) return;
    setBusy(true);
    try {
      const body = full ? { game: t.id, players: picked } : { game: t.id, seat: t.seats[picked.indexOf(sender)].id };
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
        <a className="btn sm ghost" href={hashFor({ kind: "games" })}>
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
        <h2>Нова партія: {t.title}</h2>
        <div className="form-grid">
          {t.seats.map((s, i) => (
            <label key={s.id} className="field">
              <span>
                {s.name[0].toUpperCase() + s.name.slice(1)}
                {i === 0 ? " (ходять першими)" : ""}
              </span>
              <select
                value={picked[i]}
                onChange={(e) => setSeats(t.seats.map((_, k) => (k === i ? e.target.value : picked[k])))}
                disabled={busy}
                aria-label={s.name}
              >
                <option value="">— {FREE_SEAT} (хто приєднається) —</option>
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
            <Play size={16} /> Почати
          </button>
          {hint && <span className={`status${valid ? "" : " error"}`}>{hint}</span>}
        </div>
        <p className="muted small">
          {m.rules} Грати можуть люди й агенти в будь-якому поєднанні. Партія йде в кімнаті <code>game-&lt;номер&gt;</code>: агенти
          отримують там позицію й відповідають командою <code>move &lt;хід&gt;</code>. Дивитися будь-яку партію може кожен.
        </p>
      </form>

      <section className="card">
        <div className="card-head">
          <h2>Партії</h2>
          <div className="seg" role="tablist">
            {FILTERS.map(([k, label]) => (
              <button key={k} type="button" role="tab" aria-selected={filter === k} className={filter === k ? "on" : ""} onClick={() => setFilter(k)}>
                {label}
              </button>
            ))}
          </div>
        </div>
        {games === null ? (
          <p className="muted small">Завантаження…</p>
        ) : shown.length === 0 ? (
          <p className="muted small">Тут поки порожньо.</p>
        ) : (
          <ul className="game-list">
            {shown.map((g) => {
              const playing = g.players.includes(sender);
              return (
                <li key={g.id} className="game-item">
                  <a href={hashFor({ kind: "game", id: g.id })} className={`game-row ${g.status}`}>
                    <Gamepad2 size={16} className="muted" />
                    <span className="game-players">
                      {g.players.map((p, i) => (
                        <span key={i}>
                          {i > 0 && <span className="muted"> проти </span>}
                          <b title={seatName(t, i)}>{p ?? <i className="muted">{FREE_SEAT}</i>}</b>
                        </span>
                      ))}
                    </span>
                    <span className="game-state">{gameStatus(g, t)}</span>
                    <span className="muted small">
                      №{g.id} · {g.moves.length} ход. · {fmtShort(g.updated_ts)}
                    </span>
                  </a>
                  {canJoin(g, sender) ? (
                    <button type="button" className="btn sm primary" disabled={busy} onClick={() => void join(g)}>
                      <LogIn size={14} /> Приєднатися
                    </button>
                  ) : (
                    !playing &&
                    g.status === "active" && (
                      <a className="btn sm ghost" href={hashFor({ kind: "game", id: g.id })}>
                        <Eye size={14} /> Дивитися
                      </a>
                    )
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
