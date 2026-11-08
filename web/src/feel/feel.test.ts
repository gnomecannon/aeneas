import { describe, expect, it } from "vitest";
import { bendSteps, degreeNote, filterDrive, filterHz, midiToHz, parseKey, randomNote, rootMidi, scaleNotes, stepInScale, themeColors, THEME_COLORS } from "./theory";
import { DEFAULT_FEEL, cleanPatch, mergeFeel, newId, viewFrom } from "./prefs";
import { HubClient } from "../sync/api";

describe("notes", () => {
  it("puts the root at 12 * (octave + 1) + key index", () => {
    expect(rootMidi("C", 4)).toBe(60);
    expect(rootMidi("A", 4)).toBe(69);
    expect(rootMidi("A#", 2)).toBe(46);
  });

  it("spans two octaves of the scale with the top root", () => {
    expect(scaleNotes("C", "major_pentatonic", 4)).toEqual([60, 62, 64, 67, 69, 72, 74, 76, 79, 81, 84]);
    const d = scaleNotes("D", "dorian", 3);
    expect(d[0]).toBe(50);
    expect(d).toHaveLength(15);
    expect(d[d.length - 1]).toBe(74);
  });

  it("counts degrees up the scale and into the next octave", () => {
    expect([0, 2, 4].map((n) => degreeNote("C", "major", 4, n))).toEqual([60, 64, 67]);
    expect([0, 2, 4].map((n) => degreeNote("C", "major_pentatonic", 4, n))).toEqual([60, 64, 69]);
    expect(degreeNote("C", "major_pentatonic", 4, 5)).toBe(72);
  });

  it("never repeats the last note", () => {
    const notes = scaleNotes("E", "blues", 4);
    let last: number | null = null;
    for (let i = 0; i < 500; i++) {
      const n = randomNote(notes, last);
      expect(notes).toContain(n);
      expect(n).not.toBe(last);
      last = n;
    }
    // Even when the random source lands on the last note's slot.
    expect(randomNote([60, 62], 60, () => 0)).toBe(62);
    expect(randomNote([60, 62], 62, () => 0.999)).toBe(60);
    expect(randomNote([60], 60)).toBe(60);
  });

  it("converts MIDI to Hz", () => {
    expect(midiToHz(69)).toBe(440);
    expect(midiToHz(81)).toBe(880);
    expect(midiToHz(60)).toBeCloseTo(261.626, 2);
  });

  it("reads a music idea's key like the hub", () => {
    expect(parseKey("Am")).toEqual({ key: "A", scale: "minor" });
    expect(parseKey("Bb dorian")).toEqual({ key: "A#", scale: "dorian" });
    expect(parseKey("F#m")).toEqual({ key: "F#", scale: "minor" });
    expect(parseKey("E")).toEqual({ key: "E", scale: "major" });
    expect(parseKey("hummed")).toBeNull();
  });
});

describe("theme colors", () => {
  it("uses the named palettes", () => {
    expect(themeColors("aurora", [], "#000000")).toEqual(["#7C5CFF", "#2EC5FF", "#3DF5A7", "#FFD166", "#FF5C8A"]);
    expect(themeColors("candy", [], "")).toHaveLength(8);
    expect(themeColors("neon", [{ id: "a", colors: ["#123456"] }], "")).toEqual(THEME_COLORS.neon);
  });

  it("uses a saved palette by id, aurora when it is gone or empty", () => {
    const pals = [{ id: "dusk", colors: ["#112233", "#445566"] }, { id: "none", colors: [] }];
    expect(themeColors("custom:dusk", pals, "")).toEqual(["#112233", "#445566"]);
    expect(themeColors("custom:none", pals, "")).toEqual(THEME_COLORS.aurora);
    expect(themeColors("custom:gone", pals, "")).toEqual(THEME_COLORS.aurora);
    expect(themeColors("plaid", pals, "")).toEqual(THEME_COLORS.aurora);
  });

  it("draws mono in the accent at a few opacities", () => {
    expect(themeColors("mono", [], " #2f5fbf")).toEqual(["rgba(47, 95, 191, 1)", "rgba(47, 95, 191, 0.75)", "rgba(47, 95, 191, 0.5)", "rgba(47, 95, 191, 0.3)"]);
    expect(themeColors("mono", [], "rebeccapurple")).toEqual(["rebeccapurple"]);
  });
});

