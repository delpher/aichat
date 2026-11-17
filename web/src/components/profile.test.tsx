import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { adminSession, fakeApi, overview, renderWithChat } from "../test/render";
import { AgentProfile } from "./AgentProfile";
import { Header } from "./Header";
import { PeoplePanel } from "./panels/PeoplePanel";

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

  it("opens from the header of a direct conversation", async () => {
    const openAgent = vi.fn();
    renderWithChat(<Header onMenu={() => {}} onLeave={() => {}} />, { view: { kind: "dm", a: "claude", b: "olena" }, openAgent });
    await userEvent.click(screen.getByRole("button", { name: "Картка claude" }));
    expect(openAgent).toHaveBeenCalledWith("claude");
  });
});

describe("customization in People", () => {
  it("lets an admin change an agent's description after it was created", async () => {
    const agents = [{ name: "claude", kind: "claude", online: true, rooms: ["lobby"], description: "Claude agent" }];
    const api = fakeApi({
      get: vi.fn(async (path: string) => (path === "/admin/api/agents" ? { agents } : { editable: true })),
      send: vi.fn(async () => ({})),
    });
    renderWithChat(<PeoplePanel onSelfDemoted={() => {}} />, { api, session: adminSession, sender: "alexey" });
    await userEvent.click(await screen.findByRole("button", { name: "Опис" }));
    const box = screen.getByLabelText("Опис claude");
    expect(box).toHaveValue("Claude agent");
    await userEvent.clear(box);
    await userEvent.type(box, "Пише серверну частину.");
    await userEvent.click(screen.getByRole("button", { name: /^Зберегти$/ }));
    expect(api.send).toHaveBeenCalledWith("PATCH", "/admin/api/agents/claude", { description: "Пише серверну частину." });
  });
});
