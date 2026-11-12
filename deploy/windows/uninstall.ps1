<#
.SYNOPSIS
  Take the Aeneas hub off this Windows PC (deploy\install.ps1): the scheduled task that starts it, the programs the
  installer put in its folder (Node, MinGit, Ollama, Tor), and the app. Your data and keys are NOT deleted: the script
  ends by naming the folders that hold them, so you can copy them somewhere first and delete them yourself.
    powershell -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\AeneasHub\app\deploy\windows\uninstall.ps1"
  Asks once before changing anything (EA_UNINSTALL_YES=1 answers yes without asking). Nothing is sent anywhere.
#>
$ErrorActionPreference = 'Continue'
$App = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$Root = Split-Path $App
$Conf = Join-Path $Root 'config'
$EnvFile = Join-Path $Conf 'hub.env'
$cfg = @{}
if (Test-Path $EnvFile) { foreach ($l in [IO.File]::ReadAllLines($EnvFile)) { if ($l -match '^([A-Z0-9_]+)=(.*)$') { $cfg[$Matches[1]] = $Matches[2] } } }
$Data = if ($cfg['EA_DATA_DIR']) { $cfg['EA_DATA_DIR'] } else { Join-Path $Root 'data' }
$Port = if ($cfg['EA_PORT']) { $cfg['EA_PORT'] } else { '8787' }
$Models = if ($cfg['EA_MODELS_DIR']) { $cfg['EA_MODELS_DIR'] } else { Join-Path $Root 'models' }
function Say([string]$t) { Write-Host "==> $t" }
# Programs the installer put there, each marked with its .everythingapp file (one you installed yourself stays).
$programs = @('node', 'git', 'ollama', 'tor', 'searxng', 'python') | ForEach-Object { Join-Path $Root $_ } | Where-Object { (Test-Path (Join-Path $_ '.everythingapp')) -or ((Split-Path $_ -Leaf) -eq 'node' -and (Test-Path (Join-Path $_ 'node.exe'))) }

Write-Host 'This stops and removes the Aeneas hub and the scheduled task that starts it, and deletes:'
Write-Host "  $App (the app)"
foreach ($p in $programs) { Write-Host "  $p" }
Write-Host "It keeps your data ($Data), keys and settings ($Conf) and the models ($Models)."
if ([Console]::IsInputRedirected) {
  if ($env:EA_UNINSTALL_YES -ne '1') { Write-Host 'Run this in a PowerShell window, or with EA_UNINSTALL_YES=1.' -ForegroundColor Red; exit 1 }
} elseif ((Read-Host 'Go ahead? [y/N]') -notmatch '^(y|yes)$') { Write-Host 'Nothing was changed.'; exit 0 }

# The task: stopped (which stops the hub, Ollama and Tor with it), then removed. One registered by an administrator
# may need one to remove it: Windows asks.
# The firewall rule for the home network (made when that was chosen) goes under the same permission prompt.
$fwName = 'Aeneas hub (home network)'
$task = Get-ScheduledTask -TaskName 'Aeneas hub' -ErrorAction SilentlyContinue | Select-Object -First 1
if ($task) {
  $task | Stop-ScheduledTask -ErrorAction SilentlyContinue
  $task | Unregister-ScheduledTask -Confirm:$false -ErrorAction SilentlyContinue
}
$fw = [bool](Get-NetFirewallRule -DisplayName $fwName -ErrorAction SilentlyContinue)
if ((Get-ScheduledTask -TaskName 'Aeneas hub' -ErrorAction SilentlyContinue) -or $fw) {
  $what = @()
  if (Get-ScheduledTask -TaskName 'Aeneas hub' -ErrorAction SilentlyContinue) { $what += 'the scheduled task \Aeneas\Aeneas hub' }
  if ($fw) { $what += 'the firewall rules for the home network' }
  Say "Windows asks for permission (an administrator) to remove $($what -join ' and ')"
  $cmd = "Get-ScheduledTask -TaskName 'Aeneas hub' -ErrorAction SilentlyContinue | Unregister-ScheduledTask -Confirm:`$false; Get-NetFirewallRule -DisplayName '$fwName' -ErrorAction SilentlyContinue | Remove-NetFirewallRule;"
  try { Start-Process powershell.exe -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList "-NoProfile -Command $cmd" } catch { }
}
if ($task) {
  if (Get-ScheduledTask -TaskName 'Aeneas hub' -ErrorAction SilentlyContinue) { Say 'The scheduled task is still there: remove "Aeneas hub" in Task Scheduler (folder Aeneas) by hand' }
  else { Say 'The scheduled task is removed' }
}
if ($fw) {
  if (Get-NetFirewallRule -DisplayName $fwName -ErrorAction SilentlyContinue) { Say "The firewall rules are still there: remove \"$fwName\" in Windows Defender Firewall, Inbound Rules, by hand" }
  else { Say 'The firewall rules for the home network are removed' }
}
# Anything still running from the hub's folder (a service started by hand) is stopped; not the uninstaller, which can
# run from that folder too.
Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith("$Root\", [StringComparison]::OrdinalIgnoreCase) -and $_.Name -notlike 'Uninstall Aeneas hub*' -and $_.ProcessId -ne $PID } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine -like "*$Root*hub-service.ps1*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 2

# Only the HTTPS address the installer added for the hub's port; other Tailscale Serve settings stay.
$ts = (Get-Command tailscale.exe -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Source)
if (-not $ts -and (Test-Path "$env:ProgramFiles\Tailscale\tailscale.exe")) { $ts = "$env:ProgramFiles\Tailscale\tailscale.exe" }
if ($ts -and ((& $ts serve status 2>$null | Out-String) -match ":$Port\b")) {
  & $ts serve --https=$Port off 2>$null | Out-Null
  if ($LASTEXITCODE -eq 0) { Say "Tailscale Serve no longer serves port $Port" } else { Say "Tailscale Serve still serves port $Port; remove it with: tailscale serve --https=$Port off" }
}

# @(): with only one program left, $programs is one path, and a path plus a list makes one long string.
foreach ($p in @($programs) + @((Join-Path $Root 'run')) + @(Get-ChildItem -Directory -LiteralPath $Root -Filter 'work-*' -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName })) {
  Remove-Item -Recurse -Force -LiteralPath $p -ErrorAction SilentlyContinue
  if (Test-Path $p) { Say "$p could not be removed fully (a program still has a file open); delete it after a restart" } else { Say "Removed $p" }
}
Remove-Item -Recurse -Force -LiteralPath $App -ErrorAction SilentlyContinue
if (Test-Path $App) { Say "$App could not be removed fully; delete it after a restart" } else { Say "Removed $App" }
Write-Host ''
Write-Host 'Left in place, for you to keep or delete:'
Write-Host "  $Data   your data, backups and notes"
Write-Host "  $Conf   hub.env, the backup and work keys"
Write-Host "  $Models   the models, several GB"
Write-Host 'Paired phones and computers stop syncing; remove the app from them as usual.'
