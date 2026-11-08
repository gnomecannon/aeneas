import { EventEmitter } from "node:events";

export interface ChangeEvent { seq: number; id: string; kind: string }
/**
 * A notification for connected clients. `reminder` carries `friction`; `digest` is the once-a-day summary
 * (id `digest:<date>`); `activity` is the focus check-in and carries `log_id` (id is the log id too);
 * `sensor` is a state change of a home sensor and carries `name`, `value`, `unit` and the new `state`;
 * `quiz` says the recall quiz for `date` is ready (id `quiz:<date>`); `monitor` is a homelab monitor going
 * `down` or back `up` (and the 6 hour re-notify of an unacknowledged incident) with `name`, `state` and `error`.
 */
export interface NotifyEvent {
  id: string;
  kind: "reminder" | "digest" | "activity" | "sensor" | "quiz" | "monitor";
  title: string;
  at: string;
  friction?: string;
  log_id?: string;
  name?: string;
  value?: number | null;
  unit?: string;
  state?: string;
  date?: string;
  error?: string;
}

export interface BusEvents {
  change: (e: ChangeEvent) => void;
  notify: (e: NotifyEvent) => void;
}

/** Tiny in-process event bus. SSE subscribers and the reminder loop talk through it. */
export class Bus {
  private em = new EventEmitter();
  constructor() { this.em.setMaxListeners(1000); }
  on<K extends keyof BusEvents>(ev: K, fn: BusEvents[K]): () => void {
    this.em.on(ev, fn as any);
    return () => this.em.off(ev, fn as any);
  }
  /** Number of live subscribers for one event. Used to prove SSE handlers clean up after themselves. */
  listenerCount(ev: keyof BusEvents): number { return this.em.listenerCount(ev); }
  emit<K extends keyof BusEvents>(ev: K, payload: Parameters<BusEvents[K]>[0]): void {
    this.em.emit(ev, payload);
  }
}
