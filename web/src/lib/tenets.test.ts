import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { dictationCompany, dictationNotice } from "./useDictation";
import { pickLocalVoice } from "./speech";
import { MEALS_STATES, locationNotice, stateNote } from "./mealsTax";

const CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const EDGE = `${CHROME} Edg/140.0.0.0`;
const SAFARI = "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/605.1.15";
const FIREFOX = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0";

describe("dictation names whose service hears the audio", () => {
  it("tells the browsers apart", () => {
    expect(dictationCompany(CHROME)).toBe("Google");
    expect(dictationCompany(EDGE)).toBe("Microsoft");
    expect(dictationCompany(SAFARI)).toBe("Apple");
    expect(dictationCompany(CHROME, true)).toBe("Microsoft");
    expect(dictationCompany(FIREFOX)).toBeNull();
  });
  it("says it before the first use, in plain words", () => {
    expect(dictationNotice("Google")).toContain("goes to Google's speech service");
    expect(dictationNotice(null)).toContain("the speech service your browser uses");
    expect(dictationNotice("Google")).not.toMatch(/[\u2013\u2014]/);
  });
});

describe("answers are read only with a voice on the device", () => {
  const v = (lang: string, localService: boolean, isDefault = false) => ({ lang, localService, default: isDefault });
  it("never picks an online voice", () => {
    expect(pickLocalVoice([v("en-US", false, true), v("en-GB", false)], "en-US")).toBe(-1);
    expect(pickLocalVoice([], "en-US")).toBe(-1);
  });
  it("prefers the page's language among local voices", () => {
    expect(pickLocalVoice([v("en-US", false, true), v("fr-FR", true), v("en-GB", true), v("en-US", true)], "en-US")).toBe(3);
    expect(pickLocalVoice([v("fr-FR", true), v("en-GB", true)], "en-US")).toBe(1);
    expect(pickLocalVoice([v("fr-FR", true, true), v("de-DE", true)], "en-US")).toBe(0);
  });
});

describe("meals tax without location", () => {
  it("has the same 51 rates as the hub", () => {
    const hub = fs.readFileSync(path.resolve(__dirname, "../../../hub/src/mealstax.ts"), "utf8");
    const rows = [...hub.matchAll(/([A-Z]{2}): \{ name: "([^"]+)", pct: ([\d.]+) \}/g)].map((m) => [m[1], m[2], Number(m[3])]);
    expect(rows.length).toBe(51);
    expect(MEALS_STATES.map((s) => [s.code, s.name, s.pct]).sort()).toEqual(rows.sort());
  });
  it("says who finds the position before the browser is asked", () => {
    expect(locationNotice(false, CHROME)).toContain("Google's location service");
    expect(locationNotice(true, CHROME)).toContain("Microsoft's location service");
    expect(locationNotice(false, SAFARI)).toContain("your browser's location service");
    expect(locationNotice(false, CHROME)).toContain("Or pick your state");
    expect(stateNote("Vermont")).toBe("Vermont's rate on restaurant meals. Your city or county may add its own.");
  });
});
