import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Setup } from "../../api/types";
import { overview, renderWithChat } from "../../test/render";
import { SetupBox } from "./SetupBox";

const setup: Setup = {
  kind: "claude",
  steps: [
    { title: "Підключіть однією командою", code: "curl … install --token 'x'", lang: "bash" },
    { title: "Запустіть Claude Code", code: "claude --dangerously-load-development-channels server:aichat", lang: "bash" },
    { title: "Створіть .mcp.json", code: '{"args":["<AICHAT_DIR>/claude-channel.mjs"]}', lang: "json", manual: true },
  ],
};

describe("SetupBox", () => {
  it("leads with the one-command way and folds the manual steps", () => {
    const { container } = renderWithChat(<SetupBox name="newbot" title="Як запустити newbot" setup={setup} fresh onClose={() => {}} />);
    const quick = container.querySelector(".card > ol.steps")!;
    expect(quick).toHaveTextContent("Підключіть однією командою");
    expect(quick).not.toHaveTextContent(".mcp.json");
    const manual = container.querySelector("details.manual")!;
    expect(manual).not.toHaveAttribute("open");
    expect(manual).toHaveTextContent("Створіть .mcp.json");
    expect(screen.getByText(/лише один раз/)).toBeInTheDocument();
  });

  it("puts a new token on top, apart from the commands, and folds the instructions under it (alexey, 3553)", () => {
    const { container } = renderWithChat(
      <SetupBox name="newbot" title="Як підключити newbot" setup={{ ...setup, token: "tok-123" }} fresh onClose={() => {}} />,
    );
    const top = container.querySelector(".setup-token")!;
    expect(top).toHaveTextContent("Токен агента");
    expect(top).toHaveTextContent("tok-123");
    expect(top.querySelector("button.copy")).toBeInTheDocument();
    expect(top).toHaveTextContent("менеджері агентів");
    const guide = container.querySelector("details.setup-guide")!;
    expect(guide).not.toHaveAttribute("open");
    expect(guide).toHaveTextContent("Підключіть однією командою");
    // the token block comes before the folded instructions
    expect(top.compareDocumentPosition(guide) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("shows the instructions open when asked for again (no token)", () => {
    const { container } = renderWithChat(<SetupBox name="newbot" title="t" setup={setup} fresh={false} onClose={() => {}} />);
    expect(container.querySelector(".setup-token")).toBeNull();
    expect(container.querySelector("details.setup-guide")).toBeNull();
    expect(container.querySelector(".card > ol.steps")).toHaveTextContent("Підключіть однією командою");
  });

  it("waits for the new agent until it connects", () => {
    renderWithChat(<SetupBox name="claude" title="t" setup={setup} fresh={false} onClose={() => {}} />, {
      overview: { ...overview, agents: overview.agents.map((a) => (a.name === "claude" ? { ...a, online: false } : a)) },
    });
    expect(screen.getByRole("status")).toHaveTextContent("Чекаємо, поки claude підключиться");
  });

  it("says connected once the agent is online", () => {
    renderWithChat(<SetupBox name="claude" title="t" setup={setup} fresh={false} onClose={() => {}} />);
    expect(screen.getByRole("status")).toHaveTextContent("claude підключився і зараз онлайн");
  });
});
