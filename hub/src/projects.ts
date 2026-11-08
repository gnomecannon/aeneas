import { nowIso } from "@everythingapp/shared";
import type { Entity } from "@everythingapp/shared";
import type { Hub } from "./hub.js";
import type { Store } from "./store.js";
import { StoreError } from "./store.js";
import type { Vault } from "./vault.js";
import { dayKey } from "./metrics.js";

/**
 * Module 5, builds. A project's `parts` are checked against `inventory` by name on every write (and again
 * whenever inventory changes), the summary gathers everything that points at the project, and the living plan
 * note at `Projects/<name>/Plan.md` keeps six fixed headings with a dated log that is only ever appended to.
 */

const DAY_MS = 24 * 3600_000;

export interface Part { name: string; qty: number; have?: number; inventory_id?: string }
/** `inventory_id` when the part is matched to Inventory, so a client can link the name to it. */
export interface PartRow { name: string; qty: number; have: number; missing: number; inventory_id?: string }

const norm = (s: unknown) => String(s ?? "").trim().toLowerCase();

/** Fill `have` and `inventory_id` for each part from inventory rows with the same name (case-insensitive). */
export function matchParts(store: Store, parts: Part[]): Part[] {
  const inventory = store.list({ kind: "inventory", limit: 100000 });
  return parts.map((p) => {
    const hits = inventory.filter((i) => norm(i.fields.name) === norm(p.name));
    const have = hits.reduce((n, i) => n + (typeof i.fields.qty === "number" ? i.fields.qty : 1), 0);
    const out: Part = { name: p.name, qty: typeof p.qty === "number" ? p.qty : 1, have };
    if (hits[0]) out.inventory_id = hits[0].id;
    return out;
  });
}

/** Rewrite the project's parts when the inventory match changed anything. Returns true when a patch was written. */
export function refreshParts(store: Store, project: Entity): boolean {
  const parts = Array.isArray(project.fields.parts) ? (project.fields.parts as Part[]) : [];
  if (!parts.length) return false;
  const matched = matchParts(store, parts);
  if (JSON.stringify(matched) === JSON.stringify(parts)) return false;
  store.patch(project.id, { parts: matched });
  return true;
}

export function installProjectHooks(hub: Hub): void {
  hub.store.afterWrite((entity) => {
    if (entity.kind === "project" && !entity.deleted_at) refreshParts(hub.store, entity);
    if (entity.kind === "inventory") {
      for (const p of hub.store.list({ kind: "project", limit: 100000 })) refreshParts(hub.store, p);
    }
  });
}

export function partRows(project: Entity): PartRow[] {
  const parts = Array.isArray(project.fields.parts) ? (project.fields.parts as Part[]) : [];
  return parts.map((p) => {
    const qty = typeof p.qty === "number" ? p.qty : 1;
    const have = typeof p.have === "number" ? p.have : 0;
    return { name: p.name, qty, have, missing: Math.max(0, qty - have), ...(p.inventory_id ? { inventory_id: p.inventory_id } : {}) };
  });
}

/** `Projects/<name>` with characters a vault path cannot carry replaced. */
export function projectFolder(project: Entity): string {
  const name = String(project.fields.name ?? "project").replace(/[\\/:*?"<>|\0]+/g, " ").replace(/\s+/g, " ").trim() || "project";
  return `Projects/${name}`;
}

export function planPath(project: Entity): string {
  return `${projectFolder(project)}/Plan.md`;
}

export function getProject(store: Store, id: string): Entity {
  const p = store.get(id);
  if (!p || p.kind !== "project" || p.deleted_at) throw new StoreError(404, "project not found");
  return p;
}

// ---------- plan note ----------

export const PLAN_HEADINGS = ["Goal", "Definition of done", "Current state", "Next", "Parts", "Log"] as const;
export type PlanHeading = (typeof PLAN_HEADINGS)[number];
export interface PlanSections { goal?: string; current?: string; next?: string; parts?: string; log_line?: string }

const EMPTY = "Not written yet.";

/** Split a plan body into its `## ` sections. Text before the first heading is dropped (the title line). Extra headings are kept. */
export function parsePlan(body: string): Map<string, string> {
  const out = new Map<string, string>();
  let current: string | null = null;
  let buf: string[] = [];
  const flush = () => { if (current !== null) out.set(current, buf.join("\n").trim()); };
  for (const line of body.split(/\r?\n/)) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m) { flush(); current = m[1]; buf = []; continue; }
    if (current !== null) buf.push(line);
  }
  flush();
  return out;
}

