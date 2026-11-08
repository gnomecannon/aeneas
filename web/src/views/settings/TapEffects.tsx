import { useEffect, useRef, useState } from "react";
import { go } from "../../lib/router";
import { addFeelImage, getFeel, removeFeelImage, updateFeel, useFeel } from "../../feel/store";
import { burstStyle, playCelebration } from "../../feel/FeelLayer";
import { ShapeLayer, paintShape } from "../../feel/shapes";
import { forgetImage, shrinkImage, useImageUrl } from "../../feel/images";
import { MAX_IMAGES, MAX_PALETTE_COLORS, MAX_PALETTES, newId, type FeelView, type ImageShape, type Palette } from "../../feel/prefs";
import { SHAPES, SHAPE_NAMES, THEMES, THEME_COLORS, THEME_NAMES, monoColors, themeColors, type ShapeName } from "../../feel/theory";
import { SubPage, Toggle, errorText } from "./common";

function accent(): string {
  return typeof document !== "undefined" ? getComputedStyle(document.documentElement).getPropertyValue("--accent") : "";
}

function Swatches({ colors }: { colors: string[] }) {
  return (
    <span className="swatches" aria-hidden="true">
      {colors.map((c, i) => (
        <span key={i} style={{ background: c }} />
      ))}
    </span>
  );
}

/** Shapes are on when any shape or image is: the last one cannot be turned off. */
function enabledCount(f: FeelView): number {
  return f.shapes.length + f.images.filter((i) => i.enabled).length;
}

export function TapEffects() {
  const f = useFeel();
  const ac = accent();
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");

  const saveName = (id: string) => {
    const name = draftName.trim().slice(0, 40);
    setRenaming(null);
    if (name) updateFeel({ palettes: getFeel().palettes.map((p) => (p.id === id ? { ...p, name } : p)) });
  };
  const duplicate = (p: Palette) => {
    const cur = getFeel().palettes;
    if (cur.length >= MAX_PALETTES) return alert(`${MAX_PALETTES} palettes at most; delete one first.`);
    const id = newId(cur.map((x) => x.id));
    updateFeel({ palettes: [...cur, { ...p, id, name: `${p.name.slice(0, 35)} copy` }] });
  };
  const remove = (p: Palette) => {
    if (!confirm(`Delete the palette "${p.name}"?`)) return;
    const cur = getFeel();
    const patch: Parameters<typeof updateFeel>[0] = { palettes: cur.palettes.filter((x) => x.id !== p.id) };
    if (cur.theme === `custom:${p.id}`) patch.theme = "aurora";
    updateFeel(patch);
  };

  return (
    <SubPage path="/settings/theme/taps">
      <Toggle checked={f.motion} onChange={(motion) => updateFeel({ motion })} label="Shapes on taps and new things" />

      <section className="col">
        <div className="row between">
          <h2 className="settings-h">Colors</h2>
          <button type="button" className="small" onClick={() => go("/settings/theme/taps/new")} disabled={f.palettes.length >= MAX_PALETTES}>
            New palette
          </button>
        </div>
        <div className="list palette-list" role="radiogroup" aria-label="Shape colors">
          {THEMES.map((t) => (
            <div key={t} className="item palette-row">
              <button type="button" role="radio" aria-checked={f.theme === t} className="palette-pick" onClick={() => updateFeel({ theme: t })}>
                <span className="radio-dot" aria-hidden="true" />
                <span className="palette-name">{THEME_NAMES[t]}</span>
                <Swatches colors={t === "mono" ? monoColors(ac) : THEME_COLORS[t as keyof typeof THEME_COLORS]} />
              </button>
              <span className="palette-actions">
                <button type="button" className="ghost small" onClick={() => go(`/settings/theme/taps/new?from=${t}`)}>
                  Customize
                </button>
              </span>
            </div>
          ))}
          {f.palettes.map((p) => (
            <div key={p.id} className="item palette-row">
              {renaming === p.id ? (
                <form
                  className="palette-pick"
                  onSubmit={(e) => {
                    e.preventDefault();
                    saveName(p.id);
                  }}
                >
                  <input autoFocus onFocus={(e) => e.target.select()} value={draftName} maxLength={40} aria-label="Palette name" onChange={(e) => setDraftName(e.target.value)} onBlur={() => saveName(p.id)} onKeyDown={(e) => e.key === "Escape" && setRenaming(null)} />
                </form>
              ) : (
                <button type="button" role="radio" aria-checked={f.theme === `custom:${p.id}`} className="palette-pick" onClick={() => updateFeel({ theme: `custom:${p.id}` })}>
                  <span className="radio-dot" aria-hidden="true" />
                  <span className="palette-name">{p.name}</span>
                  <Swatches colors={p.colors} />
                </button>
              )}
              <span className="palette-actions">
                <button type="button" className="ghost small" onClick={() => go(`/settings/theme/taps/${p.id}`)}>
                  Edit
                </button>
                <button
                  type="button"
                  className="ghost small"
                  onClick={() => {
                    setDraftName(p.name);
                    setRenaming(p.id);
                  }}
                >
                  Rename
                </button>
                <button type="button" className="ghost small" onClick={() => duplicate(p)}>
                  Duplicate
                </button>
                <button type="button" className="ghost small danger" onClick={() => remove(p)}>
                  Delete
                </button>
              </span>
            </div>
          ))}
        </div>
      </section>

      <section className="col">
        <h2 className="settings-h">Shapes</h2>
        <ShapeGrid f={f} colors={themeColors(f.theme, f.palettes, ac)} />
      </section>

      <ImagesSection f={f} />

      <section className="col">
        <h2 className="settings-h">Size and amount</h2>
        <div className="slider-grid">
          <div>
            <label htmlFor="fx-size">Size {Math.round(f.shape_size * 100)}%</label>
            <input id="fx-size" type="range" min={0.5} max={2} step={0.1} value={f.shape_size} onChange={(e) => updateFeel({ shape_size: Number(e.target.value) }, 400)} />
          </div>
          <div>
            <label htmlFor="fx-density">Amount {Math.round(f.density * 100)}%</label>
            <input id="fx-density" type="range" min={0.5} max={2} step={0.1} value={f.density} onChange={(e) => updateFeel({ density: Number(e.target.value) }, 400)} />
          </div>
        </div>
        <div className="row">
          <button type="button" onClick={() => playCelebration("create")}>
            Show a burst
          </button>
        </div>
      </section>
    </SubPage>
  );
}

