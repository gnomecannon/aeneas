import { describe, expect, it } from "vitest";
import { allAppThemes, appThemeName, classicColors, contrast, resolveAppTheme, themeVars } from "./appTheme";
import { APP_THEMES, DEFAULT_FEEL } from "./prefs";

describe("app themes", () => {
  it("leaves Classic alone", () => {
    expect(resolveAppTheme(DEFAULT_FEEL)).toBeNull();
    expect(appThemeName(DEFAULT_FEEL)).toBe("Classic");
    expect(appThemeName({ ...DEFAULT_FEEL, appearance: "dark" })).toBe("Classic, dark");
    expect(classicColors("system", true).background).toBe("#17181b");
    expect(classicColors("light", true).background).toBe("#f5f4f1");
  });

  it("matches the hub's built-in colors", () => {
    expect(APP_THEMES.find((a) => a.id === "midnight")).toEqual({ id: "midnight", name: "Midnight", mode: "dark", accent: "#7C5CFF", background: "#0E1020", surface: "#181B33", text: "#E8E9F3" });
    expect(APP_THEMES.map((a) => a.id)).toEqual(["midnight", "paper", "daylight", "forest", "ocean", "sunset", "neon"]);
  });

  it("finds built-in and saved themes", () => {
    const cave = { id: "cave", name: "Cave", mode: "dark" as const, accent: "#33CCAA", background: "#101010", surface: "#1A1A1A", text: "#EEEEEE" };
    const f = { ...DEFAULT_FEEL, app_themes: [cave], app_theme: "custom:cave" };
    expect(resolveAppTheme(f)?.name).toBe("Cave");
    expect(resolveAppTheme({ ...f, app_theme: "paper" })?.mode).toBe("light");
    expect(allAppThemes(f).map((a) => a.id).slice(-1)).toEqual(["custom:cave"]);
  });

  for (const t of APP_THEMES) {
    it(`${t.name}: derived colors stay readable`, () => {
      const v = themeVars(t);
      expect(contrast(v["--text"], v["--bg"])).toBeGreaterThanOrEqual(7);
      for (const k of ["--muted", "--text-2"]) {
        expect(contrast(v[k], v["--bg"])).toBeGreaterThanOrEqual(4.5);
        expect(contrast(v[k], v["--surface"])).toBeGreaterThanOrEqual(4.5);
      }
      expect(contrast(v["--accent-text"], v["--accent"])).toBeGreaterThanOrEqual(4.5);
      expect(v["color-scheme"]).toBe(t.mode);
    });
  }

  it("keeps muted text readable even when the chosen colors are close", () => {
    const v = themeVars({ mode: "dark", accent: "#808080", background: "#202020", surface: "#303030", text: "#B0B0B0" });
    expect(contrast(v["--muted"], v["--surface"])).toBeGreaterThanOrEqual(Math.min(4.5, contrast("#B0B0B0", "#303030")));
  });
});
