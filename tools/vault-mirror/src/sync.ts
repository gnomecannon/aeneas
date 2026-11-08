import { hashContent } from "./hash.ts";
import { HubClient, type IndexEntry } from "./hub.ts";
import type { Matcher } from "./ignore.ts";
import { conflictName, listLocal, readLocal, trashLocal, writeLocal, type LocalFile } from "./local.ts";
import type { Entry, State } from "./state.ts";

export type Action =
  | "put"
  | "put-new"
  | "get"
  | "get-new"
  | "conflict"
  | "delete-remote"
  | "trash-local"
  | "restore-local"
  | "same"
  | "forget";

export interface Decision {
  path: string;
  action: Action;
  reason: string;
}

export interface SyncOptions {
  hub: HubClient;
  vaultDir: string;
  state: State;
  ignore: Matcher;
  dryRun: boolean;
  log: (line: string) => void;
  /**
   * Name each path in the log. A note's file name is personal text, and once and watch write to a log file
   * (~/Library/Logs/everythingapp), so by default only dry-run, a preview printed for the owner, names them.
   */
  logPaths?: boolean;
  now?: () => Date;
}

export interface SyncSummary {
  decisions: Decision[];
  counts: Record<Action, number>;
}

const LABEL: Record<Action, string> = {
  put: "PUT      ",
  "put-new": "PUT      ",
  get: "GET      ",
  "get-new": "GET      ",
  conflict: "CONFLICT ",
  "delete-remote": "DEL-HUB  ",
  "trash-local": "TRASH    ",
  "restore-local": "GET      ",
  same: "SAME     ",
  forget: "FORGET   ",
};

/**
 * One full pass. Pure decision first, then apply (unless dryRun), then update state.
 * The hub wins any conflict (CONTRACT.md section 3, Vault).
 */
