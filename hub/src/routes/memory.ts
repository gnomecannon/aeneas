import { Hono } from "hono";
import type { Hub } from "../hub.js";
import { readJsonObject } from "../http.js";
import { StoreError } from "../store.js";
import { closeSession, hostsSummary, listRunbooks, renderSnippet, runSnippet, type CloseBody } from "../memory.js";
import { checkCommand } from "../preflight.js";
import { mergePeople } from "../people.js";

/** Module 2: runbooks, hosts, snippet rendering, ledgers and the session close. */
export function memoryRoutes() {
  const r = new Hono<{ Variables: { hub: Hub } }>();

  r.get("/runbooks", (c) => c.json(listRunbooks(c.get("hub").store, c.req.query("host") || undefined)));

  r.get("/hosts", (c) => c.json(hostsSummary(c.get("hub").store)));

  r.post("/people/merge", async (c) => {
    const body = await readJsonObject<{ keep?: unknown; merge?: unknown }>(c);
    if (typeof body.keep !== "string" || !Array.isArray(body.merge) || !body.merge.every((x) => typeof x === "string")) throw new StoreError(422, "keep is a person id and merge a list of person ids");
    return c.json(mergePeople(c.get("hub").store, body.keep, body.merge as string[]));
  });

  r.post("/snippets/:id/render", async (c) => {
    const hub = c.get("hub");
    const body = await readJsonObject<{ params?: Record<string, unknown> }>(c);
    const params = body.params && typeof body.params === "object" && !Array.isArray(body.params) ? body.params : {};
    const { text } = renderSnippet(hub.store, c.req.param("id"), params);
    return c.json({ text });
  });

  /** Try a snippet on its host: read-only snippets run at once; one that changes something answers 409. */
  r.post("/snippets/:id/run", async (c) => {
    const body = await readJsonObject<{ params?: Record<string, unknown>; host?: unknown }>(c);
    const params = body.params && typeof body.params === "object" && !Array.isArray(body.params) ? body.params : {};
    return c.json(await runSnippet(c.get("hub"), c.req.param("id"), params, typeof body.host === "string" ? body.host : undefined));
  });

  r.post("/ai/sessions/:id/close", async (c) => {
    const hub = c.get("hub");
    const body = await readJsonObject<Partial<CloseBody>>(c);
    if (typeof body.outcome !== "string") throw new StoreError(422, "outcome must be fixed, abandoned or parked");
    return c.json(await closeSession(hub.store, hub.ai, c.req.param("id"), body as CloseBody, hub.vault));
  });

  r.post("/preflight", async (c) => {
    const body = await readJsonObject<{ text?: unknown }>(c);
    if (typeof body.text !== "string") throw new StoreError(422, "text must be a string");
    if (body.text.length > 20000) throw new StoreError(422, "text must be 20000 characters or fewer");
    return c.json(checkCommand(body.text));
  });

  r.get("/ledgers", (c) => {
    const open = c.req.query("open");
    let ledgers = c.get("hub").store.list({ kind: "ledger", limit: 100000 });
    if (open === "true") ledgers = ledgers.filter((l) => l.fields.open !== false);
    else if (open === "false") ledgers = ledgers.filter((l) => l.fields.open === false);
    return c.json(ledgers);
  });

  return r;
}
