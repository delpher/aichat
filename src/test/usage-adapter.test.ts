import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { accountEmail, MAX_GAP_MS, MIN_GAP_MS, shortLine, shouldSend, usageFromStatus } from "../adapters/usage-report.js";
import { installStatusLine } from "../adapters/install.js";
import { accountHash } from "../usage.js";
import { startBroker, tok } from "./helpers.js";
import type { UsageReport } from "../protocol.js";

/** What Claude Code gives a status line on a subscription, cut to the fields that matter here. */
const STATUS = {
  cwd: "/work/bot",
  workspace: { project_dir: "/work/bot", current_dir: "/work/bot" },
  cost: { total_cost_usd: 0.4213, total_duration_ms: 60000 },
  context_window: { total_input_tokens: 15234, total_output_tokens: 4521, context_window_size: 200000, used_percentage: 62.4 },
  rate_limits: {
    five_hour: { used_percentage: 23.5, resets_at: 1763571600 },
    seven_day: { used_percentage: 41.2, resets_at: 1764000000 },
  },
};

test("Claude Code's status line JSON becomes a provider-neutral usage report", () => {
  const b = usageFromStatus(STATUS, "Olena@example.com");
  assert.deepEqual(b, {
    provider: "anthropic",
    account: accountHash("olena@example.com"),
    windows: [
      { name: "five_hour", usedPct: 23.5, resetsAt: new Date(1763571600 * 1000).toISOString() },
      { name: "seven_day", usedPct: 41.2, resetsAt: new Date(1764000000 * 1000).toISOString() },
    ],
    // the context_window token counts are the last request's, not the session's: only the cost is a session total
    session: { cost: 0.4213, currency: "USD" },
    context: { usedPct: 62.4 },
  });
  assert.equal(shortLine(b), "AIChat · 5h 24% · 7d 41% · ctx 62%");

  // an API key: no limits, no account; early in a session the context is not known yet
  const early = usageFromStatus({ context_window: { total_input_tokens: 0, total_output_tokens: 0, used_percentage: null } });
  assert.deepEqual(early, { provider: "anthropic", windows: [] });
  assert.equal(shortLine(early), "AIChat");
});

test("the account's address is read from Claude Code's .claude.json, in CLAUDE_CONFIG_DIR or at home", () => {
  const home = mkdtempSync(join(tmpdir(), "aichat-home-"));
  const profile = mkdtempSync(join(tmpdir(), "aichat-profile-"));
  try {
    assert.equal(accountEmail({}, home), undefined);
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "home@example.com", accountUuid: "x" } }));
    assert.equal(accountEmail({}, home), "home@example.com");
    writeFileSync(join(profile, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "work@example.com" } }));
    assert.equal(accountEmail({ CLAUDE_CONFIG_DIR: profile }, home), "work@example.com");
    writeFileSync(join(profile, ".claude.json"), "{ broken");
    assert.equal(accountEmail({ CLAUDE_CONFIG_DIR: profile }, home), "home@example.com");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(profile, { recursive: true, force: true });
  }
});

test("a report is sent when something changed, but not more often than every 15 s, and at least every 5 min", () => {
  const b = usageFromStatus(STATUS);
  const sig = JSON.stringify(b);
  assert.equal(shouldSend(b, undefined, 1000), true);
  assert.equal(shouldSend(b, { sig: "old", at: 0 }, MIN_GAP_MS - 1), false);
  assert.equal(shouldSend(b, { sig: "old", at: 0 }, MIN_GAP_MS), true);
  assert.equal(shouldSend(b, { sig, at: 0 }, MIN_GAP_MS), false);
  assert.equal(shouldSend(b, { sig, at: 0 }, MAX_GAP_MS), true);
});

test("install sets the usage status line and keeps the person's own one behind a pipe, once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aichat-statusline-"));
  try {
    const hook = "C:\\aichat\\aichat-hook.mjs";
    const local = () => JSON.parse(readFileSync(join(dir, ".claude", "settings.local.json"), "utf8"));
    // nobody has a status line: the hook prints its own
    let r = await installStatusLine({ dir, hook, userSettings: join(dir, "no-such.json") });
    assert.equal(r.theirs, undefined);
    assert.deepEqual(local().statusLine, { type: "command", command: 'node "C:/aichat/aichat-hook.mjs" statusline --line' });

    // the person's own status line, with its padding, sits behind the hook; other settings stay
    const user = join(dir, "user-settings.json");
    writeFileSync(user, JSON.stringify({ statusLine: { type: "command", command: "bash ~/statusline.sh", padding: 1 } }));
    writeFileSync(join(dir, ".claude", "settings.local.json"), JSON.stringify({ permissions: { allow: ["Bash(ls)"] } }));
    r = await installStatusLine({ dir, hook, userSettings: user });
    assert.equal(r.theirs, "bash ~/statusline.sh");
    assert.deepEqual(local().permissions, { allow: ["Bash(ls)"] });
    assert.deepEqual(local().statusLine, {
      type: "command",
      command: 'node "C:/aichat/aichat-hook.mjs" statusline | bash ~/statusline.sh',
      padding: 1,
    });

    // again (say, with the adapter in a new folder): the hook is replaced, not wrapped twice
    r = await installStatusLine({ dir, hook: "/opt/aichat/aichat-hook.mjs", userSettings: user });
    assert.equal(local().statusLine.command, 'node "/opt/aichat/aichat-hook.mjs" statusline | bash ~/statusline.sh');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the status line command passes the JSON on and reports the usage to the broker", async () => {
  const { broker, http, url } = await startBroker([{ name: "bot", kind: "claude" }, { name: "boss", kind: "human", admin: true }]);
  const hook = fileURLToPath(new URL("../adapters/aichat-hook.js", import.meta.url));
  const tmp = mkdtempSync(join(tmpdir(), "aichat-sl-"));
  const profile = join(tmp, "profile");
  mkdirSync(profile);
  writeFileSync(join(profile, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "bot-owner@example.com" } }));
  const env = { ...process.env, AICHAT_URL: url, AICHAT_TOKEN: tok("bot"), CLAUDE_CONFIG_DIR: profile, TMPDIR: tmp, TEMP: tmp, TMP: tmp };
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [hook, "statusline", ...args], { input: JSON.stringify(STATUS), encoding: "utf8", env });
  const reports = async () =>
    (
      (await (await fetch(`${http}/api/usage`, { headers: { authorization: `Bearer ${tok("boss")}` } })).json()) as {
        usage: UsageReport[];
      }
    ).usage;
  try {
    let r = run();
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, JSON.stringify(STATUS)); // unchanged, for the person's own status line behind the pipe
    let got = await reports();
    assert.equal(got.length, 1);
    assert.equal(got[0].agent, "bot");
    assert.equal(got[0].account, accountHash("bot-owner@example.com"));
    assert.deepEqual(got[0].windows.map((w) => [w.name, w.usedPct]), [["five_hour", 23.5], ["seven_day", 41.2]]);

    // right after, nothing new is sent; --line prints its own line instead of the JSON
    const at = got[0].at;
    r = run("--line");
    assert.equal(r.stdout.trim(), "AIChat · 5h 24% · 7d 41% · ctx 62%");
    got = await reports();
    assert.equal(got[0].at, at);
  } finally {
    await broker.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});
