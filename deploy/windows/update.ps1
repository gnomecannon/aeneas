<#
.SYNOPSIS
  Update a Windows hub (deploy\install.ps1) to the newest code of its branch: started by the hub (Settings, About,
  Update hub, or the assistant), or by hand:
    powershell -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\AeneasHub\app\deploy\windows\update.ps1"
.DESCRIPTION
  The same steps as deploy/update.sh on Linux and macOS: git fetch the branch (main unless EA_REF says otherwise);
  nothing newer: "up to date"; refuse when files were changed by hand or the branch is not a fast forward; else move
  to it, install its packages and the web app with the hub stopped (Windows will not replace files a running program
  has open), start the hub and wait for it twice. When the new code does not install or the hub does not come back:
  back to the commit it had. Progress goes to $EA_UPDATE_DIR\status.json (the hub reads it) and update.log.
  A change to the hub's service itself (deploy\windows\hub-service.ps1) is used from the next restart of Windows, or
  at once by running the install command again.
#>
$ErrorActionPreference = 'Continue'
$App = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$Root = Split-Path $App
$Run = Join-Path $Root 'run'
$EnvFile = Join-Path $Root 'config\hub.env'
function Env-Value([string]$k) {
  if (-not (Test-Path $EnvFile)) { return '' }
  $v = ''; foreach ($l in [IO.File]::ReadAllLines($EnvFile)) { if ($l.StartsWith("$k=")) { $v = $l.Substring($k.Length + 1) } }; return $v
}
$Data = Env-Value 'EA_DATA_DIR'; if (-not $Data) { $Data = Join-Path $Root 'data' }
$UpdateDir = if ($env:EA_UPDATE_DIR) { $env:EA_UPDATE_DIR } else { Join-Path $Data 'update' }
$Port = if ($env:EA_PORT) { $env:EA_PORT } else { Env-Value 'EA_PORT' }; if (-not $Port) { $Port = '8787' }
$Ref = if ($env:EA_REF) { $env:EA_REF } else { 'main' }
New-Item -ItemType Directory -Force -Path $UpdateDir, $Run | Out-Null
$Status = Join-Path $UpdateDir 'status.json'
$Lock = Join-Path $UpdateDir 'lock'
$LogFile = Join-Path $UpdateDir 'update.log'
$Utf8 = New-Object Text.UTF8Encoding $false
$env:Path = "$(Join-Path $Root 'node');$(Join-Path $Root 'git\cmd');$env:Path"
$env:NPM_CONFIG_UPDATE_NOTIFIER = 'false'; $env:NPM_CONFIG_FUND = 'false'; $env:GIT_TERMINAL_PROMPT = '0'

function Log([string]$t) { [IO.File]::AppendAllText($LogFile, "$t`n", $Utf8) }
$script:From = ''; $script:To = ''
function Set-Status([string]$state, [string]$message) {
  $s = [ordered]@{ state = $state; message = $message; from = $(if ($script:From) { $script:From } else { $null }); to = $(if ($script:To) { $script:To } else { $null }); at = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ') }
  [IO.File]::WriteAllText("$Status.tmp", ($s | ConvertTo-Json -Compress), $Utf8)
  Move-Item -Force "$Status.tmp" $Status
  Log "-- ${state}: $message"
}
function Finish([string]$state, [string]$message) { Set-Status $state $message; Remove-Item -Force -Recurse -ErrorAction SilentlyContinue $Lock; exit 0 }
# A program with a time limit, its output in the log; the exit code is returned (124 when it ran out of time).
function Run-Limited([int]$seconds, [string]$file, [string[]]$argv, [string]$dir = $App) {
  $q = ($argv | ForEach-Object { if ($_ -match '[\s"]') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ } }) -join ' '
  $out = Join-Path $UpdateDir 'step.out'
  $p = Start-Process -FilePath $file -ArgumentList $q -WorkingDirectory $dir -NoNewWindow -PassThru -RedirectStandardOutput $out -RedirectStandardError "$out.err"
  # Windows PowerShell 5.1 keeps a process's exit code only while its handle is held: without this, every step read
  # as failed (an empty exit code).
  $null = $p.Handle
  $done = $p.WaitForExit($seconds * 1000)
  if (-not $done) { try { $p.Kill() } catch { } }
  foreach ($f in $out, "$out.err") { if (Test-Path $f) { Log ((Get-Content -Raw $f) -replace "`r", ''); Remove-Item -Force $f } }
  if (-not $done) { return 124 }
  return $p.ExitCode
}
function Git([string[]]$a) { $o = & git.exe -C $App @a 2>$null; return ($o | Out-String).Trim() }

