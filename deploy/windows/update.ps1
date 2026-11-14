<#
.SYNOPSIS
  Update a Windows hub (deploy\install.ps1) to the newest code of its branch: started by the hub (Settings, About,
  Update hub, or the assistant), or by hand:
    powershell -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\AeneasHub\app\deploy\windows\update.ps1"
.DESCRIPTION
  The same steps as deploy/update.sh on Linux and macOS: git fetch the branch (main unless EA_REF says otherwise);
  nothing newer: "up to date"; refuse when files were changed by hand or the branch is not a fast forward (a shallow
  clone whose history does not link up is fetched in full once and asked again); else move to it, install its
  packages and the web app with the hub stopped (Windows will not replace files a running program has open), start
  the hub and wait for it twice. Meanwhile the packages (each node_modules folder) and the web app it had wait in
  app\.update-backup: when the new code does not install or the hub does not come back, it goes back to the commit it
  had and puts them back, with no npm ci and so no network. Progress goes to $EA_UPDATE_DIR\status.json (the hub
  reads it) and update.log.
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
# Where the packages and the web app of the version installed wait while npm ci installs new ones (it deletes
# node_modules first): a failed update puts them back, so the hub runs its old version again without the network that
# just failed.
$Backup = Join-Path $App '.update-backup'
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

# The hub's service (hub-service.ps1) keeps the hub stopped while run\hold-hub is there, and starts it again after.
function Hold-Hub {
  New-Item -ItemType File -Force -Path (Join-Path $Run 'hold-hub') | Out-Null
  $pidFile = Join-Path $Run 'hub.pid'
  if (Test-Path $pidFile) { try { Stop-Process -Id ([int](Get-Content $pidFile)) -Force -ErrorAction Stop } catch { } }
  for ($i = 0; $i -lt 30 -and (Test-Path $pidFile); $i++) { Start-Sleep -Milliseconds 500 }
}
function Release-Hub { Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $Run 'hold-hub') }

