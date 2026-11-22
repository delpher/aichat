import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AuthError, HttpError } from "../../api/http";
import { MAX_HOOKS, type HookRule } from "../../api/types";
import { fakeApi, renderWithChat } from "../../test/render";
import { AutomationPanel } from "./AutomationPanel";

function hookRule(over: Partial<HookRule> = {}): HookRule {
  return {
    id: "hook-1",
    enabled: true,
    trigger: { type: "idle", idleMinutes: 30 },
    repeat: "always",
    action: {
      type: "system_message",
      recipient: "participant",
      text: "У тебе вільний час.",
    },
    by: "alexey",
    createdAt: "2026-11-20T17:00:00.000Z",
    updatedAt: "2026-11-20T17:00:00.000Z",
    stats: { fired: 4, agents: 2, lastFiredAt: "2026-11-20T17:15:00.000Z" },
    ...over,
  };
}

function apiWith(hooks: HookRule[], send: unknown = vi.fn(async () => ({})), maxTextLength = 20000) {
  return fakeApi({
    get: vi.fn(async (path: string) => {
      if (path === "/admin/api/hooks") return { hooks };
      if (path === "/admin/api/settings") return { settings: { maxTextLength } };
      return Promise.reject(new Error(`unexpected GET ${path}`));
    }),
    send,
  });
}

