import { test } from "node:test";
import assert from "node:assert/strict";
import { validate } from "../broker/config.js";
import { accountHash } from "../usage.js";
import { connect, startBroker, tok } from "./helpers.js";
import type { ServerFrame, UsageReport } from "../protocol.js";

function api(http: string, who: string) {
  return async <T = Record<string, unknown>>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> => {
    const r = await fetch(`${http}${path}`, {
      method,
      headers: { authorization: `Bearer ${tok(who)}`, "content-type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: r.status, data: (await r.json()) as T };
  };
}

const OLENA = accountHash("olena@example.com");
const PEOPLE = [
  { name: "boss", kind: "human", admin: true },
  { name: "olena", kind: "human" },
  { name: "petro", kind: "human" },
  { name: "bot", kind: "claude" },
  { name: "bot2", kind: "claude" },
];

const report = (account?: string, pct = 40) => ({
  provider: "anthropic",
  ...(account ? { account } : {}),
  windows: [
    { name: "five_hour", usedPct: pct, resetsAt: "2026-11-19T17:00:00Z" },
    { name: "seven_day", usedPct: 15 },
  ],
  session: { tokensIn: 1200, tokensOut: 300, cost: 0.42, currency: "USD" },
  context: { usedPct: 62 },
});

test("an account is named by a hash of its address, the same whatever the case and spaces", () => {
  assert.match(OLENA, /^[0-9a-f]{64}$/);
  assert.equal(accountHash("  Olena@Example.COM "), OLENA);
  assert.notEqual(accountHash("petro@example.com"), OLENA);
});

test("config: only people name accounts, as hashes, at most five", () => {
  const person = (accounts: unknown, kind = "human") => ({ agents: [{ name: "p", kind, token: tok("p"), accounts }] }) as never;
  assert.ok(validate(person([OLENA])));
  assert.throws(() => validate(person(["olena@example.com"])), /list of account hashes/);
  assert.throws(() => validate(person([OLENA], "claude")), /only people name their accounts/);
  assert.throws(() => validate(person(Array.from({ length: 6 }, (_, i) => accountHash(`a${i}@x.io`)))), /at most 5 accounts/);
});

test("a person sees the usage of agents on their account, an admin sees all, an agent its own", async () => {
  const { broker, http, cfg } = await startBroker(PEOPLE);
  try {
    const olena = api(http, "olena");
    assert.equal((await olena("GET", "/api/me")).data.accounts, 0);
    const set = await olena("PUT", "/api/me/accounts", { emails: ["Olena@example.com"] });
    assert.equal(set.status, 200);
    assert.equal(set.data.accounts, 1);
    assert.deepEqual(cfg().agents.find((a) => a.name === "olena")?.accounts, [OLENA]); // the hash, never the address
    assert.equal((await olena("GET", "/api/me")).data.accounts, 1);

    const posted = await api(http, "bot")<{ usage: UsageReport }>("POST", "/api/usage", report(OLENA));
    assert.equal(posted.status, 200);
    assert.equal(posted.data.usage.agent, "bot");
    assert.equal(posted.data.usage.windows[0].resetsAt, "2026-11-19T17:00:00.000Z");
    await api(http, "bot2")("POST", "/api/usage", report(accountHash("someone@else.io"), 90));

    const seen = async (who: string) =>
      (await api(http, who)<{ usage: UsageReport[] }>("GET", "/api/usage")).data.usage.map((r) => r.agent).sort();
    assert.deepEqual(await seen("olena"), ["bot"]);
    // a person gets the hashes of their own accounts back, to tell their agents from others (an admin sees all)
    assert.deepEqual((await olena("GET", "/api/usage")).data.accounts, [OLENA]);
    assert.equal((await api(http, "bot")("GET", "/api/usage")).data.accounts, undefined);
    assert.deepEqual(await seen("petro"), []);
    assert.deepEqual(await seen("boss"), ["bot", "bot2"]);
    assert.deepEqual(await seen("bot2"), ["bot2"]);

    // a newer report replaces the older one; removing one's accounts hides the reports again
    await api(http, "bot")("POST", "/api/usage", report(OLENA, 55));
    const mine = (await olena<{ usage: UsageReport[] }>("GET", "/api/usage")).data.usage;
    assert.equal(mine.length, 1);
    assert.equal(mine[0].windows[0].usedPct, 55);
    assert.equal((await olena("PUT", "/api/me/accounts", { emails: [] })).data.accounts, 0);
    assert.equal(cfg().agents.find((a) => a.name === "olena")?.accounts, undefined);
    assert.deepEqual(await seen("olena"), []);

    // a removed agent's report goes with it
    assert.equal((await api(http, "boss")("DELETE", "/admin/api/agents/bot")).status, 200);
    assert.deepEqual(await seen("boss"), ["bot2"]);
  } finally {
    await broker.close();
  }
});

test("a usage report reaches the account's owner and the agent live, and nobody else", async () => {
  const { broker, url, http } = await startBroker(PEOPLE);
  try {
    await api(http, "olena")("PUT", "/api/me/accounts", { emails: ["olena@example.com"] });
    const frames = new Map<string, ServerFrame[]>();
    const clients = await Promise.all(
      ["olena", "petro", "bot"].map(async (name) => {
        const c = await connect(url, name);
        const got: ServerFrame[] = [];
        // BrokerClient only emits messages and presence: read the raw frames
        (c as unknown as { ws: { on: (e: string, f: (d: unknown) => void) => void } }).ws.on("message", (d) => got.push(JSON.parse(String(d))));
        frames.set(name, got);
        return c;
      }),
    );
    await api(http, "bot")("POST", "/api/usage", report(OLENA));
    const usage = (name: string) => frames.get(name)!.filter((f) => f.type === "usage");
    for (let i = 0; i < 50 && (usage("olena").length < 1 || usage("bot").length < 1); i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(usage("olena").length, 1);
    assert.equal(usage("bot").length, 1);
    assert.equal(usage("petro").length, 0);
    for (const c of clients) c.close();
  } finally {
    await broker.close();
  }
});

test("usage reports are checked: no addresses, sane numbers, and only agents send them", async () => {
  const { broker, http } = await startBroker(PEOPLE);
  try {
    const bot = api(http, "bot");
    const bad = async (body: unknown, re: RegExp) => {
      const r = await bot<{ error: string }>("POST", "/api/usage", body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.match(r.data.error, re);
    };
    await bad({ ...report(), provider: "Anthropic Inc" }, /provider/);
    await bad({ ...report(), account: "olena@example.com" }, /never an address/);
    await bad({ ...report(), windows: [{ name: "five_hour", usedPct: 140 }] }, /0 to 100/);
    await bad({ ...report(), windows: [{ name: "a", usedPct: 1 }, { name: "a", usedPct: 2 }] }, /given twice/);
    await bad({ ...report(), windows: [{ name: "a", usedPct: 1, resetsAt: "soon" }] }, /ISO time/);
    await bad({ ...report(), session: { tokensIn: -1 } }, /whole number/);
    await bad({ ...report(), session: { cost: 1 } }, /currency/);
    await bad({ ...report(), context: { usedPct: "62" } }, /0 to 100/);

    // what a newer adapter adds is left out, not refused; an account is optional
    const r = await bot<{ usage: UsageReport }>("POST", "/api/usage", { provider: "openai", windows: [], extra: 1 });
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.data.usage).sort(), ["agent", "at", "provider", "windows"]);

    assert.equal((await api(http, "olena")("POST", "/api/usage", report())).status, 403);
    assert.equal((await bot("PUT", "/api/me/accounts", { emails: ["bot@example.com"] })).status, 403);
    const olena = api(http, "olena");
    assert.equal((await olena("PUT", "/api/me/accounts", { emails: ["not an address"] })).status, 400);
    assert.equal((await olena("PUT", "/api/me/accounts", { emails: "olena@example.com" })).status, 400);
  } finally {
    await broker.close();
  }
});
