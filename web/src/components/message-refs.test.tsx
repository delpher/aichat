import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { fakeApi, msg, renderWithChat } from "../test/render";
import { Markdown } from "./Markdown";
import { MessageItem } from "./MessageItem";
import { MessageList } from "./MessageList";

describe("#1234 message references", () => {
  it("links message numbers in text, not inside words, code or links, and a room of that name wins", () => {
    const { container } = renderWithChat(
      <Markdown text={"see #2418 and #12, not a#99, #77x or `#55`, [#66](http://x) or #lobby"} rooms={["lobby", "12"]} />,
    );
    const refs = [...container.querySelectorAll(".msg-ref")];
    expect(refs.map((r) => r.textContent)).toEqual(["#2418"]);
    expect(refs[0]).toHaveAttribute("data-msg", "2418");
    expect([...container.querySelectorAll(".room-ref")].map((r) => r.textContent)).toEqual(["#12", "#lobby"]);
  });

  it("leaves numbers of pull requests, issues, games and notes as text, also in lists of them (alexey, 3110)", () => {
    const { container } = renderWithChat(
      <Markdown text={"PR #79 (таби) і #80 відкриті; PRs #75, #76 та #77; issue #5; PR-и #81–#82; Pull Request #9, #10-#11; PR#12; але #2418 — повідомлення, і #79 в реченні теж; PR: #3; партія #23, гра #21 і #22, нотатка #20, game #5"} />,
    );
    expect([...container.querySelectorAll(".msg-ref")].map((r) => r.textContent)).toEqual(["#2418", "#79"]);
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

  it("goes to a loaded message on click", async () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    const props = { hasOlder: false, olderLoads: 0, showWhere: false, emptyTitle: "", emptyText: "", loading: false, onLoadOlder: () => {} };
    renderWithChat(<MessageList {...props} messages={[msg({ id: 10, text: "first" }), msg({ id: 11, text: "as said in #10" })]} />);
    await userEvent.click(screen.getByText("#10", { selector: ".msg-ref" }));
    expect(scroll).toHaveBeenCalled();
  });

  it("asks the broker for a message that is not loaded and opens its conversation", async () => {
    const elsewhere = msg({ id: 5, room: "random", text: "old news" });
    const get = vi.fn(async (path: string) => (path === "/api/messages/5" ? { message: elsewhere } : Promise.reject(new Error("no"))));
    const openMessage = vi.fn();
    const props = { hasOlder: false, olderLoads: 0, showWhere: false, emptyTitle: "", emptyText: "", loading: false, onLoadOlder: () => {} };
    renderWithChat(<MessageList {...props} messages={[msg({ id: 11, text: "see #5" })]} />, { api: fakeApi({ get }), openMessage });
    await userEvent.click(screen.getByText("#5", { selector: ".msg-ref" }));
    await waitFor(() => expect(openMessage).toHaveBeenCalledWith(elsewhere));
  });

  it("says so when the broker does not show it", async () => {
    const get = vi.fn(async () => Promise.reject(new Error("unknown message: 7")));
    const toast = vi.fn();
    const props = { hasOlder: false, olderLoads: 0, showWhere: false, emptyTitle: "", emptyText: "", loading: false, onLoadOlder: () => {} };
    renderWithChat(<MessageList {...props} messages={[msg({ id: 11, text: "see #7" })]} />, { api: fakeApi({ get }), toast });
    await userEvent.click(screen.getByText("#7", { selector: ".msg-ref" }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.stringMatching(/#7 недоступне/)));
  });
});
