import { execFile } from "node:child_process";

/**
 * Whether the GPU on the hub's machine is free for background model work: no game on it. The card that runs the model
 * may also run someone's games (Steam on that machine's desktop), so scheduled work (the mail reader at its set times) asks first and waits
 * while anything else is using the card. Read from `nvidia-smi`; a machine without it counts as free.
 */

/** Processes that are always on the card and are not a game: the desktop, Steam's client, the model server. */
const DESKTOP = /(gnome-shell|xwayland|xorg|kwin|plasmashell|steamwebhelper|\/steam$|ubuntu12_32\/steam|ollama|llama|compiz|mutter)/i;
/** A process holding this much graphics memory that is not the desktop is a game (or a 3D app, which counts too). */
const GAME_MIB = 300;
/** Card load that means something else is drawing, when the model is not running. */
const BUSY_PCT = 20;

export interface GpuProcess { pid: number; type: string; name: string; mib: number }

/** Addresses that are this machine (or the Docker host, from a container): a model server there uses this card. */
const THIS_MACHINE = /^(127\.\d{1,3}\.\d{1,3}\.\d{1,3}|localhost|\[::1\]|172\.17\.0\.1|host\.docker\.internal)$/i;
export function onThisMachine(url: string): boolean {
  try { return THIS_MACHINE.test(new URL(url).hostname); } catch { return false; }
}

/** The process table of `nvidia-smi`'s plain output. */
export function parseNvidiaProcesses(text: string): GpuProcess[] {
  const out: GpuProcess[] = [];
  for (const line of text.split("\n")) {
    const m = /^\|\s+\d+\s+\S+\s+\S+\s+(\d+)\s+(C\+G|C|G)\s+(.+?)\s+(\d+)MiB\s*\|$/.exec(line);
    if (m) out.push({ pid: Number(m[1]), type: m[2], name: m[3].trim(), mib: Number(m[4]) });
  }
  return out;
}

/** What `nvidia-smi` says decides it: a game is running, or the card is busy while the model is idle. */
export function gpuBusy(processes: GpuProcess[], utilizationPct: number | null, modelRunning: boolean): string | null {
  const game = processes.find((p) => !DESKTOP.test(p.name) && p.mib >= GAME_MIB);
  if (game) return `${game.name.split(/[\\/]/).pop()} is using the GPU`;
  if (!modelRunning && utilizationPct !== null && utilizationPct >= BUSY_PCT) return `the GPU is ${utilizationPct}% busy`;
  return null;
}

/**
 * Windows: `nvidia-smi` shows no graphics memory per program there (N/A for each), and the card's own load is not a
 * sign of a game: on a gaming PC at its desktop (measured 2026-11-10) the card was 39% busy, the compositor (dwm) held
 * 35 GB, Wallpaper Engine 3.6 GB and the NVIDIA overlay 2.6 GB, all at 0 to 5% 3D load. Windows' own counters give each
 * program's 3D load; a program that is not part of the desktop drawing at 25% or more is taken for a game (a game in
 * front draws far more). The model server works on the card's compute engine, never 3D, so it never counts.
 */
export interface WinGpuProcess { pid: number; name: string; mib: number; pct3d: number }
/** Programs that draw on the card and are not games: Windows' own desktop, overlays, wallpapers, launchers, browsers. */
const WIN_DESKTOP = /^(dwm|csrss|explorer|\w*experiencehost|searchhost|searchapp|textinputhost|tabtip|lockapp|shellhost|applicationframehost|systemsettings|widgets|phoneexperiencehost|crossdeviceresume|nvidia (overlay|share|app)|nvcontainer|nvdisplay\.container|wallpaper(32|64)|wallpaperengine\w*|lively\w*|msedgewebview2|steamwebhelper|steam|epicgameslauncher|galaxyclient|battle\.net|eadesktop|ubisoftconnect|ollama\w*|llama\S*|parsecd|remoting_desktop|rustdesk|chrome|msedge|firefox|brave|opera\w*|vivaldi|arc|obs\w*)$/i;
const GAME_PCT_3D = 25;
export function gpuBusyWindows(processes: WinGpuProcess[]): string | null {
  const game = processes
    .filter((p) => !WIN_DESKTOP.test(p.name.replace(/\.exe$/i, "")) && p.pct3d >= GAME_PCT_3D)
    .sort((a, b) => b.pct3d - a.pct3d)[0];
  return game ? `${game.name.replace(/\.exe$/i, "")} is using the GPU` : null;
}

/** One PowerShell call reads both counters (about 2.5 s) and prints a line per program: pid, name, MiB, 3D %. */
const WIN_QUERY = [
  "$m = (Get-Counter '\\GPU Process Memory(*)\\Dedicated Usage' -ErrorAction SilentlyContinue).CounterSamples",
  "$e = (Get-Counter '\\GPU Engine(*engtype_3D)\\Utilization Percentage' -ErrorAction SilentlyContinue).CounterSamples",
  "$mib = @{}; $pct = @{}",
  "foreach ($s in $m) { if ($s.InstanceName -match 'pid_(\\d+)_') { $k = [int]$Matches[1]; $mib[$k] = [math]::Max([double]$mib[$k], $s.CookedValue / 1MB) } }",
  "foreach ($s in $e) { if ($s.InstanceName -match 'pid_(\\d+)_') { $k = [int]$Matches[1]; $pct[$k] = [double]$pct[$k] + $s.CookedValue } }",
  "foreach ($k in $pct.Keys) { if ($pct[$k] -ge 1) { $n = (Get-Process -Id $k -ErrorAction SilentlyContinue).ProcessName; \"$k`t$n`t$([math]::Round([double]$mib[$k]))`t$([math]::Round($pct[$k], 1))\" } }",
].join("; ");

export function parseWindowsGpu(text: string): WinGpuProcess[] {
  return text.split(/\r?\n/).map((l) => l.split("\t")).filter((f) => f.length === 4 && f[1])
    .map(([pid, name, mib, pct]) => ({ pid: Number(pid), name, mib: Number(mib) || 0, pct3d: Number(pct) || 0 }));
}

function run(file: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: 8000, windowsHide: true }, (err, stdout) => resolve(err ? null : String(stdout)));
  });
}

/** How the card is asked; tests replace it, so what the test machine's own card is doing does not count. */
export const gpuProbe = { run, platform: process.platform as NodeJS.Platform };

/** Null when the GPU is free for background work, else why not. */
export async function gpuBusyNow(modelRunning: boolean): Promise<string | null> {
  if (gpuProbe.platform === "win32") {
    const out = await gpuProbe.run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", WIN_QUERY]);
    return out === null ? null : gpuBusyWindows(parseWindowsGpu(out));
  }
  const table = await gpuProbe.run("nvidia-smi", []);
  if (table === null) return null;
  const util = await gpuProbe.run("nvidia-smi", ["--query-gpu=utilization.gpu", "--format=csv,noheader,nounits"]);
  const pct = util === null ? null : Number.parseInt(util.trim().split("\n")[0] ?? "", 10);
  return gpuBusy(parseNvidiaProcesses(table), Number.isFinite(pct) ? pct : null, modelRunning);
}
