<#
.SYNOPSIS
  The Aeneas hub's service on Windows: runs the hub and what it needs, and keeps them running.
.DESCRIPTION
  Started at boot, before anyone logs in, by the scheduled task "\Aeneas\Aeneas hub" that deploy/install.ps1
  registers, as the user who installed the hub (Windows keeps no password for it: the task logs on "whether the user
  is logged on or not, without storing a password", which also means it reaches no network shares).

  It runs each program listed in <Root>\config\services.json (the hub; Ollama and Tor when the installer set them up)
  and starts a program again 3 seconds after it stops (longer when it keeps stopping at once, up to a minute). All of
  them belong to one Windows job, so they stop with this script, whatever stops it. Each one's output goes to
  <Root>\data\logs\<name>.log (the previous 10 MB kept as <name>.log.1).

  While the PC is on AC power it asks Windows not to go to sleep (on battery, a laptop sleeps as usual): a hub that
  sleeps cannot answer the phone. The screen still turns off as set.

  Without a restart of the task: a changed services.json is read within 5 seconds (programs whose line changed are
  started again, new ones started, removed ones stopped); <Root>\run\hold-<name> keeps that program stopped while it is
  there (the installer and the updater use it while they replace files, which Windows will not do while they run).
  <Root>\run\<name>.pid has each running program's process id.
.PARAMETER Root
  The hub's folder (%LOCALAPPDATA%\AeneasHub unless EA_ROOT chose another at install).
#>
param([Parameter(Mandatory = $true)][string]$Root)
$ErrorActionPreference = 'Stop'

Add-Type -Language CSharp -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

public static class AeneasHubService {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll")] static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);
  [DllImport("kernel32.dll")] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll")] static extern uint SetThreadExecutionState(uint flags);
  [DllImport("kernel32.dll")] static extern bool GetSystemPowerStatus(out PowerStatus status);

  [StructLayout(LayoutKind.Sequential)] struct PowerStatus { public byte ACLineStatus; public byte BatteryFlag; public byte BatteryLifePercent; public byte SystemStatusFlag; public int BatteryLifeTime; public int BatteryFullLifeTime; }
  [StructLayout(LayoutKind.Sequential)] struct BasicLimits { public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass; }
  [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes; }
  [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits { public BasicLimits Basic; public IoCounters Io; public UIntPtr ProcessMemoryLimit; public UIntPtr JobMemoryLimit; public UIntPtr PeakProcessMemoryUsed; public UIntPtr PeakJobMemoryUsed; }

  const uint KILL_ON_JOB_CLOSE = 0x2000;
  const uint ES_CONTINUOUS = 0x80000000, ES_SYSTEM_REQUIRED = 0x00000001;
  const long LOG_LIMIT = 10L * 1024 * 1024;

  public class Spec { public string Name, File, Args, WorkDir, Env, Key; }
  class Child {
    public Spec Spec; public Process Proc; public DateTime StartedAt; public DateTime NextStart = DateTime.MinValue;
    public int Delay = 3; public StreamWriter Log; public object Lock = new object();
  }

  static IntPtr job;
  static readonly Dictionary<string, Child> children = new Dictionary<string, Child>();
  static string runDir, logDir;

  static void Note(string text) {
    try { File.AppendAllText(Path.Combine(logDir, "service.log"), DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + " " + text + Environment.NewLine); } catch { }
  }

  static void MakeJob() {
    job = CreateJobObject(IntPtr.Zero, null);
    ExtendedLimits limits = new ExtendedLimits();
    limits.Basic.LimitFlags = KILL_ON_JOB_CLOSE;
    int size = Marshal.SizeOf(typeof(ExtendedLimits));
    IntPtr p = Marshal.AllocHGlobal(size);
    try { Marshal.StructureToPtr(limits, p, false); SetInformationJobObject(job, 9, p, (uint)size); } finally { Marshal.FreeHGlobal(p); }
  }

  // On AC power (or when Windows cannot tell), Windows is asked to stay awake; on battery, not. Checked each minute.
  static void StayAwake() {
    uint last = 0;
    while (true) {
      PowerStatus s;
      bool onBattery = GetSystemPowerStatus(out s) && s.ACLineStatus == 0;
      uint want = onBattery ? ES_CONTINUOUS : (ES_CONTINUOUS | ES_SYSTEM_REQUIRED);
      if (want != last) { SetThreadExecutionState(want); last = want; Note(onBattery ? "on battery: Windows may sleep as set" : "on AC power: Windows is asked to stay awake while the hub runs"); }
      Thread.Sleep(60000);
    }
  }

  static void Rotate(Child c) {
    string file = Path.Combine(logDir, c.Spec.Name + ".log");
    lock (c.Lock) {
      if (c.Log != null) { c.Log.Dispose(); c.Log = null; }
      try { if (File.Exists(file) && new FileInfo(file).Length > LOG_LIMIT) { File.Delete(file + ".1"); File.Move(file, file + ".1"); } } catch { }
      c.Log = new StreamWriter(new FileStream(file, FileMode.Append, FileAccess.Write, FileShare.ReadWrite | FileShare.Delete));
      c.Log.AutoFlush = true;
    }
  }

  static void Write(Child c, string line) {
    if (line == null) return;
    lock (c.Lock) {
      try {
        if (c.Log != null && c.Log.BaseStream.Length > LOG_LIMIT) { Rotate(c); }
        if (c.Log != null) c.Log.WriteLine(line);
      } catch { }
    }
  }

  static void Start(Child c) {
    Spec s = c.Spec;
    Rotate(c);
    ProcessStartInfo psi = new ProcessStartInfo(s.File, s.Args);
    psi.WorkingDirectory = s.WorkDir;
    psi.UseShellExecute = false;
    psi.CreateNoWindow = true;
    psi.RedirectStandardOutput = true;
    psi.RedirectStandardError = true;
    psi.RedirectStandardInput = true;
    foreach (string pair in (s.Env ?? "").Split('\n')) {
      int eq = pair.IndexOf('=');
      if (eq <= 0) continue;
      string key = pair.Substring(0, eq), value = pair.Substring(eq + 1).TrimEnd('\r');
      if (key == "PATH+") psi.EnvironmentVariables["PATH"] = value + ";" + psi.EnvironmentVariables["PATH"];
      else psi.EnvironmentVariables[key] = value;
    }
    Process p = new Process();
    p.StartInfo = psi;
    Child me = c;
    p.OutputDataReceived += delegate(object sender, DataReceivedEventArgs e) { Write(me, e.Data); };
    p.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs e) { Write(me, e.Data); };
    p.Start();
    AssignProcessToJobObject(job, p.Handle);
    p.StandardInput.Close();
    p.BeginOutputReadLine();
    p.BeginErrorReadLine();
    c.Proc = p;
    c.StartedAt = DateTime.Now;
    try { File.WriteAllText(Path.Combine(runDir, s.Name + ".pid"), p.Id.ToString()); } catch { }
    Note("started " + s.Name + " (process " + p.Id + ")");
  }

  static void Stop(Child c, string why) {
    if (c.Proc != null && !c.Proc.HasExited) {
      Note("stopping " + c.Spec.Name + ": " + why);
      try { c.Proc.Kill(); c.Proc.WaitForExit(15000); } catch { }
    }
    c.Proc = null;
    try { File.Delete(Path.Combine(runDir, c.Spec.Name + ".pid")); } catch { }
  }

  public static void Update(Spec[] specs) {
    HashSet<string> seen = new HashSet<string>();
    foreach (Spec s in specs) {
      seen.Add(s.Name);
      Child c;
      if (children.TryGetValue(s.Name, out c)) {
        if (c.Spec.Key == s.Key) continue;
        Stop(c, "its settings changed");
        c.Spec = s; c.Delay = 3; c.NextStart = DateTime.MinValue;
      } else {
        children[s.Name] = new Child { Spec = s };
      }
    }
    foreach (string name in new List<string>(children.Keys)) {
      if (seen.Contains(name)) continue;
      Stop(children[name], "it is no longer listed");
      children.Remove(name);
    }
  }

  // One pass: each listed program runs unless it is held; one that stopped is started again after its delay.
  public static void Tick() {
    DateTime now = DateTime.Now;
    foreach (Child c in children.Values) {
      bool held = File.Exists(Path.Combine(runDir, "hold-" + c.Spec.Name));
      if (held) { if (c.Proc != null) Stop(c, "held"); continue; }
      if (c.Proc != null && !c.Proc.HasExited) {
        if (c.Delay > 3 && (now - c.StartedAt).TotalMinutes > 5) c.Delay = 3;
        continue;
      }
      if (c.Proc != null) {
        int code = -1;
        try { code = c.Proc.ExitCode; } catch { }
        bool quick = (now - c.StartedAt).TotalSeconds < 30;
        c.Delay = quick ? Math.Min(c.Delay * 2, 60) : 3;
        Note(c.Spec.Name + " stopped (exit code " + code + "); starting it again in " + c.Delay + " seconds");
        c.Proc = null;
        c.NextStart = now.AddSeconds(c.Delay);
        try { File.Delete(Path.Combine(runDir, c.Spec.Name + ".pid")); } catch { }
      }
      if (now < c.NextStart) continue;
      try { Start(c); } catch (Exception e) { Note("could not start " + c.Spec.Name + ": " + e.Message); c.NextStart = now.AddSeconds(30); }
    }
  }

  public static void Begin(string run, string logs) {
    runDir = run; logDir = logs;
    Directory.CreateDirectory(runDir);
    Directory.CreateDirectory(logDir);
    MakeJob();
    Thread awake = new Thread(StayAwake);
    awake.IsBackground = true;
    awake.Start();
    Note("service started");
  }
}
'@

# Windows' own rules for one command-line argument (CommandLineToArgvW): quoted when it holds a space, a tab or a quote;
# backslashes are doubled only before a quote.
function ConvertTo-Arg([string]$a) {
  if ($a -ne '' -and $a -notmatch '[\s"]') { return $a }
  return '"' + ($a -replace '(\\*)"', '$1$1\"' -replace '(\\+)$', '$1$1') + '"'
}

function Read-Specs([string]$file) {
  # Windows PowerShell 5.1's ConvertFrom-Json hands a JSON list over as one object; assigned first, then iterated, it
  # is a list of entries again (wrapped in @() at once it became a list holding that one list).
  $parsed = Get-Content -Raw -LiteralPath $file | ConvertFrom-Json
  $specs = foreach ($s in @($parsed)) {
    $envLines = @()
    if ($s.env) { foreach ($p in $s.env.PSObject.Properties) { $envLines += "$($p.Name)=$($p.Value)" } }
    $spec = New-Object 'AeneasHubService+Spec'
    $spec.Name = [string]$s.name
    $spec.File = [string]$s.file
    $spec.Args = (@($s.args) | ForEach-Object { ConvertTo-Arg ([string]$_) }) -join ' '
    $spec.WorkDir = [string]$s.cwd
    $spec.Env = $envLines -join "`n"
    $spec.Key = "$($spec.File)|$($spec.Args)|$($spec.WorkDir)|$($spec.Env)"
    $spec
  }
  return , @($specs)
}

$conf = Join-Path $Root 'config\services.json'
[AeneasHubService]::Begin((Join-Path $Root 'run'), (Join-Path $Root 'data\logs'))
$stamp = $null
while ($true) {
  try {
    $now = (Get-Item -LiteralPath $conf).LastWriteTimeUtc
    if ($now -ne $stamp) { [AeneasHubService]::Update((Read-Specs $conf)); $stamp = $now }
  } catch {
    Add-Content -LiteralPath (Join-Path $Root 'data\logs\service.log') -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') services.json could not be read: $($_.Exception.Message)"
  }
  [AeneasHubService]::Tick()
  Start-Sleep -Seconds 2
}