export function renderParts(project: Entity): string {
  const rows = partRows(project);
  if (!rows.length) return "No parts listed.";
  return rows.map((r) => `- ${r.name}: need ${r.qty}, have ${r.have}${r.missing ? `, missing ${r.missing}` : ""}`).join("\n");
}

/** Build the next plan body from the existing one: the six headings in order, log lines appended, other headings kept after them. */
export function renderPlan(project: Entity, existing: string, sections: PlanSections, now: Date = new Date()): string {
  const prev = parsePlan(existing);
  const name = String(project.fields.name ?? "");
  const dod = String(project.fields.definition_of_done ?? "").trim() || EMPTY;
  const goal = sections.goal?.trim() || prev.get("Goal") || dod;
  const current = sections.current?.trim() || prev.get("Current state") || EMPTY;
  const next = sections.next?.trim() || prev.get("Next") || EMPTY;
  const parts = sections.parts?.trim() || renderParts(project);
  const logLines = (prev.get("Log") ?? "").split("\n").map((l) => l.trimEnd()).filter(Boolean);
  if (sections.log_line?.trim()) logLines.push(`- ${dayKey(now)}: ${sections.log_line.trim().replace(/\s+/g, " ")}`);
  const log = logLines.length ? logLines.join("\n") : "No entries yet.";
  const fixed: Record<PlanHeading, string> = { Goal: goal, "Definition of done": dod, "Current state": current, Next: next, Parts: parts, Log: log };
  const out: string[] = [`# Plan: ${name}`, ""];
  for (const h of PLAN_HEADINGS) out.push(`## ${h}`, "", fixed[h], "");
  for (const [h, text] of prev) if (!(PLAN_HEADINGS as readonly string[]).includes(h)) out.push(`## ${h}`, "", text, "");
  return out.join("\n").replace(/\n{3,}/g, "\n\n");
}

/** The note entity at the project's plan path, or null. */
export function planNote(store: Store, project: Entity): Entity | null {
  const paths = [planPath(project), ...(typeof project.fields.plan_doc_path === "string" ? [project.fields.plan_doc_path] : [])];
  for (const p of paths) {
    const n = store.list({ kind: "note", where: { path: p } })[0];
    if (n) return n;
  }
  return null;
}

/** POST /projects/:id/plan: upsert the plan note and point `plan_doc_path` at it. */
export function writePlan(store: Store, vault: Vault, project: Entity, sections: PlanSections = {}, now: Date = new Date()): Entity {
  const path = planPath(project);
  const existing = planNote(store, project);
  const body = renderPlan(project, existing ? String(existing.fields.body ?? "") : "", sections, now);
  // The owner's tags, the linker's related links and other properties stay; [project, plan] is only added.
  vault.writeOwn(path, { title: `Plan: ${String(project.fields.name ?? "")}`, tags: ["project", "plan"], body });
  if (project.fields.plan_doc_path !== path) store.patch(project.id, { plan_doc_path: path });
  const note = store.list({ kind: "note", where: { path } })[0];
  if (!note) throw new StoreError(500, "plan note was not written");
  return note;
}

// ---------- summary ----------

export interface ProjectSummary {
  project: Entity;
  tasks: { next: Entity[]; doing: Entity[]; done_7d: Entity[] };
  notes: Entity[];
  plan_note: Entity | null;
  procedures: Entity[];
  music: Entity[];
  parts: PartRow[];
  last_session_close: string | null;
}

