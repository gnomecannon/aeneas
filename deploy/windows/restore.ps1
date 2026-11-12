<#
.SYNOPSIS
  Put a backup back on a Windows hub (deploy\install.ps1), on the same PC or a new one where the installer has run.
.DESCRIPTION
    powershell -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\AeneasHub\app\deploy\windows\restore.ps1"
      lists the backups, newest first
    powershell -ExecutionPolicy Bypass -File "...\restore.ps1" hub-YYYYMMDD-HHMMSS.sqlite.age
      restores that one (a name in the backups folder, or the path of a copy from elsewhere)
  The same steps as deploy/restore.sh: it checks the backup opens and is whole BEFORE anything changes, stops the hub,
  moves the current database aside as hub.sqlite.before-restore-<time> (kept, never deleted), puts the backup in its
  place, and starts the hub. A backup made with another hub's key asks for the recovery key you saved (one line
  starting AGE-SECRET-KEY-1), typed or pasted without showing, and never written anywhere.
#>
param([string]$Backup = '')
$ErrorActionPreference = 'Stop'
$App = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$Root = Split-Path $App
$Run = Join-Path $Root 'run'
$EnvFile = Join-Path $Root 'config\hub.env'
$node = Join-Path $Root 'node\node.exe'
function Say([string]$t) { Write-Host "==> $t" }
function Die([string]$t) { Write-Host "error: $t" -ForegroundColor Red; exit 1 }
if (-not (Test-Path $EnvFile)) { Die "$EnvFile is not here; run this on the hub's PC as the user who installed it" }
if (-not (Test-Path $node)) { Die 'the hub is not installed here; run the install command first' }
$cfg = @{}
foreach ($l in [IO.File]::ReadAllLines($EnvFile)) { if ($l -match '^([A-Z0-9_]+)=(.*)$') { $cfg[$Matches[1]] = $Matches[2] } }
$Data = if ($cfg['EA_DATA_DIR']) { $cfg['EA_DATA_DIR'] } else { Join-Path $Root 'data' }
$Backups = if ($cfg['EA_BACKUP_DIR']) { $cfg['EA_BACKUP_DIR'] } else { Join-Path $Data 'backups' }
$Port = if ($cfg['EA_PORT']) { $cfg['EA_PORT'] } else { '8787' }

if (-not $Backup) {
  Say "Backups in $Backups, newest first:"
  $list = @(Get-ChildItem -File -LiteralPath $Backups -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '^hub-\d{8}-\d{6}\.sqlite\.age$' } | Sort-Object LastWriteTime -Descending | Select-Object -First 40)
  if ($list.Count) { $list | ForEach-Object { "  $($_.Name)" } } else { '  (none)' }
  "Restore one with: powershell -ExecutionPolicy Bypass -File `"$PSCommandPath`" <name>"
  exit 0
}
$src = if (Test-Path -LiteralPath $Backup -PathType Leaf) { (Resolve-Path -LiteralPath $Backup).Path } else { Join-Path $Backups $Backup }
if (-not (Test-Path -LiteralPath $src -PathType Leaf)) { Die "$Backup is not a file, and not a backup in $Backups" }

# The hub's own restore (src/main.ts restore SRC DEST): decrypts into DEST, which must not exist, and checks it.
function Restore-To([string]$dest) {
  Push-Location (Join-Path $App 'hub')
  try {
    $ErrorActionPreference = 'Continue'
    $out = & $node "--env-file=$EnvFile" --import tsx src/main.ts restore $src $dest 2>&1 | Out-String
    return @{ ok = ($LASTEXITCODE -eq 0); text = $out.Trim() }
  } finally { Pop-Location }
}
$work = Join-Path $env:TEMP "aeneas-restore-$PID"
New-Item -ItemType Directory -Force -Path $work | Out-Null
try {
  # 1. Check it opens and is whole, into a scratch file, before anything changes.
  Say "Checking $(Split-Path $src -Leaf)"
  $r = Restore-To (Join-Path $work 'check.sqlite')
  if (-not $r.ok) {
    if ($r.text -match 'not encrypted with this key|no backup key') {
      if ([Console]::IsInputRedirected) { Die 'this backup was made with another key; run this in a PowerShell window to give the recovery key' }
      Write-Host 'This backup was made with another hub''s key. Paste the recovery key you saved (AGE-SECRET-KEY-1...); it is not shown, and not written anywhere:'
      $secure = Read-Host -AsSecureString
      $env:EA_RECOVERY_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
      Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $work 'check.sqlite')
      $r = Restore-To (Join-Path $work 'check.sqlite')
      if (-not $r.ok) { Die (($r.text -split "`n")[-1]) }
    } else { Die (($r.text -split "`n")[-1]) }
  }
  Write-Host (($r.text -split "`n")[-1])
  Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $work 'check.sqlite')

  # 2. Swap it in with the hub stopped (its service keeps it stopped while run\hold-hub is there); the current
  #    database is kept beside it.
  $live = Join-Path $Data 'hub.sqlite'
  $kept = "$live.before-restore-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
  Say 'Stopping the hub'
  New-Item -ItemType File -Force -Path (Join-Path $Run 'hold-hub') | Out-Null
  $pidFile = Join-Path $Run 'hub.pid'
  if (Test-Path $pidFile) { try { Stop-Process -Id ([int](Get-Content $pidFile)) -Force } catch { } }
  for ($i = 0; $i -lt 30 -and (Test-Path $pidFile); $i++) { Start-Sleep -Milliseconds 500 }
  try {
    if (Test-Path $live) {
      Move-Item $live $kept
      foreach ($x in 'wal', 'shm') { if (Test-Path "$live-$x") { Move-Item "$live-$x" "$kept-$x" } }
      Say "The database it had is kept as $kept"
    }
    $r = Restore-To $live
    if (-not $r.ok) {
      if (Test-Path $kept) { Move-Item -Force $kept $live }
      Die 'the backup could not be put in place; the hub''s own database is back'
    }
  } finally {
    Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $Run 'hold-hub')
    Remove-Item Env:\EA_RECOVERY_KEY -ErrorAction SilentlyContinue
  }
  Say 'Starting the hub'
  $up = $false
  for ($i = 0; $i -lt 60 -and -not $up; $i++) { try { $null = Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$Port/health" -TimeoutSec 2; $up = $true } catch { Start-Sleep -Seconds 1 } }
  if ($up) { Say "Restored $(Split-Path $src -Leaf). Paired devices keep working; linked accounts are linked again in Settings, Connections." }
  else { Say "Restored, but the hub has not answered yet; see $Data\logs\hub.log" }
} finally { Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $work }
