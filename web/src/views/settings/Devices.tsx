import { DIRECT_LINK_MIN_APP } from "./Link";
import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { PAIRED_POLL_MS, newlyPaired } from "../../lib/pairing";
import type { DeviceRow, PairingLinks } from "../../sync/api";
import { engine } from "../../sync/engine";
import { fmtDateTime } from "../../lib/time";
import { errorText } from "./common";
import { useHubReady } from "../../sync/hooks";
import { platformLabel } from "../../lib/links";
import { isMacBrowser } from "../../lib/platform";
import { isTauri } from "../../tauri/bridge";

type Msg = { ok: boolean; text: string } | null;

/** Device lists on screen, told when a device paired from this page so they show it without a reload. */
const listeners = new Set<() => void>();
const devicesChanged = () => listeners.forEach((f) => f());

/** "9:41" left until a code expires, or null once it has. */
function left(expiresAt: string, now: number): string | null {
  const ms = Date.parse(expiresAt) - now;
  if (!(ms > 0)) return null;
  const s = Math.ceil(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * Pair another device: a code that works once, for 10 minutes, shown as text to type, a QR code for the iPhone or
 * iPad camera, and links. Nothing shown here works after that, so a photo of the screen is harmless later.
 */
export function PairDevice({ defaultName = "iPhone" }: { defaultName?: string }) {
  const [name, setName] = useState(defaultName);
  const [links, setLinks] = useState<PairingLinks | null>(null);
  const [qr, setQr] = useState("");
  const [now, setNow] = useState(Date.now());
  const [msg, setMsg] = useState<Msg>(null);
  /** The devices the hub had when the code was made, to tell the new one when it pairs. */
  const known = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!links) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [links]);
  const remaining = links?.expires_at ? left(links.expires_at, now) : null;
  const showing = !!links && !!remaining;
  // While a code shows, ask the hub for its devices, so this page says when the new one has paired (the code is
  // used up then, so it goes away) instead of leaving the person to guess.
  useEffect(() => {
    if (!showing) return;
    let stop = false;
    const t = setInterval(() => {
      void engine.client?.devices().then((r) => {
        if (stop) return;
        if (!known.current) { known.current = new Set(r.devices.map((d) => d.id)); return; }
        const d = newlyPaired(known.current, r.devices);
        if (!d) return;
        known.current = new Set(r.devices.map((x) => x.id));
        setLinks(null);
        setQr("");
        setMsg({ ok: true, text: `${d.name} is paired.` });
        devicesChanged();
      }).catch(() => undefined);
    }, PAIRED_POLL_MS);
    return () => { stop = true; clearInterval(t); };
  }, [showing]);
  const make = async () => {
    setMsg(null);
    try {
      known.current = await engine.client!.devices().then((r) => new Set(r.devices.map((d) => d.id)), () => null);
      const l = await engine.client!.pairing(name.trim());
      setLinks(l);
      setNow(Date.now());
      setQr(await QRCode.toDataURL(l.app, { margin: 1, width: 240 }));
    } catch (e) { setMsg({ ok: false, text: errorText(e) }); }
  };
  const onPhone =/iPhone|Android/i.test(navigator.userAgent);
  return (
    <div className="col">
      <form className="row" onSubmit={(e) => { e.preventDefault(); void make(); }}>
        <input className="grow" value={name} onChange={(e) => setName(e.target.value)} placeholder="Device name" aria-label="Device name" />
        <button type="submit" className="primary" disabled={!name.trim()}>{links ? "Make another code" : "Make a pairing code"}</button>
      </form>
      {links && remaining && (
        <div className="row wrap" style={{ alignItems: "flex-start" }}>
          {qr && <img src={qr} width={240} height={240} alt="Pairing code for the Aeneas app" style={{ background: "#fff", borderRadius: 8 }} />}
          <div className="col small">
            <div style={{ fontFamily: "ui-monospace, monospace", fontSize: "2rem", letterSpacing: "0.12em" }} aria-label="Pairing code">{links.code}</div>
            <div>Works once, for {remaining} more. {links.link === "direct"
              ? `On a new phone, scan the QR code with the camera. With Direct link the code alone isn't enough: the QR code or link carries this hub's key. It needs Aeneas ${DIRECT_LINK_MIN_APP} or newer there: if scanning does nothing, update the app first.`
              : `On the new device, scan the QR code with the camera, or open Aeneas and type the code with the hub address ${links.hub}.`}</div>
            {links.link === "direct" && <div>A computer or tablet with the Aeneas app joins without this code: open Aeneas on it and point {onPhone ? "this phone's Camera" : "the Camera of a phone that already uses Aeneas"} at the code it shows. If it shows no code, update Aeneas on it, or copy the app link below and paste it into Aeneas's hub address field there.</div>}
            {isMacBrowser(navigator.userAgent, isTauri) && <a href={links.app}>Open in the app on this Mac</a>}
            <button type="button" className="ghost small" onClick={() => void navigator.clipboard.writeText(links.app).then(() => setMsg({ ok: true, text: "App link copied. Paste it into Aeneas on the new device. It works once, for 10 minutes." }))}>Copy the app link</button>
            {links.link !== "direct" && <button type="button" className="ghost small" onClick={() => void navigator.clipboard.writeText(links.web).then(() => setMsg({ ok: true, text: "Web link copied. It works once, for 10 minutes." }))}>Copy the web link</button>}
            <button type="button" className="ghost small" onClick={() => { setLinks(null); setQr(""); }}>Hide</button>
          </div>
        </div>
      )}
      {links && !remaining && <div className="muted small">That code has expired. Make another when the device is ready.</div>}
      {msg && <div className={msg.ok ? "ok small" : "error small"}>{msg.text}</div>}
    </div>
  );
}

/** Every paired device, each removable on its own: its key stops working at once. */
export function DevicesList() {
  const [list, setList] = useState<DeviceRow[] | null>(null);
  const [msg, setMsg] = useState<Msg>(null);
  const [busy, setBusy] = useState("");
  const load = () => void engine.client?.devices().then((r) => setList(r.devices)).catch((e) => setMsg({ ok: false, text: errorText(e) }));
  const ready = useHubReady();
  useEffect(load, [ready]);
  useEffect(() => { listeners.add(load); return () => { listeners.delete(load); }; });
  const remove = async (d: DeviceRow) => {
    const what = d.current ? "Remove this device? It signs out and needs a new pairing code to come back." : `Remove ${d.name}? Its key stops working at once; it needs a new pairing code to come back.`;
    if (!window.confirm(what)) return;
    setBusy(d.id);
    try { await engine.client!.removeDevice(d.id); if (!d.current) load(); else await engine.cycle(); } catch (e) { setMsg({ ok: false, text: errorText(e) }); } finally { setBusy(""); }
  };
  // Another device's Windows or Android app behind the hub: it installs the update the next time it reaches the hub.
  const update = async (d: DeviceRow) => {
    setBusy(d.id);
    try {
      await engine.client!.requestAppUpdates([d.id]);
      setMsg({ ok: true, text: `${d.name} updates the next time it reaches the hub${d.app?.kind === "android" ? " (Android asks there before it installs)" : ""}.` });
      load();
    } catch (e) { setMsg({ ok: false, text: errorText(e) }); } finally { setBusy(""); }
  };
  if (!list) return msg ? <div className="error small">{msg.text}</div> : <div className="muted small">Asking the hub for its devices.</div>;
  return (
    <div className="col">
      {list.map((d) => (
        <div key={d.id} className="row" style={{ alignItems: "center" }}>
          <div className="grow col" style={{ gap: 2 }}>
            <strong>{d.name}{d.current ? " (this device)" : ""}</strong>
            <span className="muted small">
              {d.app?.kind === "android" ? "Android" : platformLabel(d.platform)}{d.last_seen ? `, last seen ${fmtDateTime(d.last_seen)}` : ""}{d.own_key ? "" : ", still on the hub's main key"}
            </span>
            {d.app && <span className="muted small">{appVersionLine(d)}</span>}
          </div>
          {!d.current && d.outlook === "self" && !(d.app_update && !d.app_update.declined_at) && (
            <button type="button" className="small" disabled={busy === d.id} onClick={() => void update(d)}>Update</button>
          )}
          <button type="button" className="ghost small" disabled={busy === d.id} onClick={() => void remove(d)}>{d.current ? "Remove this device" : "Remove"}</button>
        </div>
      ))}
      {!list.length && <div className="muted small">No devices yet.</div>}
      {msg && <div className={msg.ok ? "ok small" : "error small"}>{msg.text}</div>}
    </div>
  );
}

/** "App 1.0.4 (build 202611181809), update asked for" in words, from what the device last told the hub. */
function appVersionLine(d: DeviceRow): string {
  if (!d.app) return "";
  const build = d.app.build ? ` (build ${d.app.build})` : "";
  const ask = d.app_update;
  const state =
    ask && ask.declined_at ? `, update to ${ask.version} put off on the device`
    : ask ? `, update to ${ask.version} asked for`
    : d.outlook === "current" ? ", up to date"
    : d.outlook === "store" ? ", newer one in the App Store or TestFlight"
    : d.outlook === "reload" ? ", reload the page for the newer one"
    : d.outlook === "self" ? ", a newer app is on the hub"
    : "";
  return `App ${d.app.version}${build}${state}`;
}
