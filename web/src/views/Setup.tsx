import { plainError } from "../lib/errors";
import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { HubClient, HubError, isDeviceKey, normalizeHubUrl, type SetupView } from "../sync/api";
import { directAddress, isDirect, parseDirect, relayOwner, validRelay } from "../sync/direct";
import { afterLink, normalizeHubId } from "../sync/hubid";
import { META, db, getMeta, setMeta } from "../sync/db";
import { engine } from "../sync/engine";
import { useMeta } from "../sync/hooks";
import { joinedHubName, setJoinedNote } from "../sync/join";
import { isAndroid, isTauri, isWindowsApp, renewJoin, startJoin, stopJoin, type JoinOffer } from "../tauri/bridge";
import { leaveSetup } from "../lib/router";
import { pairingName } from "../lib/platform";

function defaultHub(): string {
  if (isTauri) return "";
  const o = window.location.origin;
  if (/localhost:5173|127\.0\.0\.1:5173/.test(o)) return "http://localhost:8787";
  return o;
}

/**
 * A pairing link (`#/setup?hub=&code=&name=`, made in Welcome or Settings on a paired device) fills this in. An older
 * link with `token=` still works: the token is traded for this device's own key at once and never kept. A newer hub
 * adds its own id (`hid=`), which tells it from another hub whatever address the link names.
 */
function linkParams(): URLSearchParams {
  const h = window.location.hash;
  return withDirectHub(h.startsWith("#/setup?") ? new URLSearchParams(h.slice("#/setup?".length)) : new URLSearchParams());
}

/**
 * A Direct link pairing link carries the hub's key and relay (`link=direct&node=&relay=`) and no address: the hub's
 * address becomes `iroh://<key>?relay=...`, which the Windows and Android apps reach over their own Direct link.
 */
function withDirectHub(p: URLSearchParams): URLSearchParams {
  const node = p.get("node") ?? "";
  const relay = p.get("relay") ?? "";
  if (p.get("link") === "direct" && /^[0-9a-fA-F]{64}$/.test(node) && validRelay(relay)) p.set("hub", directAddress(node, relay));
  return p;
}

/**
 * A pairing link pasted into the address field (the app's `everythingapp://setup?...` or the web one), alone or inside
 * a whole message: an invitation someone sent (Settings, People on this machine) is a few lines of steps, then the link.
 */
