import { useEffect, useState, type CSSProperties } from "react";
import { go } from "../../lib/router";
import { useMediaQuery } from "../../lib/useMediaQuery";
import { getFeel, soundHere, updateFeel, useFeel } from "../../feel/store";
import { allAppThemes, appThemeName, classicColors, contrast, resolveAppTheme, themeVars, type ThemeColors } from "../../feel/appTheme";
import { newId, paletteName, type AppTheme, type Appearance, type FeelView } from "../../feel/prefs";
import { SCALE_NAMES, SYNTH_NAMES, THEME_NAMES } from "../../feel/theory";
import { NavRow, Segmented, SubPage } from "./common";

/** One line for each part of the theme, shared by the Settings and Theme menus. */
export function themeSummaries(f: FeelView): { colors: string; taps: string; sounds: string } {
  const shapes = f.shapes.length;
  const images = f.images.filter((i) => i.enabled).length;
  const taps = f.motion
    ? [paletteName(f, f.theme, THEME_NAMES), shapes ? `${shapes} ${shapes === 1 ? "shape" : "shapes"}` : "", images ? `${images} ${images === 1 ? "image" : "images"}` : ""].filter(Boolean).join(", ")
    : "Off";
  const eff = f.effective;
  const sounds = !f.sound ? "Off" : !soundHere(f) ? "Off on this computer" : `${SYNTH_NAMES[f.synth]}, ${eff.key} ${SCALE_NAMES[eff.scale].toLowerCase()}`;
  return { colors: appThemeName(f), taps, sounds };
}

export function ThemeHome() {
  const f = useFeel();
  const s = themeSummaries(f);
  return (
    <SubPage path="/settings/theme">
      <nav className="list" aria-label="Theme">
        <NavRow href="/settings/theme/colors" title="App colors" summary={s.colors} />
        <NavRow href="/settings/theme/taps" title="Tap effects" summary={s.taps} />
        <NavRow href="/settings/theme/sounds" title="Note sounds" summary={s.sounds} />
      </nav>
    </SubPage>
  );
}

/** A small live picture of a theme: the background, a surface card, a line of text and an accent button. */
export function ThemePreview({ t, big }: { t: ThemeColors; big?: boolean }) {
  const v = themeVars(t);
  return (
    <span className={`theme-preview${big ? " big" : ""}`} style={{ background: v["--bg"], color: v["--text"] }} aria-hidden="true">
      <span className="tp-card" style={{ background: v["--surface"], borderColor: v["--border"] }}>
        <span className="tp-line" style={{ background: v["--text"] }} />
        <span className="tp-line short" style={{ background: v["--muted"] }} />
        <span className="tp-btn" style={{ background: v["--accent"], color: v["--accent-text"] }}>
          Aa
        </span>
      </span>
    </span>
  );
}

const APPEARANCE: Array<{ value: Appearance; label: string }> = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

function copyName(name: string): string {
  return `${name.slice(0, 35)} copy`;
}

