import { promises as fs } from "node:fs";
import path from "node:path";

export interface SideState {
  hash: string;
  /** local: epoch milliseconds. remote: the mtime string the hub reported. */
  mtime: number | string;
}

export interface Entry {
  local: SideState;
  remote: SideState;
  synced_at: string;
}

export interface State {
  version: 1;
  entries: Record<string, Entry>;
}

export function emptyState(): State {
  return { version: 1, entries: {} };
}

export async function loadState(file: string): Promise<State> {
  try {
    const raw = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(raw) as State;
    if (parsed.version !== 1 || typeof parsed.entries !== "object") return emptyState();
    return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
    throw err;
  }
}

export async function saveState(file: string, state: State): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(state, null, 2) + "\n", "utf8");
  await fs.rename(tmp, file);
}
