import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { WorldIntro } from "../../api/types";
import { parseHash, resolveView } from "../../lib/views";
import { adminSession, fakeApi, overview, renderWithChat, userSession } from "../../test/render";
import { IntroPanel, IntroSettings } from "./IntroPanel";

const limits = { maxHops: 8, ratePerMinute: 30, maxTextLength: 20000, maxFileSizeMB: 20 };
const draft: WorldIntro = { text: "# AIChat\n\nЛюди й агенти разом.", by: "aichat", ts: "1970-01-01T00:00:00.000Z", draft: true };

describe("IntroPanel", () => {
  it("shows the intro and the limits to everyone; people cannot change it", async () => {
    const api = fakeApi({ get: vi.fn(async () => ({ intro: draft, limits })) });
    renderWithChat(<IntroPanel />, { api, session: userSession });
    expect(await screen.findByText("Люди й агенти разом.")).toBeInTheDocument();
    expect(screen.getByText(/Вбудована чернетка/)).toBeInTheDocument();
    expect(screen.getByText(/ланцюжок до 8 відповідей, до 30 повідомлень на хвилину/)).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(api.get).toHaveBeenCalledWith("/api/intro");
  });

  it("sends admins to Settings to change it", async () => {
    const go = vi.fn();
    renderWithChat(<IntroPanel />, { api: fakeApi({ get: vi.fn(async () => ({ intro: draft, limits })) }), session: adminSession, go });
    await userEvent.click(await screen.findByRole("button", { name: "Змінити в налаштуваннях" }));
    expect(go).toHaveBeenCalledWith({ kind: "settings" });
  });

  it("is a view people may open from the URL", () => {
    expect(resolveView(parseHash("#intro"), userSession, overview)).toEqual({ kind: "intro" });
  });
});

describe("IntroSettings", () => {
  it("edits the intro in Settings and saves only with the button", async () => {
    const saved: WorldIntro = { text: "Нова вводна.", by: "alexey", ts: "2026-11-17T10:00:00Z" };
    const api = fakeApi({ get: vi.fn(async () => ({ intro: draft, limits })), send: vi.fn(async () => ({ intro: saved })) });
    renderWithChat(<IntroSettings />, { api, session: adminSession, sender: "alexey" });
    const box = await screen.findByLabelText("Вводна світу");
    expect(box).toHaveValue(draft.text);
    expect(screen.getByRole("button", { name: /Зберегти вводну/ })).toBeDisabled();
    await userEvent.clear(box);
    await userEvent.type(box, "Нова вводна.");
    expect(api.send).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: /Зберегти вводну/ }));
    expect(api.send).toHaveBeenCalledWith("PUT", "/admin/api/intro", { text: "Нова вводна." });
    await waitFor(() => expect(screen.getByText(/alexey ·/)).toBeInTheDocument());
    expect(screen.getByLabelText("Вводна світу")).toHaveValue("Нова вводна.");
    expect(screen.getByRole("button", { name: /Зберегти вводну/ })).toBeDisabled();
  });

  it("offers to undo changes before saving", async () => {
    renderWithChat(<IntroSettings />, { api: fakeApi({ get: vi.fn(async () => ({ intro: draft, limits })) }), session: adminSession });
    const box = await screen.findByLabelText("Вводна світу");
    await userEvent.type(box, " ще");
    await userEvent.click(screen.getByRole("button", { name: "Скасувати" }));
    expect(screen.getByLabelText("Вводна світу")).toHaveValue(draft.text);
  });
});
