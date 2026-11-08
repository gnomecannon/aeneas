import { Hono } from "hono";
import { StoreError } from "../store.js";
import type { Hub } from "../hub.js";
import { noteLinking, requestNoteLinking } from "../note-linker.js";
import { errCode } from "../logsafe.js";

/** Knowledge map routes: related notes, tag and link suggestions, the graph. */
export function noteRoutes() {
  const r = new Hono<{ Variables: { hub: Hub } }>();

  r.get("/notes/graph", (c) => c.json(c.get("hub").map.graph()));

  // Tag notes: how many notes wait for the linker, and reading them now (it uses the model, so only when asked).
  r.get("/notes/link", (c) => c.json(noteLinking(c.get("hub"))));
  r.post("/notes/link", (c) => c.json(requestNoteLinking(c.get("hub"))));

  r.get("/notes/:id/related", (c) => {
    const hub = c.get("hub");
    const n = hub.store.get(c.req.param("id"));
    if (!n || n.kind !== "note") throw new StoreError(404, "note not found");
    return c.json(hub.map.related(n.id));
  });

  /** Recompute suggestions. With ai=true a model is also asked; its answer is merged if it arrives. */
  r.post("/notes/:id/suggest", async (c) => {
    const hub = c.get("hub");
    const n = hub.store.get(c.req.param("id"));
    if (!n || n.kind !== "note") throw new StoreError(404, "note not found");
    let tags = hub.map.suggestTags(n);
    const links = hub.map.deriveLinks(n.id, String(n.fields.body ?? ""), String(n.fields.title ?? ""), (n.fields.related as string[] | undefined) ?? []);
    let ai_used = false;
    if (c.req.query("ai") === "true" && hub.ai.available()) {
      try {
        const vocab = [...hub.map.vocabulary().keys()].slice(0, 200).join(", ");
        const out = await hub.ai.chat({
          session_id: `suggest-${n.id}`,
          task_type: "classify",
          messages: [{
            role: "user",
            content: `Suggest up to 5 tags for this note. Prefer tags from this vocabulary when they fit: ${vocab}. Reply with JSON only: {"tags": ["..."]}.\n\nTitle: ${String(n.fields.title ?? "")}\n\n${String(n.fields.body ?? "").slice(0, 4000)}`,
          }],
        });
        const m = /\{[\s\S]*\}/.exec(out.reply);
        if (m) {
          const parsed = JSON.parse(m[0]) as { tags?: unknown };
          if (Array.isArray(parsed.tags)) {
            const have = new Set(((n.fields.tags as string[] | undefined) ?? []).map((t) => t.toLowerCase()));
            for (const t of parsed.tags) {
              const s = String(t).trim().toLowerCase().replace(/^#/, "").replace(/\s+/g, "-");
              if (s && !have.has(s) && !tags.includes(s)) tags.push(s);
            }
            tags = tags.slice(0, 8);
            ai_used = true;
          }
        }
      } catch (e) {
        console.error(`[notes] ai suggestion skipped: ${errCode(e)}`);
      }
    }
    // Opening a note asks for suggestions every time; store them only when they changed.
    if (JSON.stringify(n.fields.suggested_tags ?? []) !== JSON.stringify(tags) || JSON.stringify(n.fields.links ?? []) !== JSON.stringify(links)) {
      hub.vault.patchQuiet(n.id, { suggested_tags: tags, links });
    }
    return c.json({ id: n.id, suggested_tags: tags, links, ai_used });
  });

  /** Accept suggestions with one tap: moves the named tags onto the note. */
  r.post("/notes/:id/accept", async (c) => {
    const hub = c.get("hub");
    const n = hub.store.get(c.req.param("id"));
    if (!n || n.kind !== "note") throw new StoreError(404, "note not found");
    const body = (await c.req.json().catch(() => ({}))) as { tags?: string[] | unknown };
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new StoreError(400, "JSON body must be an object");
    if (body.tags !== undefined && !Array.isArray(body.tags)) throw new StoreError(422, "tags must be an array");
    const accept = new Set(((body.tags as string[] | undefined) ?? (n.fields.suggested_tags as string[] | undefined) ?? []).map((t) => String(t).toLowerCase()));
    const tags = [...new Set([...(((n.fields.tags as string[] | undefined) ?? []).map((t) => t.toLowerCase())), ...accept])];
    const remaining = ((n.fields.suggested_tags as string[] | undefined) ?? []).filter((t) => !accept.has(t.toLowerCase()));
    const updated = hub.store.patch(n.id, { tags, suggested_tags: remaining });
    return c.json(updated);
  });

  return r;
}
