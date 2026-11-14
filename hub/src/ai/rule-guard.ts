import vm from "node:vm";

/**
 * The patterns of the owner's filter rules (kind `rule`, enforce filter or both). Each one runs on every reply, draft
 * and resume card, on the hub's only thread: a pattern that backtracks without end, such as `(a+)+$`, stalls the whole
 * hub on every reply. So a pattern is checked on every save (store.ts, whatever wrote it) and again before the hub
 * first uses it: it must compile with its flags, stay under PATTERN_MAX characters, and get through long test text
 * within PROBE_MS.
 */

/** Longest pattern a rule may hold, in characters. */
export const PATTERN_MAX = 300;
/** Time all the test texts may take together. A sound pattern needs a few milliseconds. */
export const PROBE_MS = 250;

/** Characters every pattern is tried on, besides each character written in the pattern itself. */
const PROBE_CHARS = ["a", "Z", "0", " ", "\t", "\n", ".", ",", "-", "_", "!", "\u00e9", "\u2014"];

/**
 * Test texts for one pattern. A run of 3,000 of one character (or of a word written in the pattern, for `(ha|HA)+`)
 * finds patterns that backtrack exponentially, or worse than quadratically, on it; the same with a space after each
 * (20,000 characters) finds that across words. Each text ends in a character nothing expects, so a match has to fail
 * after trying every way to split the run. Whitespace gets only the shorter run: a common pattern such as `\s+-\s+`
 * is quadratic on a long run of spaces, which costs milliseconds at this length and is no stall.
 */
function probeTexts(pattern: string): string[] {
  const chars = [...new Set([...PROBE_CHARS, ...pattern])].slice(0, 48);
  const words = [...new Set(pattern.replace(/\\./g, " ").match(/[\p{L}\p{N}]{2,12}/gu) ?? [])].slice(0, 8);
  const run = (u: string) => `${u.repeat(Math.ceil(3000 / u.length))}\u0000`;
  const spaced = (u: string) => `${`${u} `.repeat(Math.ceil(20000 / (u.length + 1)))}\u0000`;
  return [...chars, ...words].flatMap((u) => (/\s/.test(u) ? [run(u)] : [run(u), spaced(u)]));
}

/**
 * Why a rule's pattern cannot be saved, in plain words, or null when it can (or there is none). `flags` as the rule
 * holds them; the hub uses "g" when it holds none.
 */
export function patternProblem(pattern: unknown, flags: unknown): string | null {
  if (pattern === undefined || pattern === null || pattern === "") return null;
  if (typeof pattern !== "string") return "a rule's pattern must be text";
  if (pattern.length > PATTERN_MAX) return `a rule's pattern may be at most ${PATTERN_MAX} characters; this one has ${pattern.length}`;
  const f = flags === undefined || flags === null ? "g" : String(flags);
  try {
    new RegExp(pattern, f);
  } catch (e) {
    return `the rule's pattern is not a regular expression that works with the flags "${f}" (${String((e as Error).message).split(": ").pop()})`;
  }
  try {
    // A separate context with a time limit stops a runaway match, which nothing in this thread could interrupt.
    vm.runInNewContext("for (const s of texts) s.replace(new RegExp(p, f), \"\")", { texts: probeTexts(pattern), p: pattern, f }, { timeout: PROBE_MS });
  } catch {
    return `the rule's pattern takes too long on long text (more than ${PROBE_MS} ms on the hub's test text), so it would stall every reply; use a simpler one`;
  }
  return null;
}

const checked = new Map<string, string | null>();

/** patternProblem, remembered per pattern and flags: the hub asks it before each reply's filter. */
export function knownPatternProblem(pattern: unknown, flags: unknown): { problem: string | null; first: boolean } {
  const key = `${String(flags ?? "g")}\u0000${String(pattern ?? "")}`;
  if (checked.has(key)) return { problem: checked.get(key) ?? null, first: false };
  if (checked.size >= 500) checked.clear();
  const problem = patternProblem(pattern, flags);
  checked.set(key, problem);
  return { problem, first: true };
}
