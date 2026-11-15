import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { insertMention, mentionQuery } from "../lib/markdownEdit";
import { fakeApi, msg, renderWithChat } from "../test/render";
import { ChatView } from "./ChatView";
import { Composer } from "./Composer";

describe("mention helpers", () => {
  it("finds the @word before the caret", () => {
    expect(mentionQuery("hi @cl", 6)).toEqual({ start: 3, query: "cl" });
    expect(mentionQuery("@", 1)).toEqual({ start: 0, query: "" });
    expect(mentionQuery("mail@host", 9)).toBeNull();
    expect(mentionQuery("hi @cl there", 12)).toBeNull();
  });

  it("inserts @name with spacing", () => {
    expect(insertMention("hi @cl", 3, 6, "claude")).toEqual({ text: "hi @claude ", caret: 11 });
    expect(insertMention("hello", 5, 5, "olena")).toEqual({ text: "hello @olena ", caret: 13 });
    expect(insertMention("", 0, 0, "olena")).toEqual({ text: "@olena ", caret: 7 });
  });
});

describe("Composer mentions", () => {
  const props = { view: { kind: "room", room: "lobby" } as const, replyTo: null, onCancelReply: vi.fn(), dropped: [], onDroppedTaken: vi.fn() };

  it("offers names after @ and completes with Enter without sending", async () => {
    const api = fakeApi();
    renderWithChat(<Composer {...props} />, { api });
    const box = screen.getByLabelText("Повідомлення");
    await userEvent.type(box, "hey @a");
    const list = screen.getByRole("listbox", { name: "Кого згадати" });
    expect(list).toHaveTextContent("alexey");
    expect(list).not.toHaveTextContent("olena"); // yourself is not offered
    await userEvent.keyboard("{Enter}");
    expect(box).toHaveValue("hey @alexey ");
    expect(api.send).not.toHaveBeenCalled();
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("closes the list on Escape", async () => {
    renderWithChat(<Composer {...props} />);
    await userEvent.type(screen.getByLabelText("Повідомлення"), "@");
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).toBeNull();
  });
});

describe("clicking a name", () => {
  it("puts @name into the composer", async () => {
    const api = fakeApi({ get: vi.fn(async () => ({ messages: [msg({ id: 1, from: "claude", text: "hello" })] })) });
    renderWithChat(<ChatView view={{ kind: "room", room: "lobby" }} />, { api });
    await userEvent.click(await screen.findByRole("button", { name: "claude" }));
    await waitFor(() => expect(screen.getByLabelText("Повідомлення")).toHaveValue("@claude "));
  });
});

describe("Enter on touch devices", () => {
  it("makes a new line instead of sending", async () => {
    // jsdom has no matchMedia; pretend to be a phone (coarse pointer, no hover)
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("coarse"), media: q }) as MediaQueryList);
    const api = fakeApi();
    const props = { view: { kind: "room", room: "lobby" } as const, replyTo: null, onCancelReply: vi.fn(), dropped: [], onDroppedTaken: vi.fn() };
    renderWithChat(<Composer {...props} />, { api });
    const box = screen.getByLabelText("Повідомлення");
    await userEvent.type(box, "one{Enter}two");
    expect(box).toHaveValue("one\ntwo");
    expect(api.send).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Надіслати" }));
    await waitFor(() => expect(api.send).toHaveBeenCalledWith("POST", "/api/messages", { room: "lobby", text: "one\ntwo" }));
    vi.unstubAllGlobals();
  });
});

describe("clicking a mention in the text", () => {
  it("puts that @name into the composer", async () => {
    const api = fakeApi({ get: vi.fn(async () => ({ messages: [msg({ id: 1, from: "claude", text: "ask @alexey about it" })] })) });
    renderWithChat(<ChatView view={{ kind: "room", room: "lobby" }} />, { api });
    await userEvent.click(await screen.findByText("@alexey"));
    await waitFor(() => expect(screen.getByLabelText("Повідомлення")).toHaveValue("@alexey "));
  });
});
