import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { RoomBrief } from "../api/types";
import type { BoardEvent } from "../context";
import { fakeApi, overview, renderWithChat } from "../test/render";
import { ChatView } from "./ChatView";
import { BriefPanel, RoomActions, RoomBar } from "./RoomBar";
import { WorkPanel } from "./WorkPanel";

const brief: RoomBrief = {
  room: "lobby",
  text: "Мета: валідатор налаштувань.\n\nclaude пише код, olena погоджує.",
  by: "olena",
  ts: "2026-11-15T09:00:00Z",
};

/** The header row and the panel under it, wired the way ChatView does it. */
function Harness({
  b,
  onSaveBrief = async () => {},
}: {
  b: RoomBrief | null;
  onSaveBrief?: (text: string) => Promise<void>;
}) {
  const [mode, setMode] = useState<"closed" | "view" | "edit">("closed");
  return (
    <>
      <RoomBar
        brief={b}
        open={mode !== "closed"}
        onToggle={() => setMode((m) => (m === "closed" ? "view" : "closed"))}
        onEdit={() => setMode("edit")}
      />
      <RoomActions room="lobby" workOpen={false} onToggleWork={() => {}} />
      {mode !== "closed" && (
        <BriefPanel
          room="lobby"
          brief={b}
          editing={mode === "edit"}
          onEdit={() => setMode("edit")}
          onClose={() => setMode("closed")}
          onCancel={() => setMode(b ? "view" : "closed")}
          onSave={async (text) => {
            await onSaveBrief(text);
            setMode("view");
          }}
        />
      )}
    </>
  );
}
const bar = (b: RoomBrief | null, onSaveBrief = async () => {}) => <Harness b={b} onSaveBrief={onSaveBrief} />;

describe("RoomBar", () => {
  it("folds the brief to its first line and edits it", async () => {
    const onSaveBrief = vi.fn(async () => {});
    renderWithChat(bar(brief, onSaveBrief));
    const toggle = screen.getByRole("button", { name: /Бриф\s*Мета: валідатор/ });
    expect(screen.queryByText(/olena погоджує/)).toBeNull();
    await userEvent.click(toggle);
    expect(screen.getByText(/olena погоджує/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Змінити" }));
    const box = screen.getByLabelText("Бриф кімнати");
    await userEvent.clear(box);
    await userEvent.type(box, "Нова мета");
    await userEvent.click(screen.getByRole("button", { name: /Зберегти бриф/ }));
    expect(onSaveBrief).toHaveBeenCalledWith("Нова мета");
  });

  it("shows the first line of the brief as plain text", () => {
    renderWithChat(bar({ ...brief, text: "\n## **Мета:** `валідатор`\n- пункт" }));
    expect(screen.getByRole("button", { name: /Бриф/ }).querySelector(".brief-line")).toHaveTextContent(/^Мета: валідатор$/);
  });

  it("exports the room's conversation through a download link from the broker (issue #61)", async () => {
    const send = vi.fn(async () => ({ url: "/dl/rooms/lobby?tz=UTC&exp=1&sig=s" }));
    const hrefs: string[] = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      hrefs.push(this.getAttribute("href")!);
    });
    renderWithChat(bar(brief), { api: fakeApi({ send }) });
    await userEvent.click(screen.getByRole("button", { name: "Експортувати переписку #lobby у Markdown" }));
    await waitFor(() => expect(click).toHaveBeenCalled());
    expect(send).toHaveBeenCalledWith("POST", expect.stringMatching(/^\/api\/rooms\/lobby\/export\?tz=/));
    expect(hrefs).toEqual(["/dl/rooms/lobby?tz=UTC&exp=1&sig=s"]); // a plain link, no blob:
    click.mockRestore();
  });

  it("offers to add a brief and opens the work panel", () => {
    renderWithChat(bar(null));
    expect(screen.getByRole("button", { name: "Додати бриф кімнати" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Робота/ })).toBeInTheDocument();
  });
});

