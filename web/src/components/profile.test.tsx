import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { fakeApi, overview, renderWithChat } from "../test/render";
import { AgentProfile } from "./AgentProfile";
import { Header } from "./Header";

describe("agent card", () => {
  it("shows the kind, the admin's customization and rooms, and opens a direct conversation", async () => {
    const go = vi.fn();
    const onClose = vi.fn();
    renderWithChat(<AgentProfile name="claude" onClose={onClose} />, { go });
    const card = screen.getByRole("dialog", { name: "Картка claude" });
    expect(card).toHaveTextContent("Claude agent");
    expect(card).toHaveTextContent("Кастомізація");
    expect(card).toHaveTextContent("#lobby");
    expect(card).toHaveTextContent("Подяки0");
    await userEvent.click(screen.getByRole("button", { name: /Написати/ }));
    expect(go).toHaveBeenCalledWith({ kind: "dm", a: "claude", b: "olena" });
    expect(onClose).toHaveBeenCalled();
  });

  it("treats an empty customization as normal and shows the thanks received", () => {
    const o = {
      ...overview,
      agents: overview.agents.map((a) => (a.name === "claude" ? { ...a, description: undefined, thanks: 3 } : a)),
    };
    renderWithChat(<AgentProfile name="claude" onClose={() => {}} />, { overview: o });
    expect(screen.getByRole("dialog")).toHaveTextContent(/Кастомізаціянемає/);
    expect(screen.getByRole("dialog")).toHaveTextContent("Подяки3");
  });

  it("shows which adapter an online agent runs, and when it is older than the broker's", () => {
    const o = {
      ...overview,
      version: "0.3.0",
      agents: overview.agents.map((x) => (x.name === "claude" ? { ...x, adapter: { name: "claude-channel", version: "0.2.9" } } : x)),
    };
    renderWithChat(<AgentProfile name="claude" onClose={() => {}} />, { overview: o });
    expect(screen.getByRole("dialog")).toHaveTextContent("Адаптерclaude-channel 0.2.9 · старий, на брокері 0.3.0");
  });

  it("shows the keeper as part of AIChat, not as a participant with a customization", () => {
    const o = { ...overview, agents: [...overview.agents, { name: "keeper", kind: "claude", online: true, rooms: [], keeper: true as const }] };
    renderWithChat(<AgentProfile name="keeper" onClose={() => {}} />, { overview: o });
    const card = screen.getByRole("dialog");
    expect(card).toHaveTextContent(/Keeper: частина самого AIChat/);
    expect(card).not.toHaveTextContent("Кастомізація");
  });

  it("opens from the header of a direct conversation", async () => {
    const openAgent = vi.fn();
    renderWithChat(<Header onMenu={() => {}} onLeave={() => {}} />, { view: { kind: "dm", a: "claude", b: "olena" }, openAgent });
    await userEvent.click(screen.getByRole("button", { name: "Картка claude" }));
    expect(openAgent).toHaveBeenCalledWith("claude");
  });
});

describe("notebook in the card", () => {
  it("shows an agent's notes read-only, most recently changed first: title, description, text on demand", async () => {
    const notes = [
      { id: 1, title: "Olena", description: "olena prefers short answers", text: "she said so on 17.11", topic: "people", ts: "2026-11-17T09:00:00Z" },
      { id: 2, title: "Tests", description: "npm test needs a timeout", ts: "2026-11-17T10:00:00Z" },
    ];
    const api = fakeApi({ get: vi.fn(async () => ({ notes })) });
    renderWithChat(<AgentProfile name="claude" onClose={() => {}} />, { api });
    expect(screen.queryByRole("region", { name: "Нотатник claude" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /Нотатник/ }));
    const book = await screen.findByRole("region", { name: "Нотатник claude" });
    expect(api.get).toHaveBeenCalledWith("/api/agents/claude/notes");
    const items = await within(book).findAllByRole("listitem");
    expect(items.map((li) => li.querySelector(".note-title")!.textContent)).toEqual(["Tests", "Olena"]);
    expect(items.map((li) => li.querySelector(".note-description")!.textContent)).toEqual(["npm test needs a timeout", "olena prefers short answers"]);
    expect(items[1]).toHaveTextContent("people");
    // the text is folded away until asked for; a note without one has nothing to unfold
    expect(items[0].querySelector("details")).toBeNull();
    const more = items[1].querySelector("details")!;
    expect(more.open).toBe(false);
    expect(within(more).getByText("Текст, 20 символів")).toBeInTheDocument();
    await userEvent.click(within(more).getByText("Текст, 20 символів"));
    expect(more.open).toBe(true);
    expect(within(more).getByText("she said so on 17.11")).toBeVisible();
    expect(within(book).queryByRole("textbox")).toBeNull();
  });

  it("says when the notebook is empty", async () => {
    renderWithChat(<AgentProfile name="claude" onClose={() => {}} />, { api: fakeApi({ get: vi.fn(async () => ({ notes: [] })) }) });
    await userEvent.click(screen.getByRole("button", { name: /Нотатник/ }));
    expect(await screen.findByText("Нотатник порожній.")).toBeInTheDocument();
  });

  it("has no notebook for people", () => {
    renderWithChat(<AgentProfile name="alexey" onClose={() => {}} />);
    expect(screen.queryByRole("button", { name: /Нотатник/ })).toBeNull();
  });
});
