import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { adminSession, fakeApi, msg, overview, renderWithChat } from "../test/render";
import { Composer } from "./Composer";
import { Login } from "./Login";
import { Markdown } from "./Markdown";
import { MessageItem, snippet } from "./MessageItem";
import { MessageList } from "./MessageList";
import { Sidebar } from "./Sidebar";
import { render } from "@testing-library/react";

describe("Markdown", () => {
  it("renders formatting but never raw HTML", () => {
    const { container } = render(<Markdown text={"**bold** _it_ `code`\n<img src=x onerror=alert(1)><script>bad()</script>"} />);
    expect(container.querySelector("strong")).toHaveTextContent("bold");
    expect(container.querySelector("em")).toHaveTextContent("it");
    expect(container.querySelector("code")).toHaveTextContent("code");
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
  });

  it("opens links safely and drops javascript: URLs", () => {
    const { container } = render(<Markdown text={"[ok](https://example.com) [bad](javascript:alert(1)) https://auto.link"} />);
    const links = [...container.querySelectorAll("a")];
    expect(links[0]).toHaveAttribute("href", "https://example.com");
    expect(links[0]).toHaveAttribute("target", "_blank");
    expect(links[0].getAttribute("rel")).toContain("noopener");
    expect(links[1].getAttribute("href") ?? "").not.toContain("javascript");
    expect(links[2]).toHaveAttribute("href", "https://auto.link");
  });

  it("highlights mentions of known names only", () => {
    const { container } = render(<Markdown text="hi @olena and @nobody" names={["olena"]} />);
    const m = container.querySelectorAll(".mention");
    expect(m).toHaveLength(1);
    expect(m[0]).toHaveTextContent("@olena");
  });

  it("renders GFM lists and code blocks", () => {
    const { container } = render(<Markdown text={"- a\n- b\n\n```\nx = 1\n```"} />);
    expect(container.querySelectorAll("li")).toHaveLength(2);
    expect(container.querySelector("pre code")).toHaveTextContent("x = 1");
  });
});

describe("MessageItem", () => {
  const base = { compact: false, mine: false, kind: "claude", showWhere: false, showTo: false, names: [], flash: false, onJump: vi.fn() };

  it("shows sender, AI tag, text, files and a reply action", async () => {
    const onReply = vi.fn();
    const m = msg({
      id: 5,
      text: "see **this**",
      attachments: [
        { id: "f1aaaaaaaaaaaaaaaa", name: "report.pdf", mime: "application/pdf", size: 2048 },
        { id: "f2aaaaaaaaaaaaaaaa", name: "pic.png", mime: "image/png", size: 10 },
      ],
    });
    const { container } = renderWithChat(<ol><MessageItem {...base} message={m} onReply={onReply} /></ol>);
    expect(screen.getByText("claude")).toBeInTheDocument();
    expect(container.querySelector(".avatar.bot")).not.toBeNull(); // agents get a square avatar instead of an "AI" badge
    expect(screen.getByText("this").tagName).toBe("STRONG");
    expect(screen.getByText("report.pdf")).toBeInTheDocument();
    expect(await screen.findByAltText("pic.png")).toBeInTheDocument();
    await userEvent.click(screen.getByLabelText("Відповісти"));
    expect(onReply).toHaveBeenCalledWith(m);
  });

  it("quotes the parent message as plain text", () => {
    const parent = msg({ id: 1, from: "olena", text: "**Важливо**: [дивись](https://x.y)\n- пункт" });
    expect(snippet(parent)).toBe("Важливо: дивись пункт");
    renderWithChat(<ol><MessageItem {...base} message={msg({ id: 2, reply_to: 1 })} parent={parent} /></ol>);
    expect(screen.getByText("Важливо: дивись пункт")).toBeInTheDocument();
  });

  it("compact messages hide the header", () => {
    renderWithChat(<ol><MessageItem {...base} compact message={msg({ id: 3, text: "next" })} /></ol>);
    expect(screen.queryByText("claude")).toBeNull();
    expect(screen.getByText("next")).toBeInTheDocument();
  });
});

describe("MessageList", () => {
  it("groups by sender and separates days", () => {
    const messages = [
      msg({ id: 1, ts: "2026-11-14T09:00:00Z", text: "yesterday" }),
      msg({ id: 2, ts: "2026-11-15T09:00:00Z", text: "first" }),
      msg({ id: 3, ts: "2026-11-15T09:01:00Z", text: "second" }),
      msg({ id: 4, ts: "2026-11-15T09:02:00Z", from: "olena", text: "mine" }),
    ];
    const { container } = renderWithChat(
      <MessageList messages={messages} loading={false} hasOlder={false} olderLoads={0} onLoadOlder={() => {}} showWhere={false} emptyTitle="" emptyText="" />,
    );
    expect(container.querySelectorAll(".day")).toHaveLength(2);
    expect(container.querySelector('[data-id="3"]')).toHaveClass("compact");
    expect(container.querySelector('[data-id="2"]')).not.toHaveClass("compact");
    expect(container.querySelector('[data-id="4"]')).toHaveClass("mine");
  });

  it("shows the empty text and the older button", () => {
    const onLoadOlder = vi.fn();
    renderWithChat(
      <MessageList messages={[]} loading={false} hasOlder olderLoads={0} onLoadOlder={onLoadOlder} showWhere={false} emptyTitle="Порожньо" emptyText="" />,
    );
    expect(screen.getByText("Порожньо")).toBeInTheDocument();
    fireEvent.click(screen.getByText(/Завантажити старіші/));
    expect(onLoadOlder).toHaveBeenCalled();
  });
});