/** The eight shapes drawn as they will appear, each turned on or off. */
function ShapeGrid({ f, colors }: { f: FeelView; colors: string[] }) {
  const last = enabledCount(f) <= 1;
  const toggle = (s: ShapeName) => {
    const on = f.shapes.includes(s);
    if (on && last) return;
    updateFeel({ shapes: on ? f.shapes.filter((x) => x !== s) : SHAPES.filter((x) => x === s || f.shapes.includes(x)) });
  };
  return (
    <div className="shape-grid">
      {SHAPES.map((s, i) => {
        const on = f.shapes.includes(s);
        return (
          <button key={s} type="button" className="shape-tile" aria-pressed={on} disabled={on && last} title={on && last ? "Keep at least one shape or image on" : undefined} onClick={() => toggle(s)}>
            <ShapeIcon kind={s} color={colors[i % colors.length] ?? "#7C5CFF"} />
            <span className="small">{SHAPE_NAMES[s]}</span>
          </button>
        );
      })}
    </div>
  );
}

function ShapeIcon({ kind, color }: { kind: ShapeName; color: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    const g = c?.getContext("2d");
    if (!c || !g) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = 40 * dpr;
    c.height = 40 * dpr;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, 40, 40);
    g.translate(20, 20);
    paintShape(g, kind, 11, color, true);
  }, [kind, color]);
  return <canvas ref={ref} className="shape-icon" width={40} height={40} aria-hidden="true" />;
}

