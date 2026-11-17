// Semver order, shared by the adapters and the web UI (no Node APIs here).

const SEMVER_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/;

/** Semver order: negative if a < b, 0 if equal or either cannot be read, positive if a > b. */
export function compareVersions(a: string, b: string): number {
  const x = SEMVER_RE.exec(a.trim());
  const y = SEMVER_RE.exec(b.trim());
  if (!x || !y) return 0;
  for (let i = 1; i <= 3; i++) if (Number(x[i]) !== Number(y[i])) return Number(x[i]) - Number(y[i]);
  // a release is newer than its prereleases (1.2.0-rc.1 < 1.2.0)
  if (!x[4] || !y[4]) return x[4] ? -1 : y[4] ? 1 : 0;
  const p = x[4].split(".");
  const q = y[4].split(".");
  for (let i = 0; i < Math.max(p.length, q.length); i++) {
    if (p[i] === undefined) return -1;
    if (q[i] === undefined) return 1;
    const n = /^\d+$/.test(p[i]);
    const m = /^\d+$/.test(q[i]);
    if (n && m && Number(p[i]) !== Number(q[i])) return Number(p[i]) - Number(q[i]);
    if (n !== m) return n ? -1 : 1;
    if (!n && p[i] !== q[i]) return p[i] < q[i] ? -1 : 1;
  }
  return 0;
}
