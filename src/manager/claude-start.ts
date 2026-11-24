// How the manager starts a Claude Code agent (AIChat #aichat-manager-dev, 3434-3450). Claude Code keeps the session,
// not the adapter, so a start script in the agent's folder resumes it and tells the adapter how it began. The person
// writes only the Claude command (`claude`, perhaps `claude --model opus`) as the agent's start command in the
// manager's .manager.json; the script adds what AIChat needs. A manual `.\start.ps1` behaves the same.
import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The Claude command when the person set none. */
export const CLAUDE_DEFAULT_COMMAND = "claude";
/** What Claude Code needs to load the AIChat channel; the script adds it when the command lacks it. */
export const CLAUDE_CHANNEL_FLAGS = "--dangerously-load-development-channels server:aichat";

/**
 * The person's Claude command for an agent: its start entry in .manager.json, or `claude`. An entry naming the start
 * script itself (how claude-alexey was set up first) means the default.
 */
export function claudeCommand(own: string | undefined): string {
  return own && !/start\.(ps1|sh)/i.test(own) ? own : CLAUDE_DEFAULT_COMMAND;
}

/** The start script of this OS: start.ps1 on Windows, start.sh elsewhere (Linux, AIChat 3539-3547). */
export const startScriptName = (platform = process.platform) => (platform === "win32" ? "start.ps1" : "start.sh");
/** How the manager runs it in the agent's folder. */
export const startScriptCommand = (platform = process.platform) => (platform === "win32" ? ".\\start.ps1" : "./start.sh");
export const hasStartScript = (dir: string, platform = process.platform) => existsSync(join(dir, startScriptName(platform)));

/** Writes the agent's start script of this OS, never over one that is there. */
export function writeStartScript(dir: string, platform = process.platform): boolean {
  const file = join(dir, startScriptName(platform));
  if (existsSync(file)) return false;
  if (platform === "win32") writeFileSync(file, CLAUDE_START_PS1);
  else {
    writeFileSync(file, CLAUDE_START_SH, { mode: 0o755 });
    chmodSync(file, 0o755);
  }
  return true;
}

/**
 * The start script. It reads the command from ..\.manager.json (start.<folder>), adds the channel flags once,
 * resumes the newest session of the folder by id (`--continue` once started a new one although the old was there),
 * starts afresh with -Fresh or a .aichat\fresh marker, sets AICHAT_START for the adapter, and when a resume fails at
 * once (the session was removed or broken) starts a new session rather than none (opencode-alexey, 3448).
 */
export const CLAUDE_START_PS1 = `# Starts this Claude Code agent for AIChat: picks up the last session, or starts afresh with -Fresh or a .aichat\\fresh marker.
# The Claude command comes from the agent manager's settings (..\\.manager.json, start.<folder>), "claude" by default.
param([switch]$Fresh)
Set-Location -LiteralPath $PSScriptRoot
$marker = '.aichat\\fresh'
if (Test-Path $marker) { $Fresh = $true; Remove-Item $marker }

$folder = Split-Path -Leaf $PSScriptRoot
$command = '${CLAUDE_DEFAULT_COMMAND}'
try {
  $settings = Get-Content -Raw -ErrorAction Stop -LiteralPath (Join-Path (Split-Path -Parent $PSScriptRoot) '.manager.json') | ConvertFrom-Json
  $own = $settings.start.$folder
  if ($own -and $own -notmatch 'start\\.ps1') { $command = $own }
} catch { }
# split the way PowerShell itself would, so quoted values with spaces stay whole
$words = @([System.Management.Automation.PSParser]::Tokenize($command, [ref]$null) |
  Where-Object { $_.Type -notin 'NewLine', 'StatementSeparator', 'Comment' } | ForEach-Object { $_.Content })
$exe = $words[0]
$extra = [System.Collections.Generic.List[string]]@($words | Select-Object -Skip 1)
# the channel flag and its value, each once
$flag = $extra.IndexOf('--dangerously-load-development-channels')
if ($flag -lt 0) { $extra.Add('--dangerously-load-development-channels'); $extra.Add('server:aichat') }
elseif (-not $extra.Contains('server:aichat')) { $extra.Insert($flag + 1, 'server:aichat') }
# a command that chooses its own session keeps it
$ownSession = @($extra | Where-Object { $_ -in '--resume', '-r', '--continue', '-c', '--session-id' }).Count -gt 0
if ($ownSession) { $Fresh = $true }

$session = $null
if (-not $Fresh) {
  $config = if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } else { Join-Path $env:USERPROFILE '.claude' }
  $project = Join-Path $config ('projects\\' + ($PSScriptRoot -replace '[^A-Za-z0-9]', '-'))
  if (Test-Path -LiteralPath $project) {
    $session = Get-ChildItem -LiteralPath $project -Filter *.jsonl | Sort-Object LastWriteTime -Descending |
      Where-Object { Select-String -LiteralPath $_.FullName -Pattern '"type":"user"' -SimpleMatch -Quiet } |
      Select-Object -First 1
  }
}

# the adapter tells the broker whether this is the old conversation or a new one
$env:AICHAT_START = if ($session) { 'resumed' } elseif ($ownSession) { '' } else { 'new' }
$resume = if ($session) { @('--resume', $session.BaseName) } else { @() }
if ($session) { Write-Host "Resuming session $($session.BaseName) ($($session.LastWriteTime))" }
elseif ($ownSession) { Write-Host 'The command chooses its own session' }
else { Write-Host 'Starting a new session' }
$started = Get-Date
& $exe @resume @extra
# a session that cannot be resumed: a new one rather than none
if ($session -and $LASTEXITCODE -ne 0 -and ((Get-Date) - $started).TotalSeconds -lt 15) {
  Write-Host 'Could not resume that session: starting a new one'
  $env:AICHAT_START = 'new'
  & $exe @extra
}
`.replace(/\n/g, "\r\n");

