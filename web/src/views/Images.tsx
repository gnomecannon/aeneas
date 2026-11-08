import { useEffect, useMemo, useState } from "react";
import { engine } from "../sync/engine";
import { HubError, type ImageCapabilities, type ImageJob, type ImagePlan, type ImageRequest } from "../sync/api";
import { HubImage } from "./Assistant";
import { workerLabel, workersOf } from "../lib/imageWorkers";

const ASPECTS = ["1:1", "4:3", "3:2", "16:9", "9:16", "3:4", "2:3"];
const active = (j: ImageJob) => j.status === "queued" || j.status === "running";

/**
 * Make and edit images on the local GPUs through the shared image service. The plan shows the exact size, model and
 * where it will run before anything starts; nothing runs until Generate.
 */
export function Images() {
  const [caps, setCaps] = useState<ImageCapabilities | null>(null);
  const [prompt, setPrompt] = useState("");
  const [aspect, setAspect] = useState("1:1");
  const [exact, setExact] = useState(false);
  const [w, setW] = useState(1024);
  const [h, setH] = useState(1024);
  const [lock, setLock] = useState(true);
  const [style, setStyle] = useState(false);
  const [realism, setRealism] = useState(50);
  const [quality, setQuality] = useState<"auto" | "fast" | "best">("auto");
  const [hardware, setHardware] = useState("auto");
  const [count, setCount] = useState(1);
  const [seamless, setSeamless] = useState<"off" | "x" | "y" | "xy">("off");
  const [transparent, setTransparent] = useState(false);
  const [seed, setSeed] = useState("");
  const [exactPrompt, setExactPrompt] = useState(false);
  const [plan, setPlan] = useState<ImagePlan | null>(null);
  const [planErr, setPlanErr] = useState("");
  const [jobs, setJobs] = useState<ImageJob[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  // A reference handed over by the gallery's "Use as reference".
  const [ref, setRef] = useState<string | null>(() => sessionStorage.getItem("ea.imageRef"));

  const request = useMemo<ImageRequest>(() => ({
    prompt: prompt.trim(),
    ...(ref ? { operation: "edit" as const, references: [ref] } : {}),
    ...(exact ? { width: w, height: h } : ref ? { aspect: "match_source" } : { aspect }),
    ...(style ? { realism } : {}),
    ...(quality !== "auto" ? { quality } : {}),
    ...(hardware !== "auto" ? { hardware } : {}),
    ...(count > 1 ? { count } : {}),
    ...(seamless !== "off" ? { seamless } : {}),
    ...(transparent ? { transparent } : {}),
    ...(seed.trim() && Number.isInteger(Number(seed)) ? { seed: Number(seed) } : {}),
    ...(exactPrompt ? { exact_prompt: true } : {}),
  }), [ref, prompt, exact, w, h, aspect, style, realism, quality, hardware, count, seamless, transparent, seed, exactPrompt]);
  const key = JSON.stringify(request);

  useEffect(() => {
    const c = engine.client;
    if (!c) return;
    c.imageCapabilities().then((x) => { setCaps(x); if (x.enabled) c.imageJobs().then(setJobs, () => undefined); }, () => setCaps({ enabled: false }));
  }, []);

  // The plan follows the controls after a short pause; nothing is generated until Generate.
  useEffect(() => {
    const c = engine.client;
    if (!c || !request.prompt || !caps?.enabled) { setPlan(null); setPlanErr(""); return; }
    const t = setTimeout(() => {
      c.imagePlan(request).then((p) => { setPlan(p); setPlanErr(""); }, (e) => { setPlan(null); setPlanErr(e instanceof HubError ? e.message : String(e)); });
    }, 600);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, caps?.enabled]);

  const running = jobs.filter((j) => active(j) || (j.status === "succeeded" && !j.image_id)).map((j) => j.id).join(",");
  useEffect(() => {
    const c = engine.client;
    if (!c || !running) return;
    const t = setInterval(() => {
      for (const id of running.split(",")) c.imageJob(id).then((f) => setJobs((js) => js.map((j) => (j.id === id ? f : j))), () => undefined);
    }, 3000);
    return () => clearInterval(t);
  }, [running]);

  const generate = async () => {
    const c = engine.client;
    if (!c) return;
    setBusy(true); setErr("");
    try { const made = await c.imageSubmit(request); setJobs((js) => [...made, ...js]); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    setBusy(false);
  };
  const reuse = (j: ImageJob) => {
    const r = j.request;
    if (!r) return;
    setPrompt(r.prompt);
    if (r.width && r.height) { setExact(true); setW(r.width); setH(r.height); } else { setExact(false); setAspect(r.aspect ?? "1:1"); }
    if (typeof r.realism === "number") { setStyle(true); setRealism(r.realism); } else setStyle(false);
    setQuality(r.quality ?? "auto"); setHardware(r.hardware ?? "auto"); setSeamless(r.seamless ?? "off"); setTransparent(!!r.transparent);
    setCount(1); setExactPrompt(!!r.exact_prompt); setSeed(j.plan.seed != null ? String(j.plan.seed) : "");
  };
  const setWidth = (v: number) => { if (lock && w > 0) setH(Math.max(1, Math.round((h * v) / w))); setW(v); };

  return (
    <div className="col">
      <h1>{ref ? "New image from a picture" : "Create image"}</h1>
      {ref && (
        <div className="row">
          <HubImage id={ref} />
          <button type="button" className="small" onClick={() => { sessionStorage.removeItem("ea.imageRef"); setRef(null); }}>Remove reference</button>
        </div>
      )}
      {caps && !caps.enabled && <p className="muted">Image generation is not set up on the hub.</p>}
      <label className="col">Describe it
        <textarea rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="A sea cliff with a waterfall, no vegetation" />
      </label>
      {!ref && <fieldset className="col">
        <legend>Size</legend>
        <label><input type="checkbox" checked={exact} onChange={(e) => setExact(e.target.checked)} /> Exact size in pixels</label>
        {exact ? (
          <div className="row wrap">
            <input type="number" aria-label="Width" value={w} min={64} max={4096} onChange={(e) => setWidth(Number(e.target.value))} />
            <span>x</span>
            <input type="number" aria-label="Height" value={h} min={64} max={4096} onChange={(e) => setH(Number(e.target.value))} />
            <button type="button" className="small" onClick={() => { setW(h); setH(w); }} aria-label="Swap width and height">Swap</button>
            <label><input type="checkbox" checked={lock} onChange={(e) => setLock(e.target.checked)} /> Keep ratio</label>
          </div>
        ) : (
          <label>Aspect ratio <select value={aspect} onChange={(e) => setAspect(e.target.value)}>{ASPECTS.map((a) => <option key={a}>{a}</option>)}</select></label>
        )}
      </fieldset>}
      <fieldset className="col">
        <legend>Style</legend>
        <label><input type="checkbox" checked={style} onChange={(e) => setStyle(e.target.checked)} /> Set the visual style (otherwise from the prompt)</label>
        {style && (
          <label className="row" style={{ alignItems: "center", gap: 8 }}>Stylized
            <input type="range" style={{ flex: 1 }} min={0} max={100} value={realism} onChange={(e) => setRealism(Number(e.target.value))}
              aria-valuetext={realism < 34 ? "Stylized" : realism < 67 ? "Naturalistic" : "Photographic"} aria-label="Visual realism" />
            Photographic</label>
        )}
      </fieldset>
      <div className="row wrap">
        <label>Quality <select value={quality} onChange={(e) => setQuality(e.target.value as typeof quality)}><option value="auto">Auto</option><option value="fast">Fast</option><option value="best">Best practical</option></select></label>
      </div>
      <details>
        <summary>More options</summary>
        <div className="row wrap">
          <label>Hardware <select value={hardware} onChange={(e) => setHardware(e.target.value)}><option value="auto">Auto (protect gameplay)</option>{workersOf(caps).map((wk) => <option key={wk.id} value={wk.id}>{wk.label} only</option>)}</select></label>
          <label>Images <input type="number" min={1} max={4} value={count} onChange={(e) => setCount(Math.min(4, Math.max(1, Number(e.target.value))))} /></label>
          <label>Repeat seamlessly <select value={seamless} onChange={(e) => setSeamless(e.target.value as typeof seamless)}><option value="off">Off</option><option value="x">Horizontal</option><option value="y">Vertical</option><option value="xy">Both</option></select></label>
          <label><input type="checkbox" checked={transparent} onChange={(e) => setTransparent(e.target.checked)} /> Transparent background</label>
          <label>Seed <input value={seed} onChange={(e) => setSeed(e.target.value)} placeholder="random" inputMode="numeric" /></label>
          <label><input type="checkbox" checked={exactPrompt} onChange={(e) => setExactPrompt(e.target.checked)} /> Use my prompt exactly</label>
        </div>
      </details>
      <div className="card col" aria-live="polite">
        <strong>Plan</strong>
        {!request.prompt ? <span className="muted">Write a prompt to see the plan.</span>
          : planErr ? <span className="warn">{planErr}</span>
          : plan ? (
            <>
              <span>{plan.output.width} x {plan.output.height} PNG</span>
              {plan.generation && (plan.generation.width !== plan.output.width || plan.generation.height !== plan.output.height) && <span className="small muted">Generated at {plan.generation.width} x {plan.generation.height}, cropped to fit</span>}
              <span className="small muted">{plan.routing_reason}</span>
              {plan.notes.map((n) => <span key={n} className="small muted">{n}</span>)}
              {plan.prompt_adapted && <span className="small muted">Prompt sent: {plan.prompt_expanded}</span>}
              {plan.queue_reason && <span className="small warn">Would wait: {plan.queue_reason}</span>}
            </>
          ) : <span className="muted">Planning</span>}
        <button className="primary" type="button" onClick={generate} disabled={busy || !plan || !!planErr || !caps?.enabled}>{busy ? "Sending" : "Generate"}</button>
        {err && <span className="warn">{err}</span>}
      </div>
      {jobs.length > 0 && <h2>Results <a className="small" href="#/gallery">Image Gallery</a></h2>}
      {jobs.map((j) => (
        <div key={j.id} className="card col">
          <span>{j.plan.prompt_original}</span>
          <span className="small muted">{j.status_label} · {j.plan.output.width} x {j.plan.output.height}{j.measured?.total_seconds ? ` · ${Math.round(j.measured.total_seconds)} s on ${workerLabel(workersOf(caps), j.measured.worker ?? "")}` : ""}</span>
          {j.status === "running" && <progress value={j.progress ?? 0} max={1} />}
          {j.error && <span className="warn small">{j.error}</span>}
          {j.image_id && <HubImage id={j.image_id} />}
          <div className="row">
            {active(j) && <button type="button" className="small" onClick={() => engine.client?.imageCancel(j.id).then(() => engine.client!.imageJob(j.id)).then((f) => setJobs((js) => js.map((x) => (x.id === j.id ? f : x))))}>Cancel</button>}
            <button type="button" className="small" onClick={() => reuse(j)}>Reuse settings</button>
          </div>
        </div>
      ))}
    </div>
  );
}
