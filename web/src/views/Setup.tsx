import { useEffect, useState } from "react";
import { HubClient, HubError, isDeviceKey, normalizeHubUrl } from "../sync/api";
import { directAddress, isDirect, parseDirect, relayOwner, validRelay } from "../sync/direct";
import { META, db, getMeta, setMeta } from "../sync/db";
import { engine } from "../sync/engine";
import { useMeta } from "../sync/hooks";
import { isAndroid, isTauri, isWindowsApp } from "../tauri/bridge";

function defaultHub(): string {
  if (isTauri) return "";
  const o = window.location.origin;
  if (/localhost:5173|127\.0\.0\.1:5173/.test(o)) return "http://localhost:8787";
  return o;
}

/**
 * A pairing link (`#/setup?hub=&code=&name=`, made in Welcome or Settings on a paired device) fills this in. An older
 * link with `token=` still works: the token is traded for this device's own key at once and never kept.
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

/** A whole pairing link pasted into the address field (the app's `everythingapp://setup?...` or the web one). */
export function pastedLink(text: string): URLSearchParams | null {
  const t = text.trim();
  const q = /^everythingapp:\/\/setup\?(.*)$/i.exec(t)?.[1] ?? /#\/setup\?(.*)$/.exec(t)?.[1];
  if (!q) return null;
  const p = withDirectHub(new URLSearchParams(q));
  return p.get("hub") && (p.get("code") || p.get("token")) ? p : null;
}

const platform = () => (isWindowsApp ? "windows" : "web");
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Pairing links already acted on in this page load. */
const linksUsed = new Set<string>();

export function Setup() {
  const link = linkParams();
  const unpaired = useMeta<string>(META.unpaired);
  const storedHub = useMeta<string>(META.hubUrl);
  const [hub, setHub] = useState(link.get("hub") ?? defaultHub());
  // A device that was paired before keeps its hub's address, so only a new code is needed.
  useEffect(() => { if (!link.get("hub") && storedHub) setHub(storedHub); }, [storedHub]); // eslint-disable-line react-hooks/exhaustive-deps
  const [code, setCode] = useState(link.get("code") ?? "");
  const [mainKey, setMainKey] = useState(link.get("token") ?? "");
  const [name, setName] = useState(link.get("name") ?? (isAndroid ? "Android" : isWindowsApp ? "Windows" : "Browser"));
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  // A link to another hub than the one this device uses waits for a yes: a link in a note, a page or an email
  // must not move a device to someone else's hub without the owner noticing.
  const [switchFrom, setSwitchFrom] = useState<string | null>(null);

  /** Keep this device's own key; a different hub is a different dataset, so the cached copy goes. */
  const keep = async (key: string, deviceId: string | null) => {
    const url = normalizeHubUrl(hub);
    const before = await getMeta<string>(META.hubUrl);
    // Paired again on the same hub while the old key still worked: the old device entry and its key are removed, so
    // no second entry with a working key is left behind.
    const oldKey = await getMeta<string>(META.token);
    const oldId = await getMeta<string>(META.deviceId);
    if (before && normalizeHubUrl(before) === url && isDeviceKey(oldKey) && oldId && oldId !== deviceId) {
      await new HubClient({ hubUrl: url, token: oldKey! }).removeDevice(oldId).catch(() => { /* already gone */ });
    }
    if (before && normalizeHubUrl(before) !== url) {
      await setMeta(META.seq, 0);
      await db.entities.clear();
    }
    await setMeta(META.hubUrl, url);
    await setMeta(META.token, key);
    await setMeta(META.deviceName, name.trim() || "Device");
    if (deviceId) await setMeta(META.deviceId, deviceId); else await db.meta.delete(META.deviceId);
    await db.meta.delete(META.unpaired);
    await engine.restart();
    // Replaced, not added to: the link held a code or a token, and a history entry would keep it in the browser.
    window.location.replace("#/welcome");
  };

  const pairWithCode = async () => {
    if (!hub.trim() || !code.trim()) { setMsg({ ok: false, text: "The hub's address and a pairing code are needed." }); return; }
    setBusy(true);
    setMsg(null);
    try {
      // A device paired before on this hub asks to keep its id (the hub gives a new one if that id still has a key).
      const before = await getMeta<string>(META.hubUrl);
      const sameHub = !!before && normalizeHubUrl(before) === normalizeHubUrl(hub);
      const r = await new HubClient({ hubUrl: hub, token: "" }).claim(code.trim(), name.trim() || "Browser", platform(), sameHub ? await getMeta<string>(META.deviceId) : undefined);
      await keep(r.key, r.device_id);
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

  // Opened from a pairing link: connect at once, asking first only when it would leave another hub.
  useEffect(() => {
    if (!link.get("hub") || !(link.get("code") || link.get("token"))) return;
    // A code works once: a second run of this (React runs effects twice in development, or the screen mounts
    // again) would trade it or the main key a second time and the first device's key would be dropped.
    const once = `${link.get("hub")}|${link.get("code") ?? link.get("token")}`;
    if (linksUsed.has(once)) return;
    linksUsed.add(once);
    void (async () => {
      const current = await getMeta<string>(META.hubUrl);
      const key = await getMeta<string>(META.token);
      if (current && key && normalizeHubUrl(current) !== normalizeHubUrl(hub)) { setSwitchFrom(current); return; }
      await fromLink();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="setup">
      <h1>Connect to your hub</h1>
      {unpaired && !msg && <div className="error">{unpaired}</div>}
      {switchFrom && (
        <section className="card col">
          <div><strong>Switch this device to another hub?</strong></div>
          <div className="small">This link connects this device to <code>{normalizeHubUrl(hub)}</code>. It is connected to <code>{normalizeHubUrl(switchFrom)}</code> now. Switch only if you made this link yourself.</div>
          <div className="row wrap">
            <button type="button" className="primary" onClick={() => { setSwitchFrom(null); void fromLink(); }}>Switch hubs</button>
            <button type="button" onClick={() => { setSwitchFrom(null); window.location.hash = "/today"; }}>Keep the current hub</button>
          </div>
        </section>
      )}
      <form className="col" onSubmit={(e) => { e.preventDefault(); void pairWithCode(); }}>
        <div className="muted small">On a device that is already paired, open Settings, Connection, Pair another device. It shows a code that works once, for 10 minutes. On this device you can paste the whole pairing link into the address field instead.</div>
        <div>
          <label htmlFor="hub">Hub address</label>
          <input id="hub" value={hub} onChange={(e) => {
            // A pasted pairing link fills in everything (a Direct link hub has no address to type).
            const p = pastedLink(e.target.value);
            if (p) { setHub(p.get("hub")!); if (p.get("code")) setCode(p.get("code")!); if (p.get("name")) setName(p.get("name")!); return; }
            setHub(e.target.value);
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

/** For Settings: whether this device holds its own key or still the hub's main key. */
export function keyKind(token: string): "own" | "main" | "none" {
  return !token ? "none" : isDeviceKey(token) ? "own" : "main";
}
