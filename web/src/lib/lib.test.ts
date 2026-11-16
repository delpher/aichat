import { describe, expect, it } from "vitest";
import { adminSession, msg, overview, userSession } from "../test/render";
import { fmtDay, fmtSize, hueFor, initials, plural } from "./format";
import { atHopLimit, buildThreads, threadOf } from "./threads";
import { applyFormat } from "./markdownEdit";
import { dm, gameIdOfRoom, hashFor, historyPath, matchesView, parseHash, resolveView, viewKey } from "./views";

describe("views", () => {
  it("round-trips views through the hash", () => {
    for (const v of [{ kind: "room", room: "dev-team" }, dm("b", "a"), { kind: "settings" }, { kind: "all" }] as const)
      expect(parseHash(hashFor(v))).toEqual(v);
    expect(parseHash("#dm/zed/amy")).toEqual({ kind: "dm", a: "amy", b: "zed" });
    expect(parseHash("#nonsense")).toBeNull();
    expect(parseHash("#room/%E0%A4%A")).toBeNull();
  });

  it("keeps people inside their own rooms and DMs", () => {
    expect(resolveView({ kind: "room", room: "secret" }, userSession, overview)).toEqual({ kind: "room", room: "lobby" });
    expect(resolveView(dm("x", "y"), userSession, overview)).toEqual({ kind: "room", room: "lobby" });
    expect(resolveView(dm("olena", "claude"), userSession, overview)).toEqual(dm("olena", "claude"));
    expect(resolveView({ kind: "settings" }, userSession, overview)).toEqual({ kind: "room", room: "lobby" });
    expect(resolveView(null, userSession, { ...overview, rooms: [] })).toEqual({ kind: "none" });
    expect(resolveView({ kind: "room", room: "secret" }, adminSession, overview)).toEqual({ kind: "room", room: "secret" });
    expect(resolveView(null, adminSession, overview)).toEqual({ kind: "all" });
  });

  it("matches live messages to views", () => {
    expect(matchesView(msg({ id: 1 }), { kind: "room", room: "lobby" })).toBe(true);
    expect(matchesView(msg({ id: 1, room: undefined, to: "olena" }), dm("olena", "claude"))).toBe(true);
    expect(matchesView(msg({ id: 1, room: undefined, to: "alexey" }), dm("olena", "claude"))).toBe(false);
    expect(viewKey(dm("b", "a"))).toBe("d:a|b");
  });

  it("builds history paths per mode", () => {
    expect(historyPath(dm("claude", "olena"), userSession, 100)).toBe("/api/history?limit=100&with=claude");
    expect(historyPath({ kind: "room", room: "lobby" }, adminSession, 50, 7)).toBe("/admin/api/messages?limit=50&before=7&room=lobby");
  });
});

describe("applyFormat", () => {
  it("wraps the selection and unwraps it again", () => {
    const r = applyFormat("bold", "say hi now", 4, 6);
    expect(r).toEqual({ text: "say **hi** now", start: 6, end: 8 });
    expect(applyFormat("bold", r.text, r.start, r.end).text).toBe("say hi now");
  });
  it("inserts a placeholder without a selection", () => {
    const r = applyFormat("code", "x ", 2, 2);
    expect(r.text).toBe("x `код`");
    expect(r.text.slice(r.start, r.end)).toBe("код");
  });
  it("makes links with the URL selected", () => {
    const r = applyFormat("link", "see docs", 4, 8);
    expect(r.text).toBe("see [docs](https://)");
    expect(r.text.slice(r.start, r.end)).toBe("https://");
  });
  it("prefixes and un-prefixes whole lines", () => {
    const r = applyFormat("numbered", "one\ntwo", 1, 5);
    expect(r.text).toBe("1. one\n2. two");
    expect(applyFormat("numbered", r.text, 0, r.text.length).text).toBe("one\ntwo");
    expect(applyFormat("quote", "a", 0, 0).text).toBe("> a");
  });
  it("puts code blocks on their own lines", () => {
    expect(applyFormat("codeblock", "before", 6, 6).text).toBe("before\n```\nкод\n```");
  });
});

describe("format", () => {
  it("formats sizes, initials, days and colours", () => {
    expect(fmtSize(512)).toBe("512 Б");
    expect(fmtSize(1536)).toBe("1.5 КБ");
    expect(fmtSize(5 * 1024 * 1024)).toBe("5.0 МБ");
    expect(initials("claude-alexey")).toBe("CA");
    expect(initials("qhukz")).toBe("QH");
    const now = new Date("2026-11-15T12:00:00");
    expect(fmtDay("2026-11-15T08:00:00", now)).toBe("Сьогодні");
    expect(fmtDay("2026-11-14T08:00:00", now)).toBe("Вчора");
    expect(hueFor("a")).toBe(hueFor("a"));
  });
});

describe("game rooms", () => {
  it("routes game-room messages to the game view", () => {
    const m = { id: 1, from: "aichat", room: "game-4", text: "x", ts: "", hops: 0 };
    expect(gameIdOfRoom("game-4")).toBe(4);
    expect(gameIdOfRoom("lobby")).toBeNull();
    expect(matchesView(m, { kind: "game", id: 4 })).toBe(true);
    expect(matchesView(m, { kind: "game", id: 5 })).toBe(false);
  });
});

describe("threads", () => {
  it("groups reply chains under their first loaded message", () => {
    const list = [
      msg({ id: 1, from: "olena", text: "plan?" }),
      msg({ id: 2, from: "claude", text: "draft", reply_to: 1, hops: 1 }),
      msg({ id: 3, from: "olena", text: "unrelated" }),
      msg({ id: 4, from: "bot", text: "review", reply_to: 2, hops: 2 }),
      msg({ id: 5, from: "claude", text: "fixed", reply_to: 4, hops: 3 }),
      msg({ id: 6, from: "bot", text: "to an old one", reply_to: 99, hops: 4 }),
    ];
    const t = buildThreads(list);
    expect(t.rootOf.get(5)).toBe(1);
    expect(t.rootOf.get(3)).toBe(3);
    expect(t.rootOf.get(6)).toBe(6); // parent not loaded: starts its own thread
    expect([...t.byRoot.keys()]).toEqual([1]);
    const th = t.byRoot.get(1)!;
    expect(th.replies.map((m) => m.id)).toEqual([2, 4, 5]);
    expect(th.participants).toEqual(["claude", "bot"]);
    expect(th.last.id).toBe(5);
    expect(threadOf(t, 4)).toBe(th);
    expect(threadOf(t, 3)).toBeUndefined();
  });

  it("marks messages that reached the hop limit, except in game rooms", () => {
    expect(atHopLimit(msg({ id: 1, hops: 8 }), 8)).toBe(true);
    expect(atHopLimit(msg({ id: 1, hops: 7 }), 8)).toBe(false);
    expect(atHopLimit(msg({ id: 1, hops: 9, room: "game-3" }), 8)).toBe(false);
    expect(atHopLimit(msg({ id: 1, hops: 9 }), undefined)).toBe(false);
  });

  it("picks Ukrainian plural forms", () => {
    const f: [string, string, string] = ["відповідь", "відповіді", "відповідей"];
    expect([1, 2, 5, 11, 12, 21, 22, 25, 111].map((n) => plural(n, f))).toEqual([
      "відповідь",
      "відповіді",
      "відповідей",
      "відповідей",
      "відповідей",
      "відповідь",
      "відповіді",
      "відповідей",
      "відповідей",
    ]);
  });
});
