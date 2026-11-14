# Aeneas hub for Windows, one command. In PowerShell, as your normal user (not "Run as administrator"):
#
#   irm https://raw.githubusercontent.com/gnomecannon/aeneas/main/deploy/install.ps1 | iex
#
# Windows 10 or 11, 64-bit (x64), with Tailscale installed and signed in (tailscale.com/download/windows): devices
# reach the hub through it, with a real certificate. Run it again to update. What it does, all in
# %LOCALAPPDATA%\AeneasHub (EA_ROOT chooses another folder):
#   1. Node 20 in node\ and, when this PC has no git, MinGit in git\ (both checked against published SHA-256 sums);
#   2. the app in app\ (git clone), its packages and the web app;
#   3. config\hub.env with a new random token (kept on later runs);
#   4. where AI models are kept (asked; Enter keeps the default), and Ollama (MIT) in ollama\, run on 127.0.0.1:11434,
#      unless a model server already answers there. No model is downloaded: the Welcome page shows the one that fits;
#   5. Tor in tor\: the assistant's web lookups (off until turned on in the app) leave only through it;
#   6. a scheduled task, "\Aeneas\Aeneas hub", that starts the hub at boot, before anyone logs in. Windows asks once for
#      permission (an administrator) to register it. deploy\windows\hub-service.ps1 then keeps the hub, Ollama and Tor
#      running and asks Windows not to sleep while on AC power;
#   7. HTTPS on your tailnet through Tailscale Serve, and a link that opens the Welcome page already connected.
# Downloads: Node from nodejs.org and MinGit and Ollama from GitHub, each against its published SHA-256; Tor from
# torproject.org against its sums file; the app from GitHub with git, against its commits; npm packages against the lock
# file's hashes.
#
# Options (environment variables, set in the same PowerShell first, like $env:EA_PORT = "8788"): EA_ROOT, EA_PORT
# (8787), EA_REPO_URL, EA_REF (main), EA_MODELS_DIR (where models go, without asking), EA_NO_OLLAMA=1, EA_OLLAMA_PORT
# (11434), EA_TOR=0 (no Tor: web lookups stay off), EA_TOR_PORT (9052), EA_LINK (how devices reach the hub: direct, the
# default, through iroh with no account; tailscale; or home, the home network only).