export function projectSummary(hub: Hub, id: string, now: Date = new Date()): ProjectSummary {
  const project = getProject(hub.store, id);
  const tasks = hub.store.list({ kind: "task", limit: 100000 }).filter((t) => t.fields.project_id === id);
  const since = now.getTime() - 7 * DAY_MS;
  const doneAt = (t: Entity) => String(t.fields.done_at ?? t.field_ts.status ?? "");
  const byOrder = (a: Entity, b: Entity) => Number(a.fields.order ?? 0) - Number(b.fields.order ?? 0);
  const folder = `${projectFolder(project)}/`;
  const notes = hub.store.list({ kind: "note", limit: 100000 }).filter((n) => String(n.fields.path ?? "").startsWith(folder));
  const plan = planNote(hub.store, project);
  return {
    project,
    tasks: {
      next: tasks.filter((t) => t.fields.status === "next").sort(byOrder),
      doing: tasks.filter((t) => t.fields.status === "doing").sort(byOrder),
      done_7d: tasks.filter((t) => t.fields.status === "done" && new Date(doneAt(t)).getTime() >= since).sort((a, b) => doneAt(b).localeCompare(doneAt(a))),
    },
    notes: notes.filter((n) => n.id !== plan?.id),
    plan_note: plan,
    procedures: hub.store.list({ kind: "procedure", limit: 100000 }).filter((p) => p.fields.project_id === id),
    music: hub.store.list({ kind: "music_idea", limit: 100000 }).filter((m) => m.fields.project_id === id),
    parts: partRows(project),
    last_session_close: project.field_ts.resume_card ?? null,
  };
}

/** Session close: a dated log line plus fresh Current state and Next. Creates the plan when the project has none. */
export function appendCloseToPlan(store: Store, vault: Vault, project: Entity, close: { outcome: string; summary: string; note?: string }): Entity {
  const fresh = store.get(project.id) ?? project;
  const next = close.outcome === "fixed" ? "Nothing open from the last session." : close.note?.trim() || `Pick the ${close.outcome} session back up.`;
  return writePlan(store, vault, fresh, { current: `${close.outcome}: ${close.summary}`, next, log_line: `Session ${close.outcome}: ${close.summary}` });
}

/** Counts for /status.creative that belong to projects. */
export function projectsActive(store: Store): number {
  return store.list({ kind: "project", limit: 100000 }).filter((p) => p.fields.status === "active").length;
}

// ---------- activity feed ----------

/**
 * POST /projects/feed: what the tools working on a project did, pushed by a machine that can see them (for
 * example `deploy/windows/project-feed.ps1` on the machine with the working copy reads the git repo, the project's current-state doc and
 * Codex's threads for that folder). Stored on the project as `activity`; when it is newer than the resume card,
 * the card is rewritten from it so "Where I left off" follows the work. Writes only when something changed.
 */
export interface FeedThread { title: string; updated_at: string; last_message?: string }
export interface FeedSection { title: string; text: string }
export interface FeedBody {
  project?: string;
  project_id?: string;
  source?: string;
  repo?: { branch?: string; last_commit_at?: string; last_commit?: string; uncommitted?: number; last_edit_at?: string; commits?: Array<{ at: string; subject: string }> };
  doc?: { path?: string; updated_at?: string; sections?: FeedSection[] };
  threads?: FeedThread[];
}

const clip = (s: unknown, n: number) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
};
const isoOrNull = (s: unknown) => (typeof s === "string" && Number.isFinite(new Date(s).getTime()) ? new Date(s).toISOString() : null);
const shortDay = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });

/** The newest moment anything in the feed happened. */
export function feedLatest(a: { repo?: FeedBody["repo"]; doc?: FeedBody["doc"]; threads?: FeedThread[] }): string | null {
  const times = [a.repo?.last_commit_at, a.repo?.last_edit_at, a.doc?.updated_at, ...(a.threads ?? []).map((t) => t.updated_at)].map(isoOrNull).filter((x): x is string => !!x);
  return times.length ? times.sort().pop()! : null;
}