describe("prefs merge", () => {
  it("applies a partial change and moves the played key with it when not following music", () => {
    const next = mergeFeel(DEFAULT_FEEL, { key: "A#", scale: "dorian", volume: 0.8 });
    expect(next.key).toBe("A#");
    expect(next.volume).toBe(0.8);
    expect(next.synth).toBe("sine");
    expect(next.effective).toEqual({ key: "A#", scale: "dorian", from: null });
    expect(DEFAULT_FEEL.key).toBe("C");
  });

  it("keeps the hub's played key while following music", () => {
    const from = { id: "m1", title: "hummed melody", key: "A# dorian" };
    const base = { ...DEFAULT_FEEL, follow_music: true, effective: { key: "A#" as const, scale: "dorian" as const, from } };
    const next = mergeFeel(base, { key: "D", synth: "bell" });
    expect(next.key).toBe("D");
    expect(next.synth).toBe("bell");
    expect(next.effective).toEqual({ key: "A#", scale: "dorian", from });
    expect(mergeFeel(next, { follow_music: false }).effective).toEqual({ key: "D", scale: "major_pentatonic", from: null });
  });

  it("drops invalid values and clamps ranges", () => {
    expect(cleanPatch({ key: "H", scale: "chromatic", synth: "kazoo", theme: "plaid", volume: 3, octave: 9, shape_size: 5, density: 0.1, motion: "yes", appearance: "sepia" })).toEqual({
      volume: 1,
      octave: 6,
      shape_size: 2,
      density: 0.5,
    });
    expect(cleanPatch(null)).toEqual({});
  });

  it("defaults to sine, held notes and no bend", () => {
    expect(DEFAULT_FEEL.synth).toBe("sine");
    expect(DEFAULT_FEEL.hold).toBe(true);
    expect(DEFAULT_FEEL.drag_bend).toBe(false);
    expect(DEFAULT_FEEL.app_theme).toBe("classic");
    expect(DEFAULT_FEEL.shapes).toEqual(["triangle", "square", "circle", "hexagon", "diamond"]);
  });

  it("takes a list whole or not at all", () => {
    const good = { id: "dusk", name: " Dusk ", colors: ["#112233"] };
    expect(cleanPatch({ palettes: [good] }).palettes).toEqual([{ id: "dusk", name: "Dusk", colors: ["#112233"] }]);
    expect(cleanPatch({ palettes: [good, { id: "x", name: "X", colors: ["red"] }] }).palettes).toBeUndefined();
    expect(cleanPatch({ palettes: [good, good] }).palettes).toBeUndefined();
    expect(cleanPatch({ palettes: [{ ...good, colors: Array(9).fill("#000000") }] }).palettes).toBeUndefined();
    expect(cleanPatch({ shapes: ["star", "blob"] }).shapes).toBeUndefined();
    expect(cleanPatch({ shapes: ["star", "ring"] }).shapes).toEqual(["star", "ring"]);
    expect(cleanPatch({ images: [{ id: "a1", name: "Leaf", enabled: true, type: "image/jpeg" }] }).images).toBeUndefined();
    expect(cleanPatch({ app_themes: [{ id: "cave", name: "Cave", mode: "dark", accent: "#33CCAA", background: "#101010", surface: "#1A1A1A", text: "#EEEEEE" }] }).app_themes).toHaveLength(1);
    expect(cleanPatch({ app_themes: [{ id: "cave", name: "Cave", mode: "dim", accent: "#33CCAA", background: "#101010", surface: "#1A1A1A", text: "#EEEEEE" }] }).app_themes).toBeUndefined();
  });

  it("turns an older single custom color list into the palette My colors", () => {
    const v = viewFrom({ theme: "custom", colors: ["#112233", "#ffaa00"] });
    expect(v.theme).toBe("custom:mine");
    expect(v.palettes).toEqual([{ id: "mine", name: "My colors", colors: ["#112233", "#ffaa00"] }]);
    expect(viewFrom({ theme: "custom", colors: [] }).theme).toBe("aurora");
  });

  it("falls back when the palette or app theme in use is deleted", () => {
    const base = mergeFeel(DEFAULT_FEEL, {
      palettes: [{ id: "dusk", name: "Dusk", colors: ["#112233"] }],
      theme: "custom:dusk",
      app_themes: [{ id: "cave", name: "Cave", mode: "dark", accent: "#33CCAA", background: "#101010", surface: "#1A1A1A", text: "#EEEEEE" }],
      app_theme: "custom:cave",
    });
    expect(base.theme).toBe("custom:dusk");
    expect(base.app_theme).toBe("custom:cave");
    const next = mergeFeel(base, { palettes: [], app_themes: [] });
    expect(next.theme).toBe("aurora");
    expect(next.app_theme).toBe("classic");
    expect(mergeFeel(DEFAULT_FEEL, { app_theme: "midnight" }).app_theme).toBe("midnight");
    expect(mergeFeel(DEFAULT_FEEL, { app_theme: "nowhere" }).app_theme).toBe("classic");
  });

  it("makes ids the hub accepts", () => {
    const id = newId(["abc"]);
    expect(id).toMatch(/^[a-z0-9-]{1,40}$/);
  });

  it("builds a whole view from a hub answer or a broken cache", () => {
    const v = viewFrom({ ...DEFAULT_FEEL, follow_music: true, key: "C", effective: { key: "A", scale: "minor", from: { id: "x", title: "Rainy intro", key: "Am" } } });
    expect(v.effective.key).toBe("A");
    expect(v.effective.from?.title).toBe("Rainy intro");
    expect(viewFrom("garbage")).toEqual(DEFAULT_FEEL);
    expect(viewFrom({ synth: "pad" }).synth).toBe("pad");
  });
});

