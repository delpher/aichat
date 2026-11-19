import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Agent, UsageReport } from "../../api/types";
import { hashFor, parseHash, resolveView } from "../../lib/views";
import { adminSession, fakeApi, overview, renderWithChat, userSession } from "../../test/render";
import { PersonPage } from "../panels/PersonPage";
import { UsagePanel } from "../panels/UsagePanel";
import { agoText, resetText } from "./UsageList";

const MINE = "a".repeat(64);
const OTHER = "b".repeat(64);
const now = new Date();
const inAnHour = new Date(now.getTime() + 3600_000).toISOString();

const report = (agent: string, account: string | undefined, five = 40): UsageReport => ({
  agent,
  at: now.toISOString(),
  provider: "anthropic",
  ...(account ? { account } : {}),
  windows: [
    { name: "five_hour", usedPct: five, resetsAt: inAnHour },
    { name: "seven_day", usedPct: 15 },
  ],
  session: { tokensIn: 15234, tokensOut: 4521, cost: 0.42, currency: "USD" },
  context: { usedPct: 62 },
});

function usageApi(reports: UsageReport[], accounts: string[] = [MINE], send = vi.fn(async () => ({ accounts: 1 }))) {
  return fakeApi({ get: vi.fn(async () => ({ usage: reports, accounts })), send });
}

describe("usage page", () => {
  it("shows the limits of a person's account and the agents on it, not other accounts", async () => {
    renderWithChat(<UsagePanel />, { api: usageApi([report("claude", MINE)]) });
    const card = (await screen.findByRole("heading", { name: "Ваш акаунт" })).closest("section")!;
    expect(within(card).getByRole("meter", { name: "5 годин" })).toHaveAttribute("aria-valuenow", "40");
    expect(within(card).getByText("40%")).toBeInTheDocument();
    expect(within(card).getByText(/скидання о/)).toBeInTheDocument();
    expect(within(card).getByText("claude")).toBeInTheDocument();
    expect(within(card).getByText("контекст 62%")).toBeInTheDocument();
    expect(within(card).getByText("$0.42 за сесію")).toBeInTheDocument();
    expect(screen.getByText("Задано 1 акаунт.")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Інші агенти" })).toBeNull();
  });

  it("names the person's accounts by e-mail and replaces the whole list", async () => {
    const send = vi.fn(async () => ({ accounts: 2 }));
    const api = usageApi([], [], send);
    renderWithChat(<UsagePanel />, { api });
    expect(await screen.findByText("Акаунтів ще не задано.")).toBeInTheDocument();
    await userEvent.type(screen.getByRole("textbox", { name: /^Email акаунтів/ }), "me@example.com\nwork@example.com");
    await userEvent.click(screen.getByRole("button", { name: "Зберегти" }));
    expect(send).toHaveBeenCalledWith("PUT", "/api/me/accounts", { emails: ["me@example.com", "work@example.com"] });
    expect(await screen.findByText("Збережено.")).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledTimes(2); // loaded again after saving
  });

  it("shows an admin every other agent too, and an account without limits says why", async () => {
    const noLimits = { ...report("helper", undefined), windows: [] };
    renderWithChat(<UsagePanel />, { session: adminSession, sender: "alexey", api: usageApi([report("claude", MINE), report("bot", OTHER, 85), noLimits]) });
    const others = (await screen.findByRole("heading", { name: "Інші агенти" })).closest("section")!;
    expect(within(others).getByRole("heading", { name: "Акаунт bbbbbb" })).toBeInTheDocument();
    expect(within(others).getAllByRole("meter")[0]).toHaveClass("meter-warn");
    expect(within(others).getByRole("heading", { name: "Акаунт невідомий" })).toBeInTheDocument();
    expect(within(others).getByText(/не повідомив, на якому акаунті/)).toBeInTheDocument();
  });

  it("follows the live reports", async () => {
    let push: (u: UsageReport) => void = () => {};
    renderWithChat(<UsagePanel />, {
      api: usageApi([report("claude", MINE)]),
      subscribeUsage: (fn) => ((push = fn), () => {}),
    });
    expect(await screen.findByText("40%")).toBeInTheDocument();
    act(() => push(report("claude", MINE, 77)));
    expect(screen.getByText("77%")).toBeInTheDocument();
    expect(screen.queryByText("40%")).toBeNull();
  });

  it("is a page every person may open", () => {
    expect(hashFor({ kind: "usage" })).toBe("#usage");
    expect(parseHash("#usage")).toEqual({ kind: "usage" });
    expect(resolveView({ kind: "usage" }, userSession, overview)).toEqual({ kind: "usage" });
  });

  it("says when a window starts over and how fresh a report is", () => {
    const at = new Date(2026, 10, 19, 12, 0);
    expect(resetText(new Date(2026, 10, 19, 17, 0).toISOString(), at)).toMatch(/^о 17:00$/);
    expect(resetText(new Date(2026, 10, 21, 9, 0).toISOString(), at)).toMatch(/о 09:00$/);
    expect(agoText(new Date(at.getTime() - 20_000).toISOString(), at)).toBe("щойно");
    expect(agoText(new Date(at.getTime() - 5 * 60_000).toISOString(), at)).toBe("5 хв тому");
    expect(agoText(new Date(at.getTime() - 2 * 3600_000).toISOString(), at)).toBe("2 год тому");
  });
});

describe("participant page", () => {
  it("shows what an agent last reported about its usage", async () => {
    const agents: Agent[] = [
      { name: "alexey", kind: "human", online: true, rooms: [], admin: true },
      { name: "claude", kind: "claude", online: true, rooms: [] },
    ];
    const get = vi.fn(async (path: string) =>
      path === "/admin/api/agents" ? { agents } : path === "/api/usage" ? { usage: [report("claude", OTHER)], accounts: [] } : { editable: true },
    );
    renderWithChat(<PersonPage name="claude" onSelfDemoted={() => {}} />, { session: adminSession, sender: "alexey", api: fakeApi({ get }) });
    const section = (await screen.findByRole("heading", { name: "Використання" })).closest("section")!;
    await waitFor(() => expect(within(section).getByRole("meter", { name: "5 годин" })).toBeInTheDocument());
    expect(within(section).getByText("контекст 62%")).toBeInTheDocument();
  });
});
