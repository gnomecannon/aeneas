import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tonightLine, tonightSpan } from "../src/ai/prompt.js";
import { filingPrompt } from "../src/capture-filer.js";

const at = (h: number, m = 0) => new Date(2026, 10, 25, h, m);
const hm = (d: Date) => `${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;

describe("a plan for tonight with no hour", () => {
  it("starts at the next full hour, 6 PM at the earliest, and ends at midnight", () => {
    assert.equal(hm(tonightSpan(at(10, 5)).start), "25 18:00");
    assert.equal(hm(tonightSpan(at(17, 0)).start), "25 18:00");
    assert.equal(hm(tonightSpan(at(17, 1)).start), "25 18:00");
    assert.equal(hm(tonightSpan(at(18, 0)).start), "25 19:00");
    assert.equal(hm(tonightSpan(at(19, 41)).start), "25 20:00");
    assert.equal(hm(tonightSpan(at(23, 30)).start), "25 23:00");
    assert.equal(hm(tonightSpan(at(19, 41)).end), "26 0:00");
  });

  it("said after midnight, is the coming evening", () => {
    assert.equal(hm(tonightSpan(at(1, 30)).start), "25 18:00");
    assert.equal(hm(tonightSpan(at(1, 30)).end), "26 0:00");
  });

  it("is in the clock line and the filing prompt with the exact times, from when the note was written", () => {
    assert.match(tonightLine(at(17, 0)), /runs from 6:00 PM to midnight: start 2026-11-25T18:00:00[+-]\d\d:\d\d, end 2026-11-26T00:00:00/);
    const p = filingPrompt("Going to Casa Blanca with Jamie tonight to meet up with friends.", at(19, 41));
    assert.match(p, /tonight or this evening with no hour is a timed event from 8:00 PM to midnight \(start 2026-11-25T20:00:00/);
  });
});
