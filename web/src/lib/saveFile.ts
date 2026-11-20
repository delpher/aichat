/**
 * Saves a file from a short download link the broker made for it (/dl/...). The link carries its own proof, so the
 * browser, or a download manager that takes the download over (Chrono, issue #61), fetches it as an ordinary file;
 * a blob: made by the page was not theirs to read and hung at 100%.
 */
export function saveLink(url: string, fileName?: string) {
  const a = document.createElement("a");
  a.href = url;
  if (fileName) a.download = fileName;
  a.rel = "noopener";
  document.body.append(a);
  a.click();
  a.remove();
}
