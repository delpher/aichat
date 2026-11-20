import { test } from "node:test";
import assert from "node:assert/strict";
import { startBroker, tok } from "./helpers.js";
import { VERSION } from "../version.js";

test("the guide for agents is public Markdown with the broker's own addresses and limits, and no secrets (alexey, 1706)", async () => {
  const { broker, http, port } = await startBroker(
    [
      { name: "claude1", kind: "claude" },
      { name: "boss", kind: "human", admin: true },
    ],
    { maxHops: 7 },
  );
  try {
    for (const path of ["/agents.md", "/llms.txt"]) {
      const r = await fetch(`${http}${path}`);
      assert.equal(r.status, 200, path);
      assert.match(r.headers.get("content-type") ?? "", /^text\/markdown; charset=utf-8/);
      const md = await r.text();
      assert.match(md, /^# AIChat: a guide for AI agents\n/);
      assert.ok(md.includes(`Broker version: ${VERSION}.`));
      // addresses as this broker is reached
      assert.ok(md.includes(`ws://127.0.0.1:${port}/ws`));
      assert.ok(md.includes(`http://127.0.0.1:${port}/client/claude-channel.mjs`));
      assert.ok(md.includes(`http://127.0.0.1:${port}/client/opencode-channel.js`));
      assert.ok(md.includes(`Invoke-WebRequest http://127.0.0.1:${port}/client/codex-channel.mjs -OutFile codex-channel.mjs`));
      assert.ok(md.includes("node .\\codex-channel.mjs install --dir"));
      assert.ok(md.includes(`"url": "ws://127.0.0.1:${port}/ws"`)); // the OpenCode plugin wants the /ws address
      assert.match(md, /A reply chain stops after 7 replies/);
      // every way in, and how to get the token
      for (const h of ["## Step 1: get a token from your user", "## A. Claude Code", "## B. Another MCP client", "## C. WebSocket protocol", "## D. HTTP API", "## E. Webhook", "## F. Ready-made bot", "## G. OpenCode: plugin", "## H. Codex: channel adapter"])
        assert.ok(md.includes(h), h);
      // nobody's token
      assert.ok(!md.includes(tok("claude1")) && !md.includes(tok("boss")));
    }
  } finally {
    await broker.close();
  }
});

test("the guide uses publicUrl when it is set", async () => {
  const { broker, http } = await startBroker([{ name: "claude1", kind: "claude" }], { publicUrl: "https://chat.example.org" });
  try {
    const md = await (await fetch(`${http}/agents.md`)).text();
    assert.ok(md.includes("`wss://chat.example.org/ws`"));
    assert.ok(md.includes("https://chat.example.org/client/aichat-hook.mjs"));
  } finally {
    await broker.close();
  }
});
