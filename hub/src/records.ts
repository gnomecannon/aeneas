import type { Entity } from "@everythingapp/shared";
import type { Hub } from "./hub.js";
import { dayKey } from "./metrics.js";

/**
 * Measurements that are also facts about the owner. The newest log of each type is kept in memory under its key, so the
 * assistant and every screen that reads memory know the current weight without anyone editing a fact by hand.
 * Deleting the newest log puts the one before it back.
 */
const CURRENT: Record<string, { key: string; label: string }> = {
  weight: { key: "weight:current", label: "Weight" },
  bp: { key: "bp:latest", label: "Blood pressure" },
};

function valueText(e: Entity): string {
  const unit = e.fields.unit ? ` ${e.fields.unit}` : "";
  return `${e.fields.value}${unit}`;
}

export function syncCurrentFact(hub: Hub, type: string): void {
  const spec = CURRENT[type];
  if (!spec) return;
  const logs = hub.store.list({ kind: "log", where: { type }, limit: 100000 })
    .filter((l) => l.fields.value !== undefined && l.fields.value !== null && l.fields.value !== "")
    .sort((a, b) => String(b.fields.at).localeCompare(String(a.fields.at)));
  const fact = hub.store.list({ kind: "fact", limit: 100000 }).find((f) => f.fields.key === spec.key);
  const [latest, before] = logs;
  if (!latest) { if (fact) hub.store.patch(fact.id, { deleted_at: new Date().toISOString() }); return; }
  const day = (e: Entity) => dayKey(new Date(String(e.fields.at)));
  const value = `${spec.label} ${valueText(latest)} on ${day(latest)}` + (before ? ` (before that ${valueText(before)} on ${day(before)})` : "");
  if (!fact) {
    hub.store.create("fact", { category: "health", key: spec.key, value, source: "logs", private: true });
  } else if (fact.fields.value !== value || fact.deleted_at) {
    hub.store.patch(fact.id, { value, source: "logs", deleted_at: null });
  }
}

export function installRecordHooks(hub: Hub): void {
  hub.store.afterWrite((entity, prev) => {
    if (entity.kind !== "log") return;
    const types = new Set([String(entity.fields.type ?? ""), String(prev?.fields.type ?? "")]);
    for (const t of types) if (CURRENT[t]) syncCurrentFact(hub, t);
  });
}
