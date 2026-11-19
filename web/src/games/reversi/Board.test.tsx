import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { GameInfo } from "../../api/types";
import { findGame } from "../registry";
import { Board } from "./Board";
import { newGame, replay } from "./engine";
import { reversi } from "./index";

const game = (moves: string[]): GameInfo => ({
  id: 1,
  game: "reversi",
  room: "game-1",
  players: ["olena", "bot1"],
  status: "active",
  moves,
  turn: moves.length % 2,
  result: null,
  draw_offer: null,
  created_ts: "2026-11-19T10:00:00Z",
  updated_ts: "2026-11-19T10:00:00Z",
} as unknown as GameInfo);

describe("reversi board", () => {
  it("marks the squares the player may take and plays one with a click", async () => {
    const onMove = vi.fn();
    render(<Board state={newGame()} bottom="b" canMove="b" onMove={onMove} />);
    const open = screen.getAllByRole("button").filter((b) => !(b as HTMLButtonElement).disabled);
    expect(open.map((b) => b.getAttribute("title")).sort()).toEqual(["c4", "d3", "e6", "f5"]);
    expect(screen.getByLabelText("d3: можна поставити, перевернеться 1")).toBeInTheDocument();
    expect(screen.getByLabelText("d4: біла")).toBeInTheDocument();
    await userEvent.click(screen.getByTitle("d3"));
    expect(onMove).toHaveBeenCalledWith("d3");
  });

  it("offers nothing to a spectator or out of turn, and shows the score", () => {
    render(<Board state={replay(["d3"])} bottom="b" canMove="b" />);
    expect(screen.getAllByRole("button").every((b) => (b as HTMLButtonElement).disabled)).toBe(true);
    expect(screen.getByText(/4/, { selector: ".reversi-score" })).toHaveTextContent("4 1");
  });

  it("replays a game with a pass in it and is listed among the games", () => {
    const moves = ["d3", "c3", "f5", "d2", "d1", "e1", "b2", "c1", "pass"];
    render(<reversi.Play game={game(moves)} ply={moves.length} canMove={1} bottom={1} onMove={() => {}} />);
    // white to move after black's pass: some square is open to white
    expect(screen.getAllByRole("button").some((b) => !(b as HTMLButtonElement).disabled)).toBe(true);
    expect(findGame("reversi")).toBe(reversi);
    expect(reversi.toText!(["d3"])).toMatch(/Фішок: чорні 4, білі 1\n\nd3$/);
  });
});
