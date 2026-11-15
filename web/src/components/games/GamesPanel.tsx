import { Eye, Gamepad2, LogIn, Play } from "lucide-react";
import { useEffect, useState } from "react";
import type { GameInfo } from "../../api/types";
import { useChat } from "../../context";
import { fmtShort, kindLabel } from "../../lib/format";
import { hashFor } from "../../lib/views";
import { canJoin, FREE_SEAT, gameStatus, sortGames, upsertGame } from "./gameText";

type Filter = "all" | "open" | "active" | "mine";
const FILTERS: Array<[Filter, string]> = [
  ["all", "Усі"],
  ["open", "Чекають суперника"],
  ["active", "Тривають"],
  ["mine", "Мої"],
];

/** Mini-games tab: start or join a checkers game, watch any game, browse the history. */
export function GamesPanel() {
  const { api, overview, sender, subscribeGames, fail, go } = useChat();
  const [games, setGames] = useState<GameInfo[] | null>(null);
  const [white, setWhite] = useState(sender);
  /** "" = leave the seat open for whoever joins. */
  const [black, setBlack] = useState("");
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");

  useEffect(() => {
    api
      .get<{ games: GameInfo[] }>("/api/games")
      .then((d) => setGames(d.games))
      .catch((e) => {
        setGames([]);
        fail(e, "Не вдалося завантажити партії");
      });
    return subscribeGames((g) => setGames((cur) => (cur ? upsertGame(cur, g) : cur)));
  }, [api, subscribeGames, fail]);

  const players = [...overview.agents].sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
  if (!players.some((p) => p.name === sender)) players.unshift({ name: sender, kind: "human", online: true, rooms: [] });
  const label = (name: string) => {
    const p = players.find((x) => x.name === name)!;
    return `${name === sender ? `${name} (ви)` : name} · ${kindLabel(p.kind)}${p.online ? "" : " · офлайн"}`;
  };

  // An open seat is allowed only opposite yourself: you wait for whoever joins.
  const valid = white !== black && (white && black ? true : white === sender || black === sender);
  const hint = !valid
    ? white === black
      ? "Оберіть двох різних гравців."
      : "Відкрите місце можна лишити, лише якщо інше місце займаєте ви."
    : !white || !black
      ? "Партія з'явиться в списку «Чекають суперника», і до неї зможе приєднатися будь-яка людина чи агент."
      : "";

  const start = async () => {
    if (!valid) return;
    setBusy(true);
    try {
      const body = { game: "checkers", ...(white ? { white } : {}), ...(black ? { black } : {}) };
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
    filter === "all" ? true : filter === "mine" ? g.white === sender || g.black === sender || g.created_by === sender : g.status === filter,
  );

  const seatSelect = (value: string, set: (v: string) => void, title: string) => (
    <label className="field">
      <span>{title}</span>
      <select value={value} onChange={(e) => set(e.target.value)} disabled={busy}>
        <option value="">— {FREE_SEAT} (хто приєднається) —</option>
        {players.map((p) => (
          <option key={p.name} value={p.name}>
            {label(p.name)}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <div className="panel">
      <form
        className="card"
        onSubmit={(e) => {
          e.preventDefault();
          void start();
        }}
      >
        <h2>Нова партія в шашки</h2>
        <div className="form-grid">
          {seatSelect(white, setWhite, "Білі (ходять першими)")}
          {seatSelect(black, setBlack, "Чорні")}
        </div>
        <div className="actions">
          <button type="submit" className="btn primary" disabled={busy || !valid}>
            <Play size={16} /> Почати
          </button>
          {hint && <span className={`status${valid ? "" : " error"}`}>{hint}</span>}
        </div>
        <p className="muted small">
          Грати можуть люди й агенти в будь-якому поєднанні, зокрема агент з агентом. Агенти теж можуть створювати партії й
          приєднуватися до них. Партія йде в кімнаті <code>game-&lt;номер&gt;</code>: агенти отримують там дошку й відповідають
          ходом на зразок <code>move c3-d4</code>. Дивитися будь-яку партію може кожен. Правила: українські шашки (обов'язкове
          взяття, прості б'ють назад, дамка ходить далеко).
        </p>
      </form>

      <section className="card">
        <div className="card-head">
          <h2>Партії</h2>
          <div className="seg" role="tablist">
            {FILTERS.map(([k, t]) => (
              <button key={k} type="button" role="tab" aria-selected={filter === k} className={filter === k ? "on" : ""} onClick={() => setFilter(k)}>
                {t}
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
              const playing = g.white === sender || g.black === sender;
              return (
                <li key={g.id} className="game-item">
                  <a href={hashFor({ kind: "game", id: g.id })} className={`game-row ${g.status}`}>
                    <Gamepad2 size={16} className="muted" />
                    <span className="game-players">
                      <b>{g.white ?? <i className="muted">{FREE_SEAT}</i>}</b> <span className="muted">проти</span>{" "}
                      <b>{g.black ?? <i className="muted">{FREE_SEAT}</i>}</b>
                    </span>
                    <span className="game-state">{gameStatus(g)}</span>
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
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
