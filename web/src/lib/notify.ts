// Browser notifications for messages that need you: @mentions and direct messages.
import type { ChatMessage } from "../api/types";
import { KEYS, storage } from "./storage";

export const notifySupported = () => typeof window !== "undefined" && "Notification" in window;
export const notifyPermission = (): NotificationPermission | "unsupported" => (notifySupported() ? Notification.permission : "unsupported");

/** The person turned notifications on in this browser (and the browser allows them). */
export const notifyOn = () => storage.get(KEYS.notify) === "on" && notifyPermission() === "granted";
export const setNotifyPref = (on: boolean) => storage.set(KEYS.notify, on ? "on" : "off");

/** Asks the browser for permission (must run from a click); turns notifications on when granted. */
export async function enableNotify(): Promise<NotificationPermission | "unsupported"> {
  if (!notifySupported()) return "unsupported";
  const p = Notification.permission === "default" ? await Notification.requestPermission() : Notification.permission;
  if (p === "granted") setNotifyPref(true);
  return p;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whether the text mentions `name` as @name (not as part of a longer name or an e-mail address). */
export function mentions(text: string, name: string): boolean {
  return new RegExp(`(^|[^A-Za-z0-9_@.-])@${escapeRe(name)}(?![A-Za-z0-9_-])`).test(text);
}

/** A message `me` should hear about: someone else's @mention of me, or a direct message to me. */
export function needsMe(m: ChatMessage, me: string): boolean {
  if (m.from === me) return false;
  return (!m.room && m.to === me) || mentions(m.text, me);
}
