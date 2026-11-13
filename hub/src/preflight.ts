import { nowIso } from "@everythingapp/shared";
import type { Entity } from "@everythingapp/shared";
import type { Store } from "./store.js";

/**
 * Pre-flight for destructive commands (Module 2).
 * When an assistant reply contains one of the commands below, a short block is placed right before the first
 * code block or line that holds it: what to back up or snapshot, how to verify the target, and the rollback.
 * A journal entry with outcome `planned` and risk `high` records that the command was proposed. A reply about a
 * command that already ran in its turn (an approved change) gets neither.
 * Add a row to DESTRUCTIVE to extend the detector; the README lists the table.
 */

export interface DestructiveRule {
  name: string;
  pattern: RegExp;
  /** One line each. `<target>` reads naturally for every command in the family. */
  backup: string;
  verify: string;
  rollback: string;
}

export const DESTRUCTIVE: DestructiveRule[] = [
  {
    // Every recursive rm: -rf, -r alone, -r -f, -R, --recursive --force, the option before or after the path.
    name: "rm -rf",
    pattern: /\brm\s+(?:[^\n;&|]*\s)?(?:-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)\b/,
    backup: "Back up: tar the path (`tar czf /root/pre-rm.tgz <path>`) or snapshot the filesystem it lives on.",
    verify: "Verify: `ls -la <path>` and `pwd`; make sure no variable in the path expands to nothing.",
    rollback: "Rollback: restore from the tar or snapshot. rm has no undo.",
  },
  {
    name: "zpool destroy",
    pattern: /\bzpool\s+destroy\b/,
    backup: "Back up: `zfs snapshot -r <pool>@pre-destroy` and `zfs send` it to another pool or host, or confirm a current replica exists.",
    verify: "Verify: `zpool list` and `zpool status <pool>`; confirm the pool name and that nothing is still mounted from it.",
    rollback: "Rollback: `zpool import -D <pool>` can bring a destroyed pool back only until its disks are reused.",
  },
  {
    name: "zfs destroy",
    pattern: /\bzfs\s+destroy\b/,
    backup: "Back up: `zfs snapshot <dataset>@pre-destroy` and send it off the pool.",
    verify: "Verify: `zfs list -r -t all <dataset>`; check for children, clones and holds.",
    rollback: "Rollback: receive the sent snapshot back. A destroyed dataset is gone from the pool.",
  },
  {
    name: "mkfs",
    pattern: /\bmkfs(?:\.[a-z0-9]+)?\b/,
    backup: "Back up: image the device first (`dd if=<dev> of=/path/pre-mkfs.img bs=4M`) or confirm nothing on it is needed.",
    verify: "Verify: `lsblk -f <dev>` and `blkid <dev>`; confirm it is the intended device and not the system disk.",
    rollback: "Rollback: write the image back. mkfs has no undo.",
  },
  {
    name: "dd if=",
    pattern: /\bdd\s+(?:\S+\s+)*if=/,
    backup: "Back up: image the target (`of=`) device before writing to it.",
    verify: "Verify: `lsblk` and `blkid` on both `if=` and `of=`; confirm `of=` is the right device and not mounted.",
    rollback: "Rollback: write the target's image back.",
  },
  {
    name: "fdisk",
    pattern: /\bfdisk\b(?!\s+-l\b)/,
    backup: "Back up: save the partition table (`sfdisk -d <dev> > /root/pre-fdisk.table`) and image anything you cannot lose.",
    verify: "Verify: `lsblk <dev>` and `blkid <dev>`; confirm the device name.",
    rollback: "Rollback: `sfdisk <dev> < /root/pre-fdisk.table` restores the table; data needs the image.",
  },
  {
    name: "parted",
    pattern: /\bparted\b(?!\s+-l\b)/,
    backup: "Back up: save the partition table (`sfdisk -d <dev> > /root/pre-parted.table`) and image anything you cannot lose.",
    verify: "Verify: `parted <dev> print` and `lsblk <dev>`; confirm the device name.",
    rollback: "Rollback: `sfdisk <dev> < /root/pre-parted.table` restores the table; data needs the image.",
  },
  {
    name: "wipefs",
    pattern: /\bwipefs\b/,
    backup: "Back up: `wipefs --backup <dev>` writes the signatures to files in the current directory; image the device if the data matters.",
    verify: "Verify: `wipefs <dev>` without `-a` lists what would go; confirm the device name.",
    rollback: "Rollback: `dd` the saved signature files back at their offsets, or restore the image.",
  },
  {
    name: "DROP TABLE or DATABASE",
    pattern: /\bDROP\s+(?:TABLE|DATABASE)\b/i,
    backup: "Back up: dump it first (`pg_dump` or `mysqldump` of the database or table) and check the file size is plausible.",
    verify: "Verify: connect to the intended server and database and run `SELECT count(*)` on the table; confirm this is not production by mistake.",
    rollback: "Rollback: restore from the dump.",
  },
  {
    name: "reg delete",
    pattern: /\breg\s+delete\b/i,
    backup: "Back up: `reg export <key> C:\\pre-delete.reg`.",
    verify: "Verify: `reg query <key>`; confirm the hive and the full key path.",
    rollback: "Rollback: `reg import C:\\pre-delete.reg`.",
  },
  {
    name: "format",
    pattern: /(?<=^|[\s;&|(])format\s+[a-zA-Z]:/im,
    backup: "Back up: copy anything needed off the volume; image it if unsure.",
    verify: "Verify: `Get-Volume` or diskpart `list volume`; confirm the drive letter.",
    rollback: "Rollback: restore from the copy. format has no undo.",
  },
  {
    name: "diskpart",
    pattern: /\bdiskpart\b/i,
    backup: "Back up: image the disk or copy its volumes off before any `clean`, `delete` or `format`.",
    verify: "Verify: `list disk` and `list volume` inside diskpart; confirm the disk number and size match.",
    rollback: "Rollback: restore from the image. diskpart changes are immediate.",
  },
  {
    name: "rendom",
    pattern: /\brendom\b/i,
    backup: "Back up: system state backup of every domain controller and `repadmin /replsummary` clean before starting.",
    verify: "Verify: the rename plan file lists the right forest and domains; all DCs are reachable.",
    rollback: "Rollback: `rendom /end` before commit abandons the rename; after that, restore the DCs from backup.",
  },
  {
    name: "rsync --delete",
    pattern: /\brsync\b[^\n]*--delete/,
    backup: "Back up: run the same command with `--dry-run` first and snapshot or copy the destination.",
    verify: "Verify: the trailing slashes and that source and destination are the right way round.",
    rollback: "Rollback: restore the destination from its snapshot or copy.",
  },
  {
    name: "git push --force",
    pattern: /\bgit\s+push\b[^\n]*(?:--force\b|\s-f\b)/,
    backup: "Back up: note the remote branch's current commit (`git rev-parse origin/<branch>`) or tag it.",
    verify: "Verify: `git log origin/<branch>..HEAD` and `git status`; confirm the branch and the remote.",
    rollback: "Rollback: `git push --force origin <noted sha>:<branch>`.",
  },
  {
    name: "terraform destroy",
    pattern: /\bterraform\s+destroy\b/,
    backup: "Back up: copy the state file and keep the output of `terraform plan -destroy`.",
    verify: "Verify: `terraform workspace show` and any `-target` list; confirm the account or project.",
    rollback: "Rollback: `terraform apply` from the saved code and state. Data inside destroyed resources is not recoverable.",
  },
  {
    name: "blkdiscard",
    pattern: /\bblkdiscard\b/,
    backup: "Back up: image the device first (`dd if=<dev> of=/path/pre-discard.img bs=4M`) or confirm nothing on it is needed.",
    verify: "Verify: `lsblk -f <dev>`; confirm it is the intended device and that nothing on it is mounted.",
    rollback: "Rollback: write the image back. Discarded blocks read as zeros and cannot be recovered.",
  },
  {
    name: "docker compose down -v",
    pattern: /\bdocker(?:\s+|-)compose\b[^\n]*\bdown\b[^\n]*(?:\s-v\b|\s--volumes\b)/,
    backup: "Back up: archive each named volume first (`docker volume ls`, then a tar of each from a throwaway container), or snapshot the disk that holds them.",
    verify: "Verify: `docker compose config --volumes` lists the volumes it deletes; without the volumes flag they are kept.",
    rollback: "Rollback: create the volumes again and restore their archives. Removed volumes are gone.",
  },
  {
    name: "zfs rollback",
    pattern: /\bzfs\s+rollback\b/,
    backup: "Back up: `zfs snapshot <dataset>@pre-rollback` keeps what is there now.",
    verify: "Verify: `zfs list -t snapshot -r <dataset>`; with -r every snapshot newer than the target is destroyed too.",
    rollback: "Rollback: roll back to the pre-rollback snapshot. Snapshots destroyed by -r are gone.",
  },
  {
    name: "Remove-Item -Recurse",
    pattern: /\bRemove-Item\b[^\n]*\s-r[a-z]*\b|\b(?:rd|rmdir|del|erase)\s+(?:\/[a-z]+\s+)*\/s\b/i,
    backup: "Back up: copy the folder first (`Copy-Item <path> <backup> -Recurse`), or make a restore point or a snapshot.",
    verify: "Verify: `Get-ChildItem <path> -Recurse | Measure-Object` and the full path; a wildcard or an empty variable reaches more than meant.",
    rollback: "Rollback: restore from the copy. Items removed this way skip the Recycle Bin.",
  },
  {
    name: "git clean",
    pattern: /\bgit\b[^\n]*\bclean\b[^\n]*(?:\s-[a-zA-Z]*f|\s--force\b)/,
    backup: "Back up: `git clean -n` with the same -d and -x lists what goes; copy anything untracked you need, or `git stash -u`.",
    verify: "Verify: `git status --ignored` in the right repository; -x also deletes ignored files such as .env and build output.",
    rollback: "Rollback: untracked files are not in git; only the copy or the stash brings them back.",
  },
  {
    // Every sgdisk but printing, verifying and saving a backup of the table writes to the disk.
    name: "sgdisk",
    pattern: /\bsgdisk\b(?=[^\n]*\s(?:-(?![pvb]\b)[a-zA-Z]|--(?!print\b|verify\b|backup\b)[a-z]))/,
    backup: "Back up: `sgdisk --backup=/root/pre-sgdisk.gpt <dev>` saves the partition table; image anything you cannot lose.",
    verify: "Verify: `sgdisk -p <dev>` and `lsblk <dev>`; confirm the device name.",
    rollback: "Rollback: `sgdisk --load-backup=/root/pre-sgdisk.gpt <dev>` restores the table; data needs the image.",
  },
  {
    // sfdisk writes a partition table unless it only dumps, lists or checks one.
    name: "sfdisk",
    pattern: /\bsfdisk\b(?![^\n]*\s(?:-[dlJVsgF]\b|--(?:dump|list|json|verify|show-size|show-geometry|list-free)\b))/,
    backup: "Back up: `sfdisk -d <dev> > /root/pre-sfdisk.table` saves the partition table; image anything you cannot lose.",
    verify: "Verify: `sfdisk -l <dev>` and `lsblk <dev>`; confirm the device name.",
    rollback: "Rollback: feed /root/pre-sfdisk.table back to sfdisk for the device; data needs the image.",
  },
  {
    name: "lvremove",
    pattern: /\b(?:lvremove|vgremove|pvremove)\b/,
    backup: "Back up: copy the volume's data or take an LVM snapshot (`lvcreate -s`); `vgcfgbackup` saves the layout.",
    verify: "Verify: `lvs`, `vgs` and `findmnt`; confirm the volume name and that nothing is mounted from it.",
    rollback: "Rollback: `vgcfgrestore` can bring the layout back until the space is reused; the data needs the backup.",
  },
];

export interface DestructiveMatch { rule: DestructiveRule; index: number; line: number; command: string }

const MARKER = /^Pre-flight for `/m;

/** The earliest destructive command in the text, or null. */
export function detectDestructive(text: string): DestructiveMatch | null {
  let best: { rule: DestructiveRule; index: number } | null = null;
  for (const rule of DESTRUCTIVE) {
    const m = rule.pattern.exec(text);
    if (m && (!best || m.index < best.index)) best = { rule, index: m.index };
  }
  if (!best) return null;
  const line = text.slice(0, best.index).split(/\r?\n/).length - 1;
  const raw = text.split(/\r?\n/)[line] ?? "";
  const command = raw.replace(/`/g, "").replace(/^\s*(?:\$|#|>|\d+[.)]|[-*])\s+/, "").trim();
  return { rule: best.rule, index: best.index, line, command };
}

/** The lines of the block that goes before the command. */
export function preflightBlock(m: DestructiveMatch): string {
  return [
    `Pre-flight for \`${m.command.slice(0, 120)}\` (${m.rule.name}):`,
    `- ${m.rule.backup}`,
    `- ${m.rule.verify}`,
    `- ${m.rule.rollback}`,
  ].join("\n");
}

export type PreflightCheck =
  | { destructive: false }
  | { destructive: true; name: string; command: string; backup: string; verify: string; rollback: string; block: string };

/**
 * The check behind `POST /preflight`, for commands typed by hand (the journal form). Same rules and the same wording as the
 * block placed in assistant replies, so the clients never carry a copy of the table.
 */
export function checkCommand(text: string): PreflightCheck {
  const m = detectDestructive(text);
  if (!m) return { destructive: false };
  return { destructive: true, name: m.rule.name, command: m.command, backup: m.rule.backup, verify: m.rule.verify, rollback: m.rule.rollback, block: preflightBlock(m) };
}

export interface PreflightResult { text: string; inserted: boolean; match: DestructiveMatch | null }

/** A command as compared with another: no backticks, sudo or sudo -n, case or extra spaces. */
export function normalizeCommand(s: string): string {
  return s.replace(/`/g, "").replace(/^\s*[$#]\s+/, "").replace(/\bsudo\s+(?:-n\s+)?/g, "").replace(/[;\s]+$/, "").replace(/\s+/g, " ").trim().toLowerCase();
}

/** The reply's destructive command is one of `ran` (written as the reply shows it, up to a backtick or the line end). */
function alreadyRan(reply: string, m: DestructiveMatch, ran: string[]): boolean {
  const shown = normalizeCommand(reply.slice(m.index).split(/[`\n]/)[0]);
  return !!shown && ran.map(normalizeCommand).some((c) => !!c && (c.includes(shown) || shown.includes(c)));
}

