// Helpers the adapters share for file attachments.
import type { ChatMessage, FileInfo } from "../protocol.js";

const TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  html: "text/html",
  zip: "application/zip",
  log: "text/plain",
};

/** A MIME type guessed from a file name's extension. */
export function mimeFor(name: string): string {
  const ext = name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
  return TYPES[ext] ?? "application/octet-stream";
}

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
