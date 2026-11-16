import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { AgentActivity, Overview } from "../api/types";
import { activityText, statusText, toolText } from "../lib/activity";
import { insertRef, refQuery } from "../lib/markdownEdit";
import { knownRooms } from "../lib/views";
import { msg, overview, renderWithChat } from "../test/render";
import { ActivityBar } from "./ActivityBar";
import { Composer } from "./Composer";
import { Markdown } from "./Markdown";
import { MessageItem } from "./MessageItem";
import { Sidebar } from "./Sidebar";

const NOW = Date.parse("2026-11-15T10:00:00Z");
const act = (p: Partial<AgentActivity>): AgentActivity => ({ state: "busy", since: new Date(NOW - 2 * 60000).toISOString(), ...p });
const withClaude = (a: AgentActivity | undefined): Overview => ({
  ...overview,
  rooms: [...overview.rooms, { name: "ops", members: ["claude"], count: 0, last_ts: null }],
  agents: overview.agents.map((x) => (x.name === "claude" ? { ...x, activity: a } : x)),
});

describe("status texts", () => {
  it("say what, where and how long, briefly", () => {
    expect(toolText("Edit", "App.tsx")).toBe("редагує App.tsx");
    expect(toolText("Bash", "npm test")).toBe("виконує npm test");
    expect(toolText("Grep", "hopLimit")).toBe("шукає «hopLimit»");
    expect(toolText("Edit")).toBe("редагує файл");
    expect(activityText("claude", act({ detail: "Edit", target: "App.tsx", topic: "web" }), NOW)).toBe("claude працює над web: редагує App.tsx · 2 хв");
    expect(statusText(act({ topic: "web", room: "lobby" }))).toBe("Працює над web у #lobby");
    expect(statusText(act({ room: "ops" }))).toBe("Працює у #ops");
    expect(statusText(act({ topic: "review", with: "olena" }), "olena")).toBe("Працює над review з вами");
    expect(statusText(act({ state: "waiting", detail: "Claude needs your permission to use Bash" }))).toBe("Чекає дозволу на Bash");
    expect(statusText(act({ state: "idle", topic: "web", room: "lobby" }))).toBe("Web у #lobby · пауза");
    expect(statusText(act({ state: "idle" }))).toBe("");
  });
});

describe("activity line above the composer", () => {
  it("shows an agent only in the conversation it works in", () => {
    const o = withClaude(act({ detail: "Edit", target: "App.tsx", topic: "web", room: "ops" }));
    const { container, unmount } = renderWithChat(<ActivityBar view={{ kind: "room", room: "lobby" }} />, { overview: o });
    expect(container).toBeEmptyDOMElement();
    unmount();
    renderWithChat(<ActivityBar view={{ kind: "room", room: "ops" }} />, { overview: o });
    expect(screen.getByRole("status")).toHaveTextContent("claude працює над web: редагує App.tsx");
  });

  it("shows a direct conversation's agent when it works with the other side", () => {
    const o = withClaude(act({ detail: "Read", target: "notes.md", with: "olena" }));
    renderWithChat(<ActivityBar view={{ kind: "dm", a: "claude", b: "olena" }} />, { overview: o });
    expect(screen.getByRole("status")).toHaveTextContent("claude працює: читає notes.md");
  });
});

describe("sidebar", () => {
  const props = {
    unread: new Map(),
    conn: { status: "online" as const, retryIn: 0 },
    theme: "system" as const,
    onTheme: vi.fn(),
    onLogout: vi.fn(),
    onJoin: vi.fn(),
    onSearch: vi.fn(),
  };
  it("lists agents and people apart, with the kind and a short status under each agent's name", () => {
    const { container } = renderWithChat(<Sidebar {...props} />, { overview: withClaude(act({ topic: "web", room: "lobby" })) });
    const titles = [...container.querySelectorAll(".nav-title span:first-of-type")].map((e) => e.textContent);
    expect(titles).toEqual(expect.arrayContaining(["Агенти", "Люди"]));
    const claude = screen.getByRole("button", { name: /^claude/ });
    expect(claude.querySelector(".nav-sub")).toHaveTextContent("Claude Code · Працює над web у #lobby");
    expect(claude.querySelector(".nav-status")).toHaveClass("busy");
    expect(screen.getByText("1 працює")).toBeInTheDocument();
  });
});

describe("#room references", () => {
  it("finds and inserts #room like @name", () => {
    expect(refQuery("see #lo", 7)).toEqual({ start: 4, query: "lo", sigil: "#" });
    expect(refQuery("hi @cl", 6)).toEqual({ start: 3, query: "cl", sigil: "@" });
    expect(refQuery("a#lo", 4)).toBeNull();
    expect(insertRef("see #lo", 4, 7, "#", "lobby")).toEqual({ text: "see #lobby ", caret: 11 });
    expect(knownRooms({ ...overview, all_rooms: ["lobby", "random", "game-3"] })).toEqual(["lobby", "random"]);
  });

  it("links known rooms in text, not unknown ones, words or headings", () => {
    const { container } = renderWithChat(<Markdown text={"Go to #lobby, not #nowhere or a#lobby\n\n# Heading"} rooms={["lobby"]} />);
    const refs = [...container.querySelectorAll(".room-ref")];
    expect(refs.map((r) => r.textContent)).toEqual(["#lobby"]);
    expect(refs[0]).toHaveAttribute("data-room", "lobby");
    expect(container.querySelector("h1")).toHaveTextContent("Heading");
  });

  it("opens the room on click", async () => {
    const onRoom = vi.fn();
    renderWithChat(
      <ol>
        <MessageItem
          message={msg({ id: 1, text: "continue in #random" })}
          compact={false}
          mine={false}
          kind="claude"
          showWhere={false}
          showTo={false}
          names={[]}
          rooms={["random"]}
          onRoom={onRoom}
          flash={false}
          onJump={() => {}}
        />
      </ol>,
    );
    await userEvent.click(screen.getByText("#random"));
    expect(onRoom).toHaveBeenCalledWith("random");
  });

  it("suggests rooms after # in the composer", async () => {
    renderWithChat(
      <Composer view={{ kind: "room", room: "lobby" }} replyTo={null} onCancelReply={() => {}} dropped={[]} onDroppedTaken={() => {}} />,
      { overview: { ...overview, all_rooms: ["lobby", "random"] } },
    );
    const box = screen.getByLabelText("Повідомлення");
    await userEvent.type(box, "see #ra");
    const list = screen.getByRole("listbox", { name: "Яку кімнату згадати" });
    expect(list).toHaveTextContent("random");
    expect(list).toHaveTextContent("ви не в кімнаті");
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(box).toHaveValue("see #random "));
  });
});
