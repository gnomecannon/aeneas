import type { Entity } from "@everythingapp/shared";

/** Fields left out of CSV: picture data and values the hub derives for itself. */
const SKIP = new Set(["attachments", "embedding", "fts", "suggested_tags_dismissed"]);

/** Fields that read best first, when a kind has them. */
const LEAD = ["title", "name", "text", "type", "value", "unit", "status", "at", "due", "start", "end", "host", "company", "role", "year", "rating"];

function cell(v: unknown): string {
  if (v === null || v === undefined) return "";
  let s: string;
  if (Array.isArray(v)) s = v.map((x) => (x !== null && typeof x === "object" ? JSON.stringify(x) : String(x))).join("; ");
  else if (typeof v === "object") s = JSON.stringify(v);
  else s = String(v);
  // A spreadsheet runs a cell that starts with = + @ (or - before a non-number) as a formula; a leading ' keeps it text.
  if (typeof v === "string" && /^(?:[=+@\t\r]|-(?![\d.]))/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Entities as CSV (RFC 4180, CRLF, UTF-8 without a byte order mark): id, space, created and updated times, then every
 * field the rows use, the usual leading ones first and the rest alphabetical. Lists are joined with "; ".
 */
export function entitiesCsv(rows: Entity[]): string {
  const keys = new Set<string>();
  for (const e of rows) for (const k of Object.keys(e.fields)) if (!SKIP.has(k)) keys.add(k);
  const fields = [...LEAD.filter((k) => keys.has(k)), ...[...keys].filter((k) => !LEAD.includes(k)).sort()];
  const header = ["id", "space", "created_at", "updated_at", ...fields];
  const lines = [header.map(cell).join(",")];
  for (const e of rows) lines.push([e.id, e.space, e.created_at, e.updated_at, ...fields.map((k) => e.fields[k])].map(cell).join(","));
  return lines.join("\r\n") + "\r\n";
}
