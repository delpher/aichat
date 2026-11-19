// A page with unsaved changes asks before the app navigates away from it.

let guard: (() => boolean) | null = null;

/** `dirty` says whether there is something to lose; null removes the guard. */
export function setLeaveGuard(dirty: (() => boolean) | null) {
  guard = dirty;
}

/** Whether the app may leave the current page: asks only when that page has unsaved changes. */
export function mayLeave(): boolean {
  if (!guard?.()) return true;
  const ok = window.confirm("Є незбережені зміни. Піти зі сторінки без збереження?");
  if (ok) guard = null;
  return ok;
}