function ImagesSection({ f }: { f: FeelView }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  const add = async (file: File) => {
    setBusy(true);
    setMsg("");
    try {
      const png = await shrinkImage(file, 256);
      const name = file.name.replace(/\.[^.]+$/, "").trim().slice(0, 40) || "Image";
      await addFeelImage(png, name);
    } catch (e) {
      setMsg(errorText(e));
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  };

  return (
    <section className="col">
      <div className="row between">
        <h2 className="settings-h">Images</h2>
        <button type="button" className="small" disabled={busy || f.images.length >= MAX_IMAGES} onClick={() => input.current?.click()}>
          {busy ? "Adding" : "Add image"}
        </button>
        <input ref={input} type="file" accept="image/png,image/webp,image/*" hidden onChange={(e) => e.target.files?.[0] && void add(e.target.files[0])} />
      </div>
      <div className="muted small">Images with transparent backgrounds look best.</div>
      {msg && (
        <div className="error" role="status">
          {msg}
        </div>
      )}
      {f.images.length > 0 && (
        <div className="list">
          {f.images.map((img) => (
            <ImageRow key={img.id} img={img} f={f} onError={setMsg} />
          ))}
        </div>
      )}
    </section>
  );
}

function ImageRow({ img, f, onError }: { img: ImageShape; f: FeelView; onError: (m: string) => void }) {
  const url = useImageUrl(img.id);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(img.name);
  const last = img.enabled && enabledCount(f) <= 1;
  const patch = (p: Partial<ImageShape>) => updateFeel({ images: getFeel().images.map((x) => (x.id === img.id ? { ...x, ...p } : x)) });
  const saveName = () => {
    setRenaming(false);
    const n = name.trim().slice(0, 40);
    if (n && n !== img.name) patch({ name: n });
  };
  const remove = async () => {
    if (!confirm(`Delete the image "${img.name}"?`)) return;
    try {
      await removeFeelImage(img.id);
      forgetImage(img.id);
    } catch (e) {
      onError(errorText(e));
    }
  };
  return (
    <div className="item image-row">
      <span className="checker">{url ? <img src={url} alt="" /> : <span className="muted small">...</span>}</span>
      <span className="body">
        {renaming ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              saveName();
            }}
          >
            <input autoFocus onFocus={(e) => e.target.select()} value={name} maxLength={40} aria-label="Image name" onChange={(e) => setName(e.target.value)} onBlur={saveName} onKeyDown={(e) => e.key === "Escape" && setRenaming(false)} />
          </form>
        ) : (
          <span className="t">{img.name}</span>
        )}
        <label className="toggle-row small-toggle">
          <input type="checkbox" checked={img.enabled} disabled={last} onChange={(e) => patch({ enabled: e.target.checked })} />
          <span>{img.enabled ? "On" : "Off"}</span>
        </label>
      </span>
      <span className="palette-actions">
        {!renaming && (
          <button
            type="button"
            className="ghost small"
            onClick={() => {
              setName(img.name);
              setRenaming(true);
            }}
          >
            Rename
          </button>
        )}
        <button type="button" className="ghost small danger" onClick={() => void remove()}>
          Delete
        </button>
      </span>
    </div>
  );
}

