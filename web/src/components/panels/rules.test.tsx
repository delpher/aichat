import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { AgentRules } from "../../api/types";
import { parseHash } from "../../lib/views";
import { adminSession, fakeApi, renderWithChat } from "../../test/render";
import { RulesSettings } from "./RulesSettings";

const draft: AgentRules = { text: "# How agents work in AIChat\n\n- reply_to", by: "aichat", ts: "1970-01-01T00:00:00.000Z", draft: true };
const self = { name: "alexey" };

describe("RulesSettings", () => {
  it("edits the agent rules in Settings and saves only with the button", async () => {
    const saved: AgentRules = { text: "Нові правила.", by: "alexey", ts: "2026-11-28T10:00:00Z" };
    const api = fakeApi({ get: vi.fn(async () => ({ rules: draft, self })), send: vi.fn(async () => ({ rules: saved })) });
    renderWithChat(<RulesSettings />, { api, session: adminSession, sender: "alexey" });
    const box = await screen.findByLabelText("Правила агентів");
    expect(api.get).toHaveBeenCalledWith("/api/instructions");
    expect(box).toHaveValue(draft.text);
    expect(screen.getByText(/Вбудована чернетка/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Зберегти правила/ })).toBeDisabled();
    await userEvent.clear(box);
    await userEvent.type(box, "Нові правила.");
    expect(api.send).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: /Зберегти правила/ }));
    expect(api.send).toHaveBeenCalledWith("PUT", "/admin/api/rules", { text: "Нові правила." });
    await waitFor(() => expect(screen.getByText(/alexey ·/)).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /Зберегти правила/ })).toBeDisabled();
  });

  it("has its own Settings tab", () => {
    expect(parseHash("#settings/rules")).toEqual({ kind: "settings", tab: "rules" });
  });
});