# Removes a folder with all in it. cmd's rmdir removes the links npm makes for workspaces (junctions) without going
# into the folders they point to, which Remove-Item in Windows PowerShell 5.1 does not promise. The path reaches cmd in
# a variable, inside quotes, so a & or a % in a folder name stays part of the name.
function Remove-Tree([string]$path) {
  if (Test-Path -LiteralPath $path) {
    $env:EA_REMOVE = $path
    try { Start-Process -FilePath $env:ComSpec -ArgumentList '/d /c rmdir /s /q "%EA_REMOVE%"' -NoNewWindow -Wait } catch { }
    Remove-Item -ErrorAction SilentlyContinue Env:\EA_REMOVE
  }
  return (-not (Test-Path -LiteralPath $path))
}
# Every node_modules folder under $base (the root's and the workspaces', never one inside another), then web\dist, as
# paths under $base.
function Package-Parts([string]$base) {
  $found = New-Object 'System.Collections.Generic.List[string]'
  $todo = New-Object 'System.Collections.Generic.List[string]'
  $todo.Add('')
  for ($i = 0; $i -lt $todo.Count; $i++) {
    $rel = $todo[$i]
    $dir = if ($rel) { Join-Path $base $rel } else { $base }
    $subs = @()
    try { $subs = (New-Object IO.DirectoryInfo $dir).GetDirectories() } catch { }
    foreach ($d in $subs) {
      $r = if ($rel) { "$rel\$($d.Name)" } else { $d.Name }
      if ($d.Name -eq 'node_modules') { $found.Add($r) }
      elseif ($d.Name -ne '.git' -and $d.Name -ne '.update-backup' -and ([int]$d.Attributes -band 1024) -eq 0) { $todo.Add($r) }
    }
  }
  if (Test-Path -LiteralPath (Join-Path $base 'web\dist')) { $found.Add('web\dist') }
  return $found.ToArray()
}
# The backup holds the packages of this commit.
function Backup-Fits([string]$commit) {
  $f = Join-Path $Backup '.commit'
  try { return [bool]($commit -and (Test-Path -LiteralPath $f) -and ([IO.File]::ReadAllText($f).Trim() -eq $commit)) } catch { return $false }
}
# Before npm ci (it deletes node_modules first), with the hub stopped: each node_modules folder and web\dist move into
# the backup (a rename on the same disk), with the commit they belong to. When one cannot be moved, what was moved goes
# back and the update goes on without a backup, as it did before.
function Set-Aside([string]$commit) {
  if (Backup-Fits $commit) { return }  # left by a stopped update and not put back: it already holds these packages
  if (-not (Remove-Tree $Backup) -or -not (Test-Path -LiteralPath (Join-Path $App 'node_modules'))) { return }
  try {
    $null = [IO.Directory]::CreateDirectory($Backup)
    [IO.File]::WriteAllText((Join-Path $Backup '.commit'), $commit, $Utf8)
    foreach ($p in @(Package-Parts $App)) {
      $to = Join-Path $Backup $p
      $null = [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($to))
      [IO.Directory]::Move((Join-Path $App $p), $to)
    }
    [IO.File]::WriteAllText((Join-Path $Backup '.complete'), '', $Utf8)
  } catch {
    Log "could not set the packages aside, so this update has no backup: $($_.Exception.Message)"
    $null = Put-Back
  }
}
# The parts set aside go back. From a whole backup, whatever a failed install left goes first (every node_modules
# folder, and web\dist when the backup has one); from one a crash cut short (no .complete), only the places it emptied
# are filled. The backup goes once all is back; when something could not be moved it stays, for the next run.
function Put-Back {
  if (-not (Test-Path -LiteralPath $Backup)) { return $true }
  $saved = @(Package-Parts $Backup)
  $whole = Test-Path -LiteralPath (Join-Path $Backup '.complete')
  if ($whole -and -not (Test-Path -LiteralPath (Join-Path $Backup '.cleared'))) {
    foreach ($p in @(Package-Parts $App)) {
      if ($p -eq 'web\dist' -and $saved -notcontains 'web\dist') { continue }
      if (-not (Remove-Tree (Join-Path $App $p))) { Log "could not remove $p, so nothing was put back"; return $false }
    }
    try { [IO.File]::WriteAllText((Join-Path $Backup '.cleared'), '', $Utf8) } catch { }
  }
  $ok = $true
  foreach ($p in $saved) {
    $to = Join-Path $App $p
    # Taken: a whole backup cannot go back there; from one a crash cut short, the app kept its own.
    if (Test-Path -LiteralPath $to) { if ($whole) { $ok = $false }; continue }
    try {
      $null = [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($to))
      [IO.Directory]::Move((Join-Path $Backup $p), $to)
    } catch { Log "could not put $p back: $($_.Exception.Message)"; $ok = $false }
  }
  if ($ok) { $null = Remove-Tree $Backup }
  return $ok
}
# After a web app build that did not work: the web app it had, when one was set aside.
function Put-Back-Web([string]$commit) {
  $saved = Join-Path $Backup 'web\dist'
  if ((Backup-Fits $commit) -and (Test-Path -LiteralPath $saved) -and (Remove-Tree (Join-Path $App 'web\dist'))) {
    try { [IO.Directory]::Move($saved, (Join-Path $App 'web\dist')) } catch { Log "could not put the web app back: $($_.Exception.Message)" }
  }
}

Log "==== $((Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')) update of $App ($Ref)"
if (Test-Path $Lock) {
  # A lock left by an update that was killed (a restart) is cleared after an hour.
  if ((Get-Item $Lock).LastWriteTime -lt (Get-Date).AddHours(-1)) { Remove-Item -Force -Recurse $Lock } else { Log 'another update is running'; exit 1 }
}
New-Item -ItemType Directory -Path $Lock | Out-Null