Log "==== $((Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')) update of $App ($Ref)"
if (Test-Path $Lock) {
  # A lock left by an update that was killed (a restart) is cleared after an hour.
  if ((Get-Item $Lock).LastWriteTime -lt (Get-Date).AddHours(-1)) { Remove-Item -Force -Recurse $Lock } else { Log 'another update is running'; exit 1 }
}
New-Item -ItemType Directory -Path $Lock | Out-Null

if ((Git @('rev-parse', '--is-inside-work-tree')) -ne 'true') { Finish 'failed' 'This hub was copied in, not installed with git, so it cannot update itself. Update it the way it was installed.' }
$script:From = Git @('rev-parse', 'HEAD')
Set-Status 'checking' 'Looking for a newer version'
if ((Run-Limited 120 'git.exe' @('-C', $App, 'fetch', '--quiet', 'origin', $Ref)) -ne 0) { Finish 'failed' "Could not reach the hub's code on GitHub. Try again later." }
$script:To = Git @('rev-parse', 'FETCH_HEAD')
if ($script:From -eq $script:To) { Finish 'up_to_date' 'This hub already has the newest version.' }
if (Git @('status', '--porcelain', '--untracked-files=no')) { Finish 'failed' "Files in $App were changed by hand, so the update would overwrite them. Keep or undo those changes first (git -C `"$App`" status shows them)." }
& git.exe -C $App merge-base --is-ancestor $script:From $script:To 2>$null
if ($LASTEXITCODE -ne 0) { Finish 'failed' 'The newest version does not follow on from this one (the branch was rewritten). Update from a terminal with git.' }

function Health { try { $null = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 3; return $true } catch { return $false } }
# The hub's service (hub-service.ps1) keeps the hub stopped while run\hold-hub is there, and starts it again after.
function Hold-Hub {
  New-Item -ItemType File -Force -Path (Join-Path $Run 'hold-hub') | Out-Null
  $pidFile = Join-Path $Run 'hub.pid'
  if (Test-Path $pidFile) { try { Stop-Process -Id ([int](Get-Content $pidFile)) -Force -ErrorAction Stop } catch { } }
  for ($i = 0; $i -lt 30 -and (Test-Path $pidFile); $i++) { Start-Sleep -Milliseconds 500 }
}
function Release-Hub { Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $Run 'hold-hub') }
# Up within a minute and a half, and still up a little later: a hub that starts and then falls over does not count.
function Came-Back {
  $ok = $false
  for ($i = 0; $i -lt 90 -and -not $ok; $i++) { if (Health) { $ok = $true } else { Start-Sleep -Seconds 1 } }
  if (-not $ok) { return $false }
  Start-Sleep -Seconds 8
  return (Health)
}
function Install-Code {
  if ((Run-Limited 900 'npm.cmd' @('ci', '--no-audit', '--no-fund', '--loglevel=error')) -ne 0) { return $false }
  if ((Run-Limited 600 'npm.cmd' @('--workspace', 'web', 'run', 'build')) -ne 0) { Log 'the web app did not build; the hub still runs' }
  return $true
}
function Roll-Back([string]$why) {
  Set-Status 'rolling_back' "$why Going back to the version it had."
  Hold-Hub
  & git.exe -C $App reset --quiet --hard $script:From 2>$null
  $null = Install-Code
  Release-Hub
  $script:To = $script:From
  if (Came-Back) { Finish 'rolled_back' "$why The hub is back on the version it had." }
  Finish 'failed' "$why Going back did not bring the hub up either: run the install command again on this PC."
}

Set-Status 'installing' 'Installing the new version'
Hold-Hub
& git.exe -C $App merge --quiet --ff-only $script:To 2>$null
if ($LASTEXITCODE -ne 0) { Release-Hub; Finish 'failed' 'git could not move to the new version.' }
if (-not (Install-Code)) { Roll-Back "The new version's packages did not install." }
Set-Status 'restarting' 'Restarting the hub'
Release-Hub
if (-not (Came-Back)) { Roll-Back 'The new version did not start.' }
Finish 'done' 'Updated.'
