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
  if (game) return `${game.name.split("/").pop()} is using the GPU`;
  if (!modelRunning && utilizationPct !== null && utilizationPct >= BUSY_PCT) return `the GPU is ${utilizationPct}% busy`;
  return null;
}

function run(file: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: 8000 }, (err, stdout) => resolve(err ? null : String(stdout)));
  });
}

/** Null when the GPU is free for background work, else why not. */
export async function gpuBusyNow(modelRunning: boolean): Promise<string | null> {
  const table = await run("nvidia-smi", []);
  if (table === null) return null;
  const util = await run("nvidia-smi", ["--query-gpu=utilization.gpu", "--format=csv,noheader,nounits"]);
  const pct = util === null ? null : Number.parseInt(util.trim().split("\n")[0] ?? "", 10);
  return gpuBusy(parseNvidiaProcesses(table), Number.isFinite(pct) ? pct : null, modelRunning);
}
