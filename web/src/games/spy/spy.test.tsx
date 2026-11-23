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
  it("registers in the games registry and formats text summary and move rows", () => {
    expect(findGame("spy")).toBe(spy);
    expect(spy.toText?.(["deal 3", "clue море"])).toContain("«море»");
    const rows = spy.moveRows?.(["deal 3", "accuse 0 1", "ballot 2 yes", "verdict -", "stop 1 маяк"]);
    expect(rows?.map((r) => r[0].text)).toEqual([
      "Роздача",
      "гравець 1 звинувачує гравець 2",
      "гравець 3: так",
      "Не одностайно",
      "Шпигун: «маяк»",
    ]);
  });

  it("loads the player card once, hides/shows it, submits a clue, and does not show early guess for non-spy", async () => {
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
    expect(screen.queryByLabelText("Слово шпигуна")).toBeNull();
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

  it("allows out-of-turn accusation in clue phase and disables it once used", async () => {
    const onMove = vi.fn();
    const get = vi.fn(async () => ({
      card: "твоє слово — «маяк». Давай підказки так, щоб свої впізнали, а шпигун не здогадався. Самого слова не називай.",
    }));
    const game = makeGame({ moves: ["deal 3", "clue море"], turn: 1, movers: [1] });
    const { rerender, ctx } = renderWithChat(
      <spy.Play game={game} ply={2} canMove={null} bottom={0} onMove={onMove} />,
      { api: fakeApi({ get }) },
    );

    expect(await screen.findByText("«маяк»")).toBeInTheDocument();
    // Cannot accuse self
    expect(screen.queryByRole("button", { name: "Звинуватити olena" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Звинуватити bot2" }));
    expect(onMove).toHaveBeenCalledWith("accuse bot2");

    // After olena already accused and the vote failed, buttons become disabled and history is shown
    const afterFail = makeGame({
      moves: ["deal 3", "clue море", "accuse 0 2", "ballot 1 no", "verdict -"],
      turn: 1,
      movers: [1],
    });
    rerender(
      <ChatContext.Provider value={ctx}>
        <spy.Play game={afterFail} ply={afterFail.moves.length} canMove={null} bottom={0} onMove={onMove} />
      </ChatContext.Provider>,
    );
    expect(screen.getByRole("button", { name: "Звинуватити bot1" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Звинуватити bot2" })).toBeDisabled();
    expect(screen.getByLabelText("Історія звинувачень")).toBeInTheDocument();
    expect(screen.getByText("не одностайно")).toBeInTheDocument();
    expect(screen.getByText("olena — так, bot1 — ні")).toBeInTheDocument();
  });

  it("lets the spy guess the word out of turn during clue phase via guess <word>", async () => {
    const onMove = vi.fn();
    const get = vi.fn(async () => ({
      card: "ти — шпигун. Слова ти не знаєш: слухай підказки, давай свою так, ніби знаєш, і не видай себе.",
    }));
    const game = makeGame({ moves: ["deal 3", "clue море"], turn: 1, movers: [1] });
    renderWithChat(<spy.Play game={game} ply={2} canMove={null} bottom={0} onMove={onMove} />, {
      api: fakeApi({ get }),
    });

    expect(await screen.findByText("Ви — шпигун")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Слово шпигуна"), "маяк");
    await userEvent.click(screen.getByRole("button", { name: "Назвати слово" }));
    expect(onMove).toHaveBeenCalledWith("guess маяк");
  });

  it("handles yes/no secret voting in accuse phase and hides ballots until verdict", async () => {
    const onMove = vi.fn();
    const get = vi.fn(async () => ({
      card: "твоє слово — «маяк». Давай підказки так, щоб свої впізнали, а шпигун не здогадався. Самого слова не називай.",
    }));
    const moves = ["deal 4", "clue море", "accuse 1 2", "ballot 3"];
    const game = makeGame({
      players: ["olena", "bot1", "bot2", "bot3"],
      moves,
      turn: 1,
      movers: [0],
    });
    renderWithChat(<spy.Play game={game} ply={moves.length} canMove={0} bottom={0} onMove={onMove} />, {
      api: fakeApi({ get }),
    });

    expect(await screen.findByText("«маяк»")).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Голосування за звинувачення" })).toBeInTheDocument();
    expect(screen.getByText("проголосував")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Так" }));
    expect(onMove).toHaveBeenCalledWith("vote так");
    await userEvent.click(screen.getByRole("button", { name: "Ні" }));
    expect(onMove).toHaveBeenCalledWith("vote ні");
  });

  it("shows accusation history and spy miss details in the game-over summary", async () => {
    const get = vi.fn(async () => {
      throw new Error("403");
    });
    const moves = [
      "deal 3 1 маяк",
      "clue море",
      "accuse 0 2",
      "ballot 1 no",
      "verdict -",
      "stop 1 острів",
    ];
    const game = makeGame({
      id: 44,
      moves,
      turn: null,
      status: "finished",
      movers: undefined,
      result: { winner: 0, winners: [0, 2], reason: "missed", text: "Перемога: olena, bot2. Шпигун назвав не те слово." },
    });
    renderWithChat(<spy.Play game={game} ply={moves.length} canMove={null} bottom={0} onMove={vi.fn()} />, {
      api: fakeApi({ get }),
      sender: "alexey",
    });

    await waitFor(() => expect(get).toHaveBeenCalledWith("/api/games/44/card"));
    expect(screen.getByLabelText("Підсумок партії")).toBeInTheDocument();
    expect(screen.getByText("шпигун назвав не те слово")).toBeInTheDocument();
    expect(screen.getByText("«маяк»")).toBeInTheDocument();
    expect(screen.getByText("«острів»")).toBeInTheDocument();
    expect(screen.getByLabelText("Історія звинувачень")).toBeInTheDocument();
    expect(screen.getByText("olena — так, bot1 — ні")).toBeInTheDocument();
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

  it("lets the caught spy submit a guess in legacy games", async () => {
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

  it("reveals the word, spy, guess, and all votes when a legacy game is over, and ignores 403 for spectators", async () => {
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
    expect(screen.getByText("шпигуна викрито")).toBeInTheDocument();
    expect(screen.getByText("«маяк»")).toBeInTheDocument();
    expect(screen.getByText("«острів»")).toBeInTheDocument();
    expect(screen.getAllByText("→ bot1")).toHaveLength(2);
    expect(screen.getByText("→ olena")).toBeInTheDocument();
  });
});
