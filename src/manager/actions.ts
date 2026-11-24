// What the agent manager can do with an installed agent (alexey, AIChat 3145-3157): update its adapter from the
// broker, start and stop it, move a stale one out of the way and bring it back. Nothing is deleted for good: that
// stays with the user (alexey, AIChat 3158).
import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { adapterVersion, readAgent, type LocalAgent } from "./agents.js";
import { CLAUDE_CHANNEL_FLAGS, claudeCommand, hasStartScript, startScriptCommand, writeStartScript } from "./claude-start.js";

/** The file each adapter is served as by the broker (GET /client/<name>). */
const CLIENT_FILE: Record<LocalAgent["type"], string> = {
  agy: "agy-channel.mjs",
  codex: "codex-channel.mjs",
  claude: "claude-channel.mjs",
  opencode: "opencode-channel.js",
};

export class ActionError extends Error {
  constructor(
    message: string,
    readonly status = 409,
  ) {
    super(message);
  }
}

/** How to run things; tests replace it. */
export interface Runner {
  /** Opens a terminal tab in `dir` running `command` (shown with `title`). */
  openTerminal(dir: string, title: string, command: string): Promise<void>;
  /** Runs `node <args>` in `dir` and waits for it. */
  node(dir: string, args: string[]): Promise<void>;
  /** Waits until process `pid` is gone, up to `ms`; true when it went. */
  waitExit(pid: number, ms: number): Promise<boolean>;
  /**
   * Starts `node <args>` in `dir` with no window and lets it outlive the manager; its output goes to `logFile`.
   * Returns its pid.
   */
  background(dir: string, args: string[], logFile: string): Promise<number>;
  /** Whether process `pid` is there. */
  alive(pid: number): boolean;
  sleep(ms: number): Promise<void>;
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

export const systemRunner: Runner = {
  openTerminal: (dir, title, command) =>
    new Promise((resolve, reject) => {
      // Windows Terminal: a new tab in the open window; plain console window when it is not installed
      const ps = ["powershell", "-NoExit", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command];
      const tryStart = (exe: string, args: string[], next?: () => void) => {
        const child = spawn(exe, args, { cwd: dir, detached: true, stdio: "ignore", windowsHide: false });
        child.once("error", (e) => (next ? next() : reject(e)));
        child.once("spawn", () => {
          child.unref();
          resolve();
        });
      };
      if (process.platform !== "win32") {
        // elsewhere a detached tmux session: it lives on a desktop and on a server over SSH alike, and closing the window
        // that is attached to it only detaches (AIChat 3535-3541)
        const session = tmuxSession(title);
        const tmux = (args: string[]) => spawnSync("tmux", args, { stdio: "pipe", encoding: "utf8" });
        const probe = tmux(["-V"]);
        if (probe.error) return reject(new ActionError("потрібен tmux: встановіть його (наприклад, sudo apt install tmux)", 501));
        if (tmux(["has-session", "-t", `=${session}`]).status === 0)
          return reject(new ActionError(`tmux-сесія ${session} уже є: tmux attach -t ${session}`, 409));
        // sh -c as separate words: tmux runs them as they are, not through the user's shell (which may be fish). The pause
        // keeps a session whose command failed, so its error can be read instead of vanishing with it (alexey, 3631)
        const started = tmux(["new-session", "-d", "-s", session, "-c", dir, "sh", "-c", `(${command})${TMUX_PAUSE}`]);
        if (started.status !== 0) return reject(new ActionError(`tmux не запустив сесію: ${(started.stderr || "").trim()}`, 502));
        // on a desktop also open a window attached to it, as Windows opens a tab; over SSH the page names the session
        const windows = attachTerminals(session);
        const next = (i: number): void => {
          if (i >= windows.length) return resolve();
          const [exe, args] = windows[i];
          const child = spawn(exe, args, { cwd: dir, detached: true, stdio: "ignore" });
          child.once("error", () => next(i + 1));
          child.once("spawn", () => {
            child.unref();
            resolve();
          });
        };
        return next(0);
      }
      tryStart("wt.exe", ["-w", "0", "nt", "-d", dir, "--title", title, ...ps], () =>
        tryStart("cmd.exe", ["/c", "start", JSON.stringify(title), "/D", dir, ...ps]),
      );
    }),
  node: (dir, args) =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, args, { cwd: dir, stdio: "ignore", windowsHide: true });
      child.once("error", reject);
      child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`node ${basename(args[0])} ${args[1]}: код ${code}`))));
    }),
  waitExit: async (pid, ms) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (!alive(pid)) return true;
      await new Promise((r) => setTimeout(r, 250));
    }
    return !alive(pid);
  },
  background: (dir, args, logFile) =>
    new Promise((resolve, reject) => {
      mkdirSync(dirname(logFile), { recursive: true });
      const out = openSync(logFile, "a");
      try {
        // detached + windowsHide: no console window, and closing the manager does not take the agent with it
        const child = spawn(process.execPath, args, { cwd: dir, detached: true, stdio: ["ignore", out, out], windowsHide: true });
        child.once("error", reject);
        child.once("spawn", () => {
          child.unref();
          resolve(child.pid!);
        });
      } finally {
        closeSync(out);
      }
    }),
  alive,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