describe("Composer", () => {
  const props = { view: { kind: "room", room: "lobby" } as const, replyTo: null, onCancelReply: vi.fn(), dropped: [], onDroppedTaken: vi.fn() };

  it("sends on Enter, keeps Shift+Enter as a new line", async () => {
    const api = fakeApi({ send: vi.fn(async () => ({ message: msg({ id: 9, from: "olena", text: "hello" }) })) });
    const { ctx } = renderWithChat(<Composer {...props} />, { api });
    const box = screen.getByLabelText("Повідомлення");
    await userEvent.type(box, "hello{Shift>}{Enter}{/Shift}world");
    expect(box).toHaveValue("hello\nworld");
    await userEvent.type(box, "{Enter}");
    await waitFor(() => expect(api.send).toHaveBeenCalledWith("POST", "/api/messages", { room: "lobby", text: "hello\nworld" }));
    expect(ctx.addLive).toHaveBeenCalled();
    expect(box).toHaveValue("");
  });

  it("formats with the toolbar and Ctrl+B", async () => {
    renderWithChat(<Composer {...props} />);
    const box = screen.getByLabelText("Повідомлення") as HTMLTextAreaElement;
    await userEvent.type(box, "word");
    box.setSelectionRange(0, 4);
    await userEvent.click(screen.getByLabelText("Курсив (Ctrl+I)"));
    expect(box).toHaveValue("_word_");
    await userEvent.type(box, "{Control>}b{/Control}");
    expect(box.value).toContain("**");
  });

  it("uploads attached files first, then sends their ids", async () => {
    const api = fakeApi({ send: vi.fn(async () => ({ message: msg({ id: 10 }) })) });
    renderWithChat(<Composer {...props} />, { api });
    const file = new File(["data"], "notes.txt", { type: "text/plain" });
    await userEvent.upload(screen.getByTestId("file-input"), file);
    expect(screen.getByText("notes.txt")).toBeInTheDocument();
    await userEvent.click(screen.getByLabelText("Надіслати"));
    await waitFor(() =>
      expect(api.send).toHaveBeenCalledWith("POST", "/api/messages", { room: "lobby", text: "", attachments: ["id-notes.txt"] }),
    );
    expect(api.upload).toHaveBeenCalledWith("/api/files", file);
    expect(screen.queryByText("notes.txt")).toBeNull();
  });

  it("admins write as themselves, with no sender picker", async () => {
    const api = fakeApi({ send: vi.fn(async () => ({ message: msg({ id: 11 }) })) });
    renderWithChat(<Composer {...props} />, { api, session: adminSession, sender: "alexey" });
    expect(screen.queryByLabelText("Від")).toBeNull();
    await userEvent.upload(screen.getByTestId("file-input"), new File(["d"], "a.png", { type: "image/png" }));
    await userEvent.type(screen.getByLabelText("Повідомлення"), "look{Enter}");
    await waitFor(() =>
      expect(api.send).toHaveBeenCalledWith("POST", "/admin/api/messages", { as: "alexey", room: "lobby", text: "look", attachments: ["id-a.png"] }),
    );
    expect(api.upload).toHaveBeenCalledWith("/admin/api/files?as=alexey", expect.any(File));
  });

  it("answers with reply_to and blocks admins outside a DM", async () => {
    const api = fakeApi({ send: vi.fn(async () => ({})) });
    renderWithChat(<Composer {...props} replyTo={msg({ id: 4, text: "q?" })} />, { api });
    expect(screen.getByText("q?")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Повідомлення"), "a{Enter}");
    await waitFor(() => expect(api.send).toHaveBeenCalledWith("POST", "/api/messages", { room: "lobby", text: "a", reply_to: 4 }));
    renderWithChat(<Composer {...props} view={{ kind: "dm", a: "claude", b: "olena" }} />, { session: adminSession, sender: "alexey" });
    expect(screen.getAllByLabelText("Повідомлення")[1]).toBeDisabled();
  });

  it("admins pick the recipient in the all-messages view", async () => {
    const api = fakeApi({ send: vi.fn(async () => ({})) });
    renderWithChat(<Composer {...props} view={{ kind: "all" }} />, { api, session: adminSession, sender: "alexey" });
    await userEvent.selectOptions(screen.getByLabelText("Кому"), "@claude");
    await userEvent.type(screen.getByLabelText("Повідомлення"), "hi{Enter}");
    await waitFor(() => expect(api.send).toHaveBeenCalledWith("POST", "/admin/api/messages", { as: "alexey", to: "claude", text: "hi" }));
  });

  it("lists only people and agents under Кому; a reply keeps its room", () => {
    const { unmount } = renderWithChat(<Composer {...props} view={{ kind: "all" }} />, { session: adminSession, sender: "alexey" });
    const options = () => [...(screen.getByLabelText("Кому") as HTMLSelectElement).options].map((o) => o.value);
    expect(options()).toEqual(["@claude", "@olena"]);
    unmount();
    renderWithChat(<Composer {...props} view={{ kind: "all" }} replyTo={msg({ id: 4, room: "lobby" })} />, {
      session: adminSession,
      sender: "alexey",
    });
    expect(options()).toEqual(["#lobby", "@claude", "@olena"]);
    expect(screen.getByLabelText("Кому")).toHaveValue("#lobby");
  });

  it("refuses more than 10 files", async () => {
    const { ctx } = renderWithChat(<Composer {...props} />);
    const files = Array.from({ length: 11 }, (_, i) => new File(["x"], `f${i}.txt`));
    await userEvent.upload(screen.getByTestId("file-input"), files);
    expect(screen.getAllByLabelText(/^Прибрати /)).toHaveLength(10);
    expect(ctx.toast).toHaveBeenCalledWith(expect.stringContaining("10"), true);
  });
});

describe("Sidebar", () => {
  const props = { unread: new Map([["r:lobby", 3]]), conn: { status: "online" as const, retryIn: 0 }, theme: "system" as const, onTheme: vi.fn(), onLogout: vi.fn(), onJoin: vi.fn(), onSearch: vi.fn() };

  it("lists rooms with unread badges, people with presence, and rooms to join", async () => {
    const { ctx, container } = renderWithChat(<Sidebar {...props} />);
    expect(container.querySelector(".nav-item .badge")).toHaveTextContent("3");
    expect(screen.getByRole("button", { name: /^olena\s*онлайн\s*ви$/ })).toBeInTheDocument();
    expect(container.querySelectorAll(".presence.on")).toHaveLength(2);
    expect(screen.queryByText("Налаштування")).toBeNull();
    await userEvent.click(screen.getByText("random"));
    expect(props.onJoin).toHaveBeenCalledWith("random");
    await userEvent.click(screen.getByText("claude"));
    expect(ctx.go).toHaveBeenCalledWith({ kind: "dm", a: "claude", b: "olena" });
  });

  it("folds a group, keeps its unread count visible and remembers the choice", async () => {
    localStorage.clear();
    const { container, unmount } = renderWithChat(<Sidebar {...props} />);
    const head = screen.getByRole("button", { name: /Кімнати/ });
    expect(head).toHaveAttribute("aria-expanded", "true");
    await userEvent.click(head);
    expect(head).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("lobby")).toBeNull();
    expect(container.querySelector(".nav-title .badge")).toHaveTextContent("3");
    unmount();
    renderWithChat(<Sidebar {...props} />);
    expect(screen.getByRole("button", { name: /Кімнати/ })).toHaveAttribute("aria-expanded", "false");
    localStorage.clear();
  });

  it("keeps game rooms out of the room lists and counts their unread on the games tab", () => {
    const withGame = {
      ...overview,
      rooms: [...overview.rooms, { name: "game-4", members: ["olena", "claude"], count: 3, last_ts: null }],
      all_rooms: [...overview.all_rooms, "game-4", "game-5"],
    };
    renderWithChat(<Sidebar {...props} unread={new Map([["r:game-4", 2]])} />, { overview: withGame });
    expect(screen.queryByText("game-4")).toBeNull();
    expect(screen.queryByText("game-5")).toBeNull();
    expect(screen.getByRole("button", { name: /Міні-ігри/ })).toHaveTextContent("2");
  });

  it("shows admin sections to admins", () => {
    renderWithChat(<Sidebar {...props} />, { session: adminSession, sender: "alexey", overview });
    expect(screen.getByText("Усі повідомлення")).toBeInTheDocument();
    expect(screen.getByText("Налаштування")).toBeInTheDocument();
    expect(screen.getByText("адміністратор")).toBeInTheDocument();
  });
});

describe("Login", () => {
  it("submits the token and shows errors", async () => {
    const onLogin = vi.fn(async () => {});
    const { rerender } = render(<Login onLogin={onLogin} error="" />);
    await userEvent.type(screen.getByLabelText(/Особистий токен/), "  secret-token  ");
    await userEvent.click(screen.getByRole("button", { name: /Увійти/ }));
    expect(onLogin).toHaveBeenCalledWith("secret-token", true);
    rerender(<Login onLogin={onLogin} error="Невірний токен." />);
    expect(screen.getByRole("alert")).toHaveTextContent("Невірний токен.");
  });
});
