import { useEffect, useRef, useState } from "react";
import type { Entity } from "@everythingapp/shared";
import { engine } from "../sync/engine";
import { useEntities } from "../sync/hooks";
import { softDelete } from "../sync/edits";
import { useImageWorkers, workerLabel } from "../lib/imageWorkers";

const navigate = (p: string) => { window.location.hash = p; };

/** Image Gallery: what was created here, and what was attached or added. Click to view and zoom. */

type Bin = "generated" | "saved";
const SOURCES: Record<string, string> = { generated: "Created here", attached: "Attached in a chat", uploaded: "Added", downloaded: "Downloaded", photos: "Photos" };

/** Blob URL for a hub image (the endpoint needs the bearer header). */
function useHubImage(id: string): string {
  const [url, setUrl] = useState("");
  useEffect(() => {
    let u = "";
    let live = true;
    engine.client?.aiImage(id).then((b) => { if (!live) return; u = URL.createObjectURL(b); setUrl(u); }, () => undefined);
    return () => { live = false; if (u) URL.revokeObjectURL(u); };
  }, [id]);
  return url;
}

function Thumb({ e, onOpen }: { e: Entity; onOpen: () => void }) {
  const url = useHubImage(String(e.fields.image_id));
  return (
    <button type="button" className="gallery-thumb" onClick={onOpen} aria-label={String(e.fields.title ?? "Image")}>
      {url ? <img src={url} alt="" loading="lazy" /> : null}
    </button>
  );
}

function Viewer({ e, onClose }: { e: Entity; onClose: () => void }) {
  const url = useHubImage(String(e.fields.image_id));
  const [zoom, setZoom] = useState(false);
  const [info, setInfo] = useState(false);
  const workers = useImageWorkers();
  useEffect(() => {
    const k = (ev: KeyboardEvent) => { if (ev.key === "Escape") onClose(); };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  const f = e.fields as Record<string, unknown>;
  return (
    <div className="lightbox" role="dialog" aria-label="Image">
      <div className={`lightbox-stage${zoom ? " zoomed" : ""}`} onClick={() => setZoom(!zoom)}>
        {url ? <img src={url} alt={String(f.title ?? "")} /> : <span className="muted">Loading</span>}
      </div>
      <div className="lightbox-bar">
        <button type="button" className="small" onClick={() => { sessionStorage.setItem("ea.imageRef", String(f.image_id)); navigate("/images"); }}>Use as reference</button>
        {url && <a className="small button" href={url} download={`${String(f.title ?? "image").slice(0, 40)}.png`}>Download</a>}
        <button type="button" className="small" onClick={() => setInfo(!info)}>Details</button>
        <button type="button" className="small danger" onClick={() => { if (confirm("Delete this image?")) { void softDelete(e); onClose(); } }}>Delete</button>
        <span style={{ flex: 1 }} />
        <button type="button" className="small" onClick={onClose}>Close</button>
      </div>
      {info && (
        <div className="lightbox-info small">
          {f.width ? <div>{String(f.width)} x {String(f.height)}</div> : null}
          <div>{SOURCES[String(f.source)] ?? "Added"}, {new Date(e.created_at).toLocaleString()}</div>
          {f.prompt ? <p>{String(f.prompt)}</p> : null}
          {f.caption ? <p className="muted">{String(f.caption)}</p> : null}
          {f.workflow ? <div className="muted">{String(f.workflow)}{f.worker ? ` on ${workerLabel(workers, String(f.worker))}` : ""}</div> : null}
        </div>
      )}
    </div>
  );
}

export function Gallery() {
  const [bin, setBin] = useState<Bin>("generated");
  const [open, setOpen] = useState<Entity | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const file = useRef<HTMLInputElement>(null);
  const all = useEntities("image");
  const items = all.filter((e) => (bin === "generated") === (e.fields.source === "generated")).sort((a, b) => b.created_at.localeCompare(a.created_at));

  const upload = async (files: FileList | null) => {
    const c = engine.client;
    if (!c || !files?.length) return;
    setBusy(true); setErr("");
    try {
      const made = [];
      for (const f of [...files].filter((x) => x.type.startsWith("image/"))) made.push(await c.uploadImage(f, "uploaded", f.name.replace(/\.[^.]+$/, "")));
      await engine.absorb(made);
      setBin("saved");
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    setBusy(false);
  };

  return (
    <div className="col">
      <div className="row">
        <h1>Image Gallery</h1>
        <span style={{ flex: 1 }} />
        <button type="button" className="primary small" onClick={() => { sessionStorage.removeItem("ea.imageRef"); navigate("/images"); }}>Create image</button>
        <button type="button" className="small" onClick={() => file.current?.click()} disabled={busy}>{busy ? "Adding" : "Add"}</button>
        <input ref={file} type="file" accept="image/*" multiple hidden onChange={(e) => void upload(e.target.files)} />
      </div>
      <div className="segmented" role="tablist">
        <button type="button" role="tab" aria-selected={bin === "generated"} className={bin === "generated" ? "on" : ""} onClick={() => setBin("generated")}>Generated</button>
        <button type="button" role="tab" aria-selected={bin === "saved"} className={bin === "saved" ? "on" : ""} onClick={() => setBin("saved")}>Saved</button>
      </div>
      {err && <span className="warn">{err}</span>}
      {items.length === 0 ? <p className="muted">{bin === "generated" ? "Images you create appear here." : "Pictures you attach or add appear here."}</p> : (
        <div className="gallery-grid">{items.map((e) => <Thumb key={e.id} e={e} onOpen={() => setOpen(e)} />)}</div>
      )}
      {open && <Viewer e={open} onClose={() => setOpen(null)} />}
    </div>
  );
}
