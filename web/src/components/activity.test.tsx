import { act, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AgentActivity, Overview } from "../api/types";
import { activityText } from "../lib/activity";
import { fakeApi, msg, overview, renderWithChat } from "../test/render";
import { ActivityBar } from "./ActivityBar";
import { ChatView } from "./ChatView";

const NOW = Date.parse("2026-11-15T10:00:00Z");
const busy = (detail?: string, minutes = 0): AgentActivity => ({
  state: "busy",
  detail,
  room: "lobby",
  since: new Date(NOW - minutes * 60000).toISOString(),
});

function withActivity(name: string, activity: AgentActivity | undefined, online = true): Overview {
  return { ...overview, agents: overview.agents.map((a) => (a.name === name ? { ...a, online, activity } : a)) };
}

describe("activity text", () => {
  it("says what an agent does, in words, with how long", () => {
    expect(activityText("claude", busy("Edit", 3), NOW)).toBe("claude працює: редагує файл · 3 хв");
    expect(activityText("claude", busy("Bash"), NOW)).toBe("claude працює: виконує команду");
    expect(activityText("claude", busy(), NOW)).toBe("claude працює");
    const waiting = (detail?: string): AgentActivity => ({ state: "waiting", detail, since: new Date(NOW).toISOString() });
    expect(activityText("claude", waiting("Claude needs your permission to use Bash"), NOW)).toBe("claude чекає: дозволу на Bash");
    expect(activityText("claude", waiting("Claude needs your permission to use mcp__aichat__send_message"), NOW)).toBe(
      "claude чекає: дозволу на send_message",
    );
    expect(activityText("claude", waiting(), NOW)).toBe("claude чекає на людину");
    expect(activityText("claude", busy("думає"), NOW)).toBe("claude працює: думає");
  });
});

describe("activity bar", () => {
  it("shows busy and waiting agents of the open room, and nobody when all are idle or offline", () => {
    const { unmount } = renderWithChat(<ActivityBar view={{ kind: "room", room: "lobby" }} />, {
      overview: withActivity("claude", busy("Read")),
    });
    expect(screen.getByRole("status")).toHaveTextContent("claude працює: читає файл");
    unmount();

    const waiting = withActivity("claude", { state: "waiting", detail: "дозволу на Bash", room: "lobby", since: new Date().toISOString() });
    const { unmount: u2 } = renderWithChat(<ActivityBar view={{ kind: "room", room: "lobby" }} />, { overview: waiting });
    expect(screen.getByRole("status").firstElementChild).toHaveClass("waiting");
    u2();

    const { container } = renderWithChat(<ActivityBar view={{ kind: "room", room: "lobby" }} />, {
      overview: withActivity("claude", busy("Read"), false),
    });
    expect(container).toBeEmptyDOMElement();
  });

  it("ignores agents outside the conversation", () => {
    const { container } = renderWithChat(<ActivityBar view={{ kind: "dm", a: "alexey", b: "olena" }} />, {
      overview: withActivity("claude", busy("Read")),
    });
    expect(container).toBeEmptyDOMElement();
  });
});

describe("delivery ticks", () => {
  it("shows who received my message, from history and live receipts", async () => {
    let deliver: (id: number, to: string) => void = () => {};
    const api = fakeApi({
      get: vi.fn(async () => ({
        messages: [msg({ id: 1, from: "olena", text: "hi all", delivered_to: ["claude"] }), msg({ id: 2, from: "olena", text: "second" })],
      })),
    });
    renderWithChat(<ChatView view={{ kind: "room", room: "lobby" }} />, {
      api,
      subscribeDelivered: (fn) => {
        deliver = fn;
        return () => {};
      },
    });
    expect(await screen.findByLabelText("Доставлено: claude")).toBeInTheDocument();
    expect(screen.queryAllByLabelText(/Доставлено/)).toHaveLength(1);
    act(() => deliver(2, "alexey"));
    await waitFor(() => expect(screen.getByLabelText("Доставлено: alexey")).toBeInTheDocument());
  });
});
