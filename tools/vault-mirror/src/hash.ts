import { createHash } from "node:crypto";

/** Strip a UTF-8 BOM and convert CRLF and lone CR line endings to LF. */
export function normalize(text: string): string {
  let t = text;
  if (t.charCodeAt(0) === 0xfeff) t = t.slice(1);
  return t.replace(/\r\n?/g, "\n");
}

/** sha256 hex of the normalized (LF) content. This is the mirror's own hash. */
export function hashContent(text: string): string {
  return createHash("sha256").update(normalize(text), "utf8").digest("hex");
}
