// Helpers the adapters share for file attachments.
import type { ChatMessage, FileInfo } from "../protocol.js";

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export const describeFile = (f: FileInfo) => `[attachment file_id=${f.id} name="${f.name}" type=${f.mime} size=${formatSize(f.size)}]`;

/** Message text plus one line per attachment, for agents that only read text. */
export function textWithAttachments(m: ChatMessage): string {
  const files = (m.attachments ?? []).map(describeFile);
  return [m.text, ...files].filter(Boolean).join("\n");
}
