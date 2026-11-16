import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UpdateStatus } from "../api/types";
import { adminSession, fakeApi, renderWithChat } from "../test/render";
import { UpdateBox } from "./panels/UpdateBox";

const status = (over: Partial<UpdateStatus> = {}): UpdateStatus => ({
  current: "0.1.0",
  launcher: true,
  docker: false,
  repo: "delpher/aichat",
  hasToken: true,
  tokenFromEnv: false,
  prerelease: false,
  checking: false,
  installing: false,
  checkedAt: "2026-11-16T19:50:00Z",
  error: null,
  latest: {
    version: "0.2.0",
    tag: "v0.2.0",
    name: "AIChat 0.2.0",
    notes: "## What's Changed\n* Self-update",
    url: "https://github.com/delpher/aichat/releases/tag/v0.2.0",
    publishedAt: "2026-11-17T10:00:00Z",
    prerelease: false,
    node: ">=22.13",
    nodeOk: true,
    installable: true,
  },
  updateAvailable: true,
  failed: null,
  ...over,
});

afterEach(() => vi.unstubAllGlobals());

describe("UpdateBox", () => {
  it("installs the new version, waits for the restart and reloads", async () => {
    const api = fakeApi({ get: vi.fn(async () => status()), send: vi.fn(async () => ({ version: "0.2.0", restarting: true })) });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true, version: "0.2.0" }))));
    const reload = vi.fn();
    renderWithChat(<UpdateBox reload={reload} pollMs={1} />, { api, session: adminSession });
    expect(await screen.findByText(/Доступна версія 0.2.0/)).toBeInTheDocument();
    expect(screen.getByText("Self-update")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Оновити до 0.2.0/ }));
    await userEvent.click(screen.getByRole("button", { name: "Так, оновити" }));
    await waitFor(() => expect(reload).toHaveBeenCalled());
    expect(api.send).toHaveBeenCalledWith("POST", "/admin/api/update/install", { version: "0.2.0" });
  });

  it("explains why a broker without the launcher cannot update itself", async () => {
    const api = fakeApi({ get: vi.fn(async () => status({ launcher: false, docker: true })) });
    renderWithChat(<UpdateBox />, { api, session: adminSession });
    expect(await screen.findByText(/зібрано зі старого образу без запускача/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Оновити до 0.2.0/ })).toBeDisabled();
  });

  it("shows a rolled-back update and the latest-version message", async () => {
    const api = fakeApi({
      get: vi.fn(async () => status({ updateAvailable: false, failed: { version: "0.2.0", previous: "0.1.0", reason: "exited with code 1" } })),
      send: vi.fn(async () => status({ updateAvailable: false })),
    });
    renderWithChat(<UpdateBox />, { api, session: adminSession });
    expect(await screen.findByText(/Оновлення до 0.2.0 не вдалося \(exited with code 1\)/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Перевірити/ }));
    expect(await screen.findByText("Встановлено найновішу версію.")).toBeInTheDocument();
  });

  it("saves a token without showing it back", async () => {
    const api = fakeApi({ get: vi.fn(async () => status({ hasToken: false })), send: vi.fn(async () => status({ hasToken: true })) });
    renderWithChat(<UpdateBox />, { api, session: adminSession });
    await screen.findByText(/Працює версія/);
    await userEvent.click(screen.getByText("Звідки брати оновлення"));
    await userEvent.type(screen.getByLabelText("Токен GitHub", { exact: false }), "github_pat_x");
    await userEvent.click(screen.getByRole("button", { name: /Зберегти/ }));
    expect(api.send).toHaveBeenCalledWith("PATCH", "/admin/api/update/settings", { token: "github_pat_x" });
    expect(await screen.findByPlaceholderText("токен збережено")).toHaveValue("");
  });
});
