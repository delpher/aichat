import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { adapterOutdated, adapterText, startText, surfaceText } from "../lib/adapter";
import { overview, renderWithChat } from "../test/render";
import { Sidebar } from "./Sidebar";

const props = {
  unread: new Map<string, number>(),
  conn: { status: "online" as const, retryIn: 0 },
  theme: "system" as const,
  onTheme: () => {},
  onLogout: () => {},
  onJoin: () => {},
  onSearch: () => {},
};

describe("adapter versions", () => {
  it("compares an adapter with the broker", () => {
    const a = { name: "claude-channel", version: "0.3.0" };
    expect(adapterOutdated(a, "0.4.0")).toBe(true);
    expect(adapterOutdated(a, "0.3.0")).toBe(false);
    expect(adapterOutdated(undefined, "0.4.0")).toBe(false);
    expect(adapterText(a, "0.4.0")).toBe("адаптер claude-channel 0.3.0: застарів, на брокері 0.4.0");
    expect(adapterText(a, "0.3.0")).toBe("адаптер claude-channel 0.3.0");
    expect(adapterText(undefined, "0.3.0")).toBe("");
  });

  it("does not compare an adapter the broker does not serve with the broker", () => {
    const own = { name: "my-adapter", version: "0.1.0" };
    expect(adapterOutdated(own, "0.9.0")).toBe(false);
    expect(adapterText(own, "0.9.0")).toBe("адаптер my-adapter 0.1.0");
  });

  it("compares the OpenCode plugin with the broker, since the broker serves it too", () => {
    const oc = { name: "opencode-channel", version: "0.9.0" };
    expect(adapterOutdated(oc, "0.10.0")).toBe(true);
    expect(adapterOutdated(oc, "0.9.0")).toBe(false);
  });

  it("compares the Codex channel with the broker, since the broker serves it too", () => {
    const codex = { name: "codex-channel", version: "0.11.1" };
    expect(adapterOutdated(codex, "0.12.0")).toBe(true);
    expect(adapterOutdated(codex, "0.11.1")).toBe(false);
  });

  it("compares the Antigravity channel with the broker, since the broker serves it too", () => {
    const agy = { name: "agy-channel", version: "0.13.0" };
    expect(adapterOutdated(agy, "0.14.0")).toBe(true);
    expect(adapterOutdated(agy, "0.13.0")).toBe(false);
  });

  it("marks an online agent on an older adapter in the sidebar and names the version in its tooltip", () => {
    renderWithChat(<Sidebar {...props} />, {
      overview: {
        ...overview,
        version: "0.4.0",
        agents: overview.agents.map((a) => (a.name === "claude" ? { ...a, adapter: { name: "claude-channel", version: "0.3.0" } } : a)),
      },
    });
    expect(screen.getByText("старий адаптер")).toBeInTheDocument();
    expect(screen.getByTitle(/адаптер claude-channel 0\.3\.0: застарів, на брокері 0\.4\.0/)).toBeInTheDocument();
  });

  it("formats adapter surface and session start when reported, and omits them for legacy adapters", () => {
    expect(surfaceText("server")).toBe("сервер, без термінала");
    expect(surfaceText("server", true)).toBe("сервер");
    expect(surfaceText("terminal")).toBe("у терміналі");
    expect(surfaceText(undefined)).toBe("");
    expect(startText("resumed")).toBe("продовжена сесія");
    expect(startText("new")).toBe("нова сесія");
    expect(startText(undefined)).toBe("");
    expect(adapterText({ name: "opencode-channel", version: "0.21.0", surface: "server", start: "resumed" }, "0.21.0")).toBe(
      "адаптер opencode-channel 0.21.0 · сервер, без термінала · продовжена сесія",
    );
    expect(adapterText({ name: "agy-channel", version: "0.20.0", surface: "terminal", start: "new" }, "0.21.0")).toBe(
      "адаптер agy-channel 0.20.0: застарів, на брокері 0.21.0 · у терміналі · нова сесія",
    );
  });

  it("marks a server-hosted online agent in the sidebar without marking terminal or offline agents", () => {
    renderWithChat(<Sidebar {...props} />, {
      overview: {
        ...overview,
        version: "0.21.0",
        agents: [
          ...overview.agents.map((a) =>
            a.name === "claude" ? { ...a, adapter: { name: "claude-channel", version: "0.21.0", surface: "terminal" as const, start: "new" as const } } : a,
          ),
          {
            name: "opencode",
            kind: "opencode",
            online: true,
            rooms: ["lobby"],
            adapter: { name: "opencode-channel", version: "0.21.0", surface: "server" as const, start: "resumed" as const },
          },
          {
            name: "off-opencode",
            kind: "opencode",
            online: false,
            rooms: ["lobby"],
            adapter: { name: "opencode-channel", version: "0.21.0", surface: "server" as const },
          },
        ],
      },
    });
    const oc = screen.getByRole("button", { name: /^opencode/ });
    expect(oc.querySelector(".nav-sub")).toHaveTextContent("OpenCode · сервер");
    expect(oc.getAttribute("title")).toContain("адаптер opencode-channel 0.21.0 · сервер, без термінала · продовжена сесія");

    const claude = screen.getByRole("button", { name: /^claude/ });
    expect(claude.querySelector(".nav-sub")).not.toHaveTextContent("сервер");
    expect(claude.getAttribute("title")).toContain("у терміналі · нова сесія");

    const ocOff = screen.getByRole("button", { name: /^off-opencode/ });
    expect(ocOff.querySelector(".nav-sub")).toHaveTextContent("OpenCode · офлайн");
    expect(ocOff.querySelector(".nav-sub")).not.toHaveTextContent("сервер");
  });
});