/**
 * Place the block immediately before the first code block or line that contains the command.
 * A reply that already carries a block is returned unchanged, so the pipeline can never insert twice. A command in
 * `ran` already ran in this turn (an approved change the reply reports on): it gets no block and no planned entry.
 */
export function insertPreflight(reply: string, ran: string[] = []): PreflightResult {
  const m = detectDestructive(reply);
  if (!m) return { text: reply, inserted: false, match: null };
  if (ran.length && alreadyRan(reply, m, ran)) return { text: reply, inserted: false, match: null };
  if (MARKER.test(reply)) return { text: reply, inserted: false, match: m };
  const lines = reply.split(/\r?\n/);
  let at = m.line;
  // When the match sits inside a fenced block, walk back to the opening fence.
  let open = -1;
  for (let i = 0; i < m.line; i++) {
    if (/^\s*```/.test(lines[i])) open = open < 0 ? i : -1;
  }
  if (open >= 0) at = open;
  const block = preflightBlock(m).split("\n");
  const before = lines.slice(0, at);
  const after = lines.slice(at);
  if (before.length && before[before.length - 1].trim() !== "") before.push("");
  return { text: [...before, ...block, "", ...after].join("\n"), inserted: true, match: m };
}

/**
 * The journal entry for a planned destructive command. One per session and command: a repeat of the same
 * command in the same session updates the existing row instead of adding another.
 */
export function recordPlanned(store: Store, m: DestructiveMatch, host: string, sessionId?: string): Entity {
  const command = m.command.slice(0, 2000);
  const existing = sessionId
    ? store.list({ kind: "journal", where: { session_id: sessionId, outcome: "planned" } }).find((j) => j.fields.command === command)
    : undefined;
  const fields = {
    host, at: nowIso(), what: command.slice(0, 120), command, risk: "high", rollback: m.rule.rollback.replace(/^Rollback:\s*/, ""),
    outcome: "planned", ...(sessionId ? { session_id: sessionId } : {}),
  };
  return existing ? store.patch(existing.id, fields) : store.create("journal", fields);
}
