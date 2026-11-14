import { useEffect, useReducer, useRef } from "react";
import type { Entity } from "@everythingapp/shared";
import { updateEntity } from "../sync/edits";

type Fields = Record<string, unknown>;

export interface DraftOptions<D extends Fields> {
  /** The editor's fields from the stored ones, under the same names (a list joined for a text box, a missing text as ""). */
  toDraft: (fields: Fields) => D;
  /** The stored fields for the edited ones, under the same names (a number, a list); saved as typed when left out. */
  toFields?: (edited: Partial<D>, item: Entity) => Fields;
  /** After an edit is written on this device (Notes then refreshes its links). */
  onSaved?: (item: Entity) => void;
  /** Quiet time after the last keystroke before the edits are saved, in ms. */
  delay?: number;
  /** Writes the edits: updateEntity, unless a test gives another. */
  save?: (item: Entity, fields: Fields) => Promise<Entity>;
}

/** An edit handed to a save: being written until `ts` is set, then the stamp this device's write gave the field. */
interface Sent {
  value: unknown;
  ts?: string;
  /** The stored copy has shown this device's write. */
  seen?: boolean;
}

/**
 * The edits of one editor, kept apart from React so they can be tested: every field typed in waits with the others and
 * all of them are saved in one write once typing pauses. Saving only the last field typed lost a title changed just
 * before the body, and the stored copy coming back between keystrokes made the caret jump.
 */
export class DraftSaver<D extends Fields> {
  opts: DraftOptions<D>;
  /** Called when what the editor shows changed (the hook draws it again). */
  onChange: () => void = () => undefined;
  /** False once the editor is gone: a save finishing later calls nothing of it. */
  attached = true;
  /** The newest stored copy the editor was given. */
  private item: Entity | undefined;
  /** The item the edits belong to, newest copy. */
  private target: Entity | null = null;
  private pending: Partial<D> = {};
  private sent = new Map<string, Sent>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: DraftOptions<D>) {
    this.opts = opts;
  }

  /** The stored copy now (each render). A field this device wrote shows as typed until it is written again elsewhere. */
  see(item: Entity | undefined): void {
    this.item = item;
    if (!item || item.id !== this.target?.id) return;
    this.target = item;
    for (const [k, s] of this.sent) {
      if (s.ts === undefined) continue;
      const at = item.field_ts?.[k];
      if (at === s.ts) s.seen = true;
      // Written since by another device or the hub, or refused there and put back: the stored value shows.
      else if (s.seen || (at !== undefined && at > s.ts)) this.sent.delete(k);
    }
  }

  /** What the editor shows: the stored fields, with the edits waiting or being written over them. */
  view(item: Entity | undefined): D | null {
    if (!item) return null;
    const out: Fields = { ...this.opts.toDraft(item.fields) };
    if (item.id === this.target?.id) {
      for (const [k, s] of this.sent) out[k] = s.value;
      Object.assign(out, this.pending);
    }
    return out as D;
  }

  /** Nothing of this item waiting or being written. */
  isSaved(item: Entity | undefined): boolean {
    if (!item || item.id !== this.target?.id) return true;
    return !Object.keys(this.pending).length && ![...this.sent.values()].some((s) => s.ts === undefined);
  }

  /** An edit: kept with the others waiting, and saved with them once typing pauses. */
  edit = (patch: Partial<D>): void => {
    const item = this.item;
    if (!item) return;
    if (item.id !== this.target?.id) {
      // Edits still waiting for the item shown before go to that item, never to this one.
      void this.flush();
      this.target = item;
      this.sent.clear();
    }
    this.pending = { ...this.pending, ...patch };
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), this.opts.delay ?? 1000);
    this.onChange();
  };

  /** Save every waiting edit now, in one write: typing paused, Done, another item, the editor closing, the app hidden. */
  flush = (): Promise<void> => {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const item = this.target;
    const edited = this.pending;
    const keys = Object.keys(edited);
    if (!item || !keys.length) return Promise.resolve();
    this.pending = {};
    const sending = keys.map((k) => {
      const s: Sent = { value: edited[k] };
      this.sent.set(k, s);
      return [k, s] as const;
    });
    const fields = this.opts.toFields ? this.opts.toFields(edited, item) : (edited as Fields);
    return (this.opts.save ?? updateEntity)(item, fields).then(
      (out) => {
        for (const [k, s] of sending) if (this.sent.get(k) === s) s.ts = out.field_ts?.[k] ?? out.updated_at;
        if (!this.attached) return;
        this.onChange();
        this.opts.onSaved?.(out);
      },
      () => {
        // Not written (this device's storage failed): the edits wait again for the next pause or the editor closing.
        for (const [k, s] of sending) {
          if (this.sent.get(k) !== s) continue;
          this.sent.delete(k);
          if (!(k in this.pending)) (this.pending as Fields)[k] = s.value;
        }
        if (this.attached) this.onChange();
      },
    );
  };
}

const open = new Set<{ flush: () => Promise<void> }>();
let listening = false;

function saveAll(): void {
  for (const d of open) void d.flush();
}

function listen(): void {
  if (listening || typeof window === "undefined" || typeof document === "undefined") return;
  listening = true;
  // The page going away, or the app hidden (Android may close it in the background without another word): save now.
  window.addEventListener("pagehide", saveAll);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") saveAll();
  });
}

/**
 * An editor on screen (the hook's effect): its edits are saved when the app is hidden or the page goes away. The cleanup
 * it returns (the editor closing, or showing another item) saves what is waiting at once instead of dropping it.
 */
export function attachDraft<D extends Fields>(d: DraftSaver<D>): () => void {
  listen();
  d.attached = true;
  open.add(d);
  return () => {
    d.attached = false;
    open.delete(d);
    void d.flush();
  };
}

/**
 * Edits to a stored item: fields typed in wait together and are saved in one write a second after typing pauses, and at
 * once when the editor closes, shows another item, or the app is hidden. A field with an edit shows the words typed;
 * the others follow the stored item as it changes elsewhere.
 */
export function useDraftSave<D extends Fields>(item: Entity | undefined, opts: DraftOptions<D>) {
  const [, changed] = useReducer((n: number) => n + 1, 0);
  const ref = useRef<DraftSaver<D> | null>(null);
  const d = (ref.current ??= new DraftSaver<D>(opts));
  d.opts = opts;
  d.onChange = changed;
  d.see(item);
  useEffect(() => attachDraft(d), [d, item?.id]);
  return { draft: d.view(item), edit: d.edit, flush: d.flush, saved: d.isSaved(item) };
}
