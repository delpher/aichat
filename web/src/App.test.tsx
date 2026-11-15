import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

/** A fake broker: REST answers by path, and a WebSocket that welcomes and can push frames. */
class FakeSocket {
  static last: FakeSocket | null = null;
  onopen?: () => void;
  onmessage?: (e: { data: string }) => void;
  onclose?: (e: { code: number; reason: string }) => void;
  sent: unknown[] = [];
  constructor() {
    FakeSocket.last = this;
    setTimeout(() => this.onopen?.(), 0);
  }
  send(d: string) {
    const f = JSON.parse(d);
    this.sent.push(f);
    if (f.type === "auth") setTimeout(() => this.push({ type: "welcome", agent: "olena", rooms: ["lobby"] }), 0);
  }
  push(f: unknown) {
    this.onmessage?.({ data: JSON.stringify(f) });
  }
  close() {}
}

const overview = {
  me: { name: "olena", kind: "human" },
  agents: [
    { name: "olena", kind: "human", online: true, rooms: ["lobby"] },
    { name: "claude", kind: "claude", online: false, rooms: ["lobby"] },
  ],
  rooms: [{ name: "lobby", members: ["claude", "olena"], count: 1, last_ts: "2026-11-15T09:00:00Z" }],
  dms: [],
  all_rooms: ["lobby"],
};

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  location.hash = "";
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string>)?.Authorization;
      if (auth !== "Bearer good-token") return json(401, { error: "invalid token" });
      if (path === "/admin/api/overview") return json(401, { error: "not an admin" });
      if (path === "/api/overview") return json(200, overview);
      if (path.startsWith("/api/history"))
        return json(200, { messages: [{ id: 1, from: "claude", room: "lobby", text: "Привіт, **olena**", ts: "2026-11-15T09:00:00Z", hops: 0 }] });
      return json(404, { error: "not found" });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

describe("App", () => {
  it("rejects a bad token, then logs in as a person and shows live messages", async () => {
    render(<App />);
    const input = await screen.findByPlaceholderText("ваш особистий токен");
    await userEvent.type(input, "bad-token");
    await userEvent.click(screen.getByRole("button", { name: /Увійти/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Невірний токен.");

    await userEvent.clear(input);
    await userEvent.type(input, "good-token");
    await userEvent.click(screen.getByRole("button", { name: /Увійти/ }));
    expect(await screen.findByText("olena", { selector: "strong" })).toBeInTheDocument();
    expect(location.hash).toBe("#room/lobby");
    expect(localStorage.getItem("aichat.token")).toBe("good-token");

    await waitFor(() => expect(FakeSocket.last?.sent[0]).toEqual({ type: "auth", token: "good-token" }));
    FakeSocket.last!.push({ type: "message", message: { id: 2, from: "claude", room: "lobby", text: "live one", ts: "2026-11-15T09:01:00Z", hops: 0 } });
    expect(await screen.findByText("live one")).toBeInTheDocument();
    expect(screen.getByText("olena", { selector: "strong" })).toBeInTheDocument(); // history kept
    // a live message must not refetch the open conversation
    const historyCalls = () => vi.mocked(fetch).mock.calls.filter(([p]) => String(p).startsWith("/api/history")).length;
    await new Promise((r) => setTimeout(r, 50));
    expect(historyCalls()).toBe(1);

    // presence updates the sidebar dot
    FakeSocket.last!.push({ type: "presence", agent: "claude", online: true });
    await waitFor(() => expect(document.querySelectorAll(".presence.on").length).toBe(2));

    await userEvent.click(screen.getByLabelText("Вийти"));
    expect(await screen.findByPlaceholderText("ваш особистий токен")).toBeInTheDocument();
    expect(localStorage.getItem("aichat.token")).toBeNull();
  });
});
