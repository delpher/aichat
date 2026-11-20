import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { hashFor, parseHash } from "../../lib/views";
import { fakeApi, renderWithChat } from "../../test/render";
import { SettingsPanel } from "./SettingsPanel";

const settings = {
  maxHops: 8,
  ratePerMinute: 30,
  maxTextLength: 20000,
  maxFileSizeMB: 20,
  maxNotes: 200,
  maxNoteDescription: 1000,
  maxNoteText: 5000,
  wakeMode: "off",
  wakeAfterMinutes: 10,
  wakeAfterMessages: 10,
  publicUrl: "",
  projectDir: "",
};

describe("settings: waking agents", () => {
  it("shows the wake mode and thresholds and saves only what changed", async () => {
    const send = vi.fn(async (_m: string, _p: string, body: Record<string, unknown>) => ({ settings: { ...settings, ...body } }));
    const api = fakeApi({
      get: vi.fn(async (path: string) =>
        path === "/admin/api/settings"
          ? { settings, limits: { wakeAfterMinutes: { min: 1, max: 10080 }, wakeAfterMessages: { min: 1, max: 100000 } }, editable: true }
          : Promise.reject(new Error("not in this test")),
      ),
      send,
    });
    renderWithChat(<SettingsPanel tab="wake" />, { api });
    const mode = (await screen.findByLabelText("Режим пробудження")) as HTMLSelectElement;
    expect(mode.value).toBe("off");
    expect((screen.getByLabelText("Пробудження: відсутність, хвилин") as HTMLInputElement).value).toBe("10");
    fireEvent.change(mode, { target: { value: "on" } });
    fireEvent.change(screen.getByLabelText("Пробудження: пропущено повідомлень"), { target: { value: "25" } });
    fireEvent.click(screen.getByRole("button", { name: "Зберегти" }));
    await waitFor(() => expect(send).toHaveBeenCalledWith("PATCH", "/admin/api/settings", { wakeMode: "on", wakeAfterMessages: 25 }));
  });
});

describe("settings: tabs (alexey, 2238)", () => {
  const api = () =>
    fakeApi({
      get: vi.fn(async (path: string) =>
        path === "/admin/api/settings" ? { settings, limits: {}, editable: true } : Promise.reject(new Error("not in this test")),
      ),
    });

  it("shows only the current tab's part and goes to another tab by its address", async () => {
    const { ctx } = renderWithChat(<SettingsPanel />, { api: api() });
    expect(screen.getByRole("tab", { name: "Загальні" })).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByLabelText("Довжина ланцюжка відповідей")).toBeInTheDocument();
    expect(screen.queryByLabelText("Режим пробудження")).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Автоматизація" }));
    expect(ctx.go).toHaveBeenCalledWith({ kind: "settings", tab: "automation" });
  });

  it("has a page for automation with nothing in it yet", () => {
    renderWithChat(<SettingsPanel tab="automation" />, { api: api() });
    expect(screen.getByRole("heading", { name: "Автоматизація" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Довжина ланцюжка відповідей")).toBeNull();
  });

  it("keeps each tab at its own address", () => {
    expect(hashFor({ kind: "settings" })).toBe("#settings");
    expect(hashFor({ kind: "settings", tab: "general" })).toBe("#settings");
    expect(hashFor({ kind: "settings", tab: "wake" })).toBe("#settings/wake");
    expect(parseHash("#settings/automation")).toEqual({ kind: "settings", tab: "automation" });
    expect(parseHash("#settings/nope")).toEqual({ kind: "settings" });
  });
});
