import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

/** Directories never entered. */
export const SKIP_DIRS = [".obsidian", ".trash"];

/**
 * Names never mirrored, in either direction. Always on, cannot be removed. Notes of your own to keep off the hub
 * go in the vault's `.mirrorignore` or in USER_IGNORE_FILE, one pattern per line.
 * A trailing slash means "that folder and everything under it". Matching ignores the
 * difference between straight and curly apostrophes and is case-insensitive.
 */
export const DEFAULT_IGNORE = [
  "*recovery code*", "*backup code*", "*password*", "*credential*", "*2fa*", "*seed phrase*", "*private key*",
];

/**
 * Patterns kept outside the vault and outside this repository, on the machine that runs the mirror. EA_MIRROR_IGNORE
 * names another file; a missing file means none.
 */
export const USER_IGNORE_FILE = path.join(os.homedir(), ".config", "everythingapp", "vault-mirror-ignore.txt");

/** Straight apostrophes and lowercase so "Robin’s" and "robin's" compare equal. */
export function normalizeName(s: string): string {
  return s.replace(/[\u2018\u2019\u02bc]/g, "'").toLowerCase();
}

export const IGNORE_FILE = ".mirrorignore";

export interface Matcher {
  patterns: string[];
  isIgnored(relPath: string): boolean;
}

/**
 * Pattern rules (a small subset of gitignore):
 *   - blank lines and lines starting with # are skipped
 *   - "*" matches anything except "/", "**" matches anything including "/"
 *   - a pattern without "/" matches the file name or any directory name on the path
 *   - a pattern with "/" matches the whole vault-relative path
 *   - a pattern ending in "/" matches everything under that directory
 */
export function globToRegExp(pattern: string): RegExp {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        re += ".*";
        i++;
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (/[.+^${}()|[\]\\]/.test(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp("^" + re + "$", "i");
}

export function buildMatcher(extraPatterns: string[]): Matcher {
  const patterns = [...DEFAULT_IGNORE, ...extraPatterns]
    .map((p) => p.trim())
    .filter((p) => p && !p.startsWith("#"));

  const compiled = patterns.map((p) => {
    const dirOnly = p.endsWith("/");
    const body = dirOnly ? p.slice(0, -1) : p;
    const anchored = body.includes("/");
    return { dirOnly, anchored, re: globToRegExp(normalizeName(body.replace(/^\//, ""))) };
  });

  return {
    patterns,
    isIgnored(relPath: string): boolean {
      const segments = normalizeName(relPath).split("/");
      const base = segments[segments.length - 1];
      for (const c of compiled) {
        if (c.dirOnly) {
          const dirs = segments.slice(0, -1);
          if (c.anchored) {
            for (let n = 1; n <= dirs.length; n++) if (c.re.test(dirs.slice(0, n).join("/"))) return true;
          } else if (dirs.some((d) => c.re.test(d))) return true;
        } else if (c.anchored) {
          if (c.re.test(relPath)) return true;
        } else if (c.re.test(base) || segments.slice(0, -1).some((d) => c.re.test(d))) {
          return true;
        }
      }
      return false;
    },
  };
}

async function lines(file: string): Promise<string[]> {
  try {
    return (await fs.readFile(file, "utf8")).split(/\r?\n/);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return [];
  }
}

/** The defaults, the vault's own `.mirrorignore` and the patterns in the user's file outside the vault. */
export async function loadIgnore(vaultDir: string, userFile: string = process.env.EA_MIRROR_IGNORE || USER_IGNORE_FILE): Promise<Matcher> {
  return buildMatcher([...(await lines(path.join(vaultDir, IGNORE_FILE))), ...(await lines(userFile))]);
}
