import fs from "node:fs";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { Hono } from "hono";
import { StoreError } from "../store.js";

const MAX_FILE_BYTES = 1024 * 1024;
import type { Hub } from "../hub.js";
import { dayKey } from "../metrics.js";

export function vaultRoutes() {
  const r = new Hono<{ Variables: { hub: Hub } }>();

  r.get("/vault/index", (c) => c.json(c.get("hub").vault.index()));

  /** Every note as markdown, packed as .tar.gz. Hidden folders (.obsidian, .trash) are left out. */
  r.get("/vault/export", (c) => {
    const dir = c.get("hub").vault.dir;
    // Name the visible top-level entries; an exclude pattern for dot folders also matches "." on BSD tar.
    const entries = fs.readdirSync(dir).filter((n) => !n.startsWith("."));
    const args = entries.length ? ["-czf", "-", "-C", dir, "--", ...entries] : ["-czf", "-", "-T", "/dev/null"];
    // tar's warnings name the files it read ("Personal/x.md: file changed as we read it"), and a note's file name is
    // personal text: they are dropped, and the hub's log gets the exit code only.
    const child = spawn("tar", args, { stdio: ["ignore", "pipe", "ignore"] });
    child.on("exit", (code) => { if (code) console.error(`[vault] export: tar exited with ${code}`); });
    const name = `notes-${dayKey(new Date())}.tar.gz`;
    return new Response(Readable.toWeb(child.stdout) as unknown as ReadableStream, {
      headers: { "content-type": "application/gzip", "content-disposition": `attachment; filename="${name}"` },
    });
  });

  r.get("/vault/file", (c) => {
    const text = c.get("hub").vault.read(c.req.query("path") ?? "");
    if (text === null) throw new StoreError(404, "file not found");
    return c.text(text, 200, { "content-type": "text/markdown; charset=utf-8" });
  });

  r.put("/vault/file", async (c) => {
    const hub = c.get("hub");
    const p = c.req.query("path") ?? "";
    const body = await c.req.text();
    if (Buffer.byteLength(body, "utf8") > MAX_FILE_BYTES) throw new StoreError(413, "file exceeds 1 MB");
    return c.json(hub.vault.write(p, body, c.req.query("mtime")));
  });

  r.delete("/vault/file", (c) => {
    const hub = c.get("hub");
    const existed = hub.vault.remove(c.req.query("path") ?? "");
    if (!existed) throw new StoreError(404, "file not found");
    return c.json({ ok: true });
  });

  return r;
}
