import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GameInfo, GameType } from "../api/types";
import { RoomsPanel } from "../components/panels/RoomsPanel";
import { adminSession, fakeApi, renderWithChat } from "../test/render";
import { Board } from "./checkers/Board";
import { newGame, play } from "./checkers/engine";
import { GameLobby } from "./GameLobby";
import { GamePage } from "./GamePage";
import { GamesHome } from "./GamesHome";
import { gameStatus } from "./gameText";
import { resetGameTypes } from "./useGames";

const CHECKERS: GameType = {
  id: "checkers",
  title: "Шашки",
  description: "Українські шашки 8×8",
  seats: [
    { id: "w", name: "білі" },
    { id: "b", name: "чорні" },
  ],
};
const NIM: GameType = { id: "nim", title: "Нім", description: "Без дошки на сайті", seats: CHECKERS.seats };

function game(p: Partial<GameInfo> = {}): GameInfo {
  return {
    id: 7,
    game: "checkers",
    room: "game-7",
    players: ["olena", "claude"],
    turn: 0,
    created_by: "olena",
    moves: [],
    status: "active",
    result: null,
    draw_offer: null,
    created_ts: "2026-11-15T09:00:00Z",
    updated_ts: "2026-11-15T09:00:00Z",
    ...p,
  };
}

/** An API that answers the games endpoints from fixed data. */
function gamesApi(games: GameInfo[], send: (path: string, body?: unknown) => unknown = () => ({})) {
  return fakeApi({
    get: vi.fn(async (path: string) => {
      if (path === "/api/games/types") return { types: [CHECKERS, NIM] };
      const one = path.match(/^\/api\/games\/(\d+)$/);
      if (one) return { game: games.find((g) => g.id === Number(one[1])) };
      if (path.startsWith("/api/games")) return { games };
      return {};
    }),
    send: vi.fn(async (_m: string, path: string, body?: unknown) => send(path, body)),
  });
}

const sq = (name: string) => screen.getByRole("button", { name: new RegExp(`^${name}(:|$)`) });

beforeEach(() => resetGameTypes());

describe("checkers board", () => {
  it("plays a step by clicking the piece and then the square", async () => {
    const onMove = vi.fn();
    render(<Board state={newGame()} bottom="w" canMove="w" onMove={onMove} />);
    await userEvent.click(sq("c3"));
    await userEvent.click(sq("d4"));
    expect(onMove).toHaveBeenCalledWith(expect.objectContaining({ notation: "c3-d4" }));
  });

  it("collects every landing square of a multi-capture before sending it", async () => {
    const s = newGame();
    s.board = s.board.map(() => ".");
    s.board[0] = "w"; // a1
    s.board[9] = "b"; // b2
    s.board[27] = "b"; // d4
    s.board[45] = "b"; // f6
    const onMove = vi.fn();
    render(<Board state={s} bottom="w" canMove="w" onMove={onMove} />);
    await userEvent.click(sq("a1"));
    await userEvent.click(sq("c3"));
    await userEvent.click(sq("e5"));
    expect(onMove).not.toHaveBeenCalled();
    await userEvent.click(sq("g7"));
    expect(onMove).toHaveBeenCalledWith(expect.objectContaining({ notation: "a1:c3:e5:g7" }));
  });

  it("is read-only when it is not the viewer's turn", () => {
    render(<Board state={play(newGame(), "c3-d4")} bottom="w" canMove="w" onMove={vi.fn()} />);
    expect(sq("f6")).toBeDisabled();
  });
});

describe("games home", () => {
  it("shows a tile per game the web can draw, with live counts", async () => {
    const api = gamesApi([game({ turn: 0 }), game({ id: 8, status: "open", players: ["claude", null], turn: null })]);
    renderWithChat(<GamesHome />, { api });
    const tile = await screen.findByRole("link", { name: /Шашки/ });
    expect(tile).toHaveAttribute("href", "#games/checkers");
    await waitFor(() => expect(tile).toHaveTextContent("ваш хід: 1"));
    expect(tile).toHaveTextContent("чекають суперника: 1");
    expect(screen.queryByText("Нім")).toBeNull(); // the broker offers it, but the web has no board for it
  });
});

