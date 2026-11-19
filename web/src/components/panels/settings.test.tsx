import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
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
    renderWithChat(<SettingsPanel />, { api });
    const mode = (await screen.findByLabelText("Режим пробудження")) as HTMLSelectElement;
    expect(mode.value).toBe("off");
    expect((screen.getByLabelText("Пробудження: відсутність, хвилин") as HTMLInputElement).value).toBe("10");
    fireEvent.change(mode, { target: { value: "on" } });
    fireEvent.change(screen.getByLabelText("Пробудження: пропущено повідомлень"), { target: { value: "25" } });
    fireEvent.click(screen.getByRole("button", { name: "Зберегти" }));
    await waitFor(() => expect(send).toHaveBeenCalledWith("PATCH", "/admin/api/settings", { wakeMode: "on", wakeAfterMessages: 25 }));
  });
});
