import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { mentions, needsMe } from "../lib/notify";
import { dm, hashFor, historyPath, matchesView, parseHash, viewOfMessage } from "../lib/views";
import { adminSession, fakeApi, msg, renderWithChat } from "../test/render";
import { CommandPalette } from "./CommandPalette";
import { MessageList } from "./MessageList";

describe("notifications", () => {
  it("recognises @mentions and direct messages meant for me", () => {
    expect(mentions("hi @olena, look", "olena")).toBe(true);
    expect(mentions("@olena-bot is here", "olena")).toBe(false);
    expect(mentions("mail me at x@olena", "olena")).toBe(false);
    expect(needsMe(msg({ id: 1, from: "claude", room: "lobby", text: "@olena?" }), "olena")).toBe(true);
    expect(needsMe(msg({ id: 2, from: "claude", room: undefined, to: "olena", text: "hi" }), "olena")).toBe(true);
    expect(needsMe(msg({ id: 3, from: "olena", room: "lobby", text: "@olena note to self" }), "olena")).toBe(false);
    expect(needsMe(msg({ id: 4, from: "claude", room: "lobby", text: "general" }), "olena")).toBe(false);
  });
});

describe("all messages filtered by participant", () => {
  it("round-trips through the hash and narrows history and live messages", () => {
    const v = { kind: "all" as const, agent: "claude" };
    expect(parseHash(hashFor(v))).toEqual(v);
    expect(historyPath(v, adminSession, 100)).toBe("/admin/api/messages?limit=100&agent=claude");
    expect(matchesView(msg({ id: 1, from: "claude" }), v)).toBe(true);
    expect(matchesView(msg({ id: 2, from: "olena", room: undefined, to: "claude" }), v)).toBe(true);
    expect(matchesView(msg({ id: 3, from: "olena" }), v)).toBe(false);
    expect(viewOfMessage(msg({ id: 4, from: "b", room: undefined, to: "a" }))).toEqual(dm("a", "b"));
    expect(viewOfMessage(msg({ id: 5, room: "game-7" }))).toEqual({ kind: "game", id: 7 });
  });
});

describe("command palette", () => {
  it("jumps to a room with the keyboard", async () => {
    const go = vi.fn();
    const onClose = vi.fn();
    renderWithChat(<CommandPalette onClose={onClose} />, { go });
    await userEvent.type(screen.getByRole("combobox"), "lob");
    expect(screen.getAllByRole("option")).toHaveLength(1);
    await userEvent.keyboard("{Enter}");
    expect(go).toHaveBeenCalledWith({ kind: "room", room: "lobby" });
    expect(onClose).toHaveBeenCalled();
  });

  it("searches message text and opens the message", async () => {
    const found = msg({ id: 42, from: "claude", text: "Валідатор **готовий** до рев'ю" });
    const get = vi.fn(async () => ({ messages: [found] }));
    const openMessage = vi.fn();
    renderWithChat(<CommandPalette onClose={() => {}} />, { api: fakeApi({ get }), openMessage });
    await userEvent.type(screen.getByRole("combobox"), "готовий");
    await waitFor(() => expect(get).toHaveBeenCalledWith(`/api/search?q=${encodeURIComponent("готовий")}&limit=20`));
    const mark = await screen.findByText("готовий", { selector: "mark" });
    await userEvent.click(mark);
    expect(openMessage).toHaveBeenCalledWith(found);
  });
});

describe("jump to a message", () => {
  const props = { hasOlder: true, olderLoads: 0, showWhere: false, emptyTitle: "", emptyText: "" };
  it("loads older pages until the message is there", () => {
    const onLoadOlder = vi.fn();
    const onFocusDone = vi.fn();
    const later = [msg({ id: 50 }), msg({ id: 51 })];
    renderWithChat(
      <MessageList {...props} messages={later} loading={false} onLoadOlder={onLoadOlder} focusId={10} onFocusDone={onFocusDone} />,
    );
    expect(onLoadOlder).toHaveBeenCalledTimes(1);
    expect(onFocusDone).not.toHaveBeenCalled();
  });

  it("says so when the message is not in this conversation", () => {
    const toast = vi.fn();
    const onFocusDone = vi.fn();
    renderWithChat(
      <MessageList
        {...props}
        hasOlder={false}
        messages={[msg({ id: 50 })]}
        loading={false}
        onLoadOlder={() => {}}
        focusId={10}
        onFocusDone={onFocusDone}
      />,
      { toast },
    );
    expect(toast).toHaveBeenCalledWith(expect.stringMatching(/#10 не знайдено/));
    expect(onFocusDone).toHaveBeenCalled();
  });

  it("highlights it once loaded", () => {
    const onFocusDone = vi.fn();
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    const { container } = renderWithChat(
      <MessageList
        {...props}
        messages={[msg({ id: 9 }), msg({ id: 10, text: "тут" })]}
        loading={false}
        onLoadOlder={() => {}}
        focusId={10}
        onFocusDone={onFocusDone}
      />,
    );
    expect(scroll).toHaveBeenCalled();
    expect(container.querySelector('[data-id="10"]')).toHaveClass("flash");
    expect(onFocusDone).toHaveBeenCalled();
  });
});
