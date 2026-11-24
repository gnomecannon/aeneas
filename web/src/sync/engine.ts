import { plainError } from "../lib/errors";
import type { Entity, Patch } from "@everythingapp/shared";
import { db as defaultDb, EADatabase, META, getMeta, setMeta, type OutboxItem, type RejectedEdit } from "./db";
import { HubClient, HubError, isDeviceKey, readSse, type AlertInfo, type FetchLike, type ModuleInfo, type SourcesView } from "./api";
import { applyPatchLocal, mergeIncoming, planFlush, rejectedIds } from "./merge";
import { celebrate } from "../feel/events";
import { hubFetch } from "./direct";
import { router as appRouter, type HubRouter } from "./home";
import { normalizeHubId } from "./hubid";
import { parseRoutes, type HubRoutes, type RouteName, type Trigger } from "./route";
import { isTauri } from "../tauri/bridge";

export type SyncStatus = "setup" | "offline" | "syncing" | "synced";

export interface SyncState {
  status: SyncStatus;
  outbox: number;
  lastError?: string;
  live: boolean;
  seq: number;
  /** How the Windows or Android app reaches its hub right now (Settings, Connection); null in a browser. */
  route: RouteName | null;
}

/** Said when the hub's address now answers with another hub's id: nothing is synced with it. */
export const OTHER_HUB = "This address now leads to another hub, so nothing is synced. Pair this device again with a code from your own hub.";

/** The hub's answer to GET /link/routes, kept for the next start. */
export interface KeptRoutes extends HubRoutes { at: string }

/**
 * A `notify` event from /live. `reminder` carries id and friction, `digest` only a title (the first
 * digest line), `activity` the open log's id as `log_id`, `sensor` the sensor's name, value and unit, `disk` its
 * whole message in the title.
 */
export interface NotifyEvent {
  kind: string;
  title: string;
  at?: string;
  id?: string;
  friction?: string;
  log_id?: string;
  name?: string;
  value?: number;
  unit?: string;
  /** `monitor`: the monitor state and the error that took it down. */
  state?: string;
  error?: string;
  /** `monitor` down: the open incident, which the banner can acknowledge. */
  incident_id?: string;
}

type Listener = (s: SyncState) => void;

export interface EngineOptions {
  db?: EADatabase;
  fetchImpl?: FetchLike;
  platform?: () => string;
  deviceName?: () => string;
  live?: boolean;
  /** The Windows and Android apps' choice between the home network and the remote route (home.ts). None in a browser. */
  router?: HubRouter | null;
}

export class SyncEngine {
  db: EADatabase;
  client: HubClient | null = null;
  state: SyncState = { status: "setup", outbox: 0, live: false, seq: 0, route: null };
  private listeners = new Set<Listener>();
  private notifyListeners = new Set<(n: NotifyEvent) => void>();
  private moduleListeners = new Set<(m: ModuleInfo[]) => void>();
  private alertListeners = new Set<(a: AlertInfo[]) => void>();
  private sourcesListeners = new Set<(v: SourcesView) => void>();
  private fetchImpl: FetchLike;
  private platform: () => string;
  private deviceName: () => string;
  private liveEnabled: boolean;
  private liveAbort: AbortController | null = null;
  /** When the live stream last said anything (the hub pings every 25 s). */
  private liveHeard = 0;
  private backoff = 1000;
  private pullTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setInterval> | null = null;
  private flushing = false;
  private pulling = false;
  private stopped = true;
  private pullAgain = false;
  /** When this device last tried to trade the hub's main key for its own (a failure waits a minute). */
  private exchangeAt = 0;
  private router: HubRouter | null;
  /** The hub was asked which ways reach it since this connection began (GET /link/routes). */
  private routesFresh = false;
  /** The hub's address answered with another hub's id: nothing is synced until it is ours again. */
  private otherHub = false;

