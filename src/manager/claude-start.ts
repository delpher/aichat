// How the manager starts a Claude Code agent (AIChat #aichat-manager-dev, 3434-3450). Claude Code keeps the session,
// not the adapter, so a start script in the agent's folder resumes it and tells the adapter how it began. The person
// writes only the Claude command (`claude`, perhaps `claude --model opus`) as the agent's start command in the
// manager's .manager.json; the script adds what AIChat needs. A manual `.\start.ps1` behaves the same.
import { existsSync } from "node:fs";
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
  return own && !/start\.ps1/i.test(own) ? own : CLAUDE_DEFAULT_COMMAND;
}

export const hasStartScript = (dir: string) => existsSync(join(dir, "start.ps1"));

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
$words = @($command -split '\\s+' | Where-Object { $_ })
$exe = $words[0]
$extra = @($words | Select-Object -Skip 1)
if ($extra -notcontains '--dangerously-load-development-channels') { $extra += @('--dangerously-load-development-channels', 'server:aichat') }

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
$env:AICHAT_START = if ($session) { 'resumed' } else { 'new' }
$resume = if ($session) { @('--resume', $session.BaseName) } else { @() }
if ($session) { Write-Host "Resuming session $($session.BaseName) ($($session.LastWriteTime))" } else { Write-Host 'Starting a new session' }
$started = Get-Date
& $exe @resume @extra
# a session that cannot be resumed: a new one rather than none
if ($session -and $LASTEXITCODE -ne 0 -and ((Get-Date) - $started).TotalSeconds -lt 15) {
  Write-Host 'Could not resume that session: starting a new one'
  $env:AICHAT_START = 'new'
  & $exe @extra
}
`.replace(/\n/g, "\r\n");
