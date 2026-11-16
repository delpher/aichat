// Shared between the launcher (dist/launcher.js) and the broker's updater: where installed versions live
// and how the two talk through files in that folder. Kept free of dependencies so the launcher stays tiny.
//
//   <home>/<version>/        an installed release (the aichat/ folder of aichat-<version>.tar.gz)
//   <home>/current           the version the launcher starts
//   <home>/pending.json      { version, previous }: an update that has not yet started successfully
//   <home>/failed.json       { version, previous, at, reason }: the last update the launcher rolled back
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Exit code with which the broker asks the launcher to start it again (to switch to a newly installed version). */
export const RESTART_EXIT_CODE = 75;
/** Entry point inside an installed version, as in release.json `entry`. */
export const ENTRY = join("dist", "broker", "main.js");

export interface Pending {
  version: string;
  previous: string;
  at?: string;
}
export interface Failed extends Pending {
  reason: string;
}

export const paths = (home: string) => ({
  current: join(home, "current"),
  pending: join(home, "pending.json"),
  failed: join(home, "failed.json"),
  version: (v: string) => join(home, v),
});

function readText(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}
export function readJsonFile<T>(file: string): T | undefined {
  const t = readText(file);
  if (!t) return undefined;
  try {
    return JSON.parse(t) as T;
  } catch {
    return undefined;
  }
}
/** Writes through a temp file and a rename, so a crash never leaves a half-written file. */
export function writeAtomic(file: string, text: string) {
  mkdirSync(join(file, ".."), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}
export const readCurrent = (home: string) => {
  const v = readText(paths(home).current);
  return v && parseVersion(v) ? v : undefined;
};
export const readPending = (home: string) => readJsonFile<Pending>(paths(home).pending);
export const readFailed = (home: string) => readJsonFile<Failed>(paths(home).failed);
export const remove = (file: string) => rmSync(file, { force: true, recursive: true });
export const isInstalled = (home: string, v: string) => existsSync(join(paths(home).version(v), ENTRY));

// ---- semver (enough for release tags: 1.2.3 and 1.2.3-rc.1) ----

export interface Version {
  major: number;
  minor: number;
  patch: number;
  pre: string[];
}
export function parseVersion(v: string): Version | undefined {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(v.trim());
  if (!m) return undefined;
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ? m[4].split(".") : [] };
}
/** <0 if a is older than b, 0 if equal, >0 if newer. Unparseable versions sort first. */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return (x ? 1 : 0) - (y ? 1 : 0);
  for (const k of ["major", "minor", "patch"] as const) if (x[k] !== y[k]) return x[k] - y[k];
  if (!x.pre.length || !y.pre.length) return y.pre.length - x.pre.length;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn && +p !== +q) return +p - +q;
    if (pn !== qn) return pn ? -1 : 1;
    if (p !== q) return p < q ? -1 : 1;
  }
  return 0;
}
/** Checks a Node version against an `engines.node` range of the form ">=22.13" (the only form this project uses). */
export function satisfiesNode(range: string | undefined, node = process.versions.node): boolean {
  if (!range) return true;
  return range
    .split(/\s+/)
    .filter(Boolean)
    .every((part) => {
      const m = /^>=\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(part);
      if (!m) return true;
      return compareVersions(node, `${m[1]}.${m[2] ?? 0}.${m[3] ?? 0}`) >= 0;
    });
}