/** "Where I left off" written from the feed: the latest threads, the current-state doc's sections, the repo. */
export function feedResumeCard(a: { source?: string; repo?: FeedBody["repo"]; doc?: FeedBody["doc"]; threads?: FeedThread[] }): string {
  const out: string[] = [];
  const threads = a.threads ?? [];
  if (threads.length) {
    out.push(`**Latest ${a.source?.startsWith("codex") ? "Codex " : ""}threads**`);
    for (const t of threads.slice(0, 4)) out.push(`- ${t.title} (${shortDay(t.updated_at)})${t.last_message ? `: ${clip(t.last_message, 260)}` : ""}`);
  }
  const sections = a.doc?.sections ?? [];
  if (sections.length) {
    out.push("", `**Current state**${a.doc?.updated_at ? ` (${a.doc.path ?? "doc"}, ${shortDay(a.doc.updated_at)})` : ""}`);
    for (const s of sections.slice(0, 5)) out.push(`- ${s.title}: ${clip(s.text.split(/(?<=[.!?])\s/)[0], 220)}`);
  }
  const r = a.repo;
  if (r?.last_commit_at) {
    const pending = r.uncommitted ? `${r.uncommitted} file${r.uncommitted === 1 ? "" : "s"} changed since the last commit, ` : "";
    out.push("", `**Repo**: ${pending}last commit ${shortDay(r.last_commit_at)}${r.last_commit ? ` ("${clip(r.last_commit, 90)}")` : ""}.`);
  }
  return out.join("\n").trim();
}

export function applyFeed(hub: Hub, body: FeedBody): { project_id: string; changed: boolean; resume_card_written: boolean } {
  const project = body.project_id
    ? getProject(hub.store, body.project_id)
    : hub.store.list({ kind: "project", limit: 100000 }).find((p) => norm(p.fields.name) === norm(body.project));
  if (!project) throw new StoreError(404, "project not found");
  const threads = (Array.isArray(body.threads) ? body.threads : [])
    .filter((t) => t && isoOrNull(t.updated_at))
    .map((t) => ({ title: clip(t.title, 120) || "Untitled thread", updated_at: isoOrNull(t.updated_at)!, ...(t.last_message ? { last_message: clip(t.last_message, 800) } : {}) }))
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    .slice(0, 6);
  const doc = body.doc?.sections?.length
    ? { path: clip(body.doc.path, 160), updated_at: isoOrNull(body.doc.updated_at), sections: body.doc.sections.slice(0, 8).map((s) => ({ title: clip(s.title, 120), text: clip(s.text, 700) })) }
    : undefined;
  const repo = body.repo
    ? {
        branch: clip(body.repo.branch, 80),
        last_commit_at: isoOrNull(body.repo.last_commit_at),
        last_commit: clip(body.repo.last_commit, 200),
        uncommitted: Number.isFinite(body.repo.uncommitted) ? Number(body.repo.uncommitted) : 0,
        last_edit_at: isoOrNull(body.repo.last_edit_at),
        commits: (body.repo.commits ?? []).slice(0, 5).map((c) => ({ at: isoOrNull(c.at), subject: clip(c.subject, 160) })),
      }
    : undefined;
  const activity = { source: clip(body.source, 60) || "feed", ...(repo ? { repo } : {}), ...(doc ? { doc } : {}), threads };
  const latest = feedLatest(activity as never);
  const prev = project.fields.activity as Record<string, unknown> | undefined;
  const same = prev && JSON.stringify({ ...prev, received_at: undefined }) === JSON.stringify({ ...activity, received_at: undefined });
  if (same) return { project_id: project.id, changed: false, resume_card_written: false };
  const patch: Record<string, unknown> = { activity: { ...activity, received_at: nowIso() } };
  if (latest) patch.activity_at = latest;
  const cardAt = project.field_ts.resume_card ?? "";
  const card = feedResumeCard(activity as never);
  const writeCard = !!latest && !!card && latest > cardAt && card !== project.fields.resume_card;
  if (writeCard) patch.resume_card = card;
  hub.store.patch(project.id, patch);
  return { project_id: project.id, changed: true, resume_card_written: writeCard };
}
