import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeApi } from "../../api/http";
import type { BrokerTool } from "../../api/types";
import { ChatContext, type ChatContextValue } from "../../context";
import { hashFor, parseHash } from "../../lib/views";
import { formatSchemaType, ToolsPanel } from "./ToolsPanel";

const SAMPLE_TOOLS: BrokerTool[] = [
  {
    name: "send_message",
    group: "chat",
    description: "Send a message to another agent (to) or to a room (room) on AIChat.",
    inputSchema: {
      type: "object",
      properties: {
        room: { type: "string", description: "Room to post in" },
        text: { type: "string", description: "Message text" },
        attachments: {
          type: "array",
          items: { type: "string" },
          description: "Ids of uploaded files",
        },
      },
      required: ["text"],
    },
  },
  {
    name: "read_history",
    group: "chat",
    description: "Read earlier messages of a room or direct conversation.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "How many messages (default 30)" },
      },
    },
  },
];

function renderTools(responder: () => Promise<Response>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/admin/api/tools")) return responder();
    return new Response("{}", { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  const ctx = {
    api: makeApi("admin-token"),
    fail: vi.fn(),
  } as unknown as ChatContextValue;
  return {
    fetchMock,
    ctx,
    ...render(
      <ChatContext.Provider value={ctx}>
        <ToolsPanel />
      </ChatContext.Provider>,
    ),
  };
}

describe("ToolsPanel", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders broker tools with verbatim descriptions, param counts, and parameters under a details cut", async () => {
    renderTools(async () => new Response(JSON.stringify({ tools: SAMPLE_TOOLS }), { status: 200 }));

    await waitFor(() => expect(screen.getByText("send_message")).toBeInTheDocument());
    expect(screen.getByText("read_history")).toBeInTheDocument();
    expect(screen.getByText("Send a message to another agent (to) or to a room (room) on AIChat.")).toBeInTheDocument();
    expect(screen.getByText("3 параметри · 1 обов'язковий")).toBeInTheDocument();
    expect(screen.getByText("1 параметр")).toBeInTheDocument();

    // Only one group present → no redundant filter bar.
    expect(screen.queryByRole("group", { name: "Фільтр за групою" })).not.toBeInTheDocument();

    // Parameters live inside a collapsed <details> cut by default.
    const summary = screen.getByText("Параметри (3)");
    const details = summary.closest("details")!;
    expect(details).not.toHaveAttribute("open");

    fireEvent.click(summary);
    expect(screen.getByText("attachments")).toBeInTheDocument();
    expect(screen.getByText("string[]")).toBeInTheDocument();
    expect(screen.getByText("Ids of uploaded files")).toBeInTheDocument();
    expect(screen.getByText("обов'язковий")).toBeInTheDocument();
    // Raw JSON projection matches MCP tools/list (name, description, inputSchema; no group).
    const rawPre = details.querySelector(".tool-raw pre code");
    expect(rawPre).toBeTruthy();
    const parsed = JSON.parse(rawPre!.textContent || "{}");
    expect(Object.keys(parsed)).toEqual(["name", "description", "inputSchema"]);
    expect(parsed.name).toBe("send_message");
  });

  it("shows group filter pills when multiple groups exist and handles parameterless tools", async () => {
    const multi: BrokerTool[] = [
      ...SAMPLE_TOOLS,
      {
        name: "list_games",
        group: "games",
        description: "List available games.",
        inputSchema: { type: "object", properties: {} },
      },
    ];
    renderTools(async () => new Response(JSON.stringify({ tools: multi }), { status: 200 }));

    await waitFor(() => expect(screen.getByText("list_games")).toBeInTheDocument());
    expect(screen.getByText("Без параметрів")).toBeInTheDocument();

    const filterGroup = screen.getByRole("group", { name: "Фільтр за групою" });
    expect(filterGroup).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Ігри/ }));
    expect(screen.getByText("list_games")).toBeInTheDocument();
    expect(screen.queryByText("send_message")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Усі/ }));
    expect(screen.getByText("send_message")).toBeInTheDocument();
  });

  it("shows an error banner with retry on failure and recovers on retry", async () => {
    let calls = 0;
    renderTools(async () => {
      calls++;
      if (calls === 1) return new Response(JSON.stringify({ error: "boom" }), { status: 500 });
      return new Response(JSON.stringify({ tools: SAMPLE_TOOLS }), { status: 200 });
    });

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/boom/));
    fireEvent.click(screen.getByRole("button", { name: "Повторити" }));
    await waitFor(() => expect(screen.getByText("send_message")).toBeInTheDocument());
  });

  it("formats schema types cleanly and wires #settings/tools hash routing", () => {
    expect(formatSchemaType({ type: "string" })).toBe("string");
    expect(formatSchemaType({ type: "array", items: { type: "string" } })).toBe("string[]");
    expect(formatSchemaType({ type: "string", enum: ["open", "active"] })).toBe('"open" | "active"');
    expect(formatSchemaType({ type: "array", items: { enum: ["a", "b"] } })).toBe('("a" | "b")[]');
    expect(parseHash("#settings/tools")).toEqual({ kind: "settings", tab: "tools" });
    expect(hashFor({ kind: "settings", tab: "tools" })).toBe("#settings/tools");
  });
});
