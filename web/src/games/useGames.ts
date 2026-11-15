import { useEffect, useState } from "react";
import type { GameInfo, GameType } from "../api/types";
import { useChat } from "../context";
import { upsertGame } from "./gameText";

let typesCache: { token: string; types: Promise<GameType[]> } | null = null;

/** The broker's game catalog (GET /api/games/types), fetched once per session. */
export function useGameTypes(): GameType[] | null {
  const { api, session, fail } = useChat();
  const [types, setTypes] = useState<GameType[] | null>(null);
  useEffect(() => {
    if (!typesCache || typesCache.token !== session.token) {
      const types = api.get<{ types: GameType[] }>("/api/games/types").then((d) => d.types ?? []);
      typesCache = { token: session.token, types };
      types.catch(() => {
        typesCache = null;
      });
    }
    let live = true;
    typesCache.types.then(
      (t) => live && setTypes(t),
      (e) => {
        if (!live) return;
        setTypes([]);
        fail(e, "Не вдалося завантажити список ігор");
      },
    );
    return () => {
      live = false;
    };
  }, [api, session.token, fail]);
  return types;
}

/** All games (optionally of one type), kept live from the socket. */
export function useGameList(type?: string): GameInfo[] | null {
  const { api, subscribeGames, fail } = useChat();
  const [games, setGames] = useState<GameInfo[] | null>(null);
  useEffect(() => {
    let live = true;
    api
      .get<{ games: GameInfo[] }>("/api/games")
      .then((d) => live && setGames(d.games))
      .catch((e) => {
        if (!live) return;
        setGames([]);
        fail(e, "Не вдалося завантажити партії");
      });
    const off = subscribeGames(
      (g) => setGames((cur) => (cur ? upsertGame(cur, g) : cur)),
      (id) => setGames((cur) => cur && cur.filter((x) => x.id !== id)),
    );
    return () => {
      live = false;
      off();
    };
  }, [api, subscribeGames, fail]);
  return games && type ? games.filter((g) => g.game === type) : games;
}

/** Test helper: forget the cached catalog. */
export const resetGameTypes = () => {
  typesCache = null;
};