describe("work panel", () => {
  it("shows what each agent of the room does and where, with a link when it works elsewhere", async () => {
    const go = vi.fn();
    const since = new Date(Date.now() - 3 * 60000).toISOString();
    const o = {
      ...overview,
      agents: [
        ...overview.agents.filter((a) => a.name !== "claude"),
        {
          name: "claude",
          kind: "claude",
          online: true,
          rooms: ["lobby"],
          activity: { state: "busy" as const, detail: "Edit", target: "App.tsx", topic: "web", room: "lobby", since },
        },
        {
          name: "bot2",
          kind: "claude",
          online: true,
          rooms: ["lobby", "ops"],
          activity: { state: "waiting" as const, detail: "Claude needs your permission to use Bash", room: "ops", since },
        },
        { name: "bot3", kind: "openai", online: false, rooms: ["lobby"] },
      ],
    };
    renderWithChat(<WorkPanel room="lobby" members={["claude", "bot2", "bot3", "olena"]} onClose={() => {}} />, { overview: o, go });
    const cards = [...document.querySelectorAll(".agent-card")];
    expect(cards.map((c) => c.querySelector(".agent-card-name")!.textContent)).toEqual(["bot2", "claude", "bot3"]);
    const claude = cards[1];
    expect(claude).toHaveTextContent("Працює");
    expect(claude.querySelector(".agent-card-topic")).toHaveTextContent("web");
    expect(claude.querySelector(".agent-card-doing")).toHaveTextContent(/редагує App\.tsx · #lobby · 3 хв/);
    expect(claude.querySelector(".link-btn")).toBeNull(); // it works right here
    expect(cards[0]).toHaveTextContent("дозволу на Bash");
    await userEvent.click(within(cards[0] as HTMLElement).getByRole("button", { name: "#ops" }));
    expect(go).toHaveBeenCalledWith({ kind: "room", room: "ops" });
    expect(cards[2]).toHaveTextContent("Офлайн");
    expect(screen.getByText(/#lobby · 1 працює · 1 чекає/)).toBeInTheDocument();
    // people are not listed, and there is no way to hand out tasks
    expect(screen.queryByText("olena")).toBeNull();
    expect(screen.queryByLabelText(/задач/i)).toBeNull();
  });
});

describe("room brief in the chat", () => {
  it("loads it for a room, opens the work panel and follows live changes", async () => {
    const get = vi.fn(async (path: string) => (path.endsWith("/brief") ? { brief } : { messages: [] }));
    let push: (e: BoardEvent) => void = () => {};
    const subscribeBoard = (fn: (e: BoardEvent) => void) => {
      push = fn;
      return () => {};
    };
    renderWithChat(<ChatView view={{ kind: "room", room: "lobby" }} />, { api: fakeApi({ get }), subscribeBoard });
    expect(await screen.findByRole("button", { name: /Бриф\s*Мета/ })).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith("/api/rooms/lobby/brief");
    expect(get.mock.calls.some(([p]) => String(p).includes("/tasks"))).toBe(false);

    await userEvent.click(screen.getByRole("button", { name: /Робота/ }));
    expect(screen.getByRole("complementary", { name: "Робота" })).toHaveTextContent("Хто що робить");

    push({ kind: "brief", room: "elsewhere", brief: null });
    expect(screen.getByRole("button", { name: /Бриф\s*Мета/ })).toBeInTheDocument();
    push({ kind: "brief", room: "lobby", brief: null });
    expect(await screen.findByRole("button", { name: "Додати бриф кімнати" })).toBeInTheDocument();
  });

  it("has no brief or work panel in direct messages", async () => {
    const get = vi.fn(async (_path: string) => ({ messages: [] }));
    renderWithChat(<ChatView view={{ kind: "dm", a: "claude", b: "olena" }} />, { api: fakeApi({ get }) });
    await waitFor(() => expect(get).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: /Робота/ })).toBeNull();
    expect(get.mock.calls.some(([p]) => String(p).includes("/brief"))).toBe(false);
  });
});