function Install-AeneasHub {
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

  $NodeVersion = '20.20.2'
  $GitVersion = '2.56.0.4'
  $GitTag = 'v2.56.0.windows.4'
  $GitZipSum = 'e3bf78351fe777fba47ddee5950082f8a98bb0f02604fdc7ba3ee2cb68ffa877'
  $OllamaVersion = '0.40.14'
  $OllamaZipSum = '65d68cade6cf6375f398b518224f8c8a15e062387f38cf477abfc848de7e7e29'
  $RepoUrl = if ($env:EA_REPO_URL) { $env:EA_REPO_URL } else { 'https://github.com/gnomecannon/aeneas.git' }
  $Ref = if ($env:EA_REF) { $env:EA_REF } else { 'main' }
  $Root = if ($env:EA_ROOT) { $env:EA_ROOT.TrimEnd('\') } else { Join-Path $env:LOCALAPPDATA 'AeneasHub' }
  $App = Join-Path $Root 'app'
  $Conf = Join-Path $Root 'config'
  $Data = Join-Path $Root 'data'
  $Run = Join-Path $Root 'run'
  $Logs = Join-Path $Data 'logs'
  $NodeDir = Join-Path $Root 'node'
  $GitDir = Join-Path $Root 'git'
  $OllamaDir = Join-Path $Root 'ollama'
  $TorDir = Join-Path $Root 'tor'
  $Work = Join-Path $Root "work-$PID"
  $EnvFile = Join-Path $Conf 'hub.env'
  $ServicesFile = Join-Path $Conf 'services.json'
  $TaskPath = '\Aeneas\'
  $TaskName = 'Aeneas hub'
  $Utf8 = New-Object Text.UTF8Encoding $false

  function Say([string]$t) { Write-Host "==> $t" -ForegroundColor Cyan }
  function Note([string]$t) { Write-Host "    $t" }
  function Fail([string]$t) { throw "error: $t" }
  # Run by the Windows installer (Aeneas-Hub-Setup.exe): no questions here (its pages asked them), and the browser
  # opens for sign-ins and the Welcome page.
  $Installer = $env:EA_INSTALLER -eq '1'
  $CanAsk = -not $Installer -and [Environment]::UserInteractive -and -not [Console]::IsInputRedirected
  function Ask([string]$q, [bool]$default) {
    if (-not $CanAsk) { return $default }
    $hint = if ($default) { 'Y/n' } else { 'y/N' }
    $a = Read-Host "    $q [$hint]"
    if ($a -match '^[Yy]') { return $true }
    if ($a -match '^[Nn]') { return $false }
    return $default
  }
  function Write-Text([string]$path, [string]$text) { [IO.File]::WriteAllText($path, $text, $Utf8) }
  # A program outside PowerShell (curl, tar, git, npm, tailscale). Windows PowerShell 5.1 turns what such a program
  # writes on its error output (a warning, a progress bar) into errors, which would stop this script; whether it worked
  # is its exit code ($LASTEXITCODE), checked after each call.
  function X {
    $ErrorActionPreference = 'Continue'
    $exe, $rest = $args
    & $exe @rest
  }
  # curl.exe comes with Windows 10 1803 and later: HTTPS only, retried, given up when it stalls for a minute.
  function Fetch([string]$out, [string]$url, [int]$seconds, [switch]$Bar) {
    $a = @('-fL', '--proto', '=https', '--proto-redir', '=https', '--retry', '2', '--connect-timeout', '20', '--max-time', "$seconds", '--speed-limit', '2048', '--speed-time', '60', '-o', $out, $url)
    if ($Bar -and $CanAsk) { $a = @('-#') + $a } else { $a = @('-sS') + $a }
    X curl.exe @a
    return ($LASTEXITCODE -eq 0)
  }
  function Sha256([string]$f) { (Get-FileHash -Algorithm SHA256 -LiteralPath $f).Hash.ToLower() }
  function Answers([string]$url) {
    try { $null = Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 2; return $true } catch { return $false }
  }
  function Wait-For([int]$n, [string]$url) { for ($i = 0; $i -lt $n; $i++) { if (Answers $url) { return $true }; Start-Sleep -Seconds 1 }; return $false }
  function Port-Busy([int]$port) {
    $c = New-Object Net.Sockets.TcpClient
    try { $c.Connect('127.0.0.1', $port); return $true } catch { return $false } finally { $c.Close() }
  }

  # Programs the hub's service runs are held (stopped, not started again) while their files are replaced: Windows
  # will not replace a file a running program has open (deploy\windows\hub-service.ps1 reads run\hold-<name>).
  function Hold([string]$name) {
    New-Item -ItemType Directory -Force -Path $Run | Out-Null
    New-Item -ItemType File -Force -Path (Join-Path $Run "hold-$name") | Out-Null
    $pidFile = Join-Path $Run "$name.pid"
    if (Test-Path $pidFile) { try { Stop-Process -Id ([int](Get-Content $pidFile)) -Force -ErrorAction Stop } catch { } }
    for ($i = 0; $i -lt 20 -and (Test-Path $pidFile); $i++) { Start-Sleep -Milliseconds 500 }
  }
  function Release([string]$name) { Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $Run "hold-$name") }
  function Find-Task { Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue | Select-Object -First 1 }

  # hub.env, one KEY=value a line, UTF-8 without a byte order mark (node --env-file reads it at every start).
  $script:EnvChanged = $false
  function Get-Env([string]$k) {
    if (-not (Test-Path -LiteralPath $EnvFile)) { return '' }
    $v = ''
    foreach ($l in [IO.File]::ReadAllLines($EnvFile)) { if ($l.StartsWith("$k=")) { $v = $l.Substring($k.Length + 1) } }
    return $v
  }
  function Set-Env([string]$k, [string]$v) {
    $lines = @()
    if (Test-Path -LiteralPath $EnvFile) { $lines = @([IO.File]::ReadAllLines($EnvFile)) }
    $have = @($lines | Where-Object { $_.StartsWith("$k=") })
    if ($have.Count -eq 1 -and $have[0] -eq "$k=$v") { return }
    $lines = @($lines | Where-Object { -not $_.StartsWith("$k=") }) + "$k=$v"
    Write-Text $EnvFile (($lines -join "`n") + "`n")
    $script:EnvChanged = $true
  }

  # Run by the installer, every line also goes to data\logs\install.log, from the first check on, to read after a run
  # that stopped.
  if ($Installer) { try { New-Item -ItemType Directory -Force -Path $Logs | Out-Null; Start-Transcript -Path (Join-Path $Logs 'install.log') -Append | Out-Null } catch { } }
  # ---- 0. what this needs ----
  # A 32-bit PowerShell on 64-bit Windows says x86 here (the real one is in PROCESSOR_ARCHITEW6432) and sees
  # Program Files (x86): it must be the 64-bit one (the installer starts that one).
  $arch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
  if (-not [Environment]::Is64BitOperatingSystem -or $arch -ne 'AMD64') { Fail 'this installer is for 64-bit Windows on Intel or AMD processors (x64)' }
  if (-not [Environment]::Is64BitProcess) { Fail 'this is the 32-bit PowerShell: run it from Windows PowerShell in the Start menu (not the one marked x86)' }
  if (-not (Get-Command curl.exe -ErrorAction SilentlyContinue) -or -not (Get-Command tar.exe -ErrorAction SilentlyContinue)) { Fail 'curl.exe and tar.exe are needed (Windows 10 version 1803 or newer has both)' }
  function Find-Tailscale {
    $t = (Get-Command tailscale.exe -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Source)
    if (-not $t -and (Test-Path "$env:ProgramFiles\Tailscale\tailscale.exe")) { $t = "$env:ProgramFiles\Tailscale\tailscale.exe" }
    return $t
  }
  function Tailscale-State { try { return ((X $ts status --json 2>$null | Out-String) | ConvertFrom-Json) } catch { return $null } }

  New-Item -ItemType Directory -Force -Path $Root, $Conf, $Data, $Run, $Logs, (Join-Path $Data 'vault'), (Join-Path $Data 'backups'), $Work | Out-Null
  try {
    $Port = if ($env:EA_PORT) { [int]$env:EA_PORT } elseif (Get-Env 'EA_PORT') { [int](Get-Env 'EA_PORT') } else { 8787 }
    Say "Installing the Aeneas hub into $Root"
    # How devices reach the hub (hub/src/link.ts): what the installer page chose, else what this PC used before.
    $Method = if ($env:EA_LINK -in 'direct', 'tailscale', 'home') { $env:EA_LINK }
            elseif ((Get-Env 'EA_LINK') -in 'direct', 'tailscale', 'home') { Get-Env 'EA_LINK' }
            elseif ((Get-Env 'EA_PUBLIC_URL') -match '\.ts\.net(:\d+)?$') { 'tailscale' }
            else { 'direct' }
    Say "$(switch ($Method) { 'direct' { 'Devices reach the hub through Direct link (iroh): no account, the pairing QR code carries the hub''s key' } 'tailscale' { 'Devices reach the hub through Tailscale' } 'home' { 'Devices reach the hub on your home network only' } })"
    # The home network's address: the adapter with the way out (not a virtual one for WSL or Hyper-V), and how Windows
    # treats that network (Public blocks other devices).
    $lan = Get-NetIPConfiguration -ErrorAction SilentlyContinue | Where-Object { $_.IPv4DefaultGateway -and $_.NetAdapter.Status -eq 'Up' } | Select-Object -First 1
    $LanIp = if ($lan) { [string]@($lan.IPv4Address)[0].IPAddress } else { '' }
    $LanProfile = if ($lan) { [string](Get-NetConnectionProfile -InterfaceIndex $lan.InterfaceIndex -ErrorAction SilentlyContinue).NetworkCategory } else { '' }
    if ($Method -eq 'home' -and -not $LanIp) { Fail 'this PC is not on a network with a router, so other devices cannot reach it at home. Connect it to your home network (Wi-Fi or a cable), then run the installer again' }
    $FwName = 'Aeneas hub (home network)'
    $NodeExe = Join-Path $NodeDir 'node.exe'
    $fwRule = Get-NetFirewallRule -DisplayName $FwName -ErrorAction SilentlyContinue
    # Two rules under one name: the hub's port (TCP), and Bonjour (UDP 5353), where the hub tells devices its address
    # again after the router hands this PC a new one (hub/src/announce.ts).
    $fwFilters = @($fwRule | Get-NetFirewallPortFilter -ErrorAction SilentlyContinue)
    $fwTcp = [bool]($fwFilters | Where-Object { [string]$_.Protocol -eq 'TCP' -and [string]$_.LocalPort -eq [string]$Port })
    $fwMdns = [bool]($fwFilters | Where-Object { [string]$_.Protocol -eq 'UDP' -and [string]$_.LocalPort -eq '5353' })
    $needFw = $Method -eq 'home' -and -not ($fwTcp -and $fwMdns)
    $dropFw = $Method -ne 'home' -and [bool]$fwRule

    # ---- 0. the boot task, and Tailscale or the firewall: the one step that needs Windows' permission ----
    # With Tailscale chosen and not on this PC, it is downloaded from tailscale.com and checked against its published
    # SHA-256. With the home network chosen, a firewall rule lets this hub's own Node program (and nothing else) take
    # connections on its port from private networks only. Each happens under the same single permission prompt as
    # registering the task that starts the hub at boot.
    $ts = Find-Tailscale
    $runner = Join-Path $App 'deploy\windows\hub-service.ps1'
    $action = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$runner`" -Root `"$Root`""
    $desc = 'Runs the Aeneas hub (and its Ollama, Tor and search) from boot, before anyone logs in. Made by the Aeneas hub installer; remove it with Aeneas hub in Settings, Apps.'
    $me = [Security.Principal.WindowsIdentity]::GetCurrent()
    $elevated = (New-Object Security.Principal.WindowsPrincipal $me).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    $task = Find-Task
    $taskOk = $task -and ($task.Actions | Where-Object { $_.Arguments -eq $action }) -and $task.Principal.UserId -match [regex]::Escape($env:USERNAME)
    $msi = ''
    if ($Method -eq 'tailscale' -and -not $ts) {
      Say 'Your devices reach the hub through Tailscale, which is not on this PC yet: downloading it from tailscale.com (about 30 MB, checked against its published checksum)'
      $tsMsi = ''
      try { $tsMsi = [string](Invoke-RestMethod -UseBasicParsing -TimeoutSec 30 'https://pkgs.tailscale.com/stable/?mode=json').MSIs.amd64 } catch { }
      if ($tsMsi -notmatch '^tailscale-setup-[0-9.]+-amd64\.msi$') { Fail 'tailscale.com did not say which Tailscale is current; run the installer again later' }
      if (-not (Fetch "$Work\$tsMsi.sha256" "https://pkgs.tailscale.com/stable/$tsMsi.sha256" 60) -or -not (Fetch "$Work\$tsMsi" "https://pkgs.tailscale.com/stable/$tsMsi" 900)) { Fail 'the Tailscale download did not finish; run the installer again later' }
      $want = ((Get-Content "$Work\$tsMsi.sha256" -Raw).Trim() -split '\s+')[0].ToLower()
      if ((Sha256 "$Work\$tsMsi") -ne $want) { Fail 'the Tailscale download does not match its published checksum, so it was not used' }
      $msi = "$Work\$tsMsi"
    }
    if ($msi -or -not $taskOk -or $needFw -or $dropFw) {
      # Its settings go in a file beside it: Windows PowerShell 5.1 drops the quotes inside an argument it passes to
      # another program, and the task's command line quotes its paths (a user name may have a space).
      $reg = Join-Path $Work 'with-permission.ps1'
      Write-Text $reg @'
param([string]$Spec)
$ErrorActionPreference = 'Stop'
$j = [IO.File]::ReadAllText($Spec) | ConvertFrom-Json
if ($j.msi) {
  $p = Start-Process -FilePath msiexec.exe -ArgumentList "/i `"$($j.msi)`" /quiet /norestart" -Wait -PassThru
  if ($p.ExitCode -ne 0 -and $p.ExitCode -ne 3010) { exit 2 }
}
if ($j.dropFirewall -or $j.firewall) { Get-NetFirewallRule -DisplayName ([string]$j.firewallName) -ErrorAction SilentlyContinue | Remove-NetFirewallRule }
if ($j.firewall) {
  $null = New-NetFirewallRule -DisplayName ([string]$j.firewallName) -Description 'Lets devices on your home network reach the Aeneas hub. Made by the Aeneas hub installer; removed with Aeneas hub in Settings, Apps.' -Direction Inbound -Action Allow -Protocol TCP -LocalPort ([int]$j.firewall) -Program ([string]$j.program) -Profile Private
  $null = New-NetFirewallRule -DisplayName ([string]$j.firewallName) -Description 'Lets devices on your home network find the Aeneas hub again when the router gives this PC a new address (Bonjour). Made by the Aeneas hub installer; removed with Aeneas hub in Settings, Apps.' -Direction Inbound -Action Allow -Protocol UDP -LocalPort 5353 -Program ([string]$j.program) -Profile Private
}
if ($j.arguments) {
  $s = New-Object -ComObject Schedule.Service
  $s.Connect()
  $rootFolder = $s.GetFolder('\')
  try { $folder = $s.GetFolder('\Aeneas') } catch { $folder = $rootFolder.CreateFolder('Aeneas') }
  $d = $s.NewTask(0)
  $d.RegistrationInfo.Description = [string]$j.description
  $d.Settings.Enabled = $true
  $d.Settings.StartWhenAvailable = $true
  $d.Settings.DisallowStartIfOnBatteries = $false
  $d.Settings.StopIfGoingOnBatteries = $false
  $d.Settings.ExecutionTimeLimit = 'PT0S'
  $d.Settings.MultipleInstances = 2
  $d.Settings.RestartInterval = 'PT1M'
  $d.Settings.RestartCount = 999
  $d.Settings.Priority = 5
  $d.Settings.IdleSettings.StopOnIdleEnd = $false
  $null = $d.Triggers.Create(8)
  $a = $d.Actions.Create(0)
  $a.Path = 'powershell.exe'
  $a.Arguments = [string]$j.arguments
  $d.Principal.UserId = [string]$j.user
  $d.Principal.LogonType = 2
  $d.Principal.RunLevel = 0
  $sddl = "D:(A;;FA;;;SY)(A;;FA;;;BA)(A;;GRGWGX;;;$($j.sid))"
  $null = $folder.RegisterTaskDefinition('Aeneas hub', $d, 6, [string]$j.user, $null, 2, $sddl)
}
'@
      $spec = Join-Path $Work 'with-permission.json'
      Write-Text $spec (ConvertTo-Json -InputObject ([ordered]@{ msi = $msi; user = $me.Name; sid = $me.User.Value; arguments = $(if ($taskOk) { '' } else { $action }); description = $desc; firewall = $(if ($needFw) { $Port } else { 0 }); dropFirewall = $dropFw; firewallName = $FwName; program = $NodeExe }))
      $what = @()
      if ($msi) { $what += 'install Tailscale' }
      if ($needFw) { $what += "let devices on your home network reach the hub (firewall rules for its port $Port and for Bonjour, so devices find it again after the router gives this PC a new address; private networks only)" }
      if ($dropFw) { $what += 'remove the firewall rule for the home network, which this choice no longer needs' }
      if (-not $taskOk) { $what += 'register the task that starts the hub at boot, before anyone logs in' }
      if ($elevated) { X powershell.exe -NoProfile -ExecutionPolicy Bypass -File $reg -Spec $spec }
      else {
        Say "Windows now asks once for permission (an administrator), to $($what -join ' and ')"
        try { Start-Process powershell.exe -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$reg`" -Spec `"$spec`"" } catch { }
      }
      $ts = Find-Tailscale
      if ($needFw -and -not (Get-NetFirewallRule -DisplayName $FwName -ErrorAction SilentlyContinue)) { Fail 'Windows did not get permission to let your home network reach the hub. Run the installer again and choose Yes when Windows asks' }
      if ($Method -eq 'tailscale' -and -not $ts) { Fail 'Tailscale could not be installed: Windows did not get permission. Run the installer again and choose Yes when Windows asks' }
      if (-not $taskOk) {
        if (Find-Task) { Say 'The hub will start at boot, before anyone logs in (the scheduled task "\Aeneas\Aeneas hub")' }
        else {
          # No permission: a task that starts at this user's logon needs none (in the root folder, which needs none
          # either). The hub then runs only while this user is logged in.
          Say 'The permission was not given, so the hub starts when you log in to Windows instead of at boot (run the installer again to change it)'
          $act = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $action
          $trg = New-ScheduledTaskTrigger -AtLogOn -User $me.Name
          $set = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
          $prn = New-ScheduledTaskPrincipal -UserId $me.Name -LogonType Interactive -RunLevel Limited
          $null = Register-ScheduledTask -TaskPath '\' -TaskName $TaskName -Action $act -Trigger $trg -Settings $set -Principal $prn -Description $desc -Force
        }
      }
    }

    # Tailscale signed in, and kept running while nobody is logged in to Windows (its unattended mode), which a hub
    # that starts at boot needs. EA_TAILSCALE_AS_IS=1 leaves Tailscale's own settings as they are.
    $st = if ($Method -eq 'tailscale') { Tailscale-State } else { $null }
    if ($Method -ne 'tailscale') { }
    elseif (-not $st -or $st.BackendState -ne 'Running') {
      Say 'Signing this PC in to Tailscale: a browser window opens; sign in there (Google, Microsoft, GitHub or Apple), then come back here. This waits up to 15 minutes'
      $out = Join-Path $Work 'tailscale-up.txt'
      $upArgs = if ($env:EA_TAILSCALE_AS_IS -eq '1') { @('up') } else { @('up', '--unattended') }
      $p = Start-Process -FilePath $ts -ArgumentList $upArgs -NoNewWindow -PassThru -RedirectStandardOutput $out -RedirectStandardError "$out.err"
      $null = $p.Handle
      $opened = $false
      for ($i = 0; $i -lt 180; $i++) {
        $said = ((Get-Content $out, "$out.err" -ErrorAction SilentlyContinue) -join "`n")
        if (-not $opened -and $said -match '(https://login\.tailscale\.com/\S+)') { $opened = $true; Note "If no browser window opened, open this link: $($Matches[1])"; if ($Installer -or $CanAsk) { Start-Process $Matches[1] } }
        $st = Tailscale-State
        if ($st -and $st.BackendState -eq 'Running') { break }
        if ($p.HasExited -and -not $opened -and $i -gt 6) { break }
        Start-Sleep -Seconds 5
      }
      if (-not $p.HasExited) { try { $p.Kill() } catch { } }
      if (-not $st -or $st.BackendState -ne 'Running') { Fail "Tailscale is not signed in. Sign in with the Tailscale icon by the clock, then run the installer again. Tailscale said: $(((Get-Content $out, "$out.err" -ErrorAction SilentlyContinue) -join ' ').Trim())" }
      Say 'Tailscale is signed in'
    } elseif ($env:EA_TAILSCALE_AS_IS -ne '1') {
      X $ts set --unattended=true 2>$null | Out-Null
    }
    $Dns = if ($st) { ([string]$st.Self.DNSName).TrimEnd('.') } else { '' }

    # ---- 1. Node, and git ----
    $node = Join-Path $NodeDir 'node.exe'
    if (-not ((Test-Path $node) -and ((& $node -v) -eq "v$NodeVersion"))) {
      Say "Node $NodeVersion into $NodeDir (from nodejs.org, checked against its published SHA-256)"
      $zip = "node-v$NodeVersion-win-x64.zip"
      if (-not (Fetch "$Work\SHASUMS256.txt" "https://nodejs.org/dist/v$NodeVersion/SHASUMS256.txt" 60)) { Fail "nodejs.org did not answer for Node's checksums; run this again later" }
      $want = ((Get-Content "$Work\SHASUMS256.txt") | Where-Object { $_ -match "\s$([regex]::Escape($zip))$" } | ForEach-Object { ($_ -split '\s+')[0] }) | Select-Object -First 1
      if (-not $want) { Fail "nodejs.org lists no checksum for $zip" }
      if (-not (Fetch "$Work\$zip" "https://nodejs.org/dist/v$NodeVersion/$zip" 900 -Bar)) { Fail 'the Node download did not finish; run this again later' }
      if ((Sha256 "$Work\$zip") -ne $want) { Fail 'the Node download does not match its published checksum, so it was not used' }
      X tar.exe -xf "$Work\$zip" -C $Work
      if (Test-Path $NodeDir) { Remove-Item -Recurse -Force $NodeDir }
      Move-Item "$Work\node-v$NodeVersion-win-x64" $NodeDir
    }
    Say "Node $(& $node -v)"
    $git = (Get-Command git.exe -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Source)
    if (-not $git) {
      $git = Join-Path $GitDir 'cmd\git.exe'
      if (-not ((Test-Path $git) -and ((Get-Content (Join-Path $GitDir '.everythingapp') -ErrorAction SilentlyContinue) -eq "version=$GitVersion"))) {
        Say "This PC has no git, which downloads the app with its files checked: MinGit $GitVersion (GPL-2.0, about 40 MB from GitHub, checked against its published checksum) into $GitDir"
        $zip = "MinGit-$GitVersion-64-bit.zip"
        if (-not (Fetch "$Work\$zip" "https://github.com/git-for-windows/git/releases/download/$GitTag/$zip" 900 -Bar)) { Fail 'the MinGit download did not finish; run this again later' }
        if ((Sha256 "$Work\$zip") -ne $GitZipSum) { Fail 'the MinGit download does not match its published checksum, so it was not used' }
        if (Test-Path $GitDir) { Remove-Item -Recurse -Force $GitDir }
        New-Item -ItemType Directory -Force -Path $GitDir | Out-Null
        X tar.exe -xf "$Work\$zip" -C $GitDir
        Write-Text (Join-Path $GitDir '.everythingapp') "version=$GitVersion"
      }
    }
    $env:Path = "$NodeDir;$(Split-Path $git);$env:Path"
    $env:NPM_CONFIG_UPDATE_NOTIFIER = 'false'
    $env:NPM_CONFIG_FUND = 'false'
    $env:GIT_TERMINAL_PROMPT = '0'

    # ---- 2. the app, its packages and the web app ----
    Hold 'hub'
    # While npm ci installs new packages (it deletes node_modules first), the ones this copy had (each node_modules
    # folder) and its web app wait in app\.update-backup: when the install fails, the hub goes back to the version it had
    # with them, which runs without the network. deploy\windows\update.ps1 does the same with the same folder, and each
    # handles a backup the other left when it was stopped.
    $Backup = Join-Path $App '.update-backup'
    # Removes a folder with all in it. cmd's rmdir removes the links npm makes for workspaces (junctions) without going
    # into the folders they point to, which Remove-Item in Windows PowerShell 5.1 does not promise. The path reaches cmd
    # in a variable, inside quotes, so a & or a % in a folder name stays part of the name.
    function Remove-Tree([string]$path) {
      if (Test-Path -LiteralPath $path) {
        $env:EA_REMOVE = $path
        try { Start-Process -FilePath $env:ComSpec -ArgumentList '/d /c rmdir /s /q "%EA_REMOVE%"' -NoNewWindow -Wait } catch { }
        Remove-Item -ErrorAction SilentlyContinue Env:\EA_REMOVE
      }
      return (-not (Test-Path -LiteralPath $path))
    }
    # Every node_modules folder under $base (the root's and the workspaces', never one inside another), then web\dist,
    # as paths under $base.
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
    # Before npm ci, with the hub stopped: each node_modules folder and web\dist move into the backup (a rename on the
    # same disk), with the commit they belong to. When one cannot be moved, what was moved goes back and the install
    # goes on without a backup, as it did before.
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
        Note "The packages could not be set aside, so this install has no backup: $($_.Exception.Message)"
        $null = Put-Back
      }
    }
    # The parts set aside go back. From a whole backup, whatever a failed install left goes first (every node_modules
    # folder, and web\dist when the backup has one); from one a crash cut short (no .complete), only the places it
    # emptied are filled. The backup goes once all is back; when something could not be moved it stays, for the next run.
    function Put-Back {
      if (-not (Test-Path -LiteralPath $Backup)) { return $true }
      $saved = @(Package-Parts $Backup)
      $whole = Test-Path -LiteralPath (Join-Path $Backup '.complete')
      if ($whole -and -not (Test-Path -LiteralPath (Join-Path $Backup '.cleared'))) {
        foreach ($p in @(Package-Parts $App)) {
          if ($p -eq 'web\dist' -and $saved -notcontains 'web\dist') { continue }
          if (-not (Remove-Tree (Join-Path $App $p))) { Note "$p could not be removed, so nothing was put back"; return $false }
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
        } catch { Note "$p could not be put back: $($_.Exception.Message)"; $ok = $false }
      }
      if ($ok) { $null = Remove-Tree $Backup }
      return $ok
    }
    # After a web app build that did not work: the web app it had, when one was set aside.
    function Put-Back-Web([string]$commit) {
      $saved = Join-Path $Backup 'web\dist'
      if ((Backup-Fits $commit) -and (Test-Path -LiteralPath $saved) -and (Remove-Tree (Join-Path $App 'web\dist'))) {
        try { [IO.Directory]::Move($saved, (Join-Path $App 'web\dist')) } catch { Note "The web app it had could not be put back: $($_.Exception.Message)" }
      }
    }
    # The app keeps the repository's line endings (core.autocrlf=false for this checkout only): Git for Windows turns
    # them into CRLF by default, and npm turns a command's script (one starting with #!) back to LF when it installs
    # it, which then reads as a file changed by hand and stops every update.
    $from = ''
    if (Test-Path (Join-Path $App '.git')) {
      Say "Updating $App"
      if ((X $git -C $App config --get core.autocrlf) -ne 'false') {
        X $git -C $App config core.autocrlf false
        # A checkout made with CRLF is written again with the repository's endings, only when that is all that differs.
        X $git -C $App diff --quiet --ignore-cr-at-eol
        if ($LASTEXITCODE -eq 0) { X $git -C $App reset -q --hard HEAD }
      }
      $from = [string](X $git -C $App rev-parse HEAD)
      # A backup that a stopped update left (Windows restarted during it): put back while the code is still on the
      # commit it belongs to, else of no more use.
      if (Test-Path -LiteralPath $Backup) {
        if (Backup-Fits $from) { if (-not (Put-Back)) { Note 'Not everything a stopped update set aside could be put back' } }
        else { $null = Remove-Tree $Backup }
      }
      # Without --depth: in this shallow clone, a fetch with --depth 1 brings the newest commit without its parents, and
      # git then refuses to merge it (unrelated histories), here and in every update after.
      X $git -C $App fetch -q origin $Ref; if ($LASTEXITCODE) { Fail 'git could not fetch the app; run this again later' }
      X $git -C $App checkout -q $Ref
      X $git -C $App merge -q --ff-only "origin/$Ref"; $merged = -not $LASTEXITCODE
      # A copy that took such a fetch before (this installer made those) is mended by fetching its whole history once.
      if (-not $merged -and (X $git -C $App rev-parse --is-shallow-repository) -eq 'true') {
        Say 'Fetching the whole history of the app once, so this copy links up with the newest version'
        X $git -C $App fetch -q --unshallow origin $Ref; if ($LASTEXITCODE) { Fail 'git could not fetch the app; run this again later' }
        X $git -C $App merge -q --ff-only "origin/$Ref"; $merged = -not $LASTEXITCODE
      }
      if (-not $merged) { Fail "the app in $App has changes of its own; it was left as it is" }
    } else {
      Say "Downloading the app into $App"
      X $git clone -q -c core.autocrlf=false --depth 1 --branch $Ref $RepoUrl $App; if ($LASTEXITCODE) { Fail 'git could not download the app; run this again later' }
    }
    Say 'Installing packages (a minute or two the first time)'
    if ($from) { Set-Aside $from }
    $kept = [bool]$from -and (Backup-Fits $from)
    Push-Location $App
    try {
      X npm.cmd ci --no-audit --no-fund --loglevel=error | Out-Null
      if ($LASTEXITCODE) {
        if ($kept) {
          # Back to the version this copy had, with its packages: the hub runs it again without the network.
          if ([string](X $git -C $App rev-parse HEAD) -ne $from) { X $git -C $App reset -q --hard $from }
          if (Put-Back) { Say 'The hub stays on the version it had, with the packages it had' }
        }
        Fail 'npm could not install the packages; see the lines above'
      }
      X npm.cmd --workspace web run build 2>&1 | Out-Null
      if ($LASTEXITCODE) { Say 'The web app did not build; the hub still runs'; Put-Back-Web $from }
      $null = Remove-Tree $Backup
    } finally { Pop-Location }

    # ---- 3. settings ----
    if (-not (Test-Path $EnvFile)) {
      $chars = [char[]]'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
      $bytes = New-Object byte[] 48
      [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
      $token = -join ($bytes | ForEach-Object { $chars[$_ % $chars.Length] })
      $tz = (& $node -e "process.stdout.write(Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC')")
      Write-Text $EnvFile ((@(
        '# Aeneas hub settings. The model, owner name and connections are set in the app (Welcome, Settings).',
        "EA_PORT=$Port", 'EA_BIND_HOST=127.0.0.1', 'EA_PUBLIC_URL=', "EA_TOKEN=$token",
        "EA_DATA_DIR=$Data", "EA_VAULT_DIR=$Data\vault", "EA_BACKUP_DIR=$Data\backups", "EA_WORK_KEY_FILE=$Conf\work.key",
        "EA_TZ=$tz", 'EA_ALLOW_CLOUD_DEFAULT=false', 'EA_NO_DOTENV=1') -join "`n") + "`n")
      Say "Settings written to $EnvFile with a new token"
    } else { Say "Keeping the settings in $EnvFile" }
    $Port = [int](Get-Env 'EA_PORT')
    Set-Env 'EA_LINK' $Method
    if ($Method -eq 'home') {
      # The hub's own certificate (the QR code carries its fingerprint, so devices accept it and no other), made with
      # Windows' own .NET: a P-256 key, valid 10 years, named for this PC and its home address. Kept while it lasts.
      $tlsDir = Join-Path $Conf 'tls'
      $crt = Join-Path $tlsDir 'hub.crt'; $key = Join-Path $tlsDir 'hub.key'
      $keep = $false
      if ((Test-Path $crt) -and (Test-Path $key)) {
        try {
          $old = New-Object Security.Cryptography.X509Certificates.X509Certificate2 -ArgumentList (,[Convert]::FromBase64String(((Get-Content $crt -Raw) -replace '-----[^-]+-----', '' -replace '\s', '')))
          $keep = $old.NotAfter -gt (Get-Date).AddDays(30) -and ($old.Extensions | Where-Object { $_.Oid.Value -eq '2.5.29.17' } | ForEach-Object { $_.Format($false) }) -match [regex]::Escape($LanIp)
        } catch { }
      }
      if (-not $keep) {
        New-Item -ItemType Directory -Force -Path $tlsDir | Out-Null
        $ec = [Security.Cryptography.ECDsa]::Create([Security.Cryptography.ECCurve+NamedCurves]::nistP256)
        $req = New-Object Security.Cryptography.X509Certificates.CertificateRequest('CN=Aeneas hub', $ec, [Security.Cryptography.HashAlgorithmName]::SHA256)
        $san = New-Object Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder
        $san.AddDnsName($env:COMPUTERNAME); $san.AddDnsName('localhost'); $san.AddIpAddress([Net.IPAddress]::Parse($LanIp))
        $req.CertificateExtensions.Add($san.Build())
        $req.CertificateExtensions.Add((New-Object Security.Cryptography.X509Certificates.X509BasicConstraintsExtension($false, $false, 0, $true)))
        $cert = $req.CreateSelfSigned([DateTimeOffset]::Now.AddDays(-1), [DateTimeOffset]::Now.AddYears(10))
        $pem = { param($label, $bytes) "-----BEGIN $label-----`n" + ([Convert]::ToBase64String($bytes) -replace '(.{64})', "`$1`n").TrimEnd("`n") + "`n-----END $label-----`n" }
        Write-Text $key (& $pem 'PRIVATE KEY' $ec.Key.Export([Security.Cryptography.CngKeyBlobFormat]::Pkcs8PrivateBlob))
        Write-Text $crt (& $pem 'CERTIFICATE' $cert.RawData)
        Say "Made the hub's own certificate for $LanIp"
      }
      Set-Env 'EA_TLS_CERT' $crt; Set-Env 'EA_TLS_KEY' $key
      Set-Env 'EA_BIND_HOST' '0.0.0.0'
      Set-Env 'EA_PUBLIC_URL' "https://$LanIp`:$Port"
      if ($LanProfile -eq 'Public') { Say "A note: Windows treats this network as Public, which blocks other devices from reaching the hub. If this is your home network, open Settings, Network and internet, choose it, and set it to Private" }
    } else {
      Set-Env 'EA_BIND_HOST' '127.0.0.1'
      if ($Method -eq 'direct' -or (Get-Env 'EA_PUBLIC_URL') -notmatch '\.ts\.net(:\d+)?$') { Set-Env 'EA_PUBLIC_URL' '' }
    }
    # The hub's database is a plain file on this disk (only work items are sealed): say whether the disk is encrypted.
    # The shell reads BitLocker's state without an administrator: 1 is on.
    $bl = $null
    try { $bl = (New-Object -ComObject Shell.Application).NameSpace("$($Data.Substring(0, 2))\").Self.ExtendedProperty('System.Volume.BitLockerProtection') } catch { }
    if ($bl -eq 1) { Say 'The disk the hub keeps its data on is encrypted (BitLocker)' }
    else { Say "A note, nothing to do now: BitLocker does not protect the disk the hub keeps its data on ($($Data.Substring(0, 2))). Your backups are encrypted either way; someone who took the disk itself could read the hub's data. If that matters to you, turn on BitLocker or Device encryption in Windows Settings" }

    # ---- 4. where models are kept, and the model server ----
    $services = [ordered]@{}
    $services['hub'] = [ordered]@{ name = 'hub'; file = $node; args = @("--env-file=$EnvFile", '--import', 'tsx', 'src/main.ts', 'serve'); cwd = (Join-Path $App 'hub'); env = [ordered]@{ 'PATH+' = "$NodeDir;$(Split-Path $git)" } }
    $OllamaPort = if ($env:EA_OLLAMA_PORT) { [int]$env:EA_OLLAMA_PORT } else { 11434 }
    $OllamaHere = "http://127.0.0.1:$OllamaPort"
    $ownOllama = Test-Path (Join-Path $OllamaDir '.everythingapp')
    function Drive-Kind([string]$path) {
      $letter = $path.Substring(0, 1)
      try {
        $d = New-Object IO.DriveInfo "$letter`:"
        if ($d.DriveType -eq 'Network') { return 'network' }
        $disk = Get-Partition -DriveLetter $letter -ErrorAction Stop | Get-Disk -ErrorAction Stop
        if ($disk.BusType -eq 'USB') { return 'usb' }
        $pd = Get-PhysicalDisk -ErrorAction Stop | Where-Object { $_.DeviceId -eq [string]$disk.Number } | Select-Object -First 1
        if ($pd.MediaType -eq 'HDD') { return 'hdd' }
        if ($disk.BusType -eq 'NVMe') { return 'nvme' }
        if ($pd.MediaType -eq 'SSD') { return 'ssd' }
      } catch { }
      return ''
    }
    function Kind-Note([string]$k) {
      switch ($k) {
        'nvme' { 'a fast SSD (NVMe): a large model loads in about 5 to 10 seconds' }
        'ssd' { 'an SSD: a large model loads in about 40 seconds' }
        'hdd' { 'a hard drive: a large model takes about 2 minutes to load, each time the assistant starts after 5 quiet minutes' }
        'usb' { 'a USB drive: a large model loads in 20 seconds (a USB SSD) to 2 minutes (a USB hard drive), and only while it is plugged in' }
        'network' { 'a network drive: the hub runs before anyone logs in and cannot reach network drives, so models cannot be kept there' }
        default { 'a disk whose kind this installer cannot tell' }
      }
    }
    function Free-GB([string]$path) { try { [math]::Floor((New-Object IO.DriveInfo ($path.Substring(0, 2))).AvailableFreeSpace / 1GB) } catch { '?' } }
    function Models-Dir {
      # The hub's own Ollama has a folder of its own (AeneasHub\models) until another is chosen; never the folder
      # another Ollama on this PC uses (%USERPROFILE%\.ollama\models), whose models are that Ollama's and are never
      # moved. Moving is offered only from a folder chosen here before.
      $cur = Get-Env 'EA_MODELS_DIR'
      $old = if ($cur) { $cur } else { Join-Path $Root 'models' }
      $want = $old; $explicit = $false
      if ($env:EA_MODELS_DIR) { $want = $env:EA_MODELS_DIR.TrimEnd('\'); $explicit = $true }
      elseif ($CanAsk) {
        Say "AI models are kept in $old`: $(Free-GB $old) GB free, on $(Kind-Note (Drive-Kind $old)). A model takes 1.5 to 19 GB. This PC's drives:"
        foreach ($d in [IO.DriveInfo]::GetDrives() | Where-Object { $_.IsReady -and $_.DriveType -in 'Fixed', 'Removable' }) {
          Note ("{0}  {1,5} GB free  {2}" -f $d.Name.TrimEnd('\'), [math]::Floor($d.AvailableFreeSpace / 1GB), ((Kind-Note (Drive-Kind $d.Name)) -split ':')[0])
        }
        $a = (Read-Host '    Press Enter to keep them there, or type another folder (like E:\AI\models)').Trim().Trim('"').TrimEnd('\')
        if ($a) { if ($a -match '^[A-Za-z]:\\') { $want = $a } else { Say "That is not a full folder path (like E:\AI\models), so models stay in $old" } }
      }
      if ($want -notmatch '^[A-Za-z]:\\') { Say "EA_MODELS_DIR must be a full folder path (like E:\AI\models), so models stay in $old"; $want = $old; $explicit = $false }
      if ($want -ne $old) {
        $kind = Drive-Kind $want
        if ($kind -eq 'network') { Say "$want is on $(Kind-Note $kind); models stay in $old"; $want = $old }
        else {
          try { New-Item -ItemType Directory -Force -Path $want | Out-Null; [IO.File]::WriteAllText((Join-Path $want '.write-test'), ''); Remove-Item -Force (Join-Path $want '.write-test') }
          catch { Say "$want cannot be made or written to, so models stay in $old"; $want = $old }
          if ($want -ne $old -and $kind -in 'hdd', 'usb' -and -not $explicit -and -not (Ask "$want is on $(Kind-Note $kind). Keep models there anyway?" $false)) { $want = $old }
        }
      }
      if ($cur -and $want -ne $old -and (Test-Path (Join-Path $old 'blobs'))) {
        $size = [math]::Round(((Get-ChildItem -Recurse -File -LiteralPath $old -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum) / 1GB, 1)
        if (Ask "Move the models already in $old ($size GB) to $want now? Otherwise they are downloaded again when needed" $true) {
          Hold 'ollama'
          Say "Moving the models to $want"
          try {
            foreach ($sub in 'blobs', 'manifests') { if (Test-Path (Join-Path $old $sub)) { X robocopy.exe (Join-Path $old $sub) (Join-Path $want $sub) /E /MOVE /NFL /NDL /NJH /NJS /NP | Out-Null; if ($LASTEXITCODE -ge 8) { throw "robocopy $LASTEXITCODE" } } }
            Say "The models are in $want"
          } catch { Say "Not every model could be moved; what was not stays in $old" }
        }
      }
      New-Item -ItemType Directory -Force -Path $want | Out-Null
      Set-Env 'EA_MODELS_DIR' $want
      Say "Models are kept in $want ($(Free-GB $want) GB free)"
      return $want
    }
    if ($env:EA_NO_OLLAMA) { Say 'EA_NO_OLLAMA is set, so no model server is installed' }
    elseif (-not $ownOllama -and (Answers "$OllamaHere/api/tags")) {
      Say "A model server already answers at $OllamaHere, so nothing is installed or changed for models (it keeps them where it was set up to)"
      if (-not (Get-Env 'EA_OLLAMA_URL')) { Set-Env 'EA_OLLAMA_URL' $OllamaHere }
    }
    elseif (-not $ownOllama -and (Port-Busy $OllamaPort)) { Say "Something that is not Ollama uses port $OllamaPort, so Ollama was not installed (EA_OLLAMA_PORT chooses another)" }
    elseif (-not $ownOllama -and -not $env:EA_OLLAMA_PORT -and ($other = @((Get-Command ollama.exe -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source), "$env:LOCALAPPDATA\Programs\Ollama\ollama.exe") | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1)) {
      # Another Ollama is here but not answering: a second one beside it would share the card and keep its own copy
      # of every model. Nothing is changed.
      Say "Ollama is installed ($other) but does not answer on 127.0.0.1:$OllamaPort. Start it (Ollama in the Start menu), then run this again; nothing was changed"
    }
    else {
      $have = $ownOllama -and ((Get-Content (Join-Path $OllamaDir '.everythingapp')) -eq "version=$OllamaVersion")
      $go = $have
      if (-not $have) {
        if (-not $ownOllama) { Say "The assistant needs a model server on this PC: Ollama $OllamaVersion (MIT), about 1.6 GB from GitHub (github.com/ollama/ollama), checked against its published checksum. No model is downloaded now; the Welcome page shows the one that fits and its size first" }
        $go = $ownOllama -or (Ask 'Download and install Ollama now?' $true)
        if ($go) {
          $zip = 'ollama-windows-amd64.zip'
          Say "Downloading Ollama $OllamaVersion ($zip, about 1.6 GB) from GitHub"
          if (-not (Fetch "$Work\$zip" "https://github.com/ollama/ollama/releases/download/v$OllamaVersion/$zip" 7200 -Bar)) { Say 'The Ollama download did not finish, so Ollama was not installed. Run this again later'; $go = $false }
          elseif ((Sha256 "$Work\$zip") -ne $OllamaZipSum) { Say 'The Ollama download does not match its published checksum, so it was not used'; $go = $false }
          else {
            Hold 'ollama'
            $new = "$OllamaDir.new"
            if (Test-Path $new) { Remove-Item -Recurse -Force $new }
            New-Item -ItemType Directory -Force -Path $new | Out-Null
            X tar.exe -xf "$Work\$zip" -C $new
            Remove-Item -Force "$Work\$zip"
            if (-not (Test-Path "$new\ollama.exe")) { Say 'The Ollama download has no ollama.exe where expected, so it was not installed'; $go = $false }
            else {
              if (Test-Path $OllamaDir) { Remove-Item -Recurse -Force $OllamaDir }
              Move-Item $new $OllamaDir
              Write-Text (Join-Path $OllamaDir '.everythingapp') "version=$OllamaVersion"
              Say "Ollama $OllamaVersion is in $OllamaDir"
            }
          }
        } else { Say 'Ollama was not installed. Run this again to install it (EA_NO_OLLAMA=1 skips this question)' }
      }
      if ($go) {
        $models = Models-Dir
        # OLLAMA_NO_CLOUD: Ollama's own switch for its cloud features (models run on ollama.com, its web search), off here.
        $services['ollama'] = [ordered]@{ name = 'ollama'; file = (Join-Path $OllamaDir 'ollama.exe'); args = @('serve'); cwd = $OllamaDir; env = [ordered]@{ OLLAMA_HOST = "127.0.0.1:$OllamaPort"; OLLAMA_NO_CLOUD = '1'; OLLAMA_MODELS = $models } }
        if (-not (Get-Env 'EA_OLLAMA_URL')) { Set-Env 'EA_OLLAMA_URL' $OllamaHere }
        Release 'ollama'
      }
    }

    # ---- 5. Tor: web lookups (off until turned on in the app) leave only through it ----
    $TorPort = if ($env:EA_TOR_PORT) { [int]$env:EA_TOR_PORT } else { 9052 }
    $wantTor = -not ($env:EA_TOR -match '^(0|no|false|off)$')
    if (-not $wantTor) {
      if (Test-Path (Join-Path $TorDir '.everythingapp')) { Hold 'tor'; Remove-Item -Recurse -Force $TorDir; Release 'tor' }
      if ((Get-Env 'EA_TOR_SOCKS') -eq "127.0.0.1:$TorPort") { Set-Env 'EA_TOR_SOCKS' '' }
      Say 'Tor is off: web lookups stay off unless hub.env has EA_WEB_WITHOUT_TOR=1'
    } else {
      $ver = ''
      try { $ver = [string](Invoke-RestMethod -UseBasicParsing -TimeoutSec 30 'https://aus1.torproject.org/torbrowser/update_3/release/downloads.json').version } catch { }
      if ($env:EA_TOR_VERSION) { $ver = $env:EA_TOR_VERSION }
      $torOk = $false
      if ($ver -notmatch '^[0-9.]+$') { Say 'torproject.org did not say which Tor is current, so Tor was not installed. Run this again later' }
      elseif ((Get-Content (Join-Path $TorDir '.everythingapp') -ErrorAction SilentlyContinue) -eq "version=$ver") { Say "Tor $ver is already in $TorDir"; $torOk = $true }
      else {
        if (-not (Test-Path (Join-Path $TorDir '.everythingapp'))) { Say 'Web lookups (off until you turn them on in the app) go out only through Tor, so search engines and sites never see your home address. Setting up Tor from torproject.org (about 20 MB; EA_TOR=0 skips it)' }
        $base = "https://dist.torproject.org/torbrowser/$ver"
        $file = "tor-expert-bundle-windows-x86_64-$ver.tar.gz"
        if (-not (Fetch "$Work\tor-sums.txt" "$base/sha256sums-signed-build.txt" 60)) { Say "torproject.org did not answer for Tor's checksums, so Tor was not installed" }
        else {
          $want = ((Get-Content "$Work\tor-sums.txt") | Where-Object { $_ -match "\s\*?$([regex]::Escape($file))$" } | ForEach-Object { ($_ -split '\s+')[0] }) | Select-Object -First 1
          Say "Tor is checked against its published checksum; this installer has no gpg to check the signature on that list (Linux and macOS hubs check it)"
          if (-not $want) { Say "Tor $ver lists no checksum for $file, so Tor was not installed" }
          elseif (-not (Fetch "$Work\$file" "$base/$file" 1800 -Bar)) { Say 'The Tor download did not finish, so Tor was not installed' }
          elseif ((Sha256 "$Work\$file") -ne $want) { Say 'The Tor download does not match its published checksum, so it was not used' }
          else {
            Hold 'tor'
            $new = "$TorDir.new"
            if (Test-Path $new) { Remove-Item -Recurse -Force $new }
            New-Item -ItemType Directory -Force -Path $new | Out-Null
            X tar.exe -xzf "$Work\$file" -C $new
            if (-not (Test-Path "$new\tor\tor.exe")) { Say 'The Tor download has no tor.exe where expected, so Tor was not installed' }
            else {
              if (Test-Path $TorDir) { Remove-Item -Recurse -Force $TorDir }
              Move-Item $new $TorDir
              Write-Text (Join-Path $TorDir '.everythingapp') "version=$ver"
              Say "Tor $ver is in $TorDir"
              $torOk = $true
            }
          }
        }
      }
      if ($torOk) {
        $torConf = Join-Path $Conf 'tor'; $torData = Join-Path $Data 'tor'
        New-Item -ItemType Directory -Force -Path $torConf, $torData | Out-Null
        $bridges = Join-Path $torConf 'bridges'
        if ($env:EA_TOR_BRIDGES -eq 'snowflake') { Write-Text $bridges 'snowflake' } elseif ($env:EA_TOR_BRIDGES -match '^(off|0|no)$') { Remove-Item -Force -ErrorAction SilentlyContinue $bridges }
        function Write-Torrc {
          $q = { param($p) '"' + ($p -replace '\\', '/') + '"' }
          $lines = @('# Tor for Aeneas. Written by the installer, and written again on each run: changes here are replaced.',
            "SocksPort 127.0.0.1:$TorPort", 'SocksPolicy accept 127.0.0.1', 'SocksPolicy reject *',
            '# Names are looked up through Tor (socks5h), never on this machine.', 'SafeSocks 1', 'ClientOnly 1', 'AvoidDiskWrites 1',
            "DataDirectory $(& $q $torData)", "GeoIPFile $(& $q (Join-Path $TorDir 'data\geoip'))", "GeoIPv6File $(& $q (Join-Path $TorDir 'data\geoip6'))", 'Log notice stdout')
          $pt = Join-Path $TorDir 'tor\pluggable_transports'
          if ((Get-Content $bridges -ErrorAction SilentlyContinue) -eq 'snowflake' -and (Test-Path "$pt\pt_config.json")) {
            $c = Get-Content -Raw "$pt\pt_config.json" | ConvertFrom-Json
            $plug = ([string]$c.pluggableTransports.snowflake).Replace('${pt_path}', (($pt -replace '\\', '/') + '/'))
            $lines += '# Through Snowflake bridges: this network did not let Tor reach its relays directly (EA_TOR_BRIDGES=off tries direct again).'
            $lines += 'UseBridges 1'; $lines += $plug
            foreach ($b in @($c.bridges.snowflake)) { $lines += "Bridge $b" }
          }
          Write-Text (Join-Path $torConf 'torrc') (($lines -join "`n") + "`n")
        }
        Write-Torrc
        $services['tor'] = [ordered]@{ name = 'tor'; file = (Join-Path $TorDir 'tor\tor.exe'); args = @('-f', (Join-Path $torConf 'torrc')); cwd = $TorDir; env = [ordered]@{} }
        Release 'tor'
        Set-Env 'EA_TOR_SOCKS' "127.0.0.1:$TorPort"
      }
    }

    # ---- 5b. private web search: SearXNG (AGPL-3.0), as on Linux and macOS ----
    # Two things differ on Windows. SearXNG's repository holds files whose names have a colon (web server templates),
    # which Windows cannot write, so only what runs it (searx\ and its requirements) is exported from the commit git
    # fetched and checked. And SearXNG imports Unix's pwd module at start (searx\valkeydb.py), using it only to name the
    # user in an error about a valkey server these settings turn off: a stand-in for it is put on its path.
    $SearxDir = Join-Path $Root 'searxng'
    $SearxPort = if ($env:EA_SEARXNG_PORT) { [int]$env:EA_SEARXNG_PORT } else { 8888 }
    $SearxHere = "http://127.0.0.1:$SearxPort"
    $SearxCommit = 'cccbc9e158b0ac3bb2158e9841a647a5bec57b57'
    $PyDir = Join-Path $Root 'python'
    $PyVersion = '3.12.15+20261021'
    $PySum = 'be7f14464d1d66f84429ad27e01f6d1482963afff64a2fb5256b2a51c7b5d398'
    $ownSearx = Test-Path (Join-Path $SearxDir '.everythingapp')
    if ($env:EA_NO_SEARXNG) { Say 'EA_NO_SEARXNG is set, so no web search is installed' }
    elseif (-not $ownSearx -and (Get-Env 'EA_SEARXNG_URL')) { Say "Web search uses $(Get-Env 'EA_SEARXNG_URL'); it is left as it is" }
    elseif (-not $ownSearx -and (Port-Busy $SearxPort)) { Say "Something else uses port $SearxPort, so SearXNG was not installed (EA_SEARXNG_PORT chooses another)" }
    else {
      $sxOk = $true
      $py = Join-Path $PyDir 'python.exe'
      if (-not ((Test-Path $py) -and ((Get-Content (Join-Path $PyDir '.everythingapp') -ErrorAction SilentlyContinue) -eq "version=$PyVersion"))) {
        Say "Web search needs Python: $($PyVersion.Split('+')[0]) for it alone (python-build-standalone, Python's own license, about 45 MB from GitHub, checked against its published checksum) into $PyDir"
        $file = "cpython-$PyVersion-x86_64-pc-windows-msvc-install_only.tar.gz"
        if (-not (Fetch "$Work\py.tgz" "https://github.com/astral-sh/python-build-standalone/releases/download/$($PyVersion.Split('+')[1])/$($file -replace '\+', '%2B')" 900 -Bar)) { Say 'The Python download did not finish, so web search was not installed. Run this again later'; $sxOk = $false }
        elseif ((Sha256 "$Work\py.tgz") -ne $PySum) { Say 'The Python download does not match its published checksum, so it was not used'; $sxOk = $false }
        else {
          if (Test-Path $PyDir) { Remove-Item -Recurse -Force $PyDir }
          X tar.exe -xzf "$Work\py.tgz" -C $Root
          if (-not (Test-Path $py)) { Say 'The Python download has no python.exe where expected'; $sxOk = $false }
          else { Write-Text (Join-Path $PyDir '.everythingapp') "version=$PyVersion" }
        }
      }
      if ($sxOk -and -not ($ownSearx -and ((Get-Content (Join-Path $SearxDir '.everythingapp')) -eq "commit=$SearxCommit") -and (Test-Path (Join-Path $SearxDir 'venv\Scripts\python.exe')))) {
        Say "Installing SearXNG (commit $($SearxCommit.Substring(0, 12))) into $SearxDir (a few minutes the first time)"
        Hold 'searxng'
        $new = "$SearxDir.new"
        if (Test-Path $new) { Remove-Item -Recurse -Force $new }
        New-Item -ItemType Directory -Force -Path "$new\repo", "$new\src" | Out-Null
        X $git -C "$new\repo" -c init.defaultBranch=main init -q
        X $git -C "$new\repo" remote add origin https://github.com/searxng/searxng.git
        X $git -C "$new\repo" fetch -q --depth 1 origin $SearxCommit
        if ((X $git -C "$new\repo" rev-parse FETCH_HEAD) -ne $SearxCommit) { Say 'GitHub did not give the SearXNG commit, so SearXNG was not installed. Run this again later'; $sxOk = $false }
        else {
          # Only searx\ and the requirements are written; the check for names Windows cannot hold is off for this
          # export alone, since none of these files has such a name.
          X $git -C "$new\repo" -c core.protectNTFS=false archive --format=tar -o "$new\src.tar" FETCH_HEAD searx requirements.txt requirements-server.txt
          X tar.exe -xf "$new\src.tar" -C "$new\src"
          Remove-Item -Force "$new\src.tar"; Remove-Item -Recurse -Force "$new\repo"
          $vstr = '2026.11.2+' + $SearxCommit.Substring(0, 7)
          Write-Text "$new\src\searx\version_frozen.py" "VERSION_STRING = `"$vstr`"`nVERSION_TAG = `"$vstr`"`nDOCKER_TAG = `"$($vstr -replace '\+', '-')`"`nGIT_URL = `"https://github.com/searxng/searxng`"`nGIT_BRANCH = `"master`"`n"
          New-Item -ItemType Directory -Force -Path "$new\shim" | Out-Null
          Write-Text "$new\shim\pwd.py" "`"`"`"Stand-in for Unix's pwd module on Windows (Aeneas installer): SearXNG imports it at start only to name the user in an error about a valkey server, which is off here.`"`"`"`nimport getpass`n`n`ndef getpwuid(uid):`n    return (getpass.getuser(), `"x`", 0, 0, `"`", `"`", `"`")`n"
          X $py -m venv "$new\venv"
          $vpy = "$new\venv\Scripts\python.exe"
          X $vpy -m pip install --disable-pip-version-check --no-input -q -U pip setuptools wheel | Out-Null
          X $vpy -m pip install --disable-pip-version-check --no-input -q -r "$new\src\requirements.txt" -r "$new\src\requirements-server.txt" | Out-Null
          if ($LASTEXITCODE -ne 0) { Say "SearXNG's Python packages could not be installed, so SearXNG was not installed"; $sxOk = $false }
        }
        if ($sxOk) {
          if (Test-Path $SearxDir) { Remove-Item -Recurse -Force $SearxDir }
          Move-Item $new $SearxDir
          Write-Text (Join-Path $SearxDir '.everythingapp') "commit=$SearxCommit"
        } else { Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $new }
      }
      if ($sxOk) {
        # The same settings as on Linux and macOS (deploy/install.sh searxng_settings).
        $sxConf = Join-Path $Conf 'searxng'
        New-Item -ItemType Directory -Force -Path $sxConf | Out-Null
        $secretFile = Join-Path $sxConf 'secret_key'
        if (-not (Test-Path $secretFile)) {
          $b = New-Object byte[] 48; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
          $chars = [char[]]'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
          Write-Text $secretFile (-join ($b | ForEach-Object { $chars[$_ % $chars.Length] }))
        }
        $lines = @('# SearXNG for Aeneas. Written by the installer, and written again on each run: changes here are replaced.',
          '# Only these engines are asked (the Web lookups module names them): each sees the words searched and the address',
          '# the search leaves from (Tor''s, when it is set up).',
          'use_default_settings:', '  engines:', '    keep_only:', '      - duckduckgo', '      - brave', '      - mwmbl', '      - wikipedia',
          'engines:', '  - name: mwmbl', '    disabled: false', '  - name: wikipedia', '    display_type: ["infobox", "list"]',
          'general:', '  debug: false', '  instance_name: "Aeneas search"', '  enable_metrics: false',
          'search:', '  safe_search: 0', '  autocomplete: ""', '  formats:', '    - html', '    - json',
          'server:', '  bind_address: "127.0.0.1"', "  port: $SearxPort", "  secret_key: `"$((Get-Content -Raw $secretFile).Trim())`"", '  base_url: false', '  limiter: false', '  public_instance: false', '  image_proxy: true', '  method: "GET"',
          'valkey:', '  url: false')
        if ($services.Contains('tor')) {
          $lines += @('outgoing:', '  proxies:', '    all://:', "      - socks5h://127.0.0.1:$TorPort", '  # SearXNG checks at start that it really goes out through Tor, and does not start otherwise.', '  using_tor_proxy: true', '  extra_proxy_timeout: 10')
        }
        Write-Text (Join-Path $sxConf 'settings.yml') (($lines -join "`n") + "`n")
        $services['searxng'] = [ordered]@{ name = 'searxng'; file = (Join-Path $SearxDir 'venv\Scripts\python.exe'); args = @('-m', 'granian', '--interface', 'wsgi', '--host', '127.0.0.1', '--port', "$SearxPort", 'searx.webapp:app'); cwd = (Join-Path $SearxDir 'src'); env = [ordered]@{ SEARXNG_SETTINGS_PATH = (Join-Path $sxConf 'settings.yml'); PYTHONPATH = "$(Join-Path $SearxDir 'shim');$(Join-Path $SearxDir 'src')" } }
        Release 'searxng'
        if (-not (Get-Env 'EA_SEARXNG_URL')) { Set-Env 'EA_SEARXNG_URL' $SearxHere }
      }
    }

    # ---- 6. the service (its boot task was registered in step 0) ----
    Write-Text $ServicesFile ((ConvertTo-Json -InputObject @($services.Values) -Depth 5) + "`n")
    Release 'hub'
    $task = Find-Task
    if (-not $task) { Fail 'the scheduled task that runs the hub could not be registered' }
    $runnerHash = Sha256 $runner
    $lastHash = Get-Content (Join-Path $Run 'service.sha256') -ErrorAction SilentlyContinue
    if ($task.State -eq 'Running' -and ($lastHash -ne $runnerHash -or -not $taskOk)) { $task | Stop-ScheduledTask; Start-Sleep -Seconds 2 }
    if ((Find-Task).State -ne 'Running') { Find-Task | Start-ScheduledTask }
    Write-Text (Join-Path $Run 'service.sha256') $runnerHash
    Say 'Waiting for the hub'
    if (-not (Wait-For 60 "http://127.0.0.1:$Port/health")) { Fail "the hub did not start; see $Logs\hub.log and $Logs\service.log" }
    # Settings written before this start are already in use.
    $script:EnvChanged = $false
    if ($services.Contains('ollama') -and -not (Wait-For 30 "$OllamaHere/api/tags")) { Say "Ollama does not answer yet; see $Logs\ollama.log" }
    if (-not (Test-Path (Join-Path $Data '.seeded'))) {
      Push-Location (Join-Path $App 'hub')
      try { X $node "--env-file=$EnvFile" --import tsx src/main.ts seed | Out-Null; if (-not $LASTEXITCODE) { Write-Text (Join-Path $Data '.seeded') '' } } finally { Pop-Location }
    }
    if ($services.Contains('tor')) {
      Say 'Waiting for Tor to connect (up to 2 minutes the first time)'
      $isTor = { (X curl.exe -sS --max-time 10 --socks5-hostname "127.0.0.1:$TorPort" https://check.torproject.org/api/ip 2>$null | Out-String) -match '"IsTor":\s*true' }
      $ok = $false
      for ($i = 0; $i -lt 24 -and -not $ok; $i++) { if (& $isTor) { $ok = $true } else { Start-Sleep -Seconds 5 } }
      $bridges = Join-Path $Conf 'tor\bridges'
      if (-not $ok -and -not $env:EA_TOR_BRIDGES -and -not (Test-Path $bridges) -and (Test-Path (Join-Path $TorDir 'tor\pluggable_transports\pt_config.json'))) {
        Say 'Tor could not reach its relays directly (some networks block them); trying again through Snowflake bridges, which take a little longer'
        Write-Text $bridges 'snowflake'
        Write-Torrc
        Hold 'tor'; Release 'tor'
        for ($i = 0; $i -lt 36 -and -not $ok; $i++) { if (& $isTor) { $ok = $true } else { Start-Sleep -Seconds 5 } }
      }
      if ($ok) { Say "Tor is connected$(if (Test-Path $bridges) { ' (through Snowflake bridges)' })" } else { Say "Tor is still connecting; searches wait for it (see $Logs\tor.log)" }
    }
    if ($services.Contains('searxng')) {
      # SearXNG starts only once Tor answers it within 10 seconds (slower through bridges); its service tries again.
      if (Wait-For 120 "$SearxHere/healthz") { Say "Web search runs on 127.0.0.1:$SearxPort$(if ($services.Contains('tor')) { ' and goes out only through Tor' })" }
      else { Say "Web search does not answer yet; it starts once Tor answers it in time (see $Logs\searxng.log)" }
    }

    # ---- 7. the address devices use ----
    if ($Method -ne 'tailscale' -and $ts -and ((X $ts serve status 2>$null | Out-String) -match "(?m)^https://\S+:$Port\b")) {
      Say 'Turning off Tailscale Serve for the hub, which this choice no longer uses'
      X $ts serve "--https=$Port" off 2>$null | Out-Null
    }
    if ($Method -eq 'tailscale') {
    $address = "https://$Dns`:$Port"
    Say "Setting up Tailscale Serve: HTTPS on port $Port for your own devices on the tailnet, to the hub on this PC"
    $out = Join-Path $Work 'serve.txt'
    $p = Start-Process -FilePath $ts -ArgumentList @('serve', '--bg', "--https=$Port", "http://127.0.0.1:$Port") -NoNewWindow -PassThru -RedirectStandardOutput $out -RedirectStandardError "$out.err"
    # Windows PowerShell 5.1 keeps a process's exit code only while its handle is held.
    $null = $p.Handle
    # A new tailnet asks once to turn on HTTPS certificates: the link opens in the browser and this waits for it (up
    # to 10 minutes), as Tailscale itself does.
    $opened = $false
    for ($i = 0; $i -lt 120 -and -not $p.HasExited; $i++) {
      $said = ((Get-Content $out, "$out.err" -ErrorAction SilentlyContinue) -join "`n")
      if (-not $opened -and $said -match '(https://login\.tailscale\.com/\S+)') {
        $opened = $true
        Say 'Tailscale asks to turn on HTTPS for your tailnet, once: a browser window opens; turn it on there. This waits up to 10 minutes'
        Note "If no browser window opened, open this link: $($Matches[1])"
        if ($Installer -or $CanAsk) { Start-Process $Matches[1] }
      }
      Start-Sleep -Seconds 5
    }
    if (-not $p.HasExited) { try { $p.Kill() } catch { } }
    $said = ((Get-Content $out, "$out.err" -ErrorAction SilentlyContinue) -join "`n")
    $serving = ((X $ts serve status 2>$null | Out-String) -match "(?m)^https://\S+:$Port\b")
    if (($p.HasExited -and $p.ExitCode -eq 0) -or $serving) { Set-Env 'EA_PUBLIC_URL' $address }
    elseif ($said -match '(https://login\.tailscale\.com/\S+)') { Say "Tailscale Serve is not turned on for your tailnet yet. Open this link, turn it on, then run this again: $($Matches[1])" }
    else { Say "Tailscale did not set up HTTPS for the hub: $($said.Trim())" }
    }
    if ($script:EnvChanged) {
      Say 'Restarting the hub with the new settings'
      Hold 'hub'; Release 'hub'
      if (-not (Wait-For 60 "http://127.0.0.1:$Port/health")) { Say "The hub did not answer after the restart; see $Logs\hub.log" }
    }
    # The choice is the hub's too (link.json), so a choice made in Settings earlier gives way to this one.
    try { $null = Invoke-RestMethod -UseBasicParsing -Method Put -Uri "http://127.0.0.1:$Port/setup/link" -Headers @{ authorization = "Bearer $(Get-Env 'EA_TOKEN')" } -ContentType 'application/json' -Body (ConvertTo-Json @{ method = $Method }) -TimeoutSec 60 } catch { Say "The hub did not take the choice of $Method yet; it can be changed in Settings. ($($_.Exception.Message))" }

    # ---- 8. done ----
    # A one-time pairing code for this PC's browser, asked of the hub on 127.0.0.1 with the main key from hub.env.
    $link = ''
    for ($i = 0; $i -lt 10 -and -not $link; $i++) {
      try { $link = (Invoke-RestMethod -UseBasicParsing -Method Post -Uri "http://127.0.0.1:$Port/devices/pairing" -Headers @{ authorization = "Bearer $(Get-Env 'EA_TOKEN')" } -ContentType 'application/json' -Body '{"name":"Browser"}' -TimeoutSec 5).web } catch { Start-Sleep -Seconds 1 }
    }
    Write-Host ''
    Say "The hub is running at $(if (Get-Env 'EA_PUBLIC_URL') { Get-Env 'EA_PUBLIC_URL' } elseif ($Method -eq 'direct') { "http://127.0.0.1:$Port on this PC; other devices reach it through Direct link" } else { "http://127.0.0.1:$Port (this PC only until Tailscale Serve is on)" })"
    if ($link) {
      Note 'To finish, open this link in a browser on this PC (it works once, for 10 minutes). The page that opens walks you through the rest:'
      Write-Host ''; Note $link; Write-Host ''
      Note "If it has expired: powershell -ExecutionPolicy Bypass -File `"$App\deploy\windows\pair-link.ps1`""
    } else { Note "The hub did not answer for a pairing code. Once it is up, run: powershell -ExecutionPolicy Bypass -File `"$App\deploy\windows\pair-link.ps1`"" }
    Note "Logs: $Logs"
    Note 'Update later: Settings, About, Update hub in the app (or ask the assistant), or run the same command again.'
    if ($link -and ($CanAsk -or $Installer) -and -not $env:SSH_CONNECTION) { Note 'Opening the link in your browser now.'; Start-Process $link }
  } finally {
    Release 'hub'
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $Work
    if ($Installer) { try { Stop-Transcript | Out-Null } catch { } }
  }
}

# Run by the installer, a failure ends with exit code 1 so it can say so (never `exit` when pasted into a PowerShell window).
try { Install-AeneasHub } catch { Write-Host $_.Exception.Message -ForegroundColor Red; if ($env:EA_INSTALLER -eq '1') { exit 1 } }