/** Extra settings from `<root>/.manager.json`: the command that starts an agent, by folder. */
export interface ManagerSettings {
  start?: Record<string, string>;
}

export function readSettings(root: string): ManagerSettings {
  try {
    return JSON.parse(readFileSync(join(root, ".manager.json"), "utf8")) as ManagerSettings;
  } catch {
    return {};
  }
}

/**
 * The terminal command that starts the agent in its folder, or null when the manager runs it in the background
 * itself: agy and codex adapters are console programs (alexey, AIChat 3165), unless `.manager.json` says otherwise.
 */
export function startCommand(agent: LocalAgent, settings: ManagerSettings): string | null {
  const own = settings.start?.[agent.folder];
  // Claude Code: the agent's start script runs the person's Claude command (AIChat 3443-3450); without one, the
  // command itself with the channel flags
  if (agent.type === "claude") {
    if (hasStartScript(agent.dir)) return startScriptCommand();
    const command = claudeCommand(own);
    return command.includes("--dangerously-load-development-channels") ? command : `${command} ${CLAUDE_CHANNEL_FLAGS}`;
  }
  if (own) return own;
  if (agent.type === "opencode") return "opencode";
  return null;
}

/** The command that opens an interactive session of a running agent, or why there is none. */
export function sessionCommand(agent: LocalAgent, settings: ManagerSettings = {}): { command: string } | { why: string } {
  if (agent.type === "opencode") {
    // OpenCode's TUI is only a client of its background server, where the plugin keeps the agent: a terminal opened in
    // the agent's folder joins it, as many as one likes (opencode-alexey, AIChat 3659-3660). Open the agent's own session
    // unless the person's command already names one.
    const command = startCommand(agent, settings) ?? "opencode";
    const id = agent.status?.sessionID;
    const own = /(^|\s)(--session|-s|--continue|-c)(\s|=|$)/.test(command);
    return { command: id && !own ? `${command} --session ${id}` : command };
  }
  if (agent.type !== "codex" && agent.type !== "agy") return { why: "цей агент і так працює в терміналі" };
  if (!agent.attachPort) return { why: "додайте attachPort у aichat.config.json і перезапустіть агента" };
  // ./ works in PowerShell and in a POSIX shell alike (antigravity-alexey, 3537)
  return { command: `node ./${basename(agent.adapterFile)} attach --config ./aichat.config.json` };
}

/** agy and codex run as adapters of their own, which can be stopped; Claude Code and OpenCode live in a terminal. */
const stoppable = (a: LocalAgent) => a.type === "agy" || a.type === "codex";
const running = (a: LocalAgent) => a.status?.alive === true;
/** Where the output of an agent started in the background goes (a .log, so the page lists it). */
export const BACKGROUND_LOG = "background.log";

export class Actions {
  constructor(
    readonly root: string,
    readonly runner: Runner = systemRunner,
    readonly fetchText: (url: string) => Promise<string> = async (url) => {
      const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(`${url}: ${res.status} ${res.statusText}`);
      return res.text();
    },
  ) {}