/**
 * The same start script for Linux and macOS: a shell wrapper around a short Node program (Node is there for every
 * agent anyway), so the command is split like a shell would split it without eval, and the logic matches start.ps1:
 * the command from ../.manager.json, the channel flags once, the newest session of the folder resumed by id, --fresh
 * or .aichat/fresh for a new one, AICHAT_START for the adapter, a new session when a resume fails at once. Claude runs
 * as a child with this terminal, so it stays interactive; `node -e` keeps the terminal's stdin for it.
 */
export const CLAUDE_START_SH = String.raw`#!/usr/bin/env sh
# Starts this Claude Code agent for AIChat: picks up the last session, or starts afresh with --fresh or a .aichat/fresh marker.
# The Claude command comes from the agent manager's settings (../.manager.json, start.<folder>), "claude" by default.
DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
cd "$DIR" || exit 1
SCRIPT='
const fs = require("fs"), path = require("path"), os = require("os"), { spawnSync } = require("child_process");
const dir = process.cwd(), folder = path.basename(dir);
let fresh = process.argv.includes("--fresh");
const marker = path.join(dir, ".aichat", "fresh");
if (fs.existsSync(marker)) { fresh = true; fs.rmSync(marker, { force: true }); }
let command = "claude";
try {
  const own = JSON.parse(fs.readFileSync(path.join(dir, "..", ".manager.json"), "utf8")).start?.[folder];
  if (own && !/start\.(ps1|sh)/i.test(own)) command = own;
} catch {}
// split like a shell: quotes keep spaces and are dropped
const words = [...command.matchAll(/"([^"]*)"|'"'"'([^'"'"']*)'"'"'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);
const exe = words[0], extra = words.slice(1);
const flag = extra.indexOf("--dangerously-load-development-channels");
if (flag < 0) extra.push("--dangerously-load-development-channels", "server:aichat");
else if (!extra.includes("server:aichat")) extra.splice(flag + 1, 0, "server:aichat");
// a command that chooses its own session keeps it
const ownSession = extra.some((w) => ["--resume", "-r", "--continue", "-c", "--session-id"].includes(w));
if (ownSession) fresh = true;
let session = null;
if (!fresh) {
  const config = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  const project = path.join(config, "projects", dir.replace(/[^A-Za-z0-9]/g, "-"));
  try {
    session = fs.readdirSync(project).filter((f) => f.endsWith(".jsonl"))
      .map((f) => ({ id: f.slice(0, -6), file: path.join(project, f), at: fs.statSync(path.join(project, f)).mtimeMs }))
      .sort((a, b) => b.at - a.at)
      .find((s) => fs.readFileSync(s.file, "utf8").includes("\"type\":\"user\"")) || null;
  } catch {}
}
const env = { ...process.env, AICHAT_START: session ? "resumed" : ownSession ? "" : "new" };
console.log(session ? "Resuming session " + session.id : ownSession ? "The command chooses its own session" : "Starting a new session");
// the terminal stops Claude, not this wrapper: it waits for Claude and leaves with it
process.on("SIGINT", () => {});
const started = Date.now();
let r = spawnSync(exe, [...(session ? ["--resume", session.id] : []), ...extra], { stdio: "inherit", env });
// a session that cannot be resumed: a new one rather than none
if (session && r.status !== 0 && Date.now() - started < 15000) {
  console.log("Could not resume that session: starting a new one");
  r = spawnSync(exe, extra, { stdio: "inherit", env: { ...env, AICHAT_START: "new" } });
}
if (r.error) { console.error(String(r.error.message || r.error)); process.exit(127); }
process.exit(r.status ?? 0);
'
exec node -e "$SCRIPT" -- "$@"
`;
