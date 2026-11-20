import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "../../api/types";
import { handSetup } from "../../lib/handoff";
import { mayLeave, setLeaveGuard } from "../../lib/leave";
import { hashFor, parseHash } from "../../lib/views";
import { adminSession, fakeApi, renderWithChat } from "../../test/render";
import { AddPersonPage } from "./AddPersonPage";
import { PeoplePanel } from "./PeoplePanel";
import { PersonPage } from "./PersonPage";

const AGENTS: Agent[] = [
  { name: "alexey", kind: "human", online: true, rooms: ["lobby"], admin: true },
  { name: "olena", kind: "human", online: false, rooms: ["lobby"] },
  { name: "claude", kind: "claude", online: true, rooms: ["lobby"], description: "Claude agent" },
  { name: "helper", kind: "claude", online: false, rooms: [] },
];

function adminApi(agents: Agent[] = AGENTS, send = vi.fn(async () => ({}))) {
  return fakeApi({
    get: vi.fn(async (path: string) => (path === "/admin/api/agents" ? { agents } : { editable: true })),
    send,
  });
}

const asAdmin = (api = adminApi()) => ({ api, session: adminSession, sender: "alexey" });

afterEach(() => setLeaveGuard(null));

describe("People list", () => {
  it("lists everyone without per-row buttons and opens a participant's page on click", async () => {
    const { ctx } = renderWithChat(<PeoplePanel />, asAdmin());
    await userEvent.click(await screen.findByRole("button", { name: /claude/ }));
    expect(ctx.go).toHaveBeenCalledWith({ kind: "person", name: "claude" });
    expect(screen.queryByRole("button", { name: "Новий токен" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /Додати агента або людину/ }));
    expect(ctx.go).toHaveBeenCalledWith({ kind: "people-new" });
  });

  it("has its own addresses for a participant and for adding one", () => {
    expect(hashFor({ kind: "person", name: "claude" })).toBe("#person/claude");
    expect(parseHash("#person/claude")).toEqual({ kind: "person", name: "claude" });
    expect(hashFor({ kind: "people-new" })).toBe("#people/new");
    expect(parseHash("#people/new")).toEqual({ kind: "people-new" });
    expect(parseHash("#people")).toEqual({ kind: "people" });
  });
});

