import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { fakeApi, msg, renderWithChat } from "../test/render";
import { Markdown } from "./Markdown";
import { MessageItem } from "./MessageItem";
import { MessageList } from "./MessageList";

describe("links by an explicit syntax (alexey, AIChat 3120-3130)", () => {
  const all = (c: HTMLElement, sel: string) => [...c.querySelectorAll(sel)].map((r) => r.textContent);

  it("links [[msg:…]] to a message here, in a room or in a direct conversation; a bare #number is just text", () => {
    const { container } = renderWithChat(
      <Markdown
        text={"see [[msg:2418]], [[msg:lobby/7]] and [[msg:@alexey/9]]; PR #79 і #80, партія #23; not `[[msg:5]]`, [[msg:x/y]] or [[msg:a b]]"}
        rooms={["lobby", "12"]}
      />,
    );
    expect(all(container, ".msg-ref")).toEqual(["#2418", "#lobby/7", "@alexey/9"]);
    const refs = [...container.querySelectorAll<HTMLElement>(".msg-ref")];
    expect(refs.map((r) => [r.dataset.msg, r.dataset.place])).toEqual([["2418", undefined], ["7", "lobby"], ["9", "@alexey"]]);
    expect(container.textContent).toContain("PR #79 і #80, партія #23");
    expect(container.textContent).toContain("[[msg:x/y]] or [[msg:a b]]");
  });

  it("keeps @name and #room for known ones, and has [[user:…]] and [[room:…]] for the explicit forms", () => {
    const { container } = renderWithChat(
      <Markdown
        text={"@alexey in #lobby, not @nobody, #nowhere, a#lobby or **#12**; [[room:12]], [[user:alexey]], [[user:zed]]"}
        names={["alexey"]}
        rooms={["lobby", "12"]}
      />,
    );
    expect(all(container, ".room-ref")).toEqual(["#lobby", "#12"]);
    expect([...container.querySelectorAll(".room-ref")].at(-1)).toHaveAttribute("data-room", "12");
    expect(all(container, ".mention")).toEqual(["@alexey", "@alexey"]);
    expect(container.textContent).toContain("[[user:zed]]");
  });

  it("shows the message number by its time", () => {
    renderWithChat(
      <ol>
        <MessageItem
          message={msg({ id: 2418, text: "hi" })}
          compact={false}
          mine={false}
          kind="claude"
          showWhere={false}
          showTo={false}
          names={[]}
          flash={false}
          onJump={() => {}}
        />
      </ol>,
    );
    expect(screen.getByText("#2418")).toHaveClass("msg-id");
  });

  it("copies a link to the message from its number", async () => {
    const user = userEvent.setup();
    const toast = vi.fn();
    const item = (m: ReturnType<typeof msg>) => (
      <MessageItem message={m} compact={false} mine={false} me="olena" kind="claude" showWhere={false} showTo={false} names={[]} flash={false} onJump={() => {}} />
    );
    renderWithChat(
      <ol>
        {item(msg({ id: 2418, text: "in a room" }))}
        {item(msg({ id: 2419, room: undefined, to: "olena", text: "direct" }))}
      </ol>,
      { toast },
    );
    await user.click(screen.getByText("#2418"));
    expect(await navigator.clipboard.readText()).toBe("[[msg:lobby/2418]]");
    await user.click(screen.getByText("#2419"));
    expect(await navigator.clipboard.readText()).toBe("[[msg:@claude/2419]]");
    expect(toast).toHaveBeenCalledWith("Скопійовано [[msg:@claude/2419]]");
  });

  it("copies without the Clipboard API (a plain http page), or shows the link to copy by hand", async () => {
    const toast = vi.fn();
    const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    const exec = vi.fn(() => true);
    document.execCommand = exec;
    try {
      renderWithChat(
        <ol>
          <MessageItem message={msg({ id: 77 })} compact={false} mine={false} kind="claude" showWhere={false} showTo={false} names={[]} flash={false} onJump={() => {}} />
        </ol>,
        { toast },
      );
      fireEvent.click(screen.getByText("#77"));
      await waitFor(() => expect(toast).toHaveBeenCalledWith("Скопійовано [[msg:lobby/77]]"));
      expect(exec).toHaveBeenCalledWith("copy");
      exec.mockReturnValue(false);
      fireEvent.click(screen.getByText("#77"));
      await waitFor(() => expect(toast).toHaveBeenCalledWith("Скопіюйте вручну: [[msg:lobby/77]]"));
    } finally {
      if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard);
      else delete (navigator as { clipboard?: unknown }).clipboard;
    }
  });

  it("goes to a loaded message on click", async () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    const props = { hasOlder: false, olderLoads: 0, showWhere: false, emptyTitle: "", emptyText: "", loading: false, onLoadOlder: () => {} };
    renderWithChat(<MessageList {...props} messages={[msg({ id: 10, text: "first" }), msg({ id: 11, text: "as said in [[msg:10]]" })]} />);
    await userEvent.click(screen.getByText("#10", { selector: ".msg-ref" }));
    expect(scroll).toHaveBeenCalled();
  });

  it("does not go to a message that is not where the link says", async () => {
    const toast = vi.fn();
    const props = { hasOlder: false, olderLoads: 0, showWhere: false, emptyTitle: "", emptyText: "", loading: false, onLoadOlder: () => {} };
    renderWithChat(<MessageList {...props} messages={[msg({ id: 10, text: "first" }), msg({ id: 11, text: "[[msg:random/10]]" })]} />, { toast });
    await userEvent.click(screen.getByText("#random/10", { selector: ".msg-ref" }));
    expect(toast).toHaveBeenCalledWith(expect.stringMatching(/#10 не там/));
  });

  it("asks the broker for a message that is not loaded and opens its conversation", async () => {
    const elsewhere = msg({ id: 5, room: "random", text: "old news" });
    const get = vi.fn(async (path: string) => (path === "/api/messages/5" ? { message: elsewhere } : Promise.reject(new Error("no"))));
    const openMessage = vi.fn();
    const props = { hasOlder: false, olderLoads: 0, showWhere: false, emptyTitle: "", emptyText: "", loading: false, onLoadOlder: () => {} };
    renderWithChat(<MessageList {...props} messages={[msg({ id: 11, text: "see [[msg:random/5]]" })]} />, { api: fakeApi({ get }), openMessage });
    await userEvent.click(screen.getByText("#random/5", { selector: ".msg-ref" }));
    await waitFor(() => expect(openMessage).toHaveBeenCalledWith(elsewhere));
  });

  it("says so when the broker does not show it", async () => {
    const get = vi.fn(async () => Promise.reject(new Error("unknown message: 7")));
    const toast = vi.fn();
    const props = { hasOlder: false, olderLoads: 0, showWhere: false, emptyTitle: "", emptyText: "", loading: false, onLoadOlder: () => {} };
    renderWithChat(<MessageList {...props} messages={[msg({ id: 11, text: "see [[msg:7]]" })]} />, { api: fakeApi({ get }), toast });
    await userEvent.click(screen.getByText("#7", { selector: ".msg-ref" }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.stringMatching(/#7 недоступне/)));
  });
});
