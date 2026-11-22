import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { GameInfo } from "../../api/types";
import { ChatContext } from "../../context";
import { fakeApi, renderWithChat } from "../../test/render";
import { findGame } from "../registry";
import { spy } from "./index";

function makeGame(over: Partial<GameInfo> = {}): GameInfo {
  return {
    id: 42,
    game: "spy",
    room: "game-42",
    status: "active",
    players: ["olena", "bot1", "bot2"],
    moves: ["deal 3"],
    turn: 0,
    movers: [0],
    result: null,
    draw_offer: null,
    created_by: "olena",
    created_ts: "2026-11-22T18:00:00Z",
    updated_ts: "2026-11-22T18:00:00Z",
    ...over,
  } as GameInfo;
}

describe("spy game web module", () => {
  it("registers in the games registry and formats text summary", () => {
    expect(findGame("spy")).toBe(spy);
    expect(spy.toText?.(["deal 3", "clue море"])).toContain("«море»");
  });

  it("loads the player card once, hides/shows it, and submits a clue", async () => {
    const onMove = vi.fn();
    const get = vi.fn(async (path: string) => {
      if (path === "/api/games/42/card") {
        return {
          card: "твоє слово — «маяк». Давай підказки так, щоб свої впізнали, а шпигун не здогадався. Самого слова не називай.",
        };
      }
      return {};
    });
    const game = makeGame({ moves: ["deal 3"] });
    const { rerender, ctx } = renderWithChat(
      <spy.Play game={game} ply={1} canMove={0} bottom={0} onMove={onMove} />,
      { api: fakeApi({ get }) },
    );

    expect(await screen.findByText(/твоє слово — «маяк»/i)).toBeInTheDocument();
    expect(screen.getByText("«маяк»")).toBeInTheDocument();
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith("/api/games/42/card");

    // Hide and show the card
    await userEvent.click(screen.getByRole("button", { name: "Сховати" }));
    expect(screen.queryByText(/твоє слово — «маяк»/i)).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Показати" }));
    expect(screen.getByText(/твоє слово — «маяк»/i)).toBeInTheDocument();

    // Submit a clue
    const submit = screen.getByRole("button", { name: "Дати підказку" });
    expect(submit).toBeDisabled();
    await userEvent.type(screen.getByLabelText("Ваша підказка"), "берег і світло");
    expect(submit).toBeEnabled();
    await userEvent.click(submit);
    expect(onMove).toHaveBeenCalledWith("берег і світло");

    // Updating moves does not refetch the card
    const nextGame = makeGame({ moves: ["deal 3", "clue берег і світло"], turn: 1, movers: [1] });
    rerender(
      <ChatContext.Provider value={ctx}>
        <spy.Play game={nextGame} ply={2} canMove={null} bottom={0} onMove={onMove} />
      </ChatContext.Provider>,
    );
    expect(screen.getByText("«берег і світло»")).toBeInTheDocument();
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("shows secret voting buttons without self or resigned players, and hides vote targets", async () => {
    const onMove = vi.fn();
    const get = vi.fn(async () => ({
      card: "ти — шпигун. Слова ти не знаєш: слухай підказки, давай свою так, ніби знаєш, і не видай себе.",
    }));
    const moves = [
      "deal 4",
      "clue море",
      "clue хвилі",
      "clue корабель",
      "out 3",
      "clue світло",
      "clue вежа",
      "clue берег",
      "vote 1",
    ];
    const game = makeGame({
      players: ["olena", "bot1", "bot2", "bot3"],
      moves,
      turn: null,
      movers: [0, 2],
    });
    renderWithChat(<spy.Play game={game} ply={moves.length} canMove={0} bottom={0} onMove={onMove} />, {
      api: fakeApi({ get }),
    });

    expect(await screen.findByText("Ви — шпигун")).toBeInTheDocument();
    expect(screen.getByText(/Таємне голосування/i)).toBeInTheDocument();
    // bot1 voted secretly, no target shown
    expect(screen.getByText("проголосував")).toBeInTheDocument();
    // Cannot vote for self (olena) or resigned player (bot3)
    expect(screen.queryByRole("button", { name: "olena" })).toBeNull();
    expect(screen.queryByRole("button", { name: "bot3" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "bot2" }));
    expect(onMove).toHaveBeenCalledWith("vote bot2");
  });

  it("lets the caught spy submit a guess and hides the card quietly on 403 for spectators", async () => {
    const onMove = vi.fn();
    const spyGet = vi.fn(async () => ({
      card: "ти — шпигун. Слова ти не знаєш: слухай підказки, давай свою так, ніби знаєш, і не видай себе.",
    }));
    const moves = [
      "deal 3",
      "clue море",
      "clue пісок",
      "clue вежа",
      "clue світло",
      "clue берег",
      "clue корабель",
      "vote 0 1",
      "vote 1 0",
      "vote 2 1",
      "reveal 1 spy",
    ];
    const game = makeGame({ players: ["olena", "bot1", "bot2"], moves, turn: 1, movers: [1] });
    renderWithChat(<spy.Play game={game} ply={moves.length} canMove={1} bottom={1} onMove={onMove} />, {
      api: fakeApi({ get: spyGet }),
      sender: "bot1",
    });

    expect(await screen.findByText("Ви — шпигун")).toBeInTheDocument();
    expect(screen.getByText(/Викрито шпигуна/i)).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Слово шпигуна"), "маяк");
    await userEvent.click(screen.getByRole("button", { name: "Назвати слово" }));
    expect(onMove).toHaveBeenCalledWith("маяк");
  });

  it("reveals the word, spy, guess, and all votes when the game is over, and ignores 403 for spectators", async () => {
    const spectatorGet = vi.fn(async () => {
      throw new Error("403");
    });
    const moves = [
      "deal 3 1 маяк",
      "clue море",
      "clue пісок",
      "clue вежа",
      "clue світло",
      "clue берег",
      "clue корабель",
      "vote 0 1",
      "vote 1 0",
      "vote 2 1",
      "reveal 1 spy",
      "guess острів",
    ];
    const game = makeGame({
      id: 43,
      moves,
      turn: null,
      status: "finished",
      movers: undefined,
      result: { winner: 0, winners: [0, 2], reason: "caught", text: "Перемога: olena, bot2. Шпигуна викрито, і слово він не вгадав." },
    });
    renderWithChat(<spy.Play game={game} ply={moves.length} canMove={null} bottom={0} onMove={vi.fn()} />, {
      api: fakeApi({ get: spectatorGet }),
      sender: "alexey",
    });

    await waitFor(() => expect(spectatorGet).toHaveBeenCalledWith("/api/games/43/card"));
    expect(screen.queryByLabelText("Ваша картка")).toBeNull();
    expect(screen.getByLabelText("Підсумок партії")).toBeInTheDocument();
    expect(screen.getByText("шпигуна викрито, і слово він не вгадав")).toBeInTheDocument();
    expect(screen.getByText("«маяк»")).toBeInTheDocument();
    expect(screen.getByText("«острів»")).toBeInTheDocument();
    expect(screen.getAllByText("→ bot1")).toHaveLength(2);
    expect(screen.getByText("→ olena")).toBeInTheDocument();
  });
});
