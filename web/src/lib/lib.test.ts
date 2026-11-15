import { describe, expect, it } from "vitest";
import { adminSession, msg, overview, userSession } from "../test/render";
import { fmtDay, fmtSize, hueFor, initials } from "./format";
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
