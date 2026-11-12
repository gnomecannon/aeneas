<#
.SYNOPSIS
  Print a one-time pairing link for another device, on a Windows hub (deploy\install.ps1).
.DESCRIPTION
  Asks the hub on this PC, with the main key from hub.env (sent in a header, never on a command line), for a pairing
  code: it works once, for 10 minutes. The link opens the Welcome page in a browser; the phone's camera opens the
  app's own link from the QR code on that page instead.
    powershell -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\AeneasHub\app\deploy\windows\pair-link.ps1" "Kitchen iPad"
.PARAMETER Name
  The device's name, shown in Settings, Devices (default: Browser).
#>
param([string]$Name = 'Browser')
$ErrorActionPreference = 'Stop'
$root = if ($env:EA_ROOT) { $env:EA_ROOT } else { Join-Path $env:LOCALAPPDATA 'AeneasHub' }
$envFile = Join-Path $root 'config\hub.env'
if (-not (Test-Path $envFile)) { Write-Host "No hub settings at $($envFile): is the hub installed for this Windows user?" -ForegroundColor Red; return }
$cfg = @{}
foreach ($l in [IO.File]::ReadAllLines($envFile)) { if ($l -match '^([A-Z0-9_]+)=(.*)$') { $cfg[$Matches[1]] = $Matches[2] } }
$port = if ($cfg['EA_PORT']) { $cfg['EA_PORT'] } else { '8787' }
$body = @{ name = $Name } | ConvertTo-Json -Compress
try {
  $r = Invoke-RestMethod -UseBasicParsing -Method Post -Uri "http://127.0.0.1:$port/devices/pairing" -Headers @{ authorization = "Bearer $($cfg['EA_TOKEN'])" } -ContentType 'application/json' -Body $body -TimeoutSec 10
} catch { Write-Host "The hub on port $port did not answer: is it running? (Task Scheduler, Aeneas, Aeneas hub)" -ForegroundColor Red; return }
Write-Host "Works once, for 10 minutes. Code: $($r.code)"
Write-Host ''
Write-Host "  Browser: $($r.web)"
Write-Host "  App:     $($r.app)"