/** Make or change a saved palette. `id` is a saved palette's id, or "new" (copying `from`, a built-in or saved one). */
export function PaletteEditor({ id, from }: { id: string; from: string | null }) {
  const f = useFeel();
  const existing = f.palettes.find((p) => p.id === id);
  const [draft, setDraft] = useState<{ name: string; colors: string[] } | null>(null);
  const [dragFrom, setDragFrom] = useState<number | null>(null);

  useEffect(() => {
    if (draft) return;
    if (existing) setDraft({ name: existing.name, colors: existing.colors.slice() });
    else if (id === "new") {
      const src = from ?? f.theme;
      const base = from && !from.startsWith("custom:") ? THEME_NAMES[from as keyof typeof THEME_NAMES] : f.palettes.find((p) => `custom:${p.id}` === src)?.name;
      const colors = themeColors(src, f.palettes, accent())
        .map((c) => (/^#[0-9a-f]{6}$/i.test(c) ? c.toUpperCase() : null))
        .filter((c): c is string => !!c);
      setDraft({ name: base ? `${base} copy`.slice(0, 40) : "My colors", colors: (colors.length ? colors : THEME_COLORS.aurora).slice(0, MAX_PALETTE_COLORS) });
    }
  }, [existing, id, from, draft, f]);

  if (!draft) {
    return (
      <SubPage path="/settings/theme/taps/edit" title="Palette">
        <div className="muted">That palette no longer exists.</div>
      </SubPage>
    );
  }

  const setColors = (fn: (colors: string[]) => string[]) => setDraft((d) => (d ? { ...d, colors: fn(d.colors) } : d));
  const move = (i: number, j: number) =>
    setColors((cs) => {
      if (j < 0 || j >= cs.length || i === j) return cs;
      const next = cs.slice();
      const [c] = next.splice(i, 1);
      next.splice(j, 0, c);
      return next;
    });
  const name = draft.name.trim().slice(0, 40);
  const save = () => {
    const cur = getFeel().palettes;
    if (existing) {
      updateFeel({ palettes: cur.map((p) => (p.id === existing.id ? { id: p.id, name, colors: draft.colors } : p)) });
    } else {
      const nid = newId(cur.map((p) => p.id));
      updateFeel({ palettes: [...cur, { id: nid, name, colors: draft.colors }], theme: `custom:${nid}` });
    }
    go("/settings/theme/taps");
  };

  return (
    <SubPage path="/settings/theme/taps/edit" title={existing ? `Edit ${existing.name}` : "New palette"}>
      <div>
        <label htmlFor="pal-name">Name</label>
        <input id="pal-name" value={draft.name} maxLength={40} onChange={(e) => {
            const name = e.target.value;
            setDraft((d) => (d ? { ...d, name } : d));
          }} />
      </div>
      <div className="col">
        <label>Colors ({draft.colors.length} of {MAX_PALETTE_COLORS})</label>
        <div className="big-swatches">
          {draft.colors.map((c, i) => (
            <div
              key={i}
              className={`big-swatch${dragFrom === i ? " dragging" : ""}`}
              draggable
              onDragStart={() => setDragFrom(i)}
              onDragEnd={() => setDragFrom(null)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => {
                if (dragFrom !== null) move(dragFrom, i);
                setDragFrom(null);
              }}
            >
              <label className="swatch-face" style={{ background: c }} title="Change color">
                <input
                  type="color"
                  value={c.toLowerCase()}
                  aria-label={`Color ${i + 1}`}
                  onChange={(e) => {
                    const v = e.target.value.toUpperCase();
                    setColors((cs) => cs.map((x, j) => (j === i ? v : x)));
                  }}
                />
              </label>
              <div className="swatch-tools">
                <button type="button" className="ghost small" aria-label={`Move color ${i + 1} earlier`} disabled={i === 0} onClick={() => move(i, i - 1)}>
                  {"←"}
                </button>
                <button type="button" className="ghost small" aria-label={`Remove color ${i + 1}`} disabled={draft.colors.length <= 1} onClick={() => setColors((cs) => (cs.length > 1 ? cs.filter((_, j) => j !== i) : cs))}>
                  {"×"}
                </button>
                <button type="button" className="ghost small" aria-label={`Move color ${i + 1} later`} disabled={i === draft.colors.length - 1} onClick={() => move(i, i + 1)}>
                  {"→"}
                </button>
              </div>
            </div>
          ))}
          {draft.colors.length < MAX_PALETTE_COLORS && (
            <button type="button" className="big-swatch add" onClick={() => setColors((cs) => (cs.length < MAX_PALETTE_COLORS ? [...cs, THEME_COLORS.aurora[cs.length % THEME_COLORS.aurora.length]] : cs))}>
              <span aria-hidden="true">+</span>
              <span className="small">Add color</span>
            </button>
          )}
        </div>
      </div>
      <BurstPreview colors={draft.colors} f={f} />
      <div className="row">
        <button type="button" className="primary" disabled={!name} onClick={save}>
          {existing ? "Save" : "Save and use"}
        </button>
        <button type="button" onClick={() => go("/settings/theme/taps")}>
          Cancel
        </button>
      </div>
    </SubPage>
  );
}

/** A box where a burst in the draft colors goes off on every change, and on a press. */
function BurstPreview({ colors, f }: { colors: string[]; f: FeelView }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const layer = useRef<ShapeLayer | null>(null);
  const key = colors.join(",");

  useEffect(() => {
    if (!ref.current) return;
    layer.current = new ShapeLayer(ref.current, true);
    return () => layer.current?.stop();
  }, []);
  const burst = (x?: number, y?: number) => {
    const c = ref.current;
    if (!c || !layer.current) return;
    layer.current.tap(x ?? c.clientWidth / 2, y ?? c.clientHeight / 2, burstStyle(f, colors));
  };
  useEffect(() => {
    burst();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, f.shapes.join(","), f.shape_size, f.density]);

  return (
    <div className="col">
      <label>Preview</label>
      <canvas
        ref={ref}
        className="burst-preview"
        aria-label="Preview of a burst in these colors"
        onPointerDown={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          burst(e.clientX - r.left, e.clientY - r.top);
        }}
      />
    </div>
  );
}