export function AppColors() {
  const f = useFeel();
  const systemDark = useMediaQuery("(prefers-color-scheme: dark)");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");
  const themes = allAppThemes(f);
  const classic = f.app_theme === "classic";

  const pick = (id: string) => updateFeel({ app_theme: id });
  const saveName = (id: string) => {
    const name = draftName.trim().slice(0, 40);
    setRenaming(null);
    if (!name) return;
    updateFeel({ app_themes: getFeel().app_themes.map((a) => (a.id === id ? { ...a, name } : a)) });
  };
  const duplicate = (a: AppTheme) => {
    const cur = getFeel().app_themes;
    const id = newId(cur.map((x) => x.id));
    updateFeel({ app_themes: [...cur, { ...a, id, name: copyName(a.name) }] });
  };
  const remove = (a: AppTheme) => {
    if (!confirm(`Delete the theme "${a.name}"?`)) return;
    const cur = getFeel();
    const patch: Parameters<typeof updateFeel>[0] = { app_themes: cur.app_themes.filter((x) => x.id !== a.id) };
    if (cur.app_theme === `custom:${a.id}`) patch.app_theme = "classic";
    updateFeel(patch);
  };

  return (
    <SubPage path="/settings/theme/colors">
      <section className="col">
        <h2 className="settings-h">Appearance</h2>
        <Segmented label="Appearance" value={f.appearance} options={APPEARANCE} onChange={(v) => updateFeel({ appearance: v })} />
        <div className="muted small">{classic ? "Classic follows this." : "Used when Classic is chosen."}</div>
      </section>
      <section className="col">
        <div className="row between">
          <h2 className="settings-h">Themes</h2>
          <button type="button" className="small" onClick={() => go("/settings/theme/colors/new")}>
            New theme
          </button>
        </div>
        <div className="theme-grid" role="radiogroup" aria-label="App theme">
          <div className="theme-cell">
            <button type="button" role="radio" aria-checked={classic} className="theme-card" onClick={() => pick("classic")}>
              <ThemePreview t={classicColors(f.appearance, systemDark)} />
              <span className="theme-name">Classic</span>
            </button>
          </div>
          {themes.map((t) => {
            const own = t.custom ? f.app_themes.find((a) => `custom:${a.id}` === t.id) : undefined;
            return (
              <div key={t.id} className="theme-cell">
                {own && renaming === own.id ? (
                  <form
                    className="theme-card renaming"
                    onSubmit={(e) => {
                      e.preventDefault();
                      saveName(own.id);
                    }}
                  >
                    <ThemePreview t={t} />
                    <input autoFocus onFocus={(e) => e.target.select()} value={draftName} maxLength={40} aria-label="Theme name" onChange={(e) => setDraftName(e.target.value)} onBlur={() => saveName(own.id)} onKeyDown={(e) => e.key === "Escape" && setRenaming(null)} />
                  </form>
                ) : (
                  <button type="button" role="radio" aria-checked={f.app_theme === t.id} className="theme-card" onClick={() => pick(t.id)}>
                    <ThemePreview t={t} />
                    <span className="theme-name">{t.name}</span>
                  </button>
                )}
                {own && renaming !== own.id && (
                  <div className="theme-actions">
                    <button type="button" className="ghost small" onClick={() => go(`/settings/theme/colors/${own.id}`)}>
                      Edit
                    </button>
                    <button
                      type="button"
                      className="ghost small"
                      onClick={() => {
                        setDraftName(own.name);
                        setRenaming(own.id);
                      }}
                    >
                      Rename
                    </button>
                    <button type="button" className="ghost small" onClick={() => duplicate(own)}>
                      Duplicate
                    </button>
                    <button type="button" className="ghost small danger" onClick={() => remove(own)}>
                      Delete
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>
    </SubPage>
  );
}

const COLOR_FIELDS: Array<{ key: "accent" | "background" | "surface" | "text"; label: string }> = [
  { key: "accent", label: "Accent" },
  { key: "background", label: "Background" },
  { key: "surface", label: "Cards" },
  { key: "text", label: "Text" },
];

/** Make or change a saved app theme. `id` is a saved theme's id, or "new" to start from the theme in use. */
export function AppThemeEditor({ id }: { id: string }) {
  const f = useFeel();
  const systemDark = useMediaQuery("(prefers-color-scheme: dark)");
  const existing = f.app_themes.find((a) => a.id === id);
  const [draft, setDraft] = useState<Omit<AppTheme, "id"> | null>(null);

  useEffect(() => {
    if (draft) return;
    if (existing) setDraft({ ...existing });
    else if (id === "new") {
      const base = resolveAppTheme(f) ?? { ...classicColors(f.appearance, systemDark), name: "Classic" };
      setDraft({ name: "My theme", mode: base.mode, accent: base.accent.toUpperCase(), background: base.background.toUpperCase(), surface: base.surface.toUpperCase(), text: base.text.toUpperCase() });
    }
  }, [existing, id, draft, f, systemDark]);

  if (!draft) {
    return (
      <SubPage path="/settings/theme/colors/edit" title="Theme">
        <div className="muted">That theme no longer exists.</div>
      </SubPage>
    );
  }

  const edit = (patch: Partial<Omit<AppTheme, "id">>) => setDraft((d) => (d ? { ...d, ...patch } : d));
  const readable = contrast(draft.text, draft.background) >= 4.5 && contrast(draft.text, draft.surface) >= 4.5;
  const name = draft.name.trim().slice(0, 40);
  const save = () => {
    const cur = getFeel().app_themes;
    if (existing) {
      updateFeel({ app_themes: cur.map((a) => (a.id === existing.id ? { ...draft, name, id: existing.id } : a)) });
    } else {
      const nid = newId(cur.map((a) => a.id));
      updateFeel({ app_themes: [...cur, { ...draft, name, id: nid }], app_theme: `custom:${nid}` });
    }
    go("/settings/theme/colors");
  };

  return (
    <SubPage path="/settings/theme/colors/edit" title={existing ? `Edit ${existing.name}` : "New theme"}>
      <div className="editor-layout">
        <div className="col">
          <div>
            <label htmlFor="at-name">Name</label>
            <input id="at-name" value={draft.name} maxLength={40} onChange={(e) => edit({ name: e.target.value })} />
          </div>
          <div>
            <label>Mode</label>
            <Segmented
              label="Mode"
              value={draft.mode}
              options={[
                { value: "light", label: "Light" },
                { value: "dark", label: "Dark" },
              ]}
              onChange={(mode) => edit({ mode })}
            />
          </div>
          <div className="color-fields">
            {COLOR_FIELDS.map((c) => (
              <label key={c.key} className="color-field">
                <input type="color" value={draft[c.key].toLowerCase()} onChange={(e) => edit({ [c.key]: e.target.value.toUpperCase() })} />
                <span>
                  <span className="cf-name">{c.label}</span>
                  <span className="mono small muted">{draft[c.key].toUpperCase()}</span>
                </span>
              </label>
            ))}
          </div>
          {!readable && <div className="error">Text and background are close in brightness, so words may be hard to read.</div>}
        </div>
        <ThemeLivePreview t={draft} name={name || "Theme"} />
      </div>
      <div className="row">
        <button type="button" className="primary" disabled={!name} onClick={save}>
          {existing ? "Save" : "Save and use"}
        </button>
        <button type="button" onClick={() => go("/settings/theme/colors")}>
          Cancel
        </button>
      </div>
    </SubPage>
  );
}

/** A piece of the app drawn in the draft's colors, using the real styles with the variables set on this box only. */
function ThemeLivePreview({ t, name }: { t: ThemeColors; name: string }) {
  const { "color-scheme": colorScheme, ...vars } = themeVars(t);
  const style = { ...vars, colorScheme } as unknown as CSSProperties;
  return (
    <div className="live-preview" style={{ ...style, background: "var(--bg)", color: "var(--text)" }} aria-label="Preview">
      <div className="card col" style={{ margin: 0 }}>
        <strong>{name}</strong>
        <div className="small">Plan the day, then one thing at a time.</div>
        <div className="muted small">Muted words read like this.</div>
        <div className="item" style={{ alignItems: "center" }}>
          <span className="body">Water the basil</span>
          <span className="badge">2</span>
        </div>
        <div className="row">
          <button type="button" className="primary" tabIndex={-1}>
            Done
          </button>
          <button type="button" tabIndex={-1}>
            Later
          </button>
          <span style={{ color: "var(--accent)" }}>A link</span>
        </div>
      </div>
    </div>
  );
}