if ((Git @('rev-parse', '--is-inside-work-tree')) -ne 'true') { Finish 'failed' 'This hub was copied in, not installed with git, so it cannot update itself. Update it the way it was installed.' }
$script:From = Git @('rev-parse', 'HEAD')
# A backup that a stopped update left (Windows restarted during it): put back while the code is still on the commit it
# belongs to, else of no more use.
if (Test-Path -LiteralPath $Backup) {
  if (Backup-Fits $script:From) {
    Log 'putting back the packages a stopped update set aside'
    Hold-Hub
    if (-not (Put-Back)) { Log 'not everything set aside could be put back' }
    Release-Hub
  } else { $null = Remove-Tree $Backup }
}
Set-Status 'checking' 'Looking for a newer version'
if ((Run-Limited 120 'git.exe' @('-C', $App, 'fetch', '--quiet', 'origin', $Ref)) -ne 0) { Finish 'failed' "Could not reach the hub's code on GitHub. Try again later." }
$script:To = Git @('rev-parse', 'FETCH_HEAD')
if ($script:From -eq $script:To) { Finish 'up_to_date' 'This hub already has the newest version.' }
if (Git @('status', '--porcelain', '--untracked-files=no')) { Finish 'failed' "Files in $App were changed by hand, so the update would overwrite them. Keep or undo those changes first (git -C `"$App`" status shows them)." }
function Follows-On { $null = & git.exe -C $App merge-base --is-ancestor $script:From $script:To 2>$null; return ($LASTEXITCODE -eq 0) }
$follows = Follows-On
# A shallow clone that once took a fetch with --depth 1 (deploy\install.ps1 made those before) has a newest commit with
# no history linking it to this one, which reads as a rewritten branch: its whole history is fetched once, and the
# question asked again.
if (-not $follows -and (Git @('rev-parse', '--is-shallow-repository')) -eq 'true') {
  Log 'the history of this shallow clone does not link up: fetching all of it'
  if ((Run-Limited 120 'git.exe' @('-C', $App, 'fetch', '--quiet', '--unshallow', 'origin', $Ref)) -ne 0) { Finish 'failed' "Could not reach the hub's code on GitHub. Try again later." }
  $follows = Follows-On
}
if (-not $follows) { Finish 'failed' 'The newest version does not follow on from this one (the branch was rewritten). Update from a terminal with git.' }

function Health { try { $null = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 3; return $true } catch { return $false } }
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
  if ((Run-Limited 600 'npm.cmd' @('--workspace', 'web', 'run', 'build')) -ne 0) {
    Log 'the web app did not build; the hub still runs'
    Put-Back-Web $script:From
  }
  return $true
}
function Roll-Back([string]$why) {
  Set-Status 'rolling_back' "$why Going back to the version it had."
  Hold-Hub
  & git.exe -C $App reset --quiet --hard $script:From 2>$null
  # Its packages and web app, set aside before the install, go back as they were: no npm ci, so no network.
  if (Backup-Fits $script:From) { if (-not (Put-Back)) { Log 'not everything set aside could be put back' } }
  else { $null = Install-Code }
  Release-Hub
  $script:To = $script:From
  if (Came-Back) { Finish 'rolled_back' "$why The hub is back on the version it had." }
  Finish 'failed' "$why Going back did not bring the hub up either: run the install command again on this PC."
}

Set-Status 'installing' 'Installing the new version'
Hold-Hub
Set-Aside $script:From
& git.exe -C $App merge --quiet --ff-only $script:To 2>$null
if ($LASTEXITCODE -ne 0) { $null = Put-Back; Release-Hub; Finish 'failed' 'git could not move to the new version.' }
if (-not (Install-Code)) { Roll-Back "The new version's packages did not install." }
Set-Status 'restarting' 'Restarting the hub'
Release-Hub
if (-not (Came-Back)) { Roll-Back 'The new version did not start.' }
# The new version runs: what was set aside is of no more use.
$null = Remove-Tree $Backup
Finish 'done' 'Updated.'