describe("participant page", () => {
  it("saves only what changed, with the Save button, and Cancel brings the saved values back", async () => {
    const api = adminApi();
    renderWithChat(<PersonPage name="claude" onSelfDemoted={() => {}} />, asAdmin(api));
    const box = await screen.findByRole("textbox", { name: /^Опис/ });
    expect(box).toHaveValue("Claude agent");
    const save = screen.getByRole("button", { name: /^Зберегти$/ });
    expect(save).toBeDisabled();

    await userEvent.clear(box);
    await userEvent.type(box, "Інше");
    await userEvent.click(screen.getByRole("button", { name: "Скасувати" }));
    expect(box).toHaveValue("Claude agent");
    expect(api.send).not.toHaveBeenCalled();

    await userEvent.clear(box);
    await userEvent.type(box, "Пише серверну частину.");
    expect(api.send).not.toHaveBeenCalled(); // no autosave
    await userEvent.click(save);
    expect(api.send).toHaveBeenCalledWith("PATCH", "/admin/api/agents/claude", { description: "Пише серверну частину." });
  });

  it("makes an AI agent outside rooms the keeper", async () => {
    const api = adminApi();
    renderWithChat(<PersonPage name="helper" onSelfDemoted={() => {}} />, asAdmin(api));
    await userEvent.click(await screen.findByRole("checkbox", { name: "Keeper" }));
    await userEvent.click(screen.getByRole("button", { name: /^Зберегти$/ }));
    expect(api.send).toHaveBeenCalledWith("PATCH", "/admin/api/agents/helper", { keeper: true });
  });

  it("changes an AI agent's kind, such as to Codex", async () => {
    const api = adminApi();
    renderWithChat(<PersonPage name="helper" onSelfDemoted={() => {}} />, asAdmin(api));
    const kind = await screen.findByRole("combobox", { name: /^Тип/ });
    expect(kind).toHaveValue("claude");
    await userEvent.selectOptions(kind, "codex");
    await userEvent.click(screen.getByRole("button", { name: /^Зберегти$/ }));
    expect(api.send).toHaveBeenCalledWith("PATCH", "/admin/api/agents/helper", { kind: "codex" });
  });

  it("keeps an agent's own kind among the choices", async () => {
    const agents = AGENTS.map((a) => (a.name === "helper" ? { ...a, kind: "service" } : a));
    renderWithChat(<PersonPage name="helper" onSelfDemoted={() => {}} />, asAdmin(adminApi(agents)));
    expect(await screen.findByRole("combobox", { name: /^Тип/ })).toHaveValue("service");
  });

  it("shows no kind for a person", async () => {
    renderWithChat(<PersonPage name="olena" onSelfDemoted={() => {}} />, asAdmin());
    await screen.findByRole("checkbox", { name: "Адміністратор" });
    expect(screen.queryByRole("combobox", { name: /^Тип/ })).toBeNull();
  });

  it("does not offer the keeper role to an agent in rooms or when there is a keeper already", async () => {
    renderWithChat(<PersonPage name="claude" onSelfDemoted={() => {}} />, asAdmin());
    expect(await screen.findByRole("checkbox", { name: "Keeper" })).toBeDisabled();
    expect(screen.getByText(/спершу приберіть claude з #lobby/)).toBeInTheDocument();
  });

  it("says who the keeper is when another agent has the role", async () => {
    const agents = AGENTS.map((a) => (a.name === "claude" ? { ...a, rooms: [], keeper: true as const } : a));
    renderWithChat(<PersonPage name="helper" onSelfDemoted={() => {}} />, asAdmin(adminApi(agents)));
    expect(await screen.findByRole("checkbox", { name: "Keeper" })).toBeDisabled();
    expect(screen.getByText(/Keeper уже claude/)).toBeInTheDocument();
  });

  it("asks before making a person an admin, and only then saves", async () => {
    const api = adminApi();
    renderWithChat(<PersonPage name="olena" onSelfDemoted={() => {}} />, asAdmin(api));
    expect(screen.queryByRole("checkbox", { name: "Keeper" })).toBeNull();
    await userEvent.click(await screen.findByRole("checkbox", { name: "Адміністратор" }));
    await userEvent.click(screen.getByRole("button", { name: /^Зберегти$/ }));
    expect(api.send).not.toHaveBeenCalled();
    expect(screen.getByText(/Зробити olena адміном\?/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Зробити адміном і зберегти/ }));
    expect(api.send).toHaveBeenCalledWith("PATCH", "/admin/api/agents/olena", { admin: true });
  });

  it("keeps the only admin an admin", async () => {
    renderWithChat(<PersonPage name="alexey" onSelfDemoted={() => {}} />, asAdmin());
    expect(await screen.findByRole("checkbox", { name: "Адміністратор" })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Видалити alexey/ })).toBeDisabled();
  });

  it("asks before leaving with unsaved changes", async () => {
    renderWithChat(<PersonPage name="claude" onSelfDemoted={() => {}} />, asAdmin());
    const box = await screen.findByRole("textbox", { name: /^Опис/ });
    expect(mayLeave()).toBe(true);
    await userEvent.type(box, "!");
    const ask = vi.spyOn(window, "confirm").mockReturnValue(false);
    expect(mayLeave()).toBe(false);
    expect(ask).toHaveBeenCalledOnce();
    ask.mockRestore();
  });

  it("deletes after a confirmation and goes back to the list", async () => {
    const api = adminApi();
    const { ctx } = renderWithChat(<PersonPage name="olena" onSelfDemoted={() => {}} />, asAdmin(api));
    await userEvent.click(await screen.findByRole("button", { name: /Видалити olena/ }));
    await userEvent.click(screen.getByRole("button", { name: /^Видалити$/ }));
    expect(api.send).toHaveBeenCalledWith("DELETE", "/admin/api/agents/olena");
    await waitFor(() => expect(ctx.go).toHaveBeenCalledWith({ kind: "people" }));
  });

  it("shows the setup with the new token right after the participant was added", async () => {
    handSetup("helper", { kind: "claude", steps: [{ title: "Підключіть однією командою", code: "curl … 'secret'" }] });
    renderWithChat(<PersonPage name="helper" onSelfDemoted={() => {}} />, asAdmin());
    expect(await screen.findByText("Підключіть однією командою")).toBeInTheDocument();
    expect(screen.getByText(/лише один раз/)).toBeInTheDocument();
    // on top, before the participant's card
    const box = screen.getByRole("heading", { name: "Як підключити helper" }).closest("section")!;
    expect(box.compareDocumentPosition(screen.getByRole("heading", { name: "helper" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("opens the setup under the Access buttons, where it was asked for, with the link to the agents' guide (alexey, 1709)", async () => {
    const api = fakeApi({
      get: vi.fn(async (path: string) =>
        path === "/admin/api/agents"
          ? { agents: AGENTS }
          : path.endsWith("/setup")
            ? { setup: { kind: "claude", steps: [{ title: "Підключіть однією командою", code: "curl … '<TOKEN>'" }] } }
            : { editable: true },
      ),
    });
    renderWithChat(<PersonPage name="claude" onSelfDemoted={() => {}} />, asAdmin(api));
    expect(await screen.findByText(/agents\.md/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Інструкція" }));
    const heading = await screen.findByRole("heading", { name: "Як підключити claude" });
    const access = screen.getByRole("heading", { name: "Доступ" }).closest("section")!;
    expect(access.contains(heading)).toBe(true);
    expect(screen.getByText(/Токен в інструкції замінено на <TOKEN>/)).toBeInTheDocument();
  });
});

describe("adding a participant", () => {
  it("adds on its own page and opens the new participant's page", async () => {
    const send = vi.fn(async () => ({ agent: { name: "bot", kind: "claude", rooms: [], online: false }, setup: { steps: [] } }));
    const { ctx } = renderWithChat(<AddPersonPage />, asAdmin(adminApi(AGENTS, send)));
    await userEvent.type(screen.getByRole("textbox", { name: /^Ім'я/ }), "bot");
    await userEvent.selectOptions(screen.getByLabelText("Тип"), "claude");
    await userEvent.click(screen.getByRole("button", { name: /Додати й отримати токен/ }));
    expect(send).toHaveBeenCalledWith("POST", "/admin/api/agents", { name: "bot", kind: "claude", rooms: [] });
    await waitFor(() => expect(ctx.go).toHaveBeenCalledWith({ kind: "person", name: "bot" }));
  });
});