describe("bending", () => {
  it("steps through the scale from the start note", () => {
    // C major pentatonic: C D E G A.
    expect(stepInScale("C", "major_pentatonic", 60, 1)).toBe(62);
    expect(stepInScale("C", "major_pentatonic", 60, 3)).toBe(67);
    expect(stepInScale("C", "major_pentatonic", 60, -1)).toBe(57);
    expect(stepInScale("C", "major_pentatonic", 60, 5)).toBe(72);
    expect(stepInScale("C", "major_pentatonic", 60, 0)).toBe(60);
  });

  it("stays within two octaves either side", () => {
    expect(stepInScale("C", "major", 60, 40)).toBe(84);
    expect(stepInScale("C", "major", 60, -40)).toBe(36);
  });

  it("counts from the scale note below when the start is outside the scale", () => {
    expect(stepInScale("C", "major", 61, 0)).toBe(60);
    expect(stepInScale("C", "major", 61, 1)).toBe(62);
  });

  it("works the filter like a knob: an octave per 30 px from 3.1 kHz", () => {
    expect(filterHz(0)).toBe(3100);
    expect(filterHz(30)).toBeCloseTo(6200, 6);
    expect(filterHz(-60)).toBeCloseTo(775, 6);
    expect(filterHz(-1000)).toBe(60);
    expect(filterHz(1000)).toBe(16000);
    expect(filterDrive(0)).toBe(0);
    expect(filterDrive(-20)).toBe(0.5);
    expect(filterDrive(300)).toBe(1);
  });

  it("bends less eagerly: a dead zone, then 44 px a step", () => {
    expect(bendSteps(0)).toBe(0);
    expect(bendSteps(-30)).toBe(0);
    expect(bendSteps(-56)).toBe(1);
    expect(bendSteps(100)).toBe(-2);
  });
});

describe("image shape requests", () => {
  function client() {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      if (String(input).includes("/images/bad")) return new Response(JSON.stringify({ error: "image not found" }), { status: 404 });
      if (init?.method === "POST" && (init.headers as Record<string, string>)["Content-Type"] === "image/jpeg") {
        return new Response(JSON.stringify({ error: "send a PNG or WebP image" }), { status: 415 });
      }
      if (init?.method === "POST" || init?.method === "DELETE") return new Response(JSON.stringify(DEFAULT_FEEL), { status: init.method === "POST" ? 201 : 200 });
      return new Response(new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: "image/png" }), { status: 200, headers: { "content-type": "image/png" } });
    }) as typeof fetch;
    return { calls, c: new HubClient({ hubUrl: "http://hub.test", token: "tok" }, fetchImpl) };
  }

  it("uploads the raw image with its type and name", async () => {
    const { calls, c } = client();
    await c.uploadFeelImage(new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }), "Maple leaf");
    expect(calls[0].url).toBe("http://hub.test/prefs/feel/images?name=Maple%20leaf");
    expect(calls[0].init?.method).toBe("POST");
    const h = calls[0].init?.headers as Record<string, string>;
    expect(h["Content-Type"]).toBe("image/png");
    expect(h.Authorization).toBe("Bearer tok");
    expect(calls[0].init?.body).toBeInstanceOf(Blob);
    await expect(c.uploadFeelImage(new Blob([new Uint8Array([1])], { type: "image/jpeg" }), "x")).rejects.toMatchObject({ status: 415, message: "send a PNG or WebP image" });
  });

  it("fetches the bytes with the token and deletes by id", async () => {
    const { calls, c } = client();
    const blob = await c.feelImage("a1");
    expect(blob.size).toBe(4);
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    await c.deleteFeelImage("a1");
    expect(calls[1].url).toBe("http://hub.test/prefs/feel/images/a1");
    expect(calls[1].init?.method).toBe("DELETE");
    await expect(c.feelImage("bad")).rejects.toMatchObject({ status: 404 });
  });
});
