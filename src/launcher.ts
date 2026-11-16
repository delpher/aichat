#!/usr/bin/env node
// Starts the broker from the newest installed version and keeps it running across self-updates.
//
//   node dist/launcher.js [agents.json]
//
// The release this file came with is the "built-in" version. Updates installed from the web UI live in
// AICHAT_HOME (default: versions/ next to dist/; /app/versions in Docker). The broker installs an update,
// marks it pending and exits with RESTART_EXIT_CODE; the launcher then starts the new version. If that
// version exits or does not confirm a successful start within AICHAT_CONFIRM_MS, the launcher writes
// failed.json and goes back to the previous version.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ENTRY,
  RESTART_EXIT_CODE,
  compareVersions,
  isInstalled,
  paths,
  readCurrent,
  readPending,
  remove,
  writeAtomic,
  type Failed,
} from "./updates/layout.js";

const builtinRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const builtinVersion: string = (() => {
  try {
    return JSON.parse(readFileSync(join(builtinRoot, "package.json"), "utf8")).version;
  } catch {
    return "0.0.0";
  }
})();
const home = resolve(process.env.AICHAT_HOME || join(builtinRoot, "versions"));
const confirmMs = Number(process.env.AICHAT_CONFIRM_MS) || 90_000;
const args = process.argv.slice(2);
const log = (m: string) => console.error(`[launcher] ${m}`);

/** The version to start: the selected installed one, unless the built-in one (a newer image) is newer. */
function pick(): { version: string; root: string } {
  const cur = readCurrent(home);
  if (cur && isInstalled(home, cur) && compareVersions(cur, builtinVersion) >= 0) return { version: cur, root: paths(home).version(cur) };
  if (cur && cur !== builtinVersion) {
    if (!isInstalled(home, cur)) log(`version ${cur} is not installed in ${home}; starting the built-in ${builtinVersion}`);
    else log(`the built-in version ${builtinVersion} is newer than the installed ${cur}; starting it`);
  }
  return { version: builtinVersion, root: builtinRoot };
}

function rollBack(version: string, previous: string, reason: string) {
  const p = paths(home);
  log(`version ${version} failed (${reason}); going back to ${previous}`);
  const failed: Failed = { version, previous, at: new Date().toISOString(), reason };
  writeAtomic(p.failed, JSON.stringify(failed, null, 2) + "\n");
  writeAtomic(p.current, previous + "\n");
  remove(p.pending);
}

let child: ChildProcess | undefined;
let stopping = false;
for (const sig of ["SIGINT", "SIGTERM"] as const)
  process.on(sig, () => {
    stopping = true;
    if (child && child.exitCode === null) child.kill(sig);
    else process.exit(0);
  });

function start() {
  const { version, root } = pick();
  const entry = join(root, ENTRY);
  if (!existsSync(entry)) {
    log(`cannot find ${entry}`);
    process.exit(1);
  }
  const pending = readPending(home);
  const waiting = pending?.version === version;
  if (pending && !waiting) {
    // The update could not even be selected (folder missing or older than the built-in version).
    const failed: Failed = { ...pending, at: new Date().toISOString(), reason: `version ${pending.version} could not be started` };
    writeAtomic(paths(home).failed, JSON.stringify(failed, null, 2) + "\n");
    remove(paths(home).pending);
  }
  log(`starting AIChat ${version}${root === builtinRoot ? " (built-in)" : ` from ${root}`}`);
  const proc = spawn(process.execPath, [entry, ...args], {
    stdio: "inherit",
    env: { ...process.env, AICHAT_HOME: home, AICHAT_LAUNCHER: "1", AICHAT_BUILTIN_DIR: builtinRoot },
  });
  child = proc;
  let timedOut = false;
  // The broker deletes pending.json once it is listening; if it doesn't, the update is treated as broken.
  const timer = waiting
    ? setTimeout(() => {
        if (readPending(home)?.version !== version) return;
        timedOut = true;
        log(`version ${version} did not start within ${Math.round(confirmMs / 1000)} s`);
        proc.kill("SIGTERM");
        setTimeout(() => proc.exitCode === null && proc.kill("SIGKILL"), 10_000).unref();
      }, confirmMs)
    : undefined;
  proc.on("exit", (code, signal) => {
    if (timer) clearTimeout(timer);
    if (stopping) process.exit(code ?? 0);
    const still = readPending(home);
    if (waiting && still?.version === version) {
      rollBack(version, still.previous, timedOut ? "did not start in time" : `exited with ${signal ?? `code ${code}`}`);
      return start();
    }
    if (code === RESTART_EXIT_CODE) return start();
    log(`AIChat ${version} exited with ${signal ?? `code ${code}`}`);
    process.exit(code ?? 1);
  });
}

start();
