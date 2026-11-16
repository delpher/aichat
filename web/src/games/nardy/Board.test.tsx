import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { GameInfo } from "../../api/types";
import { Board, type NardyView, type Step } from "./Board";
import { nardy } from "./index";

/** Start of long nardy: 15 white on white's 24, 15 black on black's 24 (white's 12). */
function start(p: Partial<NardyView> = {}): NardyView {
  const points = Array(24).fill(0);
  points[23] = 15;
  points[11] = -15;
  return { points, off: [0, 0], turn: "w", dice: [6, 3], roll: [6, 3], ...p };
}

const STEPS: Step[] = [
  { from: 24, to: 18, notation: "24-18" },
  { from: 24, to: 21, notation: "24-21" },
];

describe("nardy board", () => {
  it("shows the heads, the dice and the borne-off counts", () => {
    render(<Board state={start()} bottom="w" canMove={null} steps={[]} />);
    expect(screen.getByLabelText("24: 15 білих")).toBeInTheDocument();
    expect(screen.getByLabelText("12: 15 чорних")).toBeInTheDocument();
    expect(screen.getByLabelText("Кубики: 6 і 3")).toBeInTheDocument();
    expect(screen.getAllByText("15", { selector: ".nd-count" })).toHaveLength(2); // both heads
    expect(screen.getAllByText("0/15")).toHaveLength(2);
  });

  it("numbers the points from the bottom player's side", () => {
    render(<Board state={start()} bottom="b" canMove={null} steps={[]} />);
    // Black's head is its own 24; white's head is black's 12.
    expect(screen.getByLabelText("24: 15 чорних")).toBeInTheDocument();
    expect(screen.getByLabelText("12: 15 білих")).toBeInTheDocument();
  });

  it("moves a checker: pick the point, then the target", async () => {
    const onMove = vi.fn();
    render(<Board state={start()} bottom="w" canMove="w" steps={STEPS} onMove={onMove} />);
    const head = screen.getByLabelText("24: 15 білих");
    expect(head).toHaveClass("movable");
    await userEvent.click(head);
    expect(head).toHaveClass("picked");
    expect(screen.getByLabelText("18: порожньо")).toHaveClass("target");
    expect(screen.getByLabelText("21: порожньо")).toHaveClass("target");
    await userEvent.click(screen.getByLabelText("21: порожньо"));
    expect(onMove).toHaveBeenCalledWith("24-21");
  });

  it("bears off with the button once a checker that can leave is picked", async () => {
    const onMove = vi.fn();
    const points = Array(24).fill(0);
    points[2] = 1;
    points[11] = -15;
    const state = start({ points, off: [14, 0], dice: [5], roll: [5, 2] });
    render(<Board state={state} bottom="w" canMove="w" steps={[{ from: 3, to: 0, notation: "3-off" }]} onMove={onMove} />);
    expect(screen.queryByRole("button", { name: "Зняти" })).toBeNull();
    await userEvent.click(screen.getByLabelText("3: 1 білих"));
    await userEvent.click(screen.getByRole("button", { name: "Зняти" }));
    expect(onMove).toHaveBeenCalledWith("3-off");
    expect(screen.getByText("14/15")).toBeInTheDocument();
  });

  it("marks spent dice and lets nobody move out of turn", () => {
    render(<Board state={start({ dice: [3], turn: "b" })} bottom="w" canMove="w" steps={STEPS} onMove={vi.fn()} />);
    const dice = screen.getByLabelText("Кубики: 6 і 3").children;
    expect(dice[0]).toHaveClass("used");
    expect(dice[1]).not.toHaveClass("used");
    expect(screen.getByLabelText("24: 15 білих")).toBeDisabled();
  });
});

function game(moves: string[]): GameInfo {
  return {
    id: 9,
    game: "nardy",
    room: "game-9",
    players: ["olena", "claude"],
    turn: 0,
    created_by: "olena",
    moves,
    status: "active",
    result: null,
    draw_offer: null,
    created_ts: "2026-11-15T09:00:00Z",
    updated_ts: "2026-11-15T09:00:00Z",
  };
}

describe("nardy module", () => {
  it("plays a step from the head with the broker's roll", async () => {
    const onMove = vi.fn();
    const moves = ["first 6-1", "roll 6-3"];
    render(<nardy.Play game={game(moves)} ply={moves.length} canMove={0} bottom={0} onMove={onMove} />);
    expect(screen.getByLabelText("Кубики: 6 і 3")).toBeInTheDocument();
    await userEvent.click(screen.getByLabelText("24: 15 білих"));
    await userEvent.click(screen.getByLabelText("18: порожньо"));
    expect(onMove).toHaveBeenCalledWith("24-18");
  });

  it("highlights the last turn and groups the move list by rolls", () => {
    const moves = ["first 6-1", "roll 6-3", "24-18 18-15", "roll 5-2"];
    render(<nardy.Play game={game(moves)} ply={moves.length} canMove={null} bottom={0} onMove={vi.fn()} />);
    expect(screen.getByLabelText("24: 14 білих")).toHaveClass("last");
    expect(screen.getByLabelText("15: 1 білих")).toHaveClass("last");
    expect(nardy.moveRows!(moves).map((r) => r.map((m) => m.text).join(" "))).toEqual([
      "перший кидок 6-1",
      "6-3: 24-18 18-15",
      "5-2:",
    ]);
  });
});