export async function syncOnce(opts: SyncOptions): Promise<SyncSummary> {
  const { hub, vaultDir, state, ignore, dryRun, log } = opts;
  const say = (opts.logPaths ?? dryRun) ? log : () => {};
  const now = opts.now ?? (() => new Date());
  const prefix = dryRun ? "DRY " : "";

  const local = await listLocal(vaultDir, ignore);
  const remoteList = await hub.index();
  const remote = new Map<string, IndexEntry>();
  for (const e of remoteList) {
    if (!ignore.isIgnored(e.path)) remote.set(e.path, e);
  }

  // local hash cache: reuse the stored hash when mtime is unchanged
  const localHash = new Map<string, string>();
  async function hashLocal(lf: LocalFile): Promise<string> {
    const cached = localHash.get(lf.rel);
    if (cached) return cached;
    const prev = state.entries[lf.rel];
    let h: string;
    if (prev && prev.local.mtime === lf.mtimeMs) h = prev.local.hash;
    else h = hashContent(await readLocal(vaultDir, lf.rel));
    localHash.set(lf.rel, h);
    return h;
  }

  const paths = new Set<string>([...local.keys(), ...remote.keys(), ...Object.keys(state.entries)]);
  const decisions: Decision[] = [];
  const counts = Object.fromEntries(Object.keys(LABEL).map((k) => [k, 0])) as Record<Action, number>;

  for (const p of [...paths].sort()) {
    if (ignore.isIgnored(p)) continue;
    const lf = local.get(p);
    const rf = remote.get(p);
    const prev = state.entries[p];

    let d: Decision;
    if (!prev) {
      if (lf && rf) d = { path: p, action: "conflict", reason: "exists on both sides, never synced" };
      else if (lf) d = { path: p, action: "put-new", reason: "new locally" };
      else if (rf) d = { path: p, action: "get-new", reason: "new on hub" };
      else continue;
    } else {
      const localChanged = lf ? (await hashLocal(lf)) !== prev.local.hash : false;
      const remoteChanged = rf ? rf.hash !== prev.remote.hash : false;
      if (!lf && !rf) d = { path: p, action: "forget", reason: "gone on both sides" };
      else if (!lf) {
        d = remoteChanged
          ? { path: p, action: "restore-local", reason: "deleted locally but changed on hub, hub wins" }
          : { path: p, action: "delete-remote", reason: "deleted locally" };
      } else if (!rf) {
        d = {
          path: p,
          action: "trash-local",
          reason: localChanged ? "deleted on hub, local edits kept in .trash" : "deleted on hub",
        };
      } else if (localChanged && remoteChanged) d = { path: p, action: "conflict", reason: "changed on both sides" };
      else if (localChanged) d = { path: p, action: "put", reason: "changed locally" };
      else if (remoteChanged) d = { path: p, action: "get", reason: "changed on hub" };
      else d = { path: p, action: "same", reason: "" };
    }

    // Conflict refinement: if both sides hold identical content there is no conflict.
    let remoteContent: string | null = null;
    if (d.action === "conflict" && lf) {
      remoteContent = await hub.get(p);
      if (remoteContent !== null && hashContent(remoteContent) === (await hashLocal(lf))) {
        d = { path: p, action: "same", reason: "identical on both sides" };
      }
    }

    decisions.push(d);
    counts[d.action]++;
    if (d.action !== "same") say(`${prefix}${LABEL[d.action]}${p}${d.reason ? "  (" + d.reason + ")" : ""}`);

    if (dryRun) continue;

    const t = now();
    const entry = (localSide: Entry["local"], remoteSide: Entry["remote"]): Entry => ({
      local: localSide,
      remote: remoteSide,
      synced_at: t.toISOString(),
    });

    switch (d.action) {
      case "put":
      case "put-new": {
        const content = await readLocal(vaultDir, p);
        const res = await hub.put(p, content, new Date(lf!.mtimeMs).toISOString());
        state.entries[p] = entry({ hash: hashContent(content), mtime: lf!.mtimeMs }, { hash: res.hash, mtime: res.mtime });
        break;
      }
      case "get":
      case "get-new":
      case "restore-local": {
        const content = await hub.get(p);
        if (content === null) {
          say(`${LABEL.forget}${p}  (vanished from hub during sync)`);
          delete state.entries[p];
          break;
        }
        const mtimeMs = await writeLocal(vaultDir, p, content, rf!.mtime);
        state.entries[p] = entry({ hash: hashContent(content), mtime: mtimeMs }, { hash: rf!.hash, mtime: rf!.mtime });
        break;
      }
      case "conflict": {
        const content = remoteContent ?? (await hub.get(p));
        if (content === null) {
          say(`${LABEL.forget}${p}  (vanished from hub during sync)`);
          break;
        }
        const localContent = await readLocal(vaultDir, p);
        const copy = conflictName(p, t);
        await writeLocal(vaultDir, copy, localContent);
        say(`${LABEL.conflict}${p}  local copy saved as ${copy}`);
        const mtimeMs = await writeLocal(vaultDir, p, content, rf!.mtime);
        state.entries[p] = entry({ hash: hashContent(content), mtime: mtimeMs }, { hash: rf!.hash, mtime: rf!.mtime });
        break;
      }
      case "delete-remote":
        await hub.delete(p);
        delete state.entries[p];
        break;
      case "trash-local": {
        const dest = await trashLocal(vaultDir, p, t);
        say(`${LABEL["trash-local"]}${p}  moved to ${dest}`);
        delete state.entries[p];
        break;
      }
      case "forget":
        delete state.entries[p];
        break;
      case "same":
        if (lf && rf) {
          // refresh cached mtime and hub mtime so the next pass stays cheap
          state.entries[p] = entry({ hash: await hashLocal(lf), mtime: lf.mtimeMs }, { hash: rf.hash, mtime: rf.mtime });
        }
        break;
    }
  }

  const changed = decisions.filter((d) => d.action !== "same").length;
  log(
    `${prefix}done: ${decisions.length} paths, ${changed} actions ` +
      `(put ${counts.put + counts["put-new"]}, get ${counts.get + counts["get-new"] + counts["restore-local"]}, ` +
      `conflict ${counts.conflict}, deleted on hub ${counts["delete-remote"]}, trashed ${counts["trash-local"]})`,
  );
  return { decisions, counts };
}
