import { useEffect, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import type { Entity, Kind } from "@everythingapp/shared";
import { db } from "./db";
import { engine, type SyncState } from "./engine";
import { isShown, useSourcesVersion } from "../lib/sources";

const EMPTY: Entity[] = [];

/**
 * Live list of non-deleted entities of one kind, optionally filtered. Tasks in an Apple Reminders list that is
 * switched off are left out (lib/sources.ts), so every screen that lists tasks hides them.
 */
export function useEntities(kind: Kind, filter?: (e: Entity) => boolean, deps: unknown[] = []): Entity[] {
  const sources = useSourcesVersion();
  const rows = useLiveQuery(
    () =>
      db.entities
        .where("kind")
        .equals(kind)
        .filter((e) => !e.deleted_at && isShown(e) && (filter ? filter(e) : true))
        .toArray(),
    [kind, kind === "task" ? sources : 0, ...deps],
  );
  return rows ?? EMPTY;
}

export function useEntity(id: string | undefined): Entity | undefined {
  return useLiveQuery(() => (id ? db.entities.get(id) : undefined), [id]);
}

export function useMeta<T = string>(key: string): T | undefined {
  const row = useLiveQuery(() => db.meta.get(key), [key]);
  return row?.value as T | undefined;
}

/**
 * True once the sync engine has its hub client. A screen that asks the hub when it opens waits for this: after a
 * reload the screen opens before the client exists, and asking only once left it on "Asking the hub" for good.
 */
export function useHubReady(): boolean {
  useSyncState();
  return !!engine.client;
}

export function useSyncState(): SyncState {
  const [s, setS] = useState<SyncState>(engine.state);
  useEffect(() => engine.subscribe(setS), []);
  return s;
}