describe("game lobby", () => {
  it("creates an open game by default, a full one when every seat is picked, and joins open games", async () => {
    const open = game({ id: 9, players: ["claude", null], status: "open", turn: null, created_by: "claude" });
    const api = gamesApi([open], () => ({ game: game({ id: 10 }) }));
    const go = vi.fn();
    renderWithChat(<GameLobby type="checkers" />, { api, go });
    expect(await screen.findByText("Чекає суперника за чорних")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /Почати/ }));
    expect(api.send).toHaveBeenCalledWith("POST", "/api/games", { game: "checkers", seat: "w" });

    await userEvent.selectOptions(screen.getByRole("combobox", { name: "чорні" }), "claude");
    await userEvent.click(screen.getByRole("button", { name: /Почати/ }));
    expect(api.send).toHaveBeenCalledWith("POST", "/api/games", { game: "checkers", players: ["olena", "claude"] });

    await userEvent.click(screen.getByRole("button", { name: /Приєднатися/ }));
    expect(api.send).toHaveBeenCalledWith("POST", "/api/games/9/join", {});
    await waitFor(() => expect(go).toHaveBeenCalledWith({ kind: "game", id: 9 }));
  });

  it("refuses an open seat when you do not sit yourself", async () => {
    renderWithChat(<GameLobby type="checkers" />, { api: gamesApi([]) });
    await userEvent.selectOptions(await screen.findByRole("combobox", { name: "білі" }), "claude");
    expect(screen.getByRole("button", { name: /Почати/ })).toBeDisabled();
  });
});

describe("game page", () => {
  it("sends the player's move to the broker", async () => {
    const api = gamesApi([game()], () => ({ game: game({ moves: ["c3-d4"], turn: 1 }) }));
    renderWithChat(<GamePage id={7} />, { api });
    expect(await screen.findByText("Ваш хід.")).toBeInTheDocument();
    await userEvent.click(sq("c3"));
    await userEvent.click(sq("d4"));
    expect(api.send).toHaveBeenCalledWith("POST", "/api/games/7/move", { move: "c3-d4" });
    expect(await screen.findByText(/Чекаємо на хід claude/)).toBeInTheDocument();
  });

  it("steps back through the moves of a finished game", async () => {
    const moves = ["c3-d4", "f6-e5", "d4:f6", "g7:e5"];
    const done = game({ moves, status: "finished", turn: null, result: { winner: null, reason: "agreement", text: "Нічия за згодою." } });
    renderWithChat(<GamePage id={7} />, { api: gamesApi([done]) });
    expect(await screen.findByText("Нічия за згодою.")).toBeInTheDocument();
    expect(screen.getByText("4/4")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "d4:f6" }));
    expect(screen.getByText("3/4")).toBeInTheDocument();
    expect(sq("f6")).toHaveAccessibleName(/f6: біла шашка/);
  });

  it("shows spectators a read-only board", async () => {
    renderWithChat(<GamePage id={7} />, { api: gamesApi([game({ players: ["claude", "alexey"] })]) });
    expect(await screen.findByText(/як глядач/)).toBeInTheDocument();
    expect(sq("c3")).toBeDisabled();
    expect(screen.queryByRole("button", { name: /Здатися/ })).toBeNull();
  });

  it("works for a game the web has no board for", async () => {
    renderWithChat(<GamePage id={7} />, { api: gamesApi([game({ game: "nim" })]) });
    expect(await screen.findByText(/не має дошки на сайті/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Здатися/ })).toBeInTheDocument();
  });
});

describe("deleting a game", () => {
  it("is offered to admins only and asks before deleting", async () => {
    const done = game({ status: "finished", turn: null, result: { winner: 0, reason: "resign", text: "Перемога: білі (olena)." } });
    const api = gamesApi([done]);
    const { unmount } = renderWithChat(<GameLobby type="checkers" />, { api });
    await screen.findByText(/Перемога/);
    expect(screen.queryByRole("button", { name: /Видалити партію/ })).toBeNull();
    unmount();

    renderWithChat(<GameLobby type="checkers" />, { api, session: adminSession, sender: "alexey" });
    await userEvent.click(await screen.findByRole("button", { name: "Видалити партію №7" }));
    expect(screen.getByRole("alertdialog")).toHaveTextContent("кімната #game-7");
    await userEvent.click(screen.getByRole("button", { name: "Видалити назавжди" }));
    expect(api.send).toHaveBeenCalledWith("DELETE", "/admin/api/games/7");
  });
});

describe("game status text", () => {
  it("names whose turn it is, who is awaited, and uses the broker's result text", () => {
    expect(gameStatus(game({ moves: ["c3-d4"], turn: 1 }), CHECKERS)).toBe("Хід: claude (чорні)");
    expect(gameStatus(game({ status: "open", players: [null, "claude"], turn: null }), CHECKERS)).toBe("Чекає суперника за білих");
    expect(gameStatus(game({ status: "finished", turn: null, result: { winner: null, reason: "repetition", text: "Нічия." } }), CHECKERS)).toBe("Нічия.");
  });
});

describe("admin rooms panel", () => {
  it("leaves game rooms out", async () => {
    const api = fakeApi({
      get: vi.fn(async (path: string) =>
        path === "/admin/api/rooms"
          ? {
              rooms: [
                { name: "lobby", members: [], count: 0, last_ts: null },
                { name: "game-7", members: [], count: 4, last_ts: null },
              ],
            }
          : { agents: [] },
      ),
    });
    renderWithChat(<RoomsPanel />, { api, session: adminSession, sender: "alexey" });
    expect(await screen.findByText("lobby")).toBeInTheDocument();
    expect(screen.queryByText("game-7")).toBeNull();
  });
});
