import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { findGame } from "../registry";
import { Board } from "./Board";
import { replay } from "./engine";
import { balda } from "./index";

const start = () => replay(["start 3 кошик"]);

describe("balda board", () => {
  it("puts a letter on an open cell and sends the word's chain", async () => {
    const onMove = vi.fn();
    render(<Board state={start()} players={["olena", "bot1", "bot2"]} canMove onMove={onMove} />);
    expect(screen.getByLabelText("c3: ш")).toBeInTheDocument();
    expect(screen.getByTitle("c1")).toBeDisabled(); // not next to a letter
    await userEvent.click(screen.getByTitle("d2"));
    await userEvent.click(screen.getByRole("button", { name: "т" }));
    expect(screen.getByLabelText("d2: т")).toBeInTheDocument();
    for (const c of ["e3", "d3", "d2"]) await userEvent.click(screen.getByTitle(c));
    expect(screen.getByText("кит", { selector: ".bd-word" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Походити «кит»" }));
    expect(onMove).toHaveBeenCalledWith("d2 т e3 d3 d2");
  });

  it("takes back the last cell of the chain, and passes", async () => {
    const onMove = vi.fn();
    render(<Board state={start()} players={["olena", "bot1", "bot2"]} canMove onMove={onMove} />);
    await userEvent.click(screen.getByTitle("d2"));
    await userEvent.click(screen.getByRole("button", { name: "т" }));
    await userEvent.click(screen.getByTitle("e3"));
    await userEvent.click(screen.getByTitle("d3"));
    await userEvent.click(screen.getByTitle("d3")); // back to "к"
    expect(screen.getByRole("button", { name: "Походити «к»" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Пропустити хід" }));
    expect(onMove).toHaveBeenCalledWith("pass");
  });

  it("shows a spectator the scores and the words, without controls", () => {
    const s = replay(["start 3 кошик", "d2 т кит", "out 1"]);
    render(<Board state={s} players={["olena", "bot1", "bot2"]} canMove={false} />);
    expect(screen.queryByRole("button", { name: "Пропустити хід" })).toBeNull();
    expect(screen.getByText("olena").closest("li")).toHaveTextContent("olena3");
    expect(screen.getByText("bot1").closest("li")).toHaveClass("out");
    expect(screen.getByText("bot2").closest("li")).toHaveClass("turn");
    expect(screen.getByText("кит")).toBeInTheDocument();
    expect(findGame("balda")).toBe(balda);
  });
});
