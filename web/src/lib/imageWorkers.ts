import { useEffect, useState } from "react";
import { engine } from "../sync/engine";
import type { ImageCapabilities, ImageWorker } from "../sync/api";

/**
 * The image service's workers one may pick by hand, with their labels: set on the hub (EA_IMAGE_WORKERS) and sent
 * with `/images/capabilities`. Fetched once per page load.
 */
let workers: ImageWorker[] | null = null;
let loading: Promise<ImageWorker[]> | null = null;

function load(): Promise<ImageWorker[]> {
  const c = engine.client;
  if (!c) return Promise.resolve([]);
  loading ??= c.imageCapabilities().then((x) => (workers = x.hardware ?? []), () => []).finally(() => { loading = null; });
  return loading;
}

/** A worker's label, or its id when the hub gives none. */
export function workerLabel(list: ImageWorker[] | null | undefined, id: string): string {
  return list?.find((w) => w.id === id)?.label ?? id;
}

/** Workers from capabilities already in hand (the Images screen loads them itself). */
export function workersOf(caps: ImageCapabilities | null): ImageWorker[] {
  return caps?.hardware ?? [];
}

export function useImageWorkers(): ImageWorker[] {
  const [list, setList] = useState<ImageWorker[]>(workers ?? []);
  useEffect(() => {
    if (workers) return;
    let live = true;
    void load().then((w) => { if (live) setList(w); });
    return () => { live = false; };
  }, []);
  return list;
}
