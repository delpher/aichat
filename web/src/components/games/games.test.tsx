import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { GameInfo } from "../../api/types";
import { adminSession, fakeApi, renderWithChat } from "../../test/render";
import { newGame, play } from "../../../../src/games/checkers";
import { RoomsPanel } from "../panels/RoomsPanel";
import { Board } from "./Board";
import { GameView } from "./GameView";
import { GamesPanel } from "./GamesPanel";
import { gameStatus } from "./gameText";

function game(p: Partial<GameInfo> = {}): GameInfo {
  return {
    id: 7,
    game: "checkers",
    room: "game-7",
    white: "olena",
    black: "claude",
    created_by: "olena",
    moves: [],
    status: "active",
    created_ts: "2026-11-15T09:00:00Z",
    updated_ts: "2026-11-15T09:00:00Z",
    ...p,
  };
}

const sq = (name: string) => screen.getByRole("button", { name: new RegExp(`^${name}(:|$)`) });

describe("Board", () => {
  it("plays a step by clicking the piece and then the square", async () => {
    const onMove = vi.fn();
    render(<Board state={newGame()} bottom="w" canMove="w" onMove={onMove} />);
    await userEvent.click(sq("c3"));
    await userEvent.click(sq("d4"));
    expect(onMove).toHaveBeenCalledWith(expect.objectContaining({ notation: "c3-d4" }));
  });

  it("collects every landing square of a multi-capture before sending it", async () => {
    // White a1 can take b2, d4 and f6 in one move.
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

  it("is read-only when it is not the viewer's turn", async () => {
    const onMove = vi.fn();
    render(<Board state={play(newGame(), "c3-d4")} bottom="w" canMove="w" onMove={onMove} />);
    expect(sq("f6")).toBeDisabled();
  });
});

describe("GamesPanel", () => {
  it("lists games and starts a new one against the chosen opponent", async () => {
    const api = fakeApi({
      get: vi.fn(async () => ({ games: [game({ status: "finished", result: { winner: "b", reason: "resign" } })] })),
      send: vi.fn(async () => ({ game: game({ id: 8 }) })),
    });
    const go = vi.fn();
    renderWithChat(<GamesPanel />, { api, go });
    expect(await screen.findByText(/Перемога: claude \(чорні\) · здача/)).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Чорні" }), "claude");
    await userEvent.click(screen.getByRole("button", { name: /Почати/ }));
    expect(api.send).toHaveBeenCalledWith("POST", "/api/games", { game: "checkers", white: "olena", black: "claude" });
    await waitFor(() => expect(go).toHaveBeenCalledWith({ kind: "game", id: 8 }));
  });
});

describe("open games", () => {
  it("creates an open game by default and lets another player join one", async () => {
    const open = game({ id: 9, white: "claude", black: null, status: "open", created_by: "claude" });
    const api = fakeApi({
      get: vi.fn(async () => ({ games: [open] })),
      send: vi.fn(async () => ({ game: { ...open, black: "olena", status: "active" } })),
    });
    const go = vi.fn();
    renderWithChat(<GamesPanel />, { api, go });
    expect(await screen.findByText("Чекає суперника за чорні")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Приєднатися/ }));
    expect(api.send).toHaveBeenCalledWith("POST", "/api/games/9/join", {});
    await waitFor(() => expect(go).toHaveBeenCalledWith({ kind: "game", id: 9 }));
    await userEvent.click(screen.getByRole("button", { name: /Почати/ }));
    expect(api.send).toHaveBeenCalledWith("POST", "/api/games", { game: "checkers", white: "olena" });
  });

  it("shows spectators a read-only board", async () => {
    const api = fakeApi({ get: vi.fn(async () => ({ game: game({ white: "claude", black: "alexey" }) })) });
    renderWithChat(<GameView id={7} />, { api });
    expect(await screen.findByText(/як глядач/)).toBeInTheDocument();
    expect(sq("c3")).toBeDisabled();
    expect(screen.queryByRole("button", { name: /Здатися/ })).toBeNull();
  });
});

describe("GameView", () => {
  it("sends the player's move to the broker", async () => {
    const api = fakeApi({
      get: vi.fn(async () => ({ game: game() })),
      send: vi.fn(async () => ({ game: game({ moves: ["c3-d4"] }) })),
    });
    renderWithChat(<GameView id={7} />, { api });
    expect(await screen.findByText(/Ваш хід/)).toBeInTheDocument();
    await userEvent.click(sq("c3"));
    await userEvent.click(sq("d4"));
    expect(api.send).toHaveBeenCalledWith("POST", "/api/games/7/move", { move: "c3-d4" });
    expect(await screen.findByText(/Чекаємо на хід claude/)).toBeInTheDocument();
  });

  it("steps back through the moves of a finished game", async () => {
    const moves = ["c3-d4", "f6-e5", "d4:f6", "g7:e5"];
    const api = fakeApi({ get: vi.fn(async () => ({ game: game({ moves, status: "finished", result: { winner: null, reason: "agreement" } }) })) });
    renderWithChat(<GameView id={7} />, { api });
    expect(await screen.findByText("4/4")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "d4:f6" }));
    expect(screen.getByText("3/4")).toBeInTheDocument();
    expect(sq("f6")).toHaveAccessibleName(/f6: біла шашка/);
  });
});

describe("gameStatus", () => {
  it("names whose turn it is and how a game ended", () => {
    expect(gameStatus(game({ moves: ["c3-d4"] }))).toBe("Хід: claude (чорні)");
    expect(gameStatus(game({ status: "finished", result: { winner: null, reason: "repetition" } }))).toBe("Нічия · триразове повторення");
  });
});

describe("deleting a game", () => {
  it("is offered to admins only and asks before deleting", async () => {
    const api = fakeApi({ get: vi.fn(async () => ({ games: [game({ status: "finished", result: { winner: "w", reason: "resign" } })] })) });
    const { unmount } = renderWithChat(<GamesPanel />, { api });
    await screen.findByText(/Перемога/);
    expect(screen.queryByRole("button", { name: /Видалити партію/ })).toBeNull();
    unmount();

    renderWithChat(<GamesPanel />, { api, session: adminSession, sender: "alexey" });
    await userEvent.click(await screen.findByRole("button", { name: "Видалити партію №7" }));
    expect(screen.getByRole("alertdialog")).toHaveTextContent("кімната #game-7");
    await userEvent.click(screen.getByRole("button", { name: "Видалити назавжди" }));
    expect(api.send).toHaveBeenCalledWith("DELETE", "/admin/api/games/7");
    await waitFor(() => expect(screen.queryByText(/Перемога/)).toBeNull());
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
