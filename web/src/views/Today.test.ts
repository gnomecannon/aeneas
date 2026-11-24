import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const src = fs.readFileSync(path.join(__dirname, "Today.tsx"), "utf8");

describe("Today says each thing once", () => {
  it("lists no charge on autopay: it pays itself, and Renewals shows it (gnomecannon/aeneas#14)", () => {
    expect(src).not.toContain("Charges on autopay");
    expect(src).not.toContain("chargesSoon");
    // A renewal the owner has to make still reaches Needs you, with its Renewed button.
    expect(src).toContain("watches: on(\"renewals\") ? t?.watches_due_soon ?? [] : []");
    expect(src).toContain("renewWatch(n.watch)");
  });
  it("draws the day once, as the Schedule card's list, with Schedule here and unschedule (gnomecannon/aeneas#15)", () => {
    expect(src).not.toContain("DayRibbon");
    expect(src).toContain("<Timeline ");
    expect(src).toContain("onSchedule={(start, hours) => setSlot({ start, hours })} onUnschedule={unschedule}");
    // On a phone the cards are one column and the Schedule comes right after Needs you.
    expect(fs.readFileSync(path.join(__dirname, "../lib/todayBoard.ts"), "utf8")).toContain('return [["needs", "schedule", "todo", "sofar", "coming"]];');
  });
  it("has no capture box: Capture is in the sidebar and the tab bar on every screen (gnomecannon/aeneas#21)", () => {
    expect(src).not.toContain("quick-capture");
    expect(src).not.toMatch(/placeholder="Capture/);
    expect(src).toContain('aria-label="Today so far"');
    const shell = fs.readFileSync(path.join(__dirname, "../components/Shell.tsx"), "utf8");
    expect(shell).toContain('{ path: "/capture", label: "Capture" },');
  });
});
