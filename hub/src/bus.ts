import { EventEmitter } from "node:events";

export interface ChangeEvent { seq: number; id: string; kind: string }
/**
 * A notification for connected clients. `reminder` carries `friction`; `digest` is the once-a-day summary
 * (id `digest:<date>`); `activity` is the focus check-in and carries `log_id` (id is the log id too);
 * `sensor` is a state change of a home sensor and carries `name`, `value`, `unit` and the new `state`;
 * `quiz` says the recall quiz for `date` is ready (id `quiz:<date>`); `monitor` is a homelab monitor going
 * `down` or back `up` (and the 6 hour re-notify of an unacknowledged incident) with `name`, `state` and `error`;
 * `disk` says the disk with the hub's data is almost full (diskspace.ts), its whole message in `title`;
 * `mail` is new mail on the Mail screen (mail-inbox.ts, notifyNewMail), its sender and subject or a count in `title`;
 * `connection` says an account or service stopped signing in or syncing (connection-problems.ts), once when it breaks,
 * its whole message in `title`, the service in `name`, and where the fix is in `fix`, `account` and `button`.
 */
export interface NotifyEvent {
  id: string;
  kind: "reminder" | "digest" | "activity" | "sensor" | "quiz" | "monitor" | "disk" | "mail" | "connection";
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
  /** `monitor` down: the open incident, so the alert can acknowledge it. */
  incident_id?: string;
  /** `connection`: where the fix is and the words on its button, as in the problem (connection-problems.ts). */
  fix?: "account" | "connections";
  account?: string;
  button?: string;
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
