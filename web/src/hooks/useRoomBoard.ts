import { useCallback, useEffect, useState } from "react";
import type { RoomBrief } from "../api/types";
import { useChat } from "../context";

const enc = encodeURIComponent;

/** A room's brief, kept live through the socket. `room` null: nothing to load (not a plain room). */
export function useRoomBoard(room: string | null) {
  const { api, subscribeBoard, fail } = useChat();
  const [brief, setBriefState] = useState<RoomBrief | null>(null);

  useEffect(() => {
    if (!room) return;
    let live = true;
    setBriefState(null);
    api
      .get<{ brief: RoomBrief | null }>(`/api/rooms/${enc(room)}/brief`)
      .then((b) => live && setBriefState(b.brief))
      .catch((e) => live && fail(e, "Бриф кімнати"));
    const off = subscribeBoard((e) => {
      if (e.room === room) setBriefState(e.brief);
    });
    return () => {
      live = false;
      off();
    };
  }, [room, api, subscribeBoard, fail]);

  const saveBrief = useCallback(
    async (text: string) => {
      const d = await api.send<{ brief: RoomBrief | null }>("PUT", `/api/rooms/${enc(room!)}/brief`, { text });
      setBriefState(d.brief);
    },
    [api, room],
  );

  return { brief, saveBrief };
}
