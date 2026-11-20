import type { Api } from "../api/http";
import type { Session } from "../api/types";
import { saveLink } from "./saveFile";

/** The viewer's time zone, so the export shows times as they see them in the chat. */
const timeZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
};

/**
 * Saves a room's whole conversation as a Markdown file. The broker builds the file (src/room-export.ts) and gives a
 * short download link to it: the admin API for an admin, the member API for a member, so everyone gets what they may
 * read.
 */
export async function exportRoom(api: Api, session: Session, room: string) {
  const base = session.mode === "admin" ? "/admin/api" : "/api";
  const q = new URLSearchParams({ tz: timeZone() });
  const { url } = await api.send<{ url: string }>("POST", `${base}/rooms/${encodeURIComponent(room)}/export?${q}`);
  saveLink(url);
}
