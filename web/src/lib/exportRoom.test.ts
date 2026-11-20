import { describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../api/types";
import { adminSession, fakeApi, userSession } from "../test/render";
import { exportFileName, fetchRoomHistory, roomMarkdown, stamp } from "./exportRoom";

const msg = (id: number, over: Partial<ChatMessage> = {}): ChatMessage => ({
  id,
  from: "olena",
  room: "lobby",
  text: `текст ${id}`,
  ts: "2026-11-20T10:05:00Z",
  hops: 0,
  ...over,
});

describe("room export", () => {
  it("reads the whole room page by page back from the newest, oldest first", async () => {
    // 1200 messages: pages of 500 from the newest
    const all = Array.from({ length: 1200 }, (_, i) => msg(i + 1));
    const get = vi.fn(async (path: string) => {
      const q = new URL(path, "http://x").searchParams;
      const before = Number(q.get("before")) || Infinity;
      const older = all.filter((m) => m.id < before);
      return { messages: older.slice(-Number(q.get("limit"))) };
    });
    const got = await fetchRoomHistory(fakeApi({ get }), userSession, "lobby");
    expect(got.map((m) => m.id)).toEqual(all.map((m) => m.id));
    expect(get.mock.calls.map(([p]) => p)).toEqual([
      "/api/history?limit=500&room=lobby",
      "/api/history?limit=500&before=701&room=lobby",
      "/api/history?limit=500&before=201&room=lobby",
    ]);
  });

  it("uses the admin API for an admin", async () => {
    const get = vi.fn(async () => ({ messages: [msg(1)] }));
    await fetchRoomHistory(fakeApi({ get }), adminSession, "dev");
    expect(get).toHaveBeenCalledWith("/admin/api/messages?limit=500&room=dev");
  });

  it("writes a title, the brief and every message with author, time, number, reply and files", () => {
    const now = new Date(2026, 10, 20, 14, 5);
    const md = roomMarkdown(
      "lobby",
      [
        msg(1, { text: "Привіт **всім**" }),
        msg(2, { from: "claude", reply_to: 1, text: "", attachments: [{ id: "f1", name: "plan.png", mime: "image/png", size: 2048 }] }),
      ],
      { room: "lobby", text: "Мета: тест.", by: "alexey", ts: "2026-11-19T09:00:00Z" },
      now,
    );
    expect(md).toContain("# #lobby\n\nЕкспортовано з AIChat 2026-11-20 14:05 · повідомлень: 2");
    expect(md).toContain("## Бриф\n\nМета: тест.\n\n_alexey, ");
    expect(md).toContain(`**olena** · ${stamp("2026-11-20T10:05:00Z")} · #1\n\nПривіт **всім**`);
    expect(md).toContain("**claude** · ");
    expect(md).toContain("#2 · у відповідь на #1\n\n_(без тексту)_\n\n- 📎 plan.png (2 КБ, файл f1)");
    expect(md.endsWith("\n")).toBe(true);
  });

  it("leaves the brief out when there is none and names the file after the room and the time", () => {
    const now = new Date(2026, 10, 20, 9, 7);
    expect(roomMarkdown("dev", [], null, now)).not.toContain("## Бриф");
    expect(exportFileName("dev", now)).toBe("aichat-dev-2026-11-20-0907.md");
  });
});
