import { Hono } from "hono";
import type { Hub } from "../hub.js";
import { readJsonObject } from "../http.js";
import { applyFeed, getProject, projectSummary, writePlan, type FeedBody, type PlanSections } from "../projects.js";
import { advanceProcedure, procedureFromText, resetProcedure, type FromTextBody } from "../procedures.js";
import { listMusic, quickIdea } from "../music.js";
import { humAudioPath, ideaMidi, rehear, startHum } from "../hum.js";
import fs from "node:fs";
import { answerQuiz, buildQuiz, quizToday } from "../quiz.js";

/** Module 5: project summaries and plans, procedures, music ideas, the recall quiz. */
export function creativeRoutes() {
  const r = new Hono<{ Variables: { hub: Hub } }>();

  r.post("/projects/feed", async (c) => c.json(applyFeed(c.get("hub"), await readJsonObject<FeedBody & Record<string, unknown>>(c))));
  r.get("/projects/:id/summary", (c) => c.json(projectSummary(c.get("hub"), c.req.param("id"))));

  r.post("/projects/:id/plan", async (c) => {
    const hub = c.get("hub");
    const project = getProject(hub.store, c.req.param("id"));
    const body = await readJsonObject<{ sections?: PlanSections }>(c);
    const sections = body.sections && typeof body.sections === "object" ? body.sections : {};
    return c.json(writePlan(hub.store, hub.vault, project, sections));
  });

  r.post("/procedures/from-text", async (c) => {
    const hub = c.get("hub");
    const body = await readJsonObject(c);
    const { procedure, via } = await procedureFromText(hub.store, hub.ai, body as unknown as FromTextBody);
    return c.json({ ...procedure, via }, 201);
  });

  r.post("/procedures/:id/advance", async (c) => {
    const hub = c.get("hub");
    return c.json(advanceProcedure(hub.store, c.req.param("id"), await readJsonObject(c)));
  });

  r.post("/procedures/:id/reset", (c) => c.json(resetProcedure(c.get("hub").store, c.req.param("id"))));

  r.get("/music", (c) => c.json(listMusic(c.get("hub").store, { type: c.req.query("type") || undefined, status: c.req.query("status") || undefined })));

  r.post("/music/quick", async (c) => c.json(quickIdea(c.get("hub").store, await readJsonObject(c)), 201));
  // Hum to MIDI (hum.ts): the recording as a WAV body; the idea comes back at once and its notes follow by sync.
  r.post("/music/hum", async (c) => {
    const q = (k: string) => c.req.query(k);
    const wav = Buffer.from(await c.req.arrayBuffer());
    return c.json(startHum(c.get("hub"), wav, { mode: q("mode"), bpm: q("bpm"), title: q("title"), project_id: q("project_id"), from: q("from"), client_id: q("client_id") }), 202);
  });
  r.post("/music/:id/rehear", async (c) => {
    const body = await readJsonObject<{ mode?: unknown; bpm?: unknown }>(c).catch(() => ({}));
    return c.json(rehear(c.get("hub"), c.req.param("id"), body), 202);
  });
  r.get("/music/:id/midi", (c) => {
    const m = ideaMidi(c.get("hub"), c.req.param("id"), c.req.query("grid") !== "off");
    return c.body(new Uint8Array(m.bytes), 200, { "content-type": "audio/midi", "content-disposition": `attachment; filename="${m.name.replace(/"/g, "")}"`, "cache-control": "no-store" });
  });
  r.get("/music/:id/audio", (c) => {
    const file = humAudioPath(c.get("hub"), c.req.param("id"));
    if (!fs.existsSync(file)) return c.json({ error: "no recording" }, 404);
    return c.body(new Uint8Array(fs.readFileSync(file)), 200, { "content-type": "audio/wav", "cache-control": "private, max-age=3600" });
  });

  r.get("/quiz/today", (c) => c.json(quizToday(c.get("hub").store)));

  /** Make today's quiz now, from today's chats (it uses the model, so it is made only when asked). */
  r.post("/quiz/build", async (c) => c.json(await buildQuiz(c.get("hub"))));

  r.post("/quiz/:id/answer", async (c) => {
    const hub = c.get("hub");
    return c.json(answerQuiz(hub.store, c.req.param("id"), await readJsonObject(c)));
  });

  return r;
}