describe("AutomationPanel", () => {
  it("lists existing hooks with counters", async () => {
    renderWithChat(<AutomationPanel />, { api: apiWith([hookRule()]) });
    expect(await screen.findByText("Агент неактивний понад 30 хв")).toBeInTheDocument();
    expect(screen.getByText("Постійно → Учаснику")).toBeInTheDocument();
    expect(screen.getByText("У тебе вільний час.")).toBeInTheDocument();
    expect(screen.getByText(/Спрацювало: 4 · агентів: 2/)).toBeInTheDocument();
  });

  it("validates fields, updates preview live and creates an idle hook", async () => {
    const created = hookRule({ id: "hook-new", stats: { fired: 0, agents: 0 } });
    const send = vi.fn(async () => ({ hook: created }));
    renderWithChat(<AutomationPanel />, { api: apiWith([], send) });

    expect(await screen.findByText("Правил автоматизації ще немає")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Додати правило" }));

    const saveBtn = screen.getByRole("button", { name: "Зберегти" });
    expect(saveBtn).toBeDisabled();

    const minutesInput = screen.getByLabelText("Час неактивності, хвилин") as HTMLInputElement;
    expect(minutesInput.value).toBe("30");

    // Whitespace-only message stays invalid
    const textArea = screen.getByLabelText("Текст повідомлення");
    fireEvent.change(textArea, { target: { value: "   \n  " } });
    expect(saveBtn).toBeDisabled();

    // Invalid idleMinutes blocks saving
    fireEvent.change(textArea, { target: { value: "У тебе вільний час." } });
    fireEvent.change(minutesInput, { target: { value: "0" } });
    expect(saveBtn).toBeDisabled();
    expect(screen.getByText(/від 1 до 10080/)).toBeInTheDocument();

    fireEvent.change(minutesInput, { target: { value: "15" } });
    expect(saveBtn).not.toBeDisabled();
    expect(
      screen.getByText(
        "Коли будь-який агент неактивний понад 15 хв, при кожному новому виконанні умови надсилати системне повідомлення цьому учаснику.",
      ),
    ).toBeInTheDocument();

    fireEvent.click(saveBtn);
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith("POST", "/admin/api/hooks", {
        enabled: true,
        trigger: { type: "idle", idleMinutes: 15 },
        repeat: "always",
        action: {
          type: "system_message",
          recipient: "participant",
          text: "У тебе вільний час.",
        },
      }),
    );
    expect(await screen.findByText("Правило створено.")).toBeInTheDocument();
  });

  it("hides idleMinutes for online/offline triggers and omits it from payload", async () => {
    const created = hookRule({
      id: "hook-off",
      trigger: { type: "offline" },
      repeat: "once",
      action: { type: "system_message", recipient: "others", text: "Агент пішов офлайн." },
      stats: { fired: 0, agents: 0 },
    });
    const send = vi.fn(async () => ({ hook: created }));
    renderWithChat(<AutomationPanel />, { api: apiWith([], send) });

    fireEvent.click(await screen.findByRole("button", { name: "Додати правило" }));

    // Even if idleMinutes was invalid before switching, offline rule can still be saved
    fireEvent.change(screen.getByLabelText("Час неактивності, хвилин"), { target: { value: "-5" } });
    fireEvent.change(screen.getByLabelText("Умова"), { target: { value: "offline" } });
    expect(screen.queryByLabelText("Час неактивності, хвилин")).toBeNull();

    fireEvent.click(screen.getByRole("radio", { name: "Один раз" }));
    fireEvent.change(screen.getByLabelText("Кому повідомлення"), { target: { value: "others" } });
    fireEvent.change(screen.getByLabelText("Текст повідомлення"), { target: { value: "Агент пішов офлайн." } });

    expect(
      screen.getByText(
        "Коли будь-який агент переходить в офлайн, один раз для кожного агента надсилати системне повідомлення усім агентам, окрім цього учасника.",
      ),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Зберегти" }));
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith("POST", "/admin/api/hooks", {
        enabled: true,
        trigger: { type: "offline" },
        repeat: "once",
        action: {
          type: "system_message",
          recipient: "others",
          text: "Агент пішов офлайн.",
        },
      }),
    );
  });

  it("edits an existing rule with PUT and preserves its stats", async () => {
    const initial = hookRule();
    const updated = hookRule({
      action: { type: "system_message", recipient: "agents", text: "Оновлений текст" },
      stats: { fired: 4, agents: 2 },
    });
    const send = vi.fn(async () => ({ hook: updated }));
    renderWithChat(<AutomationPanel />, { api: apiWith([initial], send) });

    fireEvent.click(await screen.findByRole("button", { name: "Редагувати" }));
    expect((screen.getByLabelText("Текст повідомлення") as HTMLTextAreaElement).value).toBe("У тебе вільний час.");
    fireEvent.change(screen.getByLabelText("Кому повідомлення"), { target: { value: "agents" } });
    fireEvent.change(screen.getByLabelText("Текст повідомлення"), { target: { value: "Оновлений текст" } });
    fireEvent.click(screen.getByRole("button", { name: "Зберегти" }));

    await waitFor(() =>
      expect(send).toHaveBeenCalledWith("PUT", "/admin/api/hooks/hook-1", {
        enabled: true,
        trigger: { type: "idle", idleMinutes: 30 },
        repeat: "always",
        action: { type: "system_message", recipient: "agents", text: "Оновлений текст" },
      }),
    );
    expect(await screen.findByText("Оновлений текст")).toBeInTheDocument();
    expect(screen.getByText(/Спрацювало: 4 · агентів: 2/)).toBeInTheDocument();
  });

  it("toggles enabled via PATCH and deletes only after confirmation", async () => {
    const initial = hookRule();
    const send = vi.fn(async (method: string) => {
      if (method === "PATCH") return { hook: hookRule({ enabled: false }) };
      if (method === "DELETE") return { ok: true };
      return {};
    });
    renderWithChat(<AutomationPanel />, { api: apiWith([initial], send) });

    const toggle = (await screen.findByLabelText("Увімкнути правило hook-1")) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    fireEvent.click(toggle);
    await waitFor(() => expect(send).toHaveBeenCalledWith("PATCH", "/admin/api/hooks/hook-1", { enabled: false }));
    expect(await screen.findByText("Вимкнено")).toBeInTheDocument();

    // Delete asks for confirmation first
    fireEvent.click(screen.getByRole("button", { name: "Видалити" }));
    expect(screen.getByText(/Видалити це правило/)).toBeInTheDocument();
    expect(send).not.toHaveBeenCalledWith("DELETE", expect.anything());

    // Cancel aborts deletion
    fireEvent.click(screen.getByRole("button", { name: "Скасувати" }));
    expect(screen.queryByText(/Видалити це правило/)).toBeNull();

    // Confirm performs DELETE
    fireEvent.click(screen.getByRole("button", { name: "Видалити" }));
    fireEvent.click(screen.getByRole("button", { name: "Видалити" }));
    await waitFor(() => expect(send).toHaveBeenCalledWith("DELETE", "/admin/api/hooks/hook-1"));
    expect(await screen.findByText("Правил автоматизації ще немає")).toBeInTheDocument();
  });

  it("shows server errors in Status", async () => {
    const send = vi.fn(async () => {
      throw new HttpError(400, "досягнуто ліміту");
    });
    renderWithChat(<AutomationPanel />, { api: apiWith([], send) });

    fireEvent.click(await screen.findByRole("button", { name: "Додати правило" }));
    fireEvent.change(screen.getByLabelText("Текст повідомлення"), { target: { value: "Привіт" } });
    fireEvent.click(screen.getByRole("button", { name: "Зберегти" }));
    expect(await screen.findByText("досягнуто ліміту")).toBeInTheDocument();
  });

  it("delegates AuthError to fail", async () => {
    const authErr = new AuthError(401, "invalid token");
    const authApi = fakeApi({
      get: vi.fn(async () => {
        throw authErr;
      }),
    });
    const { ctx } = renderWithChat(<AutomationPanel />, { api: authApi });
    await waitFor(() => expect(ctx.fail).toHaveBeenCalledWith(authErr, ""));
  });

  it("disables adding rules at MAX_HOOKS limit", async () => {
    const many = Array.from({ length: MAX_HOOKS }, (_, i) => hookRule({ id: `h-${i}` }));
    renderWithChat(<AutomationPanel />, { api: apiWith(many) });
    expect(await screen.findByRole("button", { name: "Додати правило" })).toBeDisabled();
  });

  it("copies rule JSON to clipboard", async () => {
    const writeText = vi.fn(async (_text: string) => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    renderWithChat(<AutomationPanel />, { api: apiWith([hookRule()]) });

    fireEvent.click(await screen.findByRole("button", { name: "JSON" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const parsed = JSON.parse(writeText.mock.calls[0][0]);
    expect(parsed).toEqual({
      id: "hook-1",
      enabled: true,
      trigger: { type: "idle", idleMinutes: 30 },
      repeat: "always",
      action: { type: "system_message", recipient: "participant", text: "У тебе вільний час." },
    });
  });
});
