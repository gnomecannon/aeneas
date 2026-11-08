import { useEffect, useMemo, useState } from "react";
import type { Entity } from "@everythingapp/shared";

import { engine } from "./engine";
import { useEntities, useSyncState } from "./hooks";
import { alertAt, hasReminder, isDueToday } from "../lib/reminders";

export const DUE_WITHIN_MINUTES = 720;

const pending = (t: Entity) => !!alertAt(t);

function byTime(a: Entity, b: Entity) {
  return (alertAt(a) ?? "") < (alertAt(b) ?? "") ? -1 : 1;
}

/**
 * Tasks whose reminder is due, for the Today strip: `/reminders/due?within=720` when the hub offers it, otherwise the
 * local "due today" computation. Hub ids are mapped back onto the local entities so an ack or
 * snooze shows at once, and the list is refreshed every 60 s and whenever reminders change.
 */
export function useTodayReminders(): { items: Entity[]; source: "hub" | "local" } {
  const reminders = useEntities("task", hasReminder);
  const sync = useSyncState();
  const [hubIds, setHubIds] = useState<string[] | null>(null);
  const [hubExtra, setHubExtra] = useState<Entity[]>([]);
  const key = reminders.map((r) => `${r.id}:${r.updated_at}`).join("|");

  useEffect(() => {
    let alive = true;
    const load = async () => {
      const c = engine.client;
      if (!c) {
        if (alive) setHubIds(null);
        return;
      }
      try {
        const res = await c.remindersDue(DUE_WITHIN_MINUTES);
        if (!alive) return;
        const list = (res.reminders ?? []).filter(pending);
        setHubIds(list.map((r) => r.id));
        setHubExtra(list);
      } catch {
        if (alive) setHubIds(null);
      }
    };
    void load();
    const id = setInterval(() => document.visibilityState === "visible" && void load(), 60_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [key, sync.status === "setup"]);

  return useMemo(() => {
    if (hubIds) {
      const local = new Map(reminders.map((r) => [r.id, r]));
      const extra = new Map(hubExtra.map((r) => [r.id, r]));
      const items = hubIds
        .map((id) => local.get(id) ?? extra.get(id))
        .filter((r): r is Entity => !!r && pending(r))
        .sort(byTime);
      return { items, source: "hub" as const };
    }
    return { items: reminders.filter((r) => isDueToday(r)).sort(byTime), source: "local" as const };
  }, [hubIds, hubExtra, reminders]);
}
