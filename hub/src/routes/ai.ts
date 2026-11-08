import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { ChatRequest } from "@everythingapp/shared";
import { StoreError } from "../store.js";
import { readJsonObject } from "../http.js";
import type { Hub } from "../hub.js";
import { wipeChats } from "../ai/wipe.js";
import { approvalOf } from "../ai/tools.js";
import { errCode } from "../logsafe.js";
import { readMachines, sshConfigNames, writeMachines, type HostFileEntry } from "../ai/hosts.js";

export function aiRoutes() {
  const r = new Hono<{ Variables: { hub: Hub } }>();

  r.post("/ai/chat", async (c) => {
    const hub = c.get("hub");
    const req = ChatRequest.parse(await readJsonObject(c));
    return c.json(await hub.ai.chat(req));
  });

  r.post("/ai/chat/stream", async (c) => {
    const hub = c.get("hub");
    const req = ChatRequest.parse(await readJsonObject(c));
    return streamSSE(c, async (stream) => {
      try {
        const out = await hub.ai.chat(req,
          (t) => { void stream.writeSSE({ event: "token", data: JSON.stringify({ token: t }) }); },
          (e) => { void stream.writeSSE({ event: e.type, data: JSON.stringify(e) }); });
        await stream.writeSSE({ event: "done", data: JSON.stringify(out) });
      } catch (e) {
        const err = e instanceof StoreError ? { error: e.message, detail: e.detail } : { error: (e as Error).message };
        await stream.writeSSE({ event: "error", data: JSON.stringify(err) });
      }
    });
  });

  /** Warm the local model's cache for the next chat (the Assistant opened). Answers at once; ?wait=true waits for it. */
  r.post("/ai/warm", async (c) => {
    const hub = c.get("hub");
    const run = hub.ai.warm();
    if (c.req.query("wait") === "true") return c.json(await run);
    run.catch((e) => console.error(`[ai] warm-up: ${errCode(e)}`));
    return c.json({ started: true }, 202);
  });

  r.post("/ai/classify", async (c) => {
    const hub = c.get("hub");
    const body = await readJsonObject<{ text?: string }>(c);
    if (!body.text || typeof body.text !== "string") throw new StoreError(422, "text required");
    return c.json(await hub.ai.classify(body.text));
  });

  r.post("/ai/resume-card", async (c) => {
    const hub = c.get("hub");
    const body = await readJsonObject<{ project_id?: string; session_id?: string; allow_cloud?: boolean }>(c);
    if (!body.project_id || !body.session_id) throw new StoreError(422, "project_id and session_id required");
    const project = await hub.ai.resumeCard(body.project_id, body.session_id, { allow_cloud: body.allow_cloud });
    return c.json({ project_id: project.id, resume_card: project.fields.resume_card, project });
  });

  r.get("/ai/memory", (c) => {
    const hub = c.get("hub");
    const cloud = c.req.query("allow_cloud") === "true";
    const allowWork = c.req.query("allow_work") === "true";
    return c.json(hub.ai.memory({ cloud, allowWork }));
  });

  // Chats live on the hub so every device shows the same list and can continue any of them.
  r.get("/ai/sessions", (c) => {
    const limit = Number(c.req.query("limit") ?? 100);
    const ai = c.get("hub").ai;
    return c.json({ sessions: ai.sessions.list(Number.isFinite(limit) ? limit : 100).map((s) => ({ ...s, working: ai.working.has(s.session_id) })) });
  });

  r.get("/ai/sessions/:id", (c) => {
    const hub = c.get("hub");
    const s = hub.ai.sessions.get(c.req.param("id"));
    if (!s) throw new StoreError(404, "session not found");
    const pending = hub.ai.hosts.pendingFor(s.session_id);
    // The whole approval, risk and pre-flight lines included: a reloaded chat showed a destructive command's card
    // without its red border and its back up, verify and rollback lines.
    return c.json({ ...s, pending_action: pending ? approvalOf({ id: pending.id, host: pending.host, command: pending.command, purpose: pending.purpose ?? "" }) : null, working: hub.ai.working.get(s.session_id) ?? null });
  });

  r.patch("/ai/sessions/:id", async (c) => {
    const body = await readJsonObject<{ title?: string }>(c);
    if (typeof body.title !== "string") throw new StoreError(422, "title required");
    if (!c.get("hub").ai.sessions.rename(c.req.param("id"), body.title)) throw new StoreError(404, "session not found");
    return c.json(c.get("hub").ai.sessions.get(c.req.param("id")));
  });

  // Deleting is permanent and leaves nothing to recover: see ai/wipe.ts.
  r.delete("/ai/sessions/:id", (c) => {
    const hub = c.get("hub");
    const id = c.req.param("id");
    if (!hub.ai.sessions.get(id, { includeDeleted: true })) throw new StoreError(404, "session not found");
    return c.json({ ok: true, ...wipeChats(hub.chatDb, hub.store, hub.ai.images, [id]) });
  });

  /** Wipe every chat. The body must say {"confirm": "wipe all chats"} so a stray request cannot do it. */
  r.delete("/ai/sessions", async (c) => {
    const hub = c.get("hub");
    const body = await readJsonObject<{ confirm?: string }>(c);
    if (body.confirm !== "wipe all chats") throw new StoreError(422, 'send {"confirm": "wipe all chats"}');
    const res = wipeChats(hub.chatDb, hub.store, hub.ai.images, null);
    return c.json({ ok: true, ...res });
  });

  /** The iPhone's photos for a photos_request: `{ photos: [{ b64, taken_at?, width?, height? }] }`, 6 at most. */
  r.post("/ai/photos/:id", async (c) => {
    const body = await readJsonObject<{ photos?: unknown }>(c);
    const photos = (Array.isArray(body.photos) ? body.photos : []).slice(0, 6)
      .filter((p): p is { b64: string } => !!p && typeof (p as any).b64 === "string")
      .map((p: any) => ({ b64: String(p.b64), ...(p.taken_at ? { taken_at: String(p.taken_at) } : {}), ...(p.width ? { width: Number(p.width), height: Number(p.height) } : {}) }));
    if (!c.get("hub").ai.deliverPhotos(c.req.param("id"), photos)) throw new StoreError(410, "nothing is waiting for these photos any more");
    return c.json({ ok: true, received: photos.length });
  });

  r.get("/ai/images/:id", (c) => {
    const img = c.get("hub").ai.images.read(c.req.param("id"));
    if (!img) throw new StoreError(404, "image not found");
    return c.body(new Uint8Array(img.data), 200, { "content-type": img.mime, "cache-control": "private, max-age=31536000, immutable" });
  });

  r.get("/ai/hosts", (c) => c.json({ hosts: c.get("hub").ai.hosts.hosts() }));

  // The machines the assistant and the sensors may reach (hosts.json): only ones the person added. `ssh_config` lists
  // the names in the hub machine's SSH config to pick from; none of them is contacted until it is added here.
  r.get("/machines", (c) => {
    const hub = c.get("hub");
    return c.json({ machines: readMachines(hub.cfg) ?? [], ssh_config: sshConfigNames(hub.cfg) });
  });
  r.put("/machines", async (c) => {
    const hub = c.get("hub");
    const body = await readJsonObject(c);
    if (!Array.isArray(body.machines)) throw new StoreError(422, "machines must be a list of { name, ssh?, os?, local?, aliases? }");
    const seen = new Set<string>();
    const list: HostFileEntry[] = [];
    for (const m of body.machines as unknown[]) {
      const o = (m && typeof m === "object" ? m : {}) as Record<string, unknown>;
      const name = typeof o.name === "string" ? o.name.trim().toLowerCase() : "";
      if (!/^[a-z0-9][a-z0-9._-]{0,62}$/.test(name)) throw new StoreError(422, "each machine needs a name of letters, digits, dots, dashes or underscores");
      if (seen.has(name)) throw new StoreError(422, `${name} is listed twice`);
      seen.add(name);
      const ssh = typeof o.ssh === "string" && o.ssh.trim() ? o.ssh.trim() : undefined;
      if (ssh && !/^[A-Za-z0-9._@:-]{1,253}$/.test(ssh)) throw new StoreError(422, `${name}: ssh must be an SSH alias or user@host`);
      const os = o.os === "linux" || o.os === "macos" || o.os === "windows" ? o.os : undefined;
      const aliases = Array.isArray(o.aliases) ? o.aliases.filter((a): a is string => typeof a === "string" && /^[A-Za-z0-9._-]{1,63}$/.test(a)).map((a) => a.toLowerCase()) : [];
      list.push({ name, ...(ssh ? { ssh } : {}), ...(os ? { os } : {}), ...(o.local === true ? { local: true } : {}), ...(aliases.length ? { aliases } : {}) });
    }
    writeMachines(hub.cfg, list);
    hub.ai.hosts.forget();
    return c.json({ machines: list });
  });

  r.get("/ai/actions/:id", (c) => {
    const a = c.get("hub").ai.hosts.get(c.req.param("id"));
    if (!a) throw new StoreError(404, "action not found");
    return c.json(a);
  });

  /** Decline a command the assistant proposed. Approving goes through POST /ai/chat/stream with approve_action_id. */
  r.post("/ai/actions/:id/cancel", (c) => {
    const hub = c.get("hub");
    const a = hub.ai.hosts.cancel(c.req.param("id"));
    if (!a) throw new StoreError(404, "action not found");
    const s = hub.ai.sessions.get(a.session_id);
    if (s) {
      for (const m of s.messages) if (m.approval?.action_id === a.id) m.approval = { ...m.approval, status: a.status };
      hub.ai.sessions.save(s.session_id, s.task_type, s.messages);
    }
    return c.json(a);
  });

  return r;
}
