import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { adapterOutdated, adapterText } from "../lib/adapter";
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
});
