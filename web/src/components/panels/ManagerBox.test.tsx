import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeApi } from "../../api/http";
import { ChatContext, type ChatContextValue } from "../../context";
import { ManagerBox, managerInstallCommand } from "./ManagerBox";

function renderBox(responses: { publicUrl?: string; manifest?: unknown; manifestStatus?: number }) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/admin/api/settings")) {
      return new Response(JSON.stringify({ settings: { publicUrl: responses.publicUrl ?? "" } }), { status: 200 });
    }
    if (url.endsWith("/client/manifest.json")) {
      const status = responses.manifestStatus ?? 200;
      return new Response(JSON.stringify(responses.manifest ?? {}), { status });
    }
    return new Response("{}", { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  const ctx = {
    api: makeApi("admin-token"),
    overview: { agents: [], rooms: [], dms: [], all_rooms: [], version: "0.22.0" },
    fail: vi.fn(),
  } as unknown as ChatContextValue;
  return render(
    <ChatContext.Provider value={ctx}>
      <ManagerBox />
    </ChatContext.Provider>,
  );
}

describe("ManagerBox", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows version, SHA-256, safe install command and HTTP warning for http:// broker", async () => {
    renderBox({
      publicUrl: "http://aichat.home:8787/",
      manifest: {
        version: "0.22.1",
        files: { "aichat-manager.mjs": { sha256: "abc123def456", size: 150000 } },
      },
    });
    await waitFor(() => expect(screen.getByText("v0.22.1")).toBeInTheDocument());
    expect(screen.getByText(/Менеджер буде завантажено й запущено з/)).toHaveTextContent("http://aichat.home:8787");
    expect(screen.getByText(/не захищене шифруванням/i)).toBeInTheDocument();
    expect(screen.getByText("abc123def456")).toBeInTheDocument();
    expect(screen.getByText(/Get-FileHash \$t -Algorithm SHA256/)).toBeInTheDocument();
    expect(screen.getByText("%USERPROFILE%\\aichat-agents\\aichat-manager.cmd")).toBeInTheDocument();
  });

  it("omits HTTP warning for https:// broker and escapes single quotes in command", async () => {
    renderBox({
      publicUrl: "https://chat.example.com",
      manifest: { version: "0.22.1", files: { "aichat-manager.mjs": { sha256: "deadbeef", size: 1024 } } },
    });
    await waitFor(() => expect(screen.getByText("v0.22.1")).toBeInTheDocument());
    expect(screen.queryByText(/не захищене шифруванням/i)).not.toBeInTheDocument();
    expect(managerInstallCommand("https://chat.example.com/")).toContain("$b='https://chat.example.com'");
    expect(managerInstallCommand("https://a'b.example")).toContain("$b='https://a''b.example'");
  });
});
