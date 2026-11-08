/**
 * What the assistant's tools may call on the hub. They run in-process with the hub's own token, so this is the
 * line between "the assistant can do what the owner can" and "the assistant can do what its tools are for":
 * text from the model ends up in paths (ids, a calculator type), and a model steered by a web page or an email
 * must not reach the password vault, pairing links, setup or the owner's switches through them.
 */

/** Paths no tool reads: they hold secrets or give access (the vault's master password and file, a pairing link). */
const NO_READ = [
  "/connections/password-manager/keepass",
  "/setup/pair",
  "/setup/backup/reveal",
  "/vault/export",
  "/feeds",
];

/** Paths a tool may change: syncing a linked account now. Every other write under these prefixes is the owner's. */
const OWNER_WRITES = ["/connections", "/space", "/modules", "/setup", "/profile", "/imports", "/devices", "/prefs/feel", "/sync"];
const TOOL_WRITES = /^\/connections\/(steam|letterboxd|atlassian|google)\/sync$/;

/**
 * Why a tool call is refused, or null when it may go ahead. The path must be a plain hub path: no `.` or `..`
 * segment (the router would resolve `/calc/../connections/...`), encoded or not, no backslash, no other host.
 */
export function refuseToolCall(method: string, rawPath: string): string | null {
  if (!rawPath.startsWith("/") || rawPath.startsWith("//") || rawPath.includes("\\")) return "not a hub path";
  const [pathPart] = rawPath.split(/[?#]/, 1);
  const parts: string[] = [];
  for (const seg of pathPart.split("/").slice(1)) {
    let d: string;
    try { d = decodeURIComponent(seg); } catch { return "a path part is not valid"; }
    if (d === "." || d === ".." || d.includes("/") || d.includes("\\") || /[\u0000-\u001f]/.test(d)) return "a path part is not allowed";
    parts.push(d);
  }
  // Compared decoded, as the router matches it (/setup/pai%72 is /setup/pair there).
  const p = `/${parts.join("/")}`.replace(/\/+$/, "") || "/";
  const under = (pre: string) => p === pre || p.startsWith(pre + "/");
  if (NO_READ.some(under)) return "that part of the hub is only for the owner";
  if (method.toUpperCase() !== "GET" && OWNER_WRITES.some(under) && !TOOL_WRITES.test(p)) return "only the owner changes that, in Settings";
  return null;
}
