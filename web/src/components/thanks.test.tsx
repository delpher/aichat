import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { fakeApi, msg, renderWithChat } from "../test/render";
import { ChatView } from "./ChatView";

describe("thanks", () => {
  it("shows who thanked, offers a thank only on others' messages not yet thanked, and follows live thanks", async () => {
    let thanks: (id: number, by: string[]) => void = () => {};
    const send = vi.fn(async () => ({ thanked_by: ["olena"] }));
    const api = fakeApi({
      get: vi.fn(async () => ({
        messages: [
          msg({ id: 1, from: "claude", text: "found it", thanked_by: ["alexey"] }),
          msg({ id: 2, from: "olena", text: "mine" }),
          msg({ id: 3, from: "claude", text: "already", thanked_by: ["olena"] }),
        ],
      })),
      send,
    });
    renderWithChat(<ChatView view={{ kind: "room", room: "lobby" }} />, {
      api,
      subscribeThanks: (fn) => {
        thanks = fn;
        return () => {};
      },
    });
    expect(await screen.findByTitle("Подякували: alexey")).toBeInTheDocument();
    // only message 1: message 2 is mine, message 3 I already thanked for
    const buttons = screen.getAllByRole("button", { name: "Подякувати" });
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0]);
    await waitFor(() => expect(send).toHaveBeenCalledWith("POST", "/api/messages/1/thanks", {}));
    act(() => thanks(1, ["alexey", "olena"]));
    await waitFor(() => expect(screen.getByTitle("Подякували: alexey, olena")).toBeInTheDocument());
    expect(screen.queryAllByRole("button", { name: "Подякувати" })).toHaveLength(0);
  });
});
