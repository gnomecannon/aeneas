import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_TODAY, todayCards } from "@everythingapp/shared";
import { todayColumns } from "../lib/todayBoard";

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
    // On a phone the cards are one column and, by default, the Schedule comes right after Needs you.
    expect(todayColumns(390, todayCards(DEFAULT_TODAY))).toEqual([["tech", "needs", "schedule", "todo", "sofar", "coming"]]);
  });
  it("says Tech once, as one folded line above Needs you: no Tech pill at the top and no Tech rows in Needs you", () => {
    // Folded whenever Today opens: plain screen state, never saved.
    expect(src).toContain("const [techOpen, setTechOpen] = useState(false);");
    expect(src).not.toMatch(/localStorage|sessionStorage/);
    // The whole line is one button that says whether it is open.
    expect(src).toMatch(/<button type="button" className="tech-line" aria-expanded=\{open\}/);
    expect(src).not.toContain("className={`today-tech");
    expect(src).not.toContain("Tech: {light.label}");
    // A card of its own that takes no slot: at the top of the card after it (Needs you by default), so the columns
    // stay as they were (lib/todayBoard.ts todaySlots).
    expect(src).toContain("tech: light && (");
    expect(src.indexOf("<TechCard ")).toBeLessThan(src.indexOf("needs: ("));
    expect(todayColumns(1688, todayCards(DEFAULT_TODAY))[0]).toEqual(["tech", "needs"]);
    expect(src).not.toMatch(/needsYou\(\{[^}]*looks/);
    expect(src).not.toContain('case "tech"');
  });
  it("has no capture box: Capture is in the sidebar and the tab bar on every screen (gnomecannon/aeneas#21)", () => {
    expect(src).not.toContain("quick-capture");
    expect(src).not.toMatch(/placeholder="Capture/);
    expect(src).toContain('aria-label="Today so far"');
    const shell = fs.readFileSync(path.join(__dirname, "../components/Shell.tsx"), "utf8");
    expect(shell).toContain('{ path: "/capture", label: "Capture" },');
  });
});