  constructor(opts: EngineOptions = {}) {
    this.db = opts.db ?? defaultDb;
    this.fetchImpl = opts.fetchImpl ?? (hubFetch as typeof fetch);
    this.platform = opts.platform ?? (() => "web");
    this.deviceName = opts.deviceName ?? (() => "web");
    this.liveEnabled = opts.live ?? true;
    this.router = opts.router !== undefined ? opts.router : isTauri ? appRouter : null;
    this.router?.chooser.subscribe(() => this.onRouteChange());
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.state);
    return () => this.listeners.delete(fn);
  }

  /** Module switches changed on some device (`event: modules` on /live). */
  onModules(fn: (m: ModuleInfo[]) => void): () => void {
    this.moduleListeners.add(fn);
    return () => this.moduleListeners.delete(fn);
  }

  /** Alert switches changed on some device (they come with `event: modules` on /live). */
  onAlerts(fn: (a: AlertInfo[]) => void): () => void {
    this.alertListeners.add(fn);
    return () => this.alertListeners.delete(fn);
  }

  /** The sources setting changed on the hub (`event: sources` on /live): the whole setting. */
  onSources(fn: (v: SourcesView) => void): () => void {
    this.sourcesListeners.add(fn);
    return () => this.sourcesListeners.delete(fn);
  }

  onNotify(fn: (n: NotifyEvent) => void): () => void {
    this.notifyListeners.add(fn);
    return () => this.notifyListeners.delete(fn);
  }

  private set(partial: Partial<SyncState>) {
    this.state = { ...this.state, ...partial };
    for (const l of this.listeners) l(this.state);
  }

  private async refreshOutboxCount() {
    const n = await this.db.outbox.count();
    this.set({ outbox: n });
  }

  async configure(): Promise<boolean> {
    const hubUrl = await getMeta<string>(META.hubUrl, this.db);
    const token = await getMeta<string>(META.token, this.db);
    if (!hubUrl || !token) {
      this.client = null;
      this.set({ status: "setup" });
      return false;
    }
    this.client = new HubClient({ hubUrl, token }, this.fetchImpl);
    if (this.router) {
      // Raced at once with the ways the hub named last time; asked again on the first connect.
      this.router.start(hubUrl, this.client.url(""), parseRoutes(await getMeta<KeptRoutes>(META.routes, this.db)));
      this.set({ route: this.router.name });
    }
    return true;
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.routesFresh = false;
    this.otherHub = false;
    await this.refreshOutboxCount();
    const seq = (await getMeta<number>(META.seq, this.db)) ?? 0;
    this.set({ seq });
    if (!(await this.configure())) return;
    this.set({ status: "syncing" });
    if (typeof window !== "undefined") {
      window.addEventListener("online", this.onOnline);
      document.addEventListener("visibilitychange", this.onVisible);
      if (this.router) {
        window.addEventListener("offline", this.onOffline);
        netInfo()?.addEventListener("change", this.onNetwork);
      }
    }
    await this.cycle();
    if (this.liveEnabled) this.openLive();
    // Edits waiting to send are retried every minute even when nothing else triggers a sync.
    if (this.retryTimer) clearInterval(this.retryTimer);
    this.retryTimer = setInterval(() => {
      if (this.stopped) return;
      void this.db.outbox.count().then((n) => { if (n > 0) void this.cycle(); });
    }, 60_000);
  }

  stop(): void {
    this.stopped = true;
    this.liveAbort?.abort();
    this.liveAbort = null;
    if (this.pullTimer) clearTimeout(this.pullTimer);
    if (this.retryTimer) clearInterval(this.retryTimer);
    this.retryTimer = null;
    if (typeof window !== "undefined") {
      window.removeEventListener("online", this.onOnline);
      document.removeEventListener("visibilitychange", this.onVisible);
      window.removeEventListener("offline", this.onOffline);
      netInfo()?.removeEventListener("change", this.onNetwork);
    }
    this.router?.stop();
    this.set({ live: false });
  }

  async restart(): Promise<void> {
    this.stop();
    await this.start();
  }

  private onOnline = () => this.wake("network");

  /**
   * Back from sleep or another tab: catch up at once rather than trusting a stream that may have died quietly. One
   * handler kept here, so stop() can take it off again; a new one on every start piled up, each syncing on its own.
   */
  private onVisible = () => {
    if (document.visibilityState === "visible") this.wake("foreground");
  };

  /** Offline, or on another network: the Windows and Android apps race the ways to the hub again. */
  private onOffline = () => void this.router?.chooser.trigger("network");
  private onNetwork = () => this.wake("network");

  /** Online again, back in the foreground or on another network: race the routes (the apps), then catch up. */
  private wake(why: Trigger) {
    if (this.router) {
      this.routesFresh = false;
      void this.router.chooser.trigger(why);
    }
    void this.cycle();
    if (this.liveEnabled && !this.liveAbort) this.openLive();
  }

  /** The app moved to the other route: the live updates move with it, and the hub is asked again which ways reach it. */
  private onRouteChange() {
    if (this.router) this.set({ route: this.router.name });
    if (this.stopped || !this.client) return;
    this.routesFresh = false;
    this.reopenLive();
    void this.cycle();
  }

  private reopenLive() {
    if (!this.liveAbort) return;
    this.liveAbort.abort();
    this.liveAbort = null;
    if (this.liveEnabled && !this.stopped) this.openLive();
  }

  /**
   * The Windows and Android apps ask the hub which ways reach it on every connect (GET /link/routes) and keep the
   * answer for the next start. When the answer names another hub than the one this device was paired with, nothing is
   * synced: false. A device paired before hubs had ids learns its hub's id here.
   */
  private async checkRoutes(): Promise<boolean> {
    if (!this.router || !this.client || (this.routesFresh && !this.otherHub)) return true;
    let answer: unknown;
    try {
      answer = await this.client.linkRoutes(timeoutSignal(15_000));
    } catch (e) {
      // An older hub has no such route (or not for this key): it is reached at its one address, as before.
      if (e instanceof HubError && (e.status === 403 || e.status === 404 || e.status === 405)) {
        this.routesFresh = true;
        return true;
      }
      throw e;
    }
    const routes = parseRoutes(answer);
    const stored = normalizeHubId(await getMeta<string>(META.hubId, this.db));
    if (routes?.hub_id && stored && routes.hub_id !== stored) {
      this.otherHub = true;
      this.liveAbort?.abort();
      this.liveAbort = null;
      this.set({ status: "offline", live: false, lastError: OTHER_HUB });
      return false;
    }
    if (routes) {
      if (routes.hub_id && !stored) await setMeta(META.hubId, routes.hub_id, this.db);
      await setMeta(META.routes, { ...routes, at: new Date().toISOString() } satisfies KeptRoutes, this.db);
      this.router.setRoutes(routes);
    }
    this.routesFresh = true;
    if (this.otherHub) {
      this.otherHub = false;
      if (this.liveEnabled && !this.liveAbort && !this.stopped) this.openLive();
    }
    return true;
  }

  /**
   * A device set up with the hub's main key (before devices had keys, or from a setup file) trades it for a key of
   * its own and forgets the main key. An older hub without the route keeps the main key working as before.
   */
  async ensureOwnKey(): Promise<void> {
    const client = this.client;
    if (!client || isDeviceKey(client.cfg.token) || Date.now() - this.exchangeAt < 60_000) return;
    this.exchangeAt = Date.now();
    // Every window and tab (the Windows app's Now widget, a second tab) runs its own engine on the same stored key.
    // Only one may trade it: a second trade would end the first one's new key and sign every window out.
    await this.withLock("ea-key-exchange", async () => {
      const stored = await getMeta<string>(META.token, this.db);
      if (isDeviceKey(stored)) { this.useKey(client.cfg.hubUrl, stored!); return; }
      const name = (await getMeta<string>(META.deviceName, this.db)) || this.deviceName();
      const id = await getMeta<string>(META.deviceId, this.db);
      try {
        const r = await client.exchange(name, this.platform(), id);
        await setMeta(META.token, r.key, this.db);
        await setMeta(META.deviceId, r.device_id, this.db);
        this.useKey(client.cfg.hubUrl, r.key);
      } catch (e) {
        if (e instanceof HubError && (e.status === 404 || e.status === 409)) this.exchangeAt = Number.POSITIVE_INFINITY;
      }
    });
  }

  /** Switch to a key (this engine's own trade, or one another window stored), reopening the live stream with it. */
  private useKey(hubUrl: string, key: string) {
    if (this.client?.cfg.token === key) return;
    this.client = new HubClient({ hubUrl, token: key }, this.fetchImpl);
    this.reopenLive();
  }

  /** Removed from the hub (Settings, Devices on another device): forget the key so setup shows. */
  private async forgetRemovedDevice(): Promise<void> {
    // Another window may have just stored a newer key for this device (a trade or a new pairing): use that instead.
    const stored = await getMeta<string>(META.token, this.db);
    if (this.client && stored && stored !== this.client.cfg.token) { this.useKey(this.client.cfg.hubUrl, stored); return; }
    const why = "This device was removed from the hub. Pair it again with a code from a device that is still paired.";
    // Nothing of the hub's stays on a removed device: every table (items, outbox, chats) is emptied and the browser's
    // caches go too. Only how it looks here (theme) and the hub's address, for pairing again, are kept.
    const keep = { hubUrl: await getMeta<string>(META.hubUrl, this.db), theme: await getMeta(META.theme, this.db), name: await getMeta(META.deviceName, this.db) };
    await this.db.transaction("rw", this.db.tables, async () => { for (const t of this.db.tables) await t.clear(); });
    if (keep.hubUrl) await setMeta(META.hubUrl, keep.hubUrl, this.db);
    if (keep.theme !== undefined) await setMeta(META.theme, keep.theme, this.db);
    if (keep.name !== undefined) await setMeta(META.deviceName, keep.name, this.db);
    await setMeta(META.unpaired, why, this.db);
    await setMeta(META.token, "", this.db);
    try { if (typeof caches !== "undefined") for (const k of await caches.keys()) await caches.delete(k); } catch { /* no cache storage here */ }
    this.stop();
    this.client = null;
    this.set({ status: "setup", lastError: why });
  }

  /** Register, flush, pull. Safe to call often. */
  async cycle(): Promise<void> {
    if (!this.client || this.stopped) return;
    try {
      await this.ensureOwnKey();
      // The Windows and Android apps make sure the address still leads to this device's hub before syncing anything.
      if (!(await this.checkRoutes())) return;
      await this.ensureDevice();
      // A push that fails (one bad edit, a hub hiccup) must not stop changes from coming in.
      let pushError: unknown;
      try {
        await this.flush();
      } catch (e) {
        pushError = e;
      }
      await this.pull();
      if (pushError) throw pushError;
      this.set({ status: (await this.db.outbox.count()) === 0 ? "synced" : "syncing", lastError: undefined });
    } catch (e) {
      // The next connect asks the hub again which ways reach it.
      this.routesFresh = false;
      const d = e instanceof HubError && e.status === 401 ? (e.detail as { device_removed?: boolean; unknown_key?: boolean } | undefined) : undefined;
      if (d?.device_removed) { await this.forgetRemovedDevice(); return; }
      // The hub does not know this key at all (its keys file was lost or restored): keep the key, in case it comes back.
      if (d?.unknown_key) { this.set({ status: "offline", lastError: "The hub does not know this device's key. If the hub was restored or moved, pair this device again in Settings, Connection." }); return; }
      this.set({ status: "offline", lastError: plainError(e) });
    }
  }

  async ensureDevice(): Promise<string> {
    let id = await getMeta<string>(META.deviceId, this.db);
    if (id) return id;
    if (!this.client) throw new Error("no hub");
    const name = (await getMeta<string>(META.deviceName, this.db)) || this.deviceName();
    const res = await this.client.register(name, this.platform());
    id = res.device_id;
    await setMeta(META.deviceId, id, this.db);
    return id;
  }

  private withLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const locks = typeof navigator !== "undefined" ? (navigator as Navigator & { locks?: LockManager }).locks : undefined;
    if (locks) return locks.request(name, fn) as Promise<T>;
    return fn();
  }

  async pull(): Promise<void> {
    if (!this.client) return;
    if (this.pulling) {
      this.pullAgain = true;
      return;
    }
    this.pulling = true;
    try {
      await this.withLock("ea-pull", async () => {
        let since = (await getMeta<number>(META.seq, this.db)) ?? 0;
        const deviceId = await getMeta<string>(META.deviceId, this.db);
        // Set when the hub answered from the beginning (it was restored from an older copy): every entity it has.
        let seen: Set<string> | null = null;
        for (let guard = 0; guard < 1000; guard++) {
          const res = await this.client!.changes(since, undefined, deviceId);
          if (res.reset) { since = 0; seen = new Set(); }
          for (const c of res.changes) seen?.add(c.entity.id);
          await this.applyChanges(res.changes.map((c) => c.entity));
          // While more pages remain, advance only past the rows actually received; the contract does not
          // say whether `seq` is the page's last row or the hub's latest, and the latter would skip rows.
          // With more pages `seq` is the page's last row (the contract): a page whose rows the hub could not send
          // (work rows sealed with a lost key) still moves the cursor, or the same request repeats for good.
          const pageMax = res.changes.length ? Math.max(...res.changes.map((c) => c.seq)) : since;
          const next = Math.max(res.seq, pageMax);
          since = Math.max(since, next);
          // During a reset the cursor is kept only once the whole feed is in: cut short, the next pull starts over.
          if (!seen) {
            await setMeta(META.seq, since, this.db);
            this.set({ seq: since });
          }
          if (!res.more) break;
        }
        // What this device holds that the restored hub does not, and no edit of ours is waiting to send, is gone.
        // Work items stay: a restored hub without its work key cannot send them, and the devices hold the copy it needs.
        if (seen) {
          const keep = seen;
          await this.db.transaction("rw", this.db.entities, this.db.outbox, async () => {
            const pending = new Set((await this.db.outbox.toArray()).map((p) => p.patch.id));
            const stale = (await this.db.entities.toArray()).filter((e) => !keep.has(e.id) && !pending.has(e.id) && e.kind !== "reading" && e.space !== "work").map((e) => e.id);
            await this.db.entities.bulkDelete(stale);
          });
          await setMeta(META.seq, since, this.db);
          this.set({ seq: since });
        }
      });
    } finally {
      this.pulling = false;
      if (this.pullAgain) {
        this.pullAgain = false;
        await this.pull();
      }
    }
  }

  /** Merge hub entities over local pending patches and write them. */
  async applyChanges(entities: Entity[]): Promise<void> {
    if (!entities.length) return;
    await this.db.transaction("rw", this.db.entities, this.db.outbox, async () => {
      const ids = entities.map((e) => e.id);
      const pending = await this.db.outbox.where("patch.id").anyOf(ids).toArray();
      const byId = new Map<string, Patch[]>();
      for (const p of pending) {
        const arr = byId.get(p.patch.id) ?? [];
        arr.push(p.patch);
        byId.set(p.patch.id, arr);
      }
      const merged = entities.map((e) => mergeIncoming(e, byId.get(e.id) ?? []));
      await this.db.entities.bulkPut(merged);
    });
  }

  async flush(): Promise<void> {
    if (!this.client || this.flushing) return;
    this.flushing = true;
    let again = false;
    try {
      await this.withLock("ea-flush", async () => {
        const deviceId = await this.ensureDevice();
        const items = await this.db.outbox.orderBy("seq").toArray();
        if (!items.length) return;
        const toRefetch = new Set<string>();
        for (const batch of planFlush(items)) {
          let res: Awaited<ReturnType<HubClient["push"]>>;
          try {
            res = await this.client!.push(
              deviceId,
              batch.map((b) => b.patch),
            );
          } catch (e) {
            // Over the hub's 2 MB limit even alone: set it aside as refused instead of blocking every edit after it.
            if (e instanceof HubError && e.status === 413 && batch.length === 1) {
              await this.logRejected([{ id: batch[0].patch.id, reason: "too large to send (over 2 MB)" }], [batch[0].patch]);
              await this.db.outbox.bulkDelete([batch[0].seq!]);
              // The device shows the hub's copy again, not the edit that will never go.
              await this.refetch(batch[0].patch.id);
              continue;
            }
            throw e;
          }
          const okIds = new Set(res.applied.map((a) => a.id));
          const badIds = new Set(rejectedIds(res.rejected));
          // An edit of an item the hub does not have (it was restored from a copy older than the item) sends the item
          // again whole, with create: it was deleted here, losing what the person had just changed.
          const resent = await this.resendMissing(res.rejected, batch.map((b) => b.patch));
          const refused = res.rejected.filter((r) => !resent.has(r.id));
          if (refused.length) await this.logRejected(refused, batch.map((b) => b.patch));
          const doneSeqs = batch.filter((b) => okIds.has(b.patch.id) || badIds.has(b.patch.id)).map((b) => b.seq!);
          // Anything the hub did not mention stays queued for the next flush.
          await this.db.outbox.bulkDelete(doneSeqs);
          // At once, batch by batch: a later batch failing (the network gone) must not leave a refused edit showing.
          for (const id of badIds) if (!toRefetch.has(id) && !resent.has(id)) { toRefetch.add(id); await this.refetch(id); }
          if (resent.size) again = true;
          await this.refreshOutboxCount();
        }
      });
    } finally {
      this.flushing = false;
      await this.refreshOutboxCount();
    }
    // A resent item goes now, not at the next edit or timer.
    if (again) await this.flush();
  }

  /**
   * The items the hub answered "entity not found" for that this device still holds, queued again whole with create,
   * stamped with when the item was made (the hub dates a new item by its stamp: "now" moved yesterday's capture to
   * today), then the refused edits again with their own stamps. Once each: a create the hub also refuses (invalid
   * fields) is a refusal like any other.
   */
  private async resendMissing(rejected: Array<{ id: string; reason: string }>, sent: Patch[]): Promise<Set<string>> {
    const resent = new Set<string>();
    const now = new Date().toISOString();
    for (const r of rejected) {
      if (!/^entity not found/.test(r.reason) || resent.has(r.id)) continue;
      const local = await this.db.entities.get(r.id);
      if (!local || local.deleted_at) continue;
      const create: Patch = { id: local.id, kind: local.kind, space: local.space, ts: local.created_at || now, fields: { ...local.fields }, create: true };
      await this.db.outbox.add({ patch: create, attempts: 0, enqueued_at: now });
      for (const p of sent) if (p.id === r.id) await this.db.outbox.add({ patch: p, attempts: 0, enqueued_at: now });
      resent.add(r.id);
    }
    return resent;
  }

  /** Keep a record of edits the hub refused (it then sends its own copy), so nothing is lost silently. */
  private async logRejected(rejected: Array<{ id: string; reason: string }>, patches: Patch[]): Promise<void> {
    const log = (await getMeta<RejectedEdit[]>(META.rejected, this.db)) ?? [];
    for (const r of rejected) {
      const fields = Object.assign({}, ...patches.filter((p) => p.id === r.id).map((p) => p.fields)) as Record<string, unknown>;
      const local = await this.db.entities.get(r.id);
      const f = (local?.fields ?? {}) as Record<string, unknown>;
      const title = String(f.title ?? f.text ?? f.name ?? f.key ?? "");
      log.push({ id: r.id, kind: local?.kind ?? patches.find((p) => p.id === r.id)?.kind ?? "", title, reason: r.reason, at: new Date().toISOString(), fields });
    }
    await setMeta(META.rejected, log.slice(-50), this.db);
  }

  async refetch(id: string): Promise<void> {
    if (!this.client) return;
    try {
      const e = await this.client.entity(id);
      await this.db.entities.put(e);
    } catch (err) {
      if (err instanceof HubError && err.status === 404) {
        // A work item the hub cannot read (restored without its work key) is not gone: this device may hold the
        // last readable copy, so it stays.
        if ((await this.db.entities.get(id))?.space === "work") return;
        await this.db.entities.delete(id);
      } else throw err;
    }
  }

  /** Apply a local patch immediately and queue it for the hub. */
  async enqueue(patch: Patch): Promise<Entity> {
    const entity = await this.db.transaction("rw", this.db.entities, this.db.outbox, async () => {
      const local = await this.db.entities.get(patch.id);
      // A field written twice in one millisecond would lose the second write to a tie, so the stamp is always
      // later than the newest one on the fields it touches.
      for (const k of Object.keys(patch.fields)) {
        const last = local?.field_ts[k];
        if (last && last >= patch.ts) patch = { ...patch, ts: new Date(Date.parse(last) + 1).toISOString() };
      }
      const next = applyPatchLocal(local, patch);
      await this.db.entities.put(next);
      const item: OutboxItem = { patch, attempts: 0, enqueued_at: new Date().toISOString() };
      await this.db.outbox.add(item);
      return next;
    });
    await this.refreshOutboxCount();
    if (this.client && !this.stopped) {
      void this.cycle();
    }
    return entity;
  }

  /**
   * Write a hub-returned entity straight into the local store. These answer an action taken on this device, so an
   * entity new here, a task now done or a reminder now acknowledged is celebrated (sync pulls go through applyChanges).
   */
  async absorb(entities: Entity[]): Promise<void> {
    const before = await this.db.entities.bulkGet(entities.map((e) => e.id));
    await this.applyChanges(entities);
    entities.forEach((e, i) => {
      const old = before[i];
      if (!old) celebrate("create");
      else if (e.kind === "task" && e.fields.status === "done" && old.fields.status !== "done") celebrate("complete");
    });
  }

  private schedulePull() {
    if (this.pullTimer) clearTimeout(this.pullTimer);
    this.pullTimer = setTimeout(() => {
      this.pullTimer = null;
      void this.cycle();
    }, 150);
  }

  openLive(): void {
    if (!this.client || this.stopped || this.liveAbort || this.otherHub) return;
    const ac = new AbortController();
    this.liveAbort = ac;
    const run = async () => {
      // Cleared however the stream ends: one left running at every normal end kept firing for good.
      let watchdog: ReturnType<typeof setInterval> | undefined;
      try {
        const deviceId = await getMeta<string>(META.deviceId, this.db);
        const path = deviceId ? `/live?device_id=${encodeURIComponent(deviceId)}` : "/live";
        const res = await this.client!.sse(path, { signal: ac.signal });
        this.backoff = 1000;
        this.set({ live: true });
        this.liveHeard = Date.now();
        // A switch changed while the stream was down sent its event to no one: read the list again.
        if (this.moduleListeners.size || this.alertListeners.size) {
          this.client!.modules().then((r) => {
            for (const l of this.moduleListeners) l(r.modules);
            if (Array.isArray(r.alerts)) for (const l of this.alertListeners) l(r.alerts);
          }).catch(() => undefined);
        }
        // The same for the sources setting (which Reminders lists are on).
        if (this.sourcesListeners.size) {
          this.client!.sources().then((v) => { for (const l of this.sourcesListeners) l(v); }).catch(() => undefined);
        }
        // A stream can die without closing (sleep, network change): after 70 s of silence, open a new one.
        watchdog = setInterval(() => {
          if (Date.now() - this.liveHeard > 70_000) {
            clearInterval(watchdog);
            ac.abort();
            if (this.liveAbort === ac) {
              this.liveAbort = null;
              this.set({ live: false });
              this.openLive();
              void this.cycle();
            }
          }
        }, 20_000);
        ac.signal.addEventListener("abort", () => clearInterval(watchdog));
        await readSse(res, (ev) => {
          this.liveHeard = Date.now();
          if (ev.event === "change") this.schedulePull();
          else if (ev.event === "modules") {
            try {
              const d = JSON.parse(ev.data) as { modules?: ModuleInfo[]; alerts?: AlertInfo[] };
              if (Array.isArray(d.modules)) for (const l of this.moduleListeners) l(d.modules);
              if (Array.isArray(d.alerts)) for (const l of this.alertListeners) l(d.alerts);
            } catch {
              /* ignore malformed */
            }
          } else if (ev.event === "sources") {
            try {
              const d = JSON.parse(ev.data) as SourcesView;
              if (Array.isArray(d.lists)) for (const l of this.sourcesListeners) l(d);
            } catch {
              /* ignore malformed */
            }
          } else if (ev.event === "notify") {
            try {
              const n = JSON.parse(ev.data) as NotifyEvent;
              for (const l of this.notifyListeners) l(n);
            } catch {
              /* ignore malformed */
            }
          }
        });
      } catch {
        /* fallthrough to reconnect */
      } finally {
        clearInterval(watchdog);
      }
      this.set({ live: false });
      if (ac.signal.aborted || this.stopped) {
        if (this.liveAbort === ac) this.liveAbort = null;
        return;
      }
      const wait = this.backoff;
      this.backoff = Math.min(this.backoff * 2, 30000);
      setTimeout(() => {
        if (this.liveAbort === ac) {
          this.liveAbort = null;
          this.openLive();
        }
      }, wait);
    };
    void run();
  }
}

/** The Network Information API (Chromium's WebView2 and Android WebView): it says when the device changes networks. */
function netInfo(): EventTarget | null {
  if (typeof navigator === "undefined") return null;
  const c = (navigator as Navigator & { connection?: EventTarget }).connection;
  return c && typeof c.addEventListener === "function" ? c : null;
}

/** An abort signal that fires after `ms`, so a request cannot hang. */
function timeoutSignal(ms: number): AbortSignal | undefined {
  if (typeof AbortSignal !== "undefined" && "timeout" in AbortSignal) return AbortSignal.timeout(ms);
  return undefined;
}

export const engine = new SyncEngine({
  platform: () => (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window && !/Android/i.test(navigator.userAgent) ? "windows" : "web"),
  deviceName: () => (typeof navigator !== "undefined" && "__TAURI_INTERNALS__" in window ? (/Android/i.test(navigator.userAgent) ? "Android" : "Windows") : "Browser"),
});
