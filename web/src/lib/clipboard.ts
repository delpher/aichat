/**
 * Copies `text`. The Clipboard API exists only on secure pages (https or localhost); the web is often opened as plain
 * http://aichat.home, so then it falls back to a hidden text field and the browser's copy command. Rejects when
 * neither works, so the caller can show the text to copy by hand (codex-alexey, AIChat 3132).
 */
export async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
  const field = document.createElement("textarea");
  field.value = text;
  field.setAttribute("readonly", "");
  field.style.position = "fixed";
  field.style.opacity = "0";
  document.body.appendChild(field);
  field.select();
  try {
    if (!document.execCommand?.("copy")) throw new Error("copy is not available");
  } finally {
    field.remove();
  }
}