  private agent(folder: string): LocalAgent {
    if (!/^[^\\/]+$/.test(folder) || folder.startsWith(".")) throw new ActionError("немає такого агента", 404);
    const found = readAgent(join(this.root, folder));
    if (!found) throw new ActionError("немає такого агента", 404);
    return found.agent;
  }

  /** `online`: the broker sees the agent connected (the only sign for Claude Code and OpenCode). */
  async start(folder: string, online?: boolean): Promise<string> {
    const a = this.agent(folder);
    if (running(a) || online) throw new ActionError("агент уже працює");
    const command = startCommand(a, readSettings(this.root));
    if (command) {
      await this.runner.openTerminal(a.dir, folder, command);
      return `Відкрито термінал з агентом.${terminalNote(folder)}`;
    }
    const pid = await this.runner.background(a.dir, [a.adapterFile, "run", "--config", join(a.dir, "aichat.config.json")], join(a.dir, ".aichat", BACKGROUND_LOG));
    // the adapter writes its pid to .aichat/status.json once it is up; an early exit means it could not start
    for (let waited = 0; waited < 15000; waited += 250) {
      if (readAgent(a.dir)?.agent.status?.pid === pid) return `Агента запущено у фоні (pid ${pid}).`;
      if (!this.runner.alive(pid)) throw new ActionError(`агент одразу завершився: дивіться лог ${BACKGROUND_LOG}`, 502);
      await this.runner.sleep(250);
    }
    return `Агента запущено у фоні (pid ${pid}), він ще готується.`;
  }

  /** Opens a terminal tab with an interactive session attached to the running agent (agy/codex: `attach`). */
  async session(folder: string, online?: boolean): Promise<string> {
    const a = this.agent(folder);
    // OpenCode has no process of the manager's: the broker seeing it online is the sign its server runs
    if (a.type === "opencode" ? !online : !running(a)) throw new ActionError("агент не запущений");
    const how = sessionCommand(a, readSettings(this.root));
    if ("why" in how) throw new ActionError(how.why, 400);
    await this.runner.openTerminal(a.dir, `${folder}: сесія`, how.command);
    return `Відкрито сесію в терміналі. Закриття вкладки агента не зупиняє.${terminalNote(`${folder}: сесія`)}`;
  }

  async stop(folder: string): Promise<string> {
    const a = this.agent(folder);
    if (!stoppable(a)) throw new ActionError("цей агент працює в терміналі: закрийте його там", 400);
    if (!running(a)) throw new ActionError("агент не запущений");
    await this.runner.node(a.dir, [a.adapterFile, "stop", "--config", join(a.dir, "aichat.config.json")]);
    if (!(await this.runner.waitExit(a.status!.pid!, 30000))) throw new ActionError("агент не зупинився за 30 с", 504);
    return "Агента зупинено.";
  }

  /**
   * Downloads the adapter from the broker, checks that it is the broker's version, keeps the old file as
   * `<file>.bak-<old version>` and puts the new one in its place (with aichat-hook.mjs next to Claude's). A running
   * agy or codex agent is restarted; Claude Code and OpenCode pick it up when restarted by hand.
   */
  async update(folder: string, brokerVersion: string | undefined): Promise<string> {
    const a = this.agent(folder);
    if (!a.brokerUrl) throw new ActionError("невідомо, з якого брокера оновлювати", 400);
    if (!brokerVersion) throw new ActionError("брокер не назвав свою версію", 502);
    const files: [string, string][] = [[CLIENT_FILE[a.type], a.adapterFile]];
    const hook = join(dirname(a.adapterFile), "aichat-hook.mjs");
    if (a.type === "claude" && existsSync(hook)) files.push(["aichat-hook.mjs", hook]);
    const fresh: [string, string][] = [];
    for (const [name, target] of files) {
      const text = await this.fetchText(`${a.brokerUrl}/client/${name}`);
      const tmp = `${target}.download`;
      writeFileSync(tmp, text);
      const got = adapterVersion(tmp);
      if (name !== "aichat-hook.mjs" && got !== brokerVersion) {
        rmSync(tmp, { force: true });
        throw new ActionError(`завантажено ${got ?? "невідому версію"}, а брокер має ${brokerVersion}`, 502);
      }
      fresh.push([tmp, target]);
    }
    const restart = stoppable(a) && running(a);
    if (restart) await this.stop(folder);
    for (const [tmp, target] of fresh) {
      if (existsSync(target)) {
        let bak = `${target}.bak-${adapterVersion(target) ?? "old"}`;
        if (existsSync(bak)) bak += `-${Date.now()}`;
        renameSync(target, bak);
      }
      renameSync(tmp, target);
    }
    // a Claude Code agent set up before the wizard wrote start scripts gets one now (never over its own)
    if (a.type === "claude") writeStartScript(a.dir);
    if (restart) await this.start(folder);
    const done = `Адаптер оновлено до ${brokerVersion}, стара версія збережена поруч (.bak).`;
    return restart ? `${done} Агента перезапущено.` : stoppable(a) ? done : `${done} Перезапустіть агента в його терміналі.`;
  }

