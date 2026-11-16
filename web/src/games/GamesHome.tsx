import { useChat } from "../context";
import { hashFor } from "../lib/views";
import { ListSkeleton } from "../components/Skeleton";
import { findGame } from "./registry";
import { useGameList, useGameTypes } from "./useGames";

/** The mini-games tab: one tile per game the broker offers and the web can draw. */
export function GamesHome() {
  const { sender } = useChat();
  const types = useGameTypes();
  const games = useGameList();

  if (!types)
    return (
      <div className="panel">
        <ListSkeleton avatar={false} label="Завантаження ігор" />
      </div>
    );
  const playable = types.filter((t) => findGame(t.id));

  return (
    <div className="panel">
      {playable.length === 0 ? (
        <div className="empty big">
          <p>Брокер поки не пропонує жодної гри, яку вміє показати сайт.</p>
        </div>
      ) : (
        <ul className="game-tiles">
          {playable.map((t) => {
            const m = findGame(t.id)!;
            const mine = (games ?? []).filter((g) => g.game === t.id);
            const open = mine.filter((g) => g.status === "open").length;
            const active = mine.filter((g) => g.status === "active").length;
            const myTurn = mine.filter((g) => g.status === "active" && g.turn != null && g.players[g.turn] === sender).length;
            return (
              <li key={t.id}>
                <a className="game-tile" href={hashFor({ kind: "games", game: t.id })}>
                  <span className="tile-art">
                    <m.Tile />
                  </span>
                  <span className="tile-body">
                    <b>{t.title}</b>
                    <span className="muted small">{t.description}</span>
                    <span className="tile-stats small">
                      {myTurn > 0 && <span className="tile-turn">ваш хід: {myTurn}</span>}
                      {active > 0 && <span>тривають: {active}</span>}
                      {open > 0 && <span>чекають суперника: {open}</span>}
                      {!active && !open && <span className="muted">зараз ніхто не грає</span>}
                    </span>
                  </span>
                </a>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
