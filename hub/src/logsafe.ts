/**
 * What a hub log line may say about an error.
 *
 * Logs reach the journal and anything that copies it, so a line holds ids, counts, kinds, durations, status codes and
 * module names only (CONTRACT.md, "Privacy rules every module meets"). An error's message is never one of those: it
 * can carry a note title or path, a model's reply, an upstream answer that echoes the request, or (a JSON.parse
 * failure) a piece of the file it read, keys included. So only these are kept: the error's class, a system or library
 * code (ENOENT, ECONNREFUSED, SQLITE_BUSY, UND_ERR_CONNECT_TIMEOUT), an HTTP status, and the first place in the hub's
 * own code it passed through. That is enough to find the cause while reading the code, and it holds no user data.
 */

const NAME = /^[A-Za-z][A-Za-z0-9]{0,39}$/;
const CODE = /^[A-Za-z][A-Za-z0-9_.-]{1,40}$/;
// "ollama 500: <body>", "search 502", "anthropic 429: <body>": a short label, then the status the upstream answered
const LEADING_STATUS = /^[\w.-]{1,40} ([1-5]\d\d)(?::|$)/;
// "Steam answered 503", "hub GET /vault/index returned 401: <body>"
const ANSWERED_STATUS = /\b(?:answered|returned) ([1-5]\d\d)\b/;
// a stack frame in the hub's own code: "at fn (file:///.../hub/src/sweep.ts:38:12)" or "at /.../hub/src/ai/index.ts:1:2"
const OWN_FRAME = /[\\/]src[\\/]((?:[\w.-]+[\\/])*[\w.-]+\.(?:ts|mjs|js)):(\d+):\d+\)?\s*$/;

function str(v: unknown): string | undefined { return typeof v === "string" ? v : undefined; }

/** A short, user-data-free description of `e`, for a log line: "TypeError at sweep.ts:38", "TypeError ECONNREFUSED at ai/web.ts:29", "StoreError status 502 upstream 503". */
export function errCode(e: unknown): string {
  if (e === null || e === undefined) return String(e);
  if (typeof e !== "object") return typeof e;
  const o = e as { name?: unknown; code?: unknown; status?: unknown; cause?: unknown; message?: unknown; stack?: unknown };
  const parts: string[] = [];
  const ctor = str((e as { constructor?: { name?: unknown } }).constructor?.name);
  const name = str(o.name) === "Error" && ctor && NAME.test(ctor) ? ctor : str(o.name);
  parts.push(name && NAME.test(name) ? name : "Error");
  const code = str(o.code);
  if (code && CODE.test(code)) parts.push(code);
  const cause = o.cause && typeof o.cause === "object" ? o.cause as { code?: unknown; name?: unknown } : null;
  const causeCode = str(cause?.code) ?? (str(cause?.name) !== "Error" ? str(cause?.name) : undefined);
  if (causeCode && CODE.test(causeCode) && causeCode !== code) parts.push(causeCode);
  if (typeof o.status === "number" && o.status >= 100 && o.status <= 599) parts.push(`status ${o.status}`);
  const msg = str(o.message) ?? "";
  const upstream = LEADING_STATUS.exec(msg)?.[1] ?? ANSWERED_STATUS.exec(msg)?.[1];
  if (upstream) parts.push(`upstream ${upstream}`);
  const stack = str(o.stack);
  if (stack) {
    for (const line of stack.split("\n").slice(1)) {
      if (!/^\s+at /.test(line) || /node_modules|node:internal/.test(line)) continue;
      const m = OWN_FRAME.exec(line);
      if (m) { parts.push(`at ${m[1]}:${m[2]}`); break; }
    }
  }
  return parts.join(" ");
}

/**
 * The host (and port) of a configured address, for a log line. A base URL may carry a user and password, a path with
 * a key in it or `?key=`: only `host:port` is kept. Anything that does not parse as a URL is "(address)".
 */
export function logHost(u: string | undefined): string {
  if (!u) return "(none)";
  try { return new URL(u).host || "(address)"; } catch { return "(address)"; }
}