  /** Moves a stale agent's folder to `<root>/.removed/<folder>-<time>`; only one that does not run. */
  remove(folder: string, confirm: string, online: boolean | undefined): string {
    const a = this.agent(folder);
    if (confirm !== folder) throw new ActionError("для підтвердження введіть назву теки", 400);
    if (running(a) || online) throw new ActionError("агент працює: спершу зупиніть його");
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
    mkdirSync(join(this.root, ".removed"), { recursive: true });
    const to = join(this.root, ".removed", `${folder}-${stamp}`);
    renameSync(a.dir, to);
    return `Теку перенесено в .removed\\${basename(to)}.`;
  }

  removed(): string[] {
    const dir = join(this.root, ".removed");
    try {
      return readdirSync(dir).filter((n) => statSync(join(dir, n)).isDirectory()).sort();
    } catch {
      return [];
    }
  }

  private removedDir(name: string): string {
    if (!this.removed().includes(name)) throw new ActionError("немає такої теки серед видалених", 404);
    return join(this.root, ".removed", name);
  }

  /** Brings a removed folder back under its old name. */
  restore(name: string): string {
    const from = this.removedDir(name);
    const folder = name.replace(/-\d{8}-\d{6}$/, "");
    const to = join(this.root, folder);
    if (existsSync(to)) throw new ActionError(`тека ${folder} уже є`);
    renameSync(from, to);
    return `Теку ${folder} повернуто.`;
  }
}

/** The tmux session of a terminal opened for `title` (an agent's folder, or "<folder>: сесія"): aichat-<folder>[-session]. */
export function tmuxSession(title: string): string {
  const [folder, rest] = title.split(": ");
  const name = `aichat-${folder}${rest ? "-session" : ""}`;
  // tmux takes no . or : in a session name
  return name.replace(/[^A-Za-z0-9_-]/g, "-");
}

/** Appended to a command run in tmux: when it ends, say so with its exit code and wait, so the session stays to be read. */
export const TMUX_PAUSE = `; code=$?; printf '\\n[Завершено, код %s. Enter — закрити]\\n' "$code"; read _`;

/**
 * The terminal windows to try, in order, for attaching to tmux `session` on a desktop; none without a display (SSH,
 * a server). `=` makes tmux match the name exactly.
 */
export function attachTerminals(session: string, env: NodeJS.ProcessEnv = process.env): [string, string[]][] {
  if (!env.DISPLAY && !env.WAYLAND_DISPLAY) return [];
  const attach = ["tmux", "attach", "-t", `=${session}`];
  return [
    ["x-terminal-emulator", ["-e", ...attach]],
    ["gnome-terminal", ["--", ...attach]],
    ["konsole", ["-e", ...attach]],
    ["xfce4-terminal", ["-x", ...attach]],
    ["kitty", attach],
    ["alacritty", ["-e", ...attach]],
    ["xterm", ["-e", ...attach]],
  ];
}

/** What the page says after opening a terminal: Windows opens a tab; elsewhere it names the tmux session to attach to. */
export function terminalNote(title: string, platform = process.platform): string {
  if (platform === "win32") return "";
  const session = tmuxSession(title);
  return ` Сесія tmux ${session} (на робочому столі відкривається вікно; інакше: tmux attach -t ${session}; Ctrl+B, D — від'єднатися, агент працює далі).`;
}