export function pastedLink(text: string): URLSearchParams | null {
  const t = text.trim();
  const q = /everythingapp:\/\/setup\?([^\s"'<>]+)/i.exec(t)?.[1] ?? /#\/setup\?([^\s"'<>]+)/.exec(t)?.[1];
  if (!q) return null;
  const p = withDirectHub(new URLSearchParams(q));
  return p.get("hub") && (p.get("code") || p.get("token")) ? p : null;
}

const platform = () => (isWindowsApp ? "windows" : "web");
/** This device's own name, used when a pairing link names no device or another kind of device. */
const ownName = isAndroid ? "Android" : isWindowsApp ? "Windows" : "Browser";
const ua = () => (typeof navigator === "undefined" ? "" : navigator.userAgent);
const errorText = (e: unknown) => plainError(e);

/** Pairing links already acted on in this page load. */
const linksUsed = new Set<string>();

export function Setup() {
  const link = linkParams();
  const unpaired = useMeta<string>(META.unpaired);
  const storedHub = useMeta<string>(META.hubUrl);
  const [hub, setHub] = useState(link.get("hub") ?? defaultHub());
  // A device that was paired before keeps its hub's address, so only a new code is needed.
  useEffect(() => { if (!link.get("hub") && storedHub) setHub(storedHub); }, [storedHub]); // eslint-disable-line react-hooks/exhaustive-deps
  // The hub's id from the link: the same hub reached at another address is not another hub.
  const [hid, setHid] = useState<string | null>(normalizeHubId(link.get("hid")));
  const [code, setCode] = useState(link.get("code") ?? "");
  const [mainKey, setMainKey] = useState(link.get("token") ?? "");
  const [name, setName] = useState(() => pairingName(link.get("name"), ownName, ua()));
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  // A link to another hub than the one this device uses waits for a yes: a link in a note, a page or an email
  // must not move a device to someone else's hub without the owner noticing.
  const [switchFrom, setSwitchFrom] = useState<string | null>(null);

  /** Where this device is paired now: the hub's address and its id, when known. */
  const current = async () => {
    const url = await getMeta<string>(META.hubUrl);
    return url ? { url, id: await getMeta<string>(META.hubId) } : null;
  };

  /**
   * Keep this device's own key; a different hub is a different dataset, so the cached copy goes. Hubs are told apart
   * by their ids when the link and this device both have one, else by address.
   */
  const keep = async (key: string, deviceId: string | null, to?: { url: string; id: string | null }) => {
    const url = normalizeHubUrl(to?.url ?? hub);
    const before = await current();
    const { same, id } = afterLink(before, { url, id: to ? to.id : hid });
    // Paired again on the same hub while the old key still worked: the old device entry and its key are removed, so
    // no second entry with a working key is left behind.
    const oldKey = await getMeta<string>(META.token);
    const oldId = await getMeta<string>(META.deviceId);
    if (same && isDeviceKey(oldKey) && oldId && oldId !== deviceId) {
      await new HubClient({ hubUrl: url, token: oldKey! }).removeDevice(oldId).catch(() => { /* already gone */ });
    }
    if (before && !same) {
      await setMeta(META.seq, 0);
      await db.entities.clear();
      await db.meta.delete(META.routes);
    }
    await setMeta(META.hubUrl, url);
    if (id) await setMeta(META.hubId, id); else await db.meta.delete(META.hubId);
    await setMeta(META.token, key);
    await setMeta(META.deviceName, name.trim() || "Device");
    if (deviceId) await setMeta(META.deviceId, deviceId); else await db.meta.delete(META.deviceId);
    await db.meta.delete(META.unpaired);
    await engine.restart();
    // Back where the person was. Replaced, not added to: the link held a code or a token, and a history entry would
    // keep it in the browser. A hub nobody has set up yet still opens Welcome (App's first run).
    leaveSetup();
  };

  /** `after` runs with the new key before this device leaves Setup (a join says which hub it joined). */
  const pairWithCode = async (given?: { hub: string; hid: string | null; code: string; name: string }, after?: (hubUrl: string, key: string) => Promise<void>) => {
    const h = given?.hub ?? hub, c = given?.code ?? code, n = given?.name ?? name;
    if (!h.trim() || !c.trim()) { setMsg({ ok: false, text: "The hub's address and a pairing code are needed." }); return; }
    setBusy(true);
    setMsg(null);
    try {
      // A device paired before on this hub asks to keep its id (the hub gives a new one if that id still has a key).
      const { same } = afterLink(await current(), { url: h, id: given ? given.hid : hid });
      const r = await new HubClient({ hubUrl: h, token: "" }).claim(c.trim(), n.trim() || "Browser", platform(), same ? await getMeta<string>(META.deviceId) : undefined);
      try { await after?.(h, r.key); } catch { /* the pairing stands without it */ }
      await keep(r.key, r.device_id, given ? { url: h, id: given.hid } : undefined);
    } catch (e) {
      setMsg({ ok: false, text: e instanceof HubError && e.status === 404 ? "This hub is older and has no pairing codes yet. Use its main key below." : errorText(e) });
    } finally { setBusy(false); }
  };

  /** The hub's main key, traded for this device's own key when the hub can (an older hub keeps the main key). */
  const pairWithMainKey = async () => {
    if (!hub.trim() || !mainKey.trim()) { setMsg({ ok: false, text: "The hub's address and its main key are needed." }); return; }
    setBusy(true);
    setMsg(null);
    try {
      const c = new HubClient({ hubUrl: hub, token: mainKey.trim() });
      await c.health();
      try {
        const r = await c.exchange(name.trim() || "Browser", platform());
        await keep(r.key, r.device_id);
      } catch (e) {
        if (e instanceof HubError && e.status === 404) await keep(mainKey.trim(), null);
        else throw e;
      }
    } catch (e) {
      const why = e instanceof HubError ? (e.detail as { main_key?: string } | undefined)?.main_key : undefined;
      setMsg({ ok: false, text: why === "not_here"
        ? "The hub takes its main key only on its own machine. Pair this device with a code from another device or the Welcome page instead."
        : why === "header_only" ? "The main key cannot be sent in a link. Paste it in the field below instead." : errorText(e) });
    } finally { setBusy(false); }
  };

  const fromLink = () => (link.get("code") ? pairWithCode() : pairWithMainKey());

  // A hub's join came in over Direct link (src-tauri/src/join.rs): pair with its link as with an opened pairing link,
  // then say which hub it was, so a device joined to someone else's hub shows it at once.
  const [joining, setJoining] = useState(false);
  const joined = (appLink: string) => {
    const p = pastedLink(appLink);
    if (!p?.get("code")) { setMsg({ ok: false, text: "The hub's pairing link could not be read. Scan the new code with your phone again." }); return; }
    const found = { hub: p.get("hub")!, hid: normalizeHubId(p.get("hid")), code: p.get("code")!, name: name.trim() || pairingName(p.get("name"), ownName, ua()) };
    setHub(found.hub); setHid(found.hid); setCode(found.code);
    setJoining(true);
    void pairWithCode(found, async (url, key) => setJoinedNote(`This device joined ${await whichHub(url, key)}.`)).finally(() => setJoining(false));
  };
  const pairingFromLink = !!(link.get("hub") && (link.get("code") || link.get("token")));

  // Opened from a pairing link: connect at once, asking first only when it would leave another hub.
  useEffect(() => {
    if (!link.get("hub") || !(link.get("code") || link.get("token"))) return;
    // A code works once: a second run of this (React runs effects twice in development, or the screen mounts
    // again) would trade it or the main key a second time and the first device's key would be dropped.
    const once = `${link.get("hub")}|${link.get("code") ?? link.get("token")}`;
    if (linksUsed.has(once)) return;
    linksUsed.add(once);
    void (async () => {
      const now = await current();
      const key = await getMeta<string>(META.token);
      if (now && key && !afterLink(now, { url: hub, id: hid }).same) { setSwitchFrom(now.url); return; }
      await fromLink();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="setup">
      <h1>Connect to your hub</h1>
      {/^#\/join(\?|$)/.test(window.location.hash) && <div className="error">Pair this device with your hub first.</div>}
      {unpaired && !msg && <div className="error">{unpaired}</div>}
      {switchFrom && (
        <section className="card col">
          <div><strong>Switch this device to another hub?</strong></div>
          <div className="small">This link connects this device to <code>{normalizeHubUrl(hub)}</code>. It is connected to <code>{normalizeHubUrl(switchFrom)}</code> now. Switch only if you made this link yourself.</div>
          <div className="row wrap">
            <button type="button" className="primary" onClick={() => { setSwitchFrom(null); void fromLink(); }}>Switch hubs</button>
            <button type="button" onClick={() => { setSwitchFrom(null); leaveSetup(); }}>Keep the current hub</button>
          </div>
        </section>
      )}
      {isTauri && !switchFrom && !pairingFromLink && (joining ? (
        <section className="card col" aria-label="Pair with your phone">
          <h2>Pair with your phone</h2>
          <p aria-live="polite">Your hub answered. Pairing this device now.</p>
        </section>
      ) : !busy && <PairWithPhone name={name} onLink={joined} />)}
      {!switchFrom && <Invitation busy={busy} onFound={(p) => {
        const found = { hub: p.get("hub")!, hid: normalizeHubId(p.get("hid")), code: p.get("code") ?? "", name: pairingName(p.get("name"), name, ua()) };
        setHub(found.hub); setHid(found.hid); setCode(found.code); setName(found.name);
        void pairWithCode(found);
      }} />}
      <form className="col" onSubmit={(e) => { e.preventDefault(); void pairWithCode(); }}>
        <div className="muted small">On a device that is already paired, open Settings, Connection, Pair another device. It shows a code that works once, for 10 minutes. On this device you can paste the whole pairing link into the address field instead.</div>
        <div>
          <label htmlFor="hub">Hub address</label>
          <input id="hub" value={hub} onChange={(e) => {
            // A pasted pairing link fills in everything (a Direct link hub has no address to type).
            const p = pastedLink(e.target.value);
            if (p) { setHub(p.get("hub")!); setHid(normalizeHubId(p.get("hid"))); if (p.get("code")) setCode(p.get("code")!); setName((n) => pairingName(p.get("name"), n, ua())); return; }
            // A typed address is compared by address: the id came with a link.
            setHub(e.target.value);
            setHid(null);
          }} placeholder="https://core.tailnet.ts.net:8787, or paste a pairing link" autoCapitalize="off" spellCheck={false} />
          {isDirect(hub) && <div className="muted small">Direct link (iroh) to the hub with key {parseDirect(hub)?.node.slice(0, 10) ?? "?"}. Relay: {parseDirect(hub) ? relayOwner(parseDirect(hub)!.relay) : "?"}.</div>}
        </div>
        <div>
          <label htmlFor="code">Pairing code</label>
          <input id="code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="ABCD-EFGH" autoCapitalize="characters" autoComplete="one-time-code" spellCheck={false} style={{ fontFamily: "ui-monospace, monospace", letterSpacing: "0.1em" }} />
        </div>
        <div>
          <label htmlFor="nm">Name for this device</label>
          <input id="nm" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        {msg && <div className={msg.ok ? "ok" : "error"}>{msg.text}</div>}
        <div className="row">
          <button type="submit" className="primary" disabled={busy || !hub.trim() || !code.trim()}>{busy ? "Pairing" : "Pair"}</button>
        </div>
      </form>
      <details>
        <summary className="small">Use the hub's main key instead</summary>
        <div className="col">
          <div className="muted small">The key in hub.env on the hub's machine (EA_TOKEN). It works only in a browser on that machine, unless the hub's EA_MAIN_KEY_FROM names this device. It is traded for this device's own key at once and not kept here.</div>
          <input type="password" value={mainKey} onChange={(e) => setMainKey(e.target.value)} placeholder="Main key" aria-label="Main key" autoCapitalize="off" autoComplete="off" spellCheck={false} />
          <div><button type="button" onClick={() => void pairWithMainKey()} disabled={busy || !hub.trim() || !mainKey.trim()}>Connect with the main key</button></div>
        </div>
      </details>
    </div>
  );
}

/** A new secret and QR code this often while Setup shows (CONTRACT, Devices). */
const JOIN_RENEW_MS = 5 * 60_000;

/**
 * The Windows and Android apps' QR code for joining with a phone's yes (CONTRACT, Devices): the app listens on an
 * iroh endpoint of its own while this shows, with a new secret every 5 minutes, and stops when it goes away. Never in
 * a browser, which cannot use Direct link.
 */
function PairWithPhone({ name, onLink }: { name: string; onLink: (link: string) => void }) {
  const [qr, setQr] = useState("");
  const [err, setErr] = useState("");
  const [tries, setTries] = useState(0);
  // The name in the code is the one in the field when it was made; the link arrives through these.
  const nameRef = useRef(name);
  nameRef.current = name;
  const onLinkRef = useRef(onLink);
  onLinkRef.current = onLink;

  useEffect(() => {
    let live = true;
    let session: number | undefined;
    const show = async (o: JoinOffer) => {
      session = o.session;
      const img = await QRCode.toDataURL(o.link, { margin: 1, width: 240 });
      if (live) { setQr(img); setErr(""); }
    };
    const start = () => startJoin(nameRef.current.trim() || ownName, isAndroid ? "android" : "windows", (l) => { if (live) onLinkRef.current(l); }).then(show);
    const failed = (e: unknown) => { if (live) { setQr(""); setErr(plainError(e)); } };
    // Every call the app is still working on, so stopping waits for it and names the newest code.
    let pending: Promise<unknown> = start().catch(failed);
    // An endpoint that stopped (the network went away) starts again.
    const t = setInterval(() => { pending = renewJoin().then(show).catch(() => start()).catch(failed); }, JOIN_RENEW_MS);
    return () => {
      live = false;
      clearInterval(t);
      void pending.finally(() => { if (session !== undefined) void stopJoin(session); });
    };
  }, [tries]);

  return (
    <section className="card col" aria-label="Pair with your phone">
      <h2>Pair with your phone</h2>
      <div className="row wrap" style={{ alignItems: "flex-start" }}>
        {qr
          ? <img src={qr} width={240} height={240} alt="Code for a phone that already uses Aeneas" style={{ background: "#fff", borderRadius: 8 }} />
          : !err && <div className="muted small" style={{ width: 240 }}>Making a code.</div>}
        <div className="col grow" style={{ minWidth: 200 }}>
          <p>On a phone that already uses Aeneas, open the Camera and point it at this code, then tap Add on the phone.</p>
          <p className="muted small">This works with a hub on Direct link. A hub on Tailscale or Home Wi-Fi only takes its address and a code below.</p>
        </div>
      </div>
      {err && (
        <div className="row wrap" style={{ alignItems: "center" }}>
          <span className="error small grow">{err}</span>
          <button type="button" onClick={() => setTries((n) => n + 1)}>Try again</button>
        </div>
      )}
    </section>
  );
}

/** Which hub a join reached, as the hub names itself, else by its key's start. */
async function whichHub(hubUrl: string, key: string): Promise<string> {
  const c = new HubClient({ hubUrl, token: key });
  const soon = () => (typeof AbortSignal !== "undefined" && "timeout" in AbortSignal ? AbortSignal.timeout(10_000) : undefined);
  const health = await c.health(soon()).catch(() => null);
  const setup = health?.hub?.name ? null : await c.req<SetupView>("GET", "/setup", undefined, soon()).catch(() => null);
  return joinedHubName({ hubName: health?.hub?.name, owner: setup?.owner, named: setup?.named }, parseDirect(hubUrl)?.node ?? "");
}

/**
 * For someone who was sent an invitation (docs/helpers.md): large and plain. Paste the whole message, or press Paste,
 * and the app finds the invitation in it and connects.
 */
function Invitation({ busy, onFound }: { busy: boolean; onFound: (p: URLSearchParams) => void }) {
  const [text, setText] = useState("");
  const [note, setNote] = useState("");
  const tryText = (t: string) => {
    setText(t);
    const p = pastedLink(t);
    if (p && p.get("code")) { setNote(""); onFound(p); }
    else if (t.trim()) setNote("There is no invitation in that. Copy the whole message you were sent, then paste it here.");
  };
  const paste = async () => {
    try { tryText(await navigator.clipboard.readText()); } catch { setNote("Press and hold in the box below, then tap Paste."); }
  };
  return (
    <section className="card col simple" aria-label="I have an invitation">
      <h2>I have an invitation</h2>
      <p>Copy the whole message you were sent, then press Paste the invitation.</p>
      <div className="choices">
        <button type="button" className="primary" disabled={busy} onClick={() => void paste()}>{busy ? "Connecting" : "Paste the invitation"}</button>
      </div>
      <textarea value={text} onChange={(e) => tryText(e.target.value)} rows={3} placeholder="Or paste the message here" aria-label="The invitation message" style={{ fontSize: 18 }} />
      {note && <p className="error">{note}</p>}
    </section>
  );
}

/** For Settings: whether this device holds its own key or still the hub's main key. */
export function keyKind(token: string): "own" | "main" | "none" {
  return !token ? "none" : isDeviceKey(token) ? "own" : "main";
}
