// Tests of core/instructions.mjs: fetching the broker's rules and composing what a model is told.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { LOCAL_HEADING, RUNTIME_HEADING, composeInstructions, fetchInstructions, rulesVersion, selfText } from "./instructions.mjs";

async function serve(handler) {
  const server = createServer(handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

const rules = { text: "# Rules\n- reply_to", by: "aichat", ts: "1970-01-01T00:00:00.000Z", draft: true };

test("fetchInstructions: the rules and who the agent is, with the token; null for an older broker or a bad answer", async () => {
  let auth;
  const ok = await serve((req, res) => {
    auth = req.headers.authorization;
    res.writeHead(req.url === "/api/instructions" ? 200 : 404, { "content-type": "application/json" });
    res.end(JSON.stringify({ rules, self: { name: "bot", description: "Тест." } }));
  });
  try {
    assert.deepEqual(await fetchInstructions({ httpBase: ok.base + "/", token: "t0ken" }), { rules, self: { name: "bot", description: "Тест." } });
    assert.equal(auth, "Bearer t0ken");
  } finally {
    await ok.close();
  }
  for (const [status, body] of [
    [404, { error: "not found" }],
    [200, { rules: { text: "  " }, self: { name: "bot" } }],
    [200, { rules, self: {} }],
    [200, "not json"],
  ]) {
    const s = await serve((_req, res) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(typeof body === "string" ? body : JSON.stringify(body));
    });
    try {
      assert.equal(await fetchInstructions({ httpBase: s.base, token: "t" }), null, JSON.stringify(body));
    } finally {
      await s.close();
    }
  }
  // nothing listening, and a broker that does not answer in time
  assert.equal(await fetchInstructions({ httpBase: "http://127.0.0.1:1", token: "t" }), null);
  const slow = await serve(() => {});
  try {
    assert.equal(await fetchInstructions({ httpBase: slow.base, token: "t", timeoutMs: 100 }), null);
  } finally {
    slow.closeAllConnections?.();
    await Promise.race([slow.close(), new Promise((r) => setTimeout(r, 200))]);
  }
});

test("composeInstructions: the broker's rules, who the agent is, the runtime, notices, the owner's rules last", () => {
  const fetched = { rules: { text: "# Rules\n- reply_to", by: "alexey", ts: "2026-11-28T10:00:00.000Z" }, self: { name: "bot" } };
  const { text, parts } = composeInstructions({ fetched, runtime: "Messages arrive as frames.", notices: ["Update me."], local: "Only work in D:\\x." });
  assert.equal(
    text,
    `# Rules\n- reply_to\n\nYou are bot on AIChat.\n\n${RUNTIME_HEADING}\nMessages arrive as frames.\n\nUpdate me.\n\n${LOCAL_HEADING}\nOnly work in D:\\x.`,
  );
  assert.deepEqual(parts, [{ source: "broker", version: "2026-11-28T10:00:00.000Z, by alexey" }, { source: "adapter" }, { source: "local" }]);
  // without local rules there is no empty heading
  assert.doesNotMatch(composeInstructions({ fetched, runtime: "r" }).text, /Local rules/);
});

test("composeInstructions: an older broker gets the adapter's own text in place of the rules", () => {
  const { text, parts } = composeInstructions({ fetched: null, runtime: "Runtime.", fallback: "The old instructions.", local: "Mine." });
  assert.equal(text, `The old instructions.\n\nRuntime.\n\n${LOCAL_HEADING}\nMine.`);
  assert.deepEqual(parts.map((p) => p.source), ["fallback", "adapter", "local"]);
});

test("rulesVersion and selfText", () => {
  assert.equal(rulesVersion(rules), "the broker's built-in draft");
  assert.equal(selfText({ name: "a", description: "Агент." }), "You are a on AIChat.\nAn AIChat admin wrote about you: Агент.");
});
