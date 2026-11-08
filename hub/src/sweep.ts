import type { Entity } from "@everythingapp/shared";
import type { Hub } from "./hub.js";
import { tidyPeople } from "./people.js";
import { musicReferencesToNotes } from "./music.js";
import { projectFolder } from "./projects.js";
import { pruneHumAudio } from "./hum.js";
import { errCode } from "./logsafe.js";

export interface SweepResult { notes: number; links_updated: number; tags_suggested: number; projects_linked: number; people_cleaned: number; people_merged: number; ms: number }

/**
 * Knowledge sweep: recompute derived links for every personal note, rule-based tag suggestions for notes that carry
 * no tags, and the project of notes kept in its folder (any folder named like the project, such as
 * `Game Design/Games/Starfall/`, or `Projects/<name>/`), so each shows the other as related. People lose repeated
 * phones and emails, and people that are surely the same are merged (`tidyPeople`). Note writes go through
 * vault.patchQuiet and only when something changed, so no file is rewritten and the change feed sees only real
 * differences.
 */
export function runSweep(hub: Hub): SweepResult {
  const t0 = Date.now();
  const out: SweepResult = { notes: 0, links_updated: 0, tags_suggested: 0, projects_linked: 0, people_cleaned: 0, people_merged: 0, ms: 0 };
  const projects = hub.store.list({ kind: "project", space: "personal", limit: 100000 });
  const same = (a: unknown, b: unknown) => JSON.stringify([...((a as string[] | undefined) ?? [])].sort()) === JSON.stringify([...((b as string[] | undefined) ?? [])].sort());
  for (const n of hub.store.list({ kind: "note", space: "personal", limit: 100000 })) {
    out.notes++;
    const patch: Record<string, unknown> = {};
    const links = hub.map.deriveLinks(n.id, String(n.fields.body ?? ""), String(n.fields.title ?? ""), (n.fields.related as string[] | undefined) ?? []);
    if (!same(links, n.fields.links)) { patch.links = links; out.links_updated++; }
    if (!n.fields.project_id) {
      const p = projectOfPath(projects, String(n.fields.path ?? ""));
      if (p) { patch.project_id = p.id; out.projects_linked++; }
    }
    const tags = (n.fields.tags as string[] | undefined) ?? [];
    if (!tags.length) {
      const suggested = hub.map.suggestTags(n);
      if (!same(suggested, n.fields.suggested_tags)) { patch.suggested_tags = suggested; out.tags_suggested++; }
    }
    if (Object.keys(patch).length) {
      try { hub.vault.patchQuiet(n.id, patch); } catch (e) { console.error(`[sweep] ${n.id}: ${errCode(e)}`); }
    }
  }
  try { musicReferencesToNotes(hub.store); } catch (e) { console.error(`[sweep] music references: ${errCode(e)}`); }
  try { const gone = pruneHumAudio(hub); if (gone) console.log(`[sweep] removed ${gone} recordings of deleted music ideas`); } catch (e) { console.error(`[sweep] hum recordings: ${errCode(e)}`); }
  try {
    const p = tidyPeople(hub.store);
    out.people_cleaned = p.cleaned; out.people_merged = p.merged;
  } catch (e) { console.error(`[sweep] people: ${errCode(e)}`); }
  out.ms = Date.now() - t0;
  console.log(`[sweep] ${out.notes} notes, ${out.links_updated} links updated, ${out.tags_suggested} tag suggestions, ${out.projects_linked} linked to projects, ${out.people_cleaned} people cleaned, ${out.people_merged} merged, ${out.ms} ms`);
  return out;
}

/** The project this note path belongs to: its plan document, `Projects/<name>/`, or any folder with the project's name. */
export function projectOfPath(projects: Entity[], notePath: string): Entity | null {
  const folders = notePath.split("/").slice(0, -1).map((f) => f.trim().toLowerCase());
  return projects.find((p) => notePath === p.fields.plan_doc_path || notePath.startsWith(`${projectFolder(p)}/`) || folders.includes(String(p.fields.name ?? "").trim().toLowerCase())) ?? null;
}
