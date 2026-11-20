/**
 * How long a file handed to the browser stays readable. The browser reads the blob only when the download finishes,
 * and that waits for the person when the browser asks where to save it; a blob freed before then leaves the download
 * hanging at 100% with nothing written (issue #61). Ten minutes covers a save dialog left open for a while.
 */
export const KEEP_BLOB_MS = 10 * 60_000;

/** Hands a blob to the browser as a file to save, and frees it only once the download can no longer need it. */
export function saveBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), KEEP_BLOB_MS);
}
