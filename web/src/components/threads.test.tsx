import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { fakeApi, msg, overview, renderWithChat } from "../test/render";
import { ChatView } from "./ChatView";
import { Markdown } from "./Markdown";
import { MessageList } from "./MessageList";
import { ThreadPanel } from "./ThreadPanel";
import { buildThreads } from "../lib/threads";

const chain = [
  msg({ id: 1, from: "olena", text: "Хто перевірить план?" }),
  msg({ id: 2, from: "claude", text: "Я дивлюсь", reply_to: 1, hops: 1 }),
  msg({ id: 3, from: "olena", text: "Окреме питання" }),
  msg({ id: 4, from: "alexey", text: "Додав зауваження", reply_to: 2, hops: 2 }),
];
const list = (over: Partial<Parameters<typeof MessageList>[0]> = {}) => (
  <MessageList
    messages={chain}
    loading={false}
    hasOlder={false}
    olderLoads={0}
    onLoadOlder={() => {}}
    showWhere={false}
    emptyTitle=""
    emptyText=""
    threads={buildThreads(chain)}
    {...over}
  />
);

describe("threads in the feed", () => {
  it("folds replies under their first message and opens the thread from the summary", async () => {
    const onOpenThread = vi.fn();
    renderWithChat(list({ threaded: true, onOpenThread }));
    expect(screen.queryByText("Я дивлюсь")).toBeNull();
    expect(screen.queryByText("Додав зауваження")).toBeNull();
    expect(screen.getByText("Окреме питання")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /2 відповіді/ }));
    expect(onOpenThread).toHaveBeenCalledWith(1, undefined);
  });

  it("keeps every message in the feed when threads are off, with a button to open the thread", async () => {
    const onOpenThread = vi.fn();
    const { container } = renderWithChat(list({ threaded: false, onOpenThread }));
    expect(container.querySelector('[data-id="2"]')).toHaveTextContent("Я дивлюсь");
    expect(screen.queryByRole("button", { name: /2 відповіді/ })).toBeNull();
    await userEvent.click(screen.getAllByLabelText("Відкрити тред")[2]); // the reply #4
    expect(onOpenThread).toHaveBeenCalledWith(1, 4);
    expect(screen.getAllByLabelText("Відкрити тред")).toHaveLength(3); // #3 is in no thread
  });

  it("marks a chain that reached the hop limit", () => {
    const capped = [msg({ id: 1, text: "start" }), msg({ id: 2, text: "last word", reply_to: 1, hops: 2 })];
    const o = { ...overview, max_hops: 2 };
    const { unmount } = renderWithChat(list({ messages: capped, threads: buildThreads(capped) }), { overview: o });
    expect(screen.getByRole("note")).toHaveTextContent(/Ланцюжок зупинено: 2 відповіді поспіль/);
    unmount();
    renderWithChat(list({ messages: capped, threads: buildThreads(capped), threaded: true, onOpenThread: () => {} }), { overview: o });
    expect(screen.queryByRole("note")).toBeNull(); // folded: the summary says it instead
    expect(screen.getByRole("button", { name: /1 відповідь.*ліміт/ })).toBeInTheDocument();
  });
});

describe("thread panel", () => {
  it("shows the chain in order and replies to its newest message", async () => {
    const send = vi.fn(async () => ({ message: msg({ id: 9, from: "olena", text: "ok", reply_to: 4, hops: 3 }) }));
    const thread = buildThreads(chain).byRoot.get(1)!;
    renderWithChat(<ThreadPanel thread={thread} onClose={() => {}} canWrite />, { api: fakeApi({ send }) });
    expect(screen.getByText("Я дивлюсь")).toBeInTheDocument();
    expect(screen.getByText("Додав зауваження")).toBeInTheDocument();
    expect(screen.queryByText("Окреме питання")).toBeNull();
    await userEvent.type(screen.getByLabelText("Повідомлення"), "ok{Enter}");
    await waitFor(() => expect(send).toHaveBeenCalled());
    expect(send).toHaveBeenCalledWith("POST", "/api/messages", { room: "lobby", text: "ok", reply_to: 4 });
  });

  it("blocks the reply box once the chain hit the limit", () => {
    const capped = [msg({ id: 1, text: "start" }), msg({ id: 2, text: "last", reply_to: 1, hops: 1 })];
    const thread = buildThreads(capped).byRoot.get(1)!;
    renderWithChat(<ThreadPanel thread={thread} onClose={() => {}} canWrite />, { overview: { ...overview, max_hops: 1 } });
    expect(screen.getByLabelText("Повідомлення")).toBeDisabled();
  });

  it("opens from the feed and closes again", async () => {
    const get = vi.fn(async () => ({ messages: chain }));
    renderWithChat(<ChatView view={{ kind: "room", room: "lobby" }} />, { api: fakeApi({ get }), threaded: true });
    await userEvent.click(await screen.findByRole("button", { name: /2 відповіді/ }));
    const panel = screen.getByRole("complementary", { name: "Тред" });
    expect(panel).toHaveTextContent("Додав зауваження");
    await userEvent.click(screen.getByLabelText("Закрити тред"));
    expect(screen.queryByRole("complementary", { name: "Тред" })).toBeNull();
  });
});

describe("code blocks", () => {
  it("highlights a named language and offers a copy button", () => {
    const { container } = renderWithChat(<Markdown text={"```ts\nconst x: number = 1;\n```"} />);
    expect(container.querySelector("code.hljs .hljs-keyword")).toHaveTextContent("const");
    expect(screen.getByLabelText("Копіювати код")).toBeInTheDocument();
    expect(container.querySelector(".code-block-head")).toHaveTextContent("ts");
  });

  it("leaves unnamed blocks as plain text", () => {
    const { container } = renderWithChat(<Markdown text={"```\nconst x = 1;\n```"} />);
    expect(container.querySelector(".hljs-keyword")).toBeNull();
  });
});
