<#
.SYNOPSIS
  Pull the local models the hub uses from Ollama on a Windows PC with a graphics card.
.DESCRIPTION
  Run in PowerShell on that PC as your normal Windows user:
    Set-ExecutionPolicy -Scope Process Bypass -Force
    A:\repos\everythingapp\deploy\windows\install-ollama-model.ps1
  Pulls the models named in -Models if they are not already present (default qwen3:8b, about 5 GB; the hub's
  Welcome page shows the one that fits this graphics card, pass that name with -Models).
.PARAMETER Models
  Override the model list.
.PARAMETER ListenOnTailnet
  Also make Ollama reachable from the hub's machine over Tailscale: sets the user environment variable OLLAMA_HOST to
  this PC's Tailscale address (port 11434, so the home network and web pages open on this PC cannot reach it),
  opens Windows Firewall port 11434 for the Tailscale range 100.64.0.0/10 only, and restarts Ollama.
  Needs an elevated PowerShell for the firewall rule.
.PARAMETER TailnetDomain
  Your tailnet's DNS name (for example tail1234.ts.net), only used to print the address the hub should reach.
  Default: the EA_TAILNET_DOMAIN environment variable; when neither is set the address is printed with a placeholder.
#>
[CmdletBinding()]
param(
  [string[]]$Models = @('qwen3:8b'),
  [switch]$ListenOnTailnet,
  [string]$TailnetDomain = $env:EA_TAILNET_DOMAIN
)

$ErrorActionPreference = 'Stop'
function Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Fail($msg) { Write-Host "ERROR: $msg" -ForegroundColor Red; exit 1 }

Step 'ollama'
$env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
if (-not (Get-Command ollama -ErrorAction SilentlyContinue)) {
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) { Fail 'ollama is not installed and winget is missing. Install Ollama from https://ollama.com/download/windows' }
  # winget shows the terms of its source and of the Ollama package to accept; nothing is accepted on your behalf.
  Write-Host 'Installing Ollama (MIT) with winget, from the winget community repository.'
  & winget install --id Ollama.Ollama --exact
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
  if (-not (Get-Command ollama -ErrorAction SilentlyContinue)) { Fail 'ollama still not on PATH. Open a new PowerShell and run again.' }
}
Write-Host (& ollama --version)

Step 'cloud features off'
# Ollama's own switch for its cloud features (models run on ollama.com, its web search). Ollama reads it when it starts.
if ([Environment]::GetEnvironmentVariable('OLLAMA_NO_CLOUD', 'User') -ne '1') {
  [Environment]::SetEnvironmentVariable('OLLAMA_NO_CLOUD', '1', 'User')
  Write-Host 'OLLAMA_NO_CLOUD=1 set for your user. Quit Ollama from the tray and start it again for it to apply.'
} else { Write-Host 'already off (OLLAMA_NO_CLOUD=1)' }

Step 'models present'
$present = @()
$listOutput = & ollama list 2>$null
if ($LASTEXITCODE -ne 0) { Fail 'ollama list failed. Is the Ollama app running? Start it from the Start menu, then run again.' }
foreach ($line in ($listOutput | Select-Object -Skip 1)) {
  $name = ($line -split '\s+')[0]
  if ($name) { $present += $name }
}
if ($present) { Write-Host ("  " + ($present -join "`n  ")) } else { Write-Host '  none' }

foreach ($m in $Models) {
  Step "model $m"
  if ($present -contains $m) {
    Write-Host 'already present'
    continue
  }
  & ollama pull $m
  if ($LASTEXITCODE -ne 0) { Fail "ollama pull $m failed" }
}

if ($ListenOnTailnet) {
  $tsip = $null
  if (Get-Command tailscale -ErrorAction SilentlyContinue) { $tsip = (& tailscale ip -4 2>$null | Select-Object -First 1) }
  if (-not $tsip) { Fail 'Tailscale is not running here, so there is no tailnet address to listen on. Start Tailscale, then run again.' }
  Step "expose Ollama on the tailnet only (OLLAMA_HOST=${tsip}:11434)"
  [Environment]::SetEnvironmentVariable('OLLAMA_HOST', "${tsip}:11434", 'User')
  # No OLLAMA_ORIGINS: web pages in a browser on this PC must not be able to use the model server.
  $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  if ($isAdmin) {
    if (-not (Get-NetFirewallRule -DisplayName 'Ollama tailnet' -ErrorAction SilentlyContinue)) {
      New-NetFirewallRule -DisplayName 'Ollama tailnet' -Direction Inbound -Protocol TCP -LocalPort 11434 -RemoteAddress 100.64.0.0/10 -Action Allow | Out-Null
      Write-Host 'firewall rule added: TCP 11434 from 100.64.0.0/10'
    } else { Write-Host 'firewall rule exists' }
  } else {
    Write-Host 'not elevated: firewall rule skipped. Run this script again as administrator with -ListenOnTailnet to add it.' -ForegroundColor Yellow
  }
  Get-Process -Name 'ollama', 'ollama app' -ErrorAction SilentlyContinue | Stop-Process -Force
  Start-Sleep -Seconds 2
  $app = Join-Path $env:LOCALAPPDATA 'Programs\Ollama\ollama app.exe'
  if (Test-Path $app) { Start-Process $app } else { Write-Host 'start the Ollama app from the Start menu' -ForegroundColor Yellow }
  Start-Sleep -Seconds 5
}

Step 'verify'
# After -ListenOnTailnet, Ollama answers on the Tailscale address only.
$hereAddr = if ($ListenOnTailnet -and $tsip) { "${tsip}:11434" } else { '127.0.0.1:11434' }
try {
  $tags = Invoke-RestMethod -Uri "http://$hereAddr/api/tags" -TimeoutSec 10
  Write-Host ("Ollama answers on $hereAddr with " + $tags.models.Count + " models")
} catch {
  Write-Host "Ollama did not answer on $hereAddr. Start the Ollama app and run again." -ForegroundColor Yellow
}
$pcName = $env:COMPUTERNAME.ToLower()
$tailnetHost = if ($TailnetDomain) { "$pcName.$($TailnetDomain.Trim('.'))" } else { "$pcName.<your-tailnet>.ts.net" }
Write-Host "From the hub's machine, this should return JSON:  curl -s http://${tailnetHost}:11434/api/tags"
