import { useEffect, useState } from "react";
import QRCode from "qrcode";
import type { DeviceRow, PairingLinks } from "../../sync/api";
import { engine } from "../../sync/engine";
import { fmtDateTime } from "../../lib/time";
import { errorText } from "./common";

type Msg = { ok: boolean; text: string } | null;

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
  useEffect(() => {
    if (!links) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [links]);
  const make = async () => {
    setMsg(null);
    try {
      const l = await engine.client!.pairing(name.trim());
      setLinks(l);
      setNow(Date.now());
      setQr(await QRCode.toDataURL(l.app, { margin: 1, width: 240 }));
    } catch (e) { setMsg({ ok: false, text: errorText(e) }); }
  };
  const remaining = links?.expires_at ? left(links.expires_at, now) : null;
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
            <div>Works once, for {remaining} more. On the new device, scan the QR code with the camera, or open Aeneas and type the code with the hub address {links.hub}.</div>
            <a href={links.app}>Open in the app on this Mac</a>
            <button type="button" className="ghost small" onClick={() => void navigator.clipboard.writeText(links.web).then(() => setMsg({ ok: true, text: "Web link copied. It works once, for 10 minutes." }))}>Copy the web link</button>
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
  useEffect(load, []);
  const remove = async (d: DeviceRow) => {
    const what = d.current ? "Remove this device? It signs out and needs a new pairing code to come back." : `Remove ${d.name}? Its key stops working at once; it needs a new pairing code to come back.`;
    if (!window.confirm(what)) return;
    setBusy(d.id);
    try { await engine.client!.removeDevice(d.id); if (!d.current) load(); else await engine.cycle(); } catch (e) { setMsg({ ok: false, text: errorText(e) }); } finally { setBusy(""); }
  };
  if (!list) return msg ? <div className="error small">{msg.text}</div> : <div className="muted small">Asking the hub for its devices.</div>;
  return (
    <div className="col">
      {list.map((d) => (
        <div key={d.id} className="row" style={{ alignItems: "center" }}>
          <div className="grow col" style={{ gap: 2 }}>
            <strong>{d.name}{d.current ? " (this device)" : ""}</strong>
            <span className="muted small">
              {d.platform}{d.last_seen ? `, last seen ${fmtDateTime(d.last_seen)}` : ""}{d.own_key ? "" : ", still on the hub's main key"}
            </span>
          </div>
          <button type="button" className="ghost small" disabled={busy === d.id} onClick={() => void remove(d)}>{d.current ? "Remove this device" : "Remove"}</button>
        </div>
      ))}
      {!list.length && <div className="muted small">No devices yet.</div>}
      {msg && <div className={msg.ok ? "ok small" : "error small"}>{msg.text}</div>}
    </div>
  );
}
