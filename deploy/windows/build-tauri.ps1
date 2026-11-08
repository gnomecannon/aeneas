<#
.SYNOPSIS
  Build the EverythingApp Windows app (Tauri) on a Windows PC.
.DESCRIPTION
  Run in an elevated PowerShell (Run as administrator) on that PC as your normal Windows user:
    Set-ExecutionPolicy -Scope Process Bypass -Force
    A:\repos\everythingapp\deploy\windows\build-tauri.ps1
  Or before the first clone, from wherever you downloaded this file:
    .\build-tauri.ps1 -RepoUrl https://github.com/gnomecannon/everythingapp.git
  Checks and installs with winget when missing: Rust (Rustlang.Rustup), Node 20 or newer (OpenJS.NodeJS.LTS),
  Visual Studio Build Tools with the C++ workload, WebView2 runtime. Then clones or pulls the repo,
  runs npm ci and npm --workspace web run tauri build, and prints the installer path.
.PARAMETER RepoDir
  Where the repo lives. Default A:\repos\everythingapp
.PARAMETER RepoUrl
  Git URL used when RepoDir does not exist yet.
.PARAMETER Branch
  Branch to check out. Default main.
.PARAMETER SkipPull
  Do not git pull; build what is on disk.
#>
[CmdletBinding()]
param(
  [string]$RepoDir = 'A:\repos\everythingapp',
  [string]$RepoUrl = 'https://github.com/gnomecannon/everythingapp.git',
  [string]$Branch = 'main',
  [switch]$SkipPull
)

$ErrorActionPreference = 'Stop'
$NodeMajorRequired = 20

function Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Fail($msg) { Write-Host "ERROR: $msg" -ForegroundColor Red; exit 1 }

function Refresh-Path {
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path += ';' + (Join-Path $env:USERPROFILE '.cargo\bin')
}

function Winget-Install($id, $extraArgs = @()) {
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    Fail "winget is not available. Install 'App Installer' from the Microsoft Store, then run this script again."
  }
  # winget shows its source terms and the package's terms to accept; this script accepts nothing on your behalf.
  Write-Host "installing $id with winget (it shows the terms to accept)"
  & winget install --id $id --exact @extraArgs
  if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne -1978335189) { Fail "winget install $id failed with exit code $LASTEXITCODE" }
  Refresh-Path
}

# ---- Rust ----
Step 'Rust toolchain'
Refresh-Path
if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
  Winget-Install 'Rustlang.Rustup'
  Refresh-Path
  & rustup default stable-msvc
}
if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) { Fail 'cargo still not on PATH. Close this window, open a new elevated PowerShell, run again.' }
Write-Host (& cargo --version)
Write-Host (& rustc --version)

# ---- Node ----
Step "Node $NodeMajorRequired or newer"
$nodeOk = $false
if (Get-Command node -ErrorAction SilentlyContinue) {
  $v = (& node -p 'process.versions.node.split(".")[0]')
  if ([int]$v -ge $NodeMajorRequired) { $nodeOk = $true }
}
if (-not $nodeOk) {
  Winget-Install 'OpenJS.NodeJS.LTS'
  Refresh-Path
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Fail 'node still not on PATH. Close this window, open a new elevated PowerShell, run again.' }
Write-Host ("node " + (& node --version) + ", npm " + (& npm --version))

# ---- Visual Studio Build Tools with C++ ----
Step 'Visual Studio Build Tools (C++ workload)'
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
$hasCpp = $false
if (Test-Path $vswhere) {
  $found = & $vswhere -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
  if ($found) { $hasCpp = $true; Write-Host "found: $found" }
}
if (-not $hasCpp) {
  Winget-Install 'Microsoft.VisualStudio.2022.BuildTools' @('--override', '--passive --wait --norestart --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended')
  if (Test-Path $vswhere) {
    $found = & $vswhere -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    if ($found) { $hasCpp = $true; Write-Host "installed: $found" }
  }
  if (-not $hasCpp) { Fail 'C++ build tools still missing. Open Visual Studio Installer, modify Build Tools 2022, tick "Desktop development with C++", then run again.' }
}

# ---- WebView2 ----
Step 'WebView2 runtime'
$wv2Keys = @(
  'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
  'HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
  'HKCU:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
)
$wv2 = $wv2Keys | Where-Object { Test-Path $_ } | ForEach-Object { (Get-ItemProperty $_).pv } | Select-Object -First 1
if ($wv2) { Write-Host "found: $wv2" } else { Winget-Install 'Microsoft.EdgeWebView2Runtime' }

# ---- repo ----
Step "repo at $RepoDir"
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Winget-Install 'Git.Git'; Refresh-Path }
if (Test-Path (Join-Path $RepoDir '.git')) {
  if (-not $SkipPull) {
    & git -C $RepoDir fetch --quiet origin
    & git -C $RepoDir checkout --quiet $Branch
    & git -C $RepoDir pull --ff-only --quiet
    if ($LASTEXITCODE -ne 0) { Fail 'git pull failed' }
  }
  Write-Host ("at " + (& git -C $RepoDir rev-parse --short HEAD))
} elseif (Test-Path (Join-Path $RepoDir 'package.json')) {
  Write-Host 'repo folder exists without .git (copied); building what is there'
} else {
  if (-not $RepoUrl) { Fail "$RepoDir does not exist. Pass -RepoUrl <git url> to clone it, or copy the repo there." }
  New-Item -ItemType Directory -Force -Path (Split-Path $RepoDir) | Out-Null
  & git clone --branch $Branch $RepoUrl $RepoDir
  if ($LASTEXITCODE -ne 0) { Fail 'git clone failed' }
}

# ---- build ----
Step 'npm ci (the web app only)'
Push-Location $RepoDir
try {
  # Only the web workspace: the Windows app is the web app in a window, and the hub's packages include a native
  # SQLite module that has to be compiled for this machine's Node (it failed on Node 26 on 2026-11-05).
  & npm ci --no-audit --no-fund --workspace web
  if ($LASTEXITCODE -ne 0) { Fail 'npm ci failed' }

  Step 'npm --workspace web run tauri build'
  & npm --workspace web run tauri build
  if ($LASTEXITCODE -ne 0) { Fail 'tauri build failed (scroll up for the first error)' }
} finally {
  Pop-Location
}

# ---- result ----
Step 'installer'
$bundle = Join-Path $RepoDir 'web\src-tauri\target\release\bundle'
$installers = @()
if (Test-Path $bundle) {
  $installers = Get-ChildItem -Path $bundle -Recurse -Include '*.exe', '*.msi' -File | Sort-Object LastWriteTime -Descending
}
if (-not $installers) { Fail "no installer found under $bundle" }
foreach ($i in $installers) { Write-Host ("  " + $i.FullName + "  (" + [math]::Round($i.Length / 1MB, 1) + " MB)") }
Write-Host "`nInstall by double-clicking the newest .exe above (NSIS installer)." -ForegroundColor Green
