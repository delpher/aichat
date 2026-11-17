import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { WorldIntro } from "../../api/types";
import { parseHash, resolveView } from "../../lib/views";
import { adminSession, fakeApi, overview, renderWithChat, userSession } from "../../test/render";
import { IntroPanel } from "./IntroPanel";

const limits = { maxHops: 8, ratePerMinute: 30, maxTextLength: 20000, maxFileSizeMB: 20 };
const draft: WorldIntro = { text: "# AIChat\n\nЛюди й агенти разом.", by: "aichat", ts: "1970-01-01T00:00:00.000Z", draft: true };

describe("IntroPanel", () => {
  it("shows the intro and the limits to everyone; people cannot change it", async () => {
    const api = fakeApi({ get: vi.fn(async () => ({ intro: draft, limits })) });
    renderWithChat(<IntroPanel />, { api, session: userSession });
    expect(await screen.findByText("Люди й агенти разом.")).toBeInTheDocument();
    expect(screen.getByText(/Вбудована чернетка/)).toBeInTheDocument();
    expect(screen.getByText(/ланцюжок до 8 відповідей, до 30 повідомлень на хвилину/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Змінити" })).toBeNull();
    expect(api.get).toHaveBeenCalledWith("/api/intro");
  });

  it("lets an admin change it and saves only with the button", async () => {
    const saved: WorldIntro = { text: "Нова вводна.", by: "alexey", ts: "2026-11-17T10:00:00Z" };
    const api = fakeApi({ get: vi.fn(async () => ({ intro: draft, limits })), send: vi.fn(async () => ({ intro: saved })) });
    renderWithChat(<IntroPanel />, { api, session: adminSession, sender: "alexey" });
    await userEvent.click(await screen.findByRole("button", { name: "Змінити" }));
    const box = screen.getByLabelText("Вводна світу");
    expect(box).toHaveValue(draft.text);
    await userEvent.clear(box);
    await userEvent.type(box, "Нова вводна.");
    expect(api.send).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: /Зберегти вводну/ }));
    expect(api.send).toHaveBeenCalledWith("PUT", "/admin/api/intro", { text: "Нова вводна." });
    await waitFor(() => expect(screen.getByText("Нова вводна.")).toBeInTheDocument());
    expect(screen.getByText(/alexey ·/)).toBeInTheDocument();
  });

  it("is a view people may open from the URL", () => {
    expect(resolveView(parseHash("#intro"), userSession, overview)).toEqual({ kind: "intro" });
  });
});
