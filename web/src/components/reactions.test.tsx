import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { REACTIONS, SYSTEM_SENDER } from "../api/types";
import { adminSession, fakeApi, msg, renderWithChat } from "../test/render";
import { ChatView } from "./ChatView";
import { MessageItem } from "./MessageItem";

describe("reactions", () => {
  it("shows reaction chips, allows picker on others and system messages, toggles own/others chips, and follows live updates", async () => {
    let onReactions: (id: number, r: Record<string, string[]>) => void = () => {};
    const send = vi.fn(async () => ({ reactions: {} }));
    const api = fakeApi({
      get: vi.fn(async () => ({
        messages: [
          msg({ id: 1, from: "claude", text: "found it", reactions: { "👍": ["alexey"] } }),
          msg({ id: 2, from: "olena", text: "mine", reactions: { "🎉": ["claude"] } }),
          msg({ id: 3, from: SYSTEM_SENDER, text: "system notice" }),
        ],
      })),
      send,
    });
    renderWithChat(<ChatView view={{ kind: "room", room: "lobby" }} />, {
      api,
      subscribeReactions: (fn) => {
        onReactions = fn;
        return () => {};
      },
    });

    const thumbChip = await screen.findByTitle("👍 alexey");
    expect(thumbChip.tagName).toBe("BUTTON");
    expect(thumbChip).toHaveAttribute("aria-pressed", "false");

    // Own message chip is read-only (not a button)
    const ownMsgChip = screen.getByTitle("🎉 claude");
    expect(ownMsgChip.tagName).toBe("SPAN");

    // Picker offered for msg 1 (claude) and msg 3 (aichat), NOT msg 2 (olena = mine)
    const pickers = screen.getAllByRole("button", { name: "Реакція" });
    expect(pickers).toHaveLength(2);

    // Open picker on msg 1, verify all 8 reactions, and pick 🎉
    fireEvent.click(pickers[0]);
    for (const emoji of REACTIONS) {
      expect(screen.getByRole("button", { name: emoji })).toBeInTheDocument();
    }
    fireEvent.click(screen.getByRole("button", { name: "🎉" }));
    await waitFor(() => expect(send).toHaveBeenCalledWith("POST", "/api/messages/1/reactions", { emoji: "🎉" }));

    // Live socket update adds 🎉 by olena
    act(() => onReactions(1, { "👍": ["alexey"], "🎉": ["olena"] }));
    const myPartyChip = await screen.findByTitle("🎉 olena");
    expect(myPartyChip).toHaveAttribute("aria-pressed", "true");

    // Clicking own chip sends DELETE
    fireEvent.click(myPartyChip);
    await waitFor(() => expect(send).toHaveBeenCalledWith("DELETE", "/api/messages/1/reactions", { emoji: "🎉" }));

    // Clicking another's chip sends POST
    fireEvent.click(thumbChip);
    await waitFor(() => expect(send).toHaveBeenCalledWith("POST", "/api/messages/1/reactions", { emoji: "👍" }));
  });

  it("uses admin endpoint with `as` for POST and DELETE in admin mode", async () => {
    const send = vi.fn(async () => ({ reactions: {} }));
    renderWithChat(
      <ul>
        <MessageItem
          message={msg({ id: 7, from: "claude", text: "pr ready", reactions: { "👍": ["alexey"] } })}
          compact={false}
          mine={false}
          me="alexey"
          kind="claude"
          showWhere={false}
          showTo={false}
          names={[]}
          flash={false}
          onJump={() => {}}
        />
      </ul>,
      { session: adminSession, sender: "alexey", api: fakeApi({ send }) },
    );

    // Clicking own chip in admin mode -> DELETE with { as, emoji }
    fireEvent.click(screen.getByTitle("👍 alexey"));
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith("DELETE", "/admin/api/messages/7/reactions", { as: "alexey", emoji: "👍" }),
    );

    // Picker in admin mode -> POST with { as, emoji }
    fireEvent.click(screen.getByRole("button", { name: "Реакція" }));
    fireEvent.click(screen.getByRole("button", { name: "✅" }));
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith("POST", "/admin/api/messages/7/reactions", { as: "alexey", emoji: "✅" }),
    );
  });

  it("renders read-only chips with no picker when me is absent, and reports errors via fail", async () => {
    renderWithChat(
      <ul>
        <MessageItem
          message={msg({ id: 9, from: "claude", text: "view only", reactions: { "👀": ["alexey"] } })}
          compact={false}
          mine={false}
          kind="claude"
          showWhere={false}
          showTo={false}
          names={[]}
          flash={false}
          onJump={() => {}}
        />
      </ul>,
    );
    expect(screen.getByTitle("👀 alexey").tagName).toBe("SPAN");
    expect(screen.queryByRole("button", { name: "Реакція" })).toBeNull();

    const err = new Error("server failed");
    const send = vi.fn(async () => {
      throw err;
    });
    const { ctx } = renderWithChat(
      <ul>
        <MessageItem
          message={msg({ id: 10, from: "claude", text: "fail test", reactions: { "👍": ["alexey"] } })}
          compact={false}
          mine={false}
          me="olena"
          kind="claude"
          showWhere={false}
          showTo={false}
          names={[]}
          flash={false}
          onJump={() => {}}
        />
      </ul>,
      { api: fakeApi({ send }) },
    );
    fireEvent.click(screen.getByTitle("👍 alexey"));
    await waitFor(() => expect(ctx.fail).toHaveBeenCalledWith(err, "Реакцію не збережено"));
  });
});
