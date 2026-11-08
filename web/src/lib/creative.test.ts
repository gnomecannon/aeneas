import { describe, expect, it } from "vitest";
import type { Entity } from "@everythingapp/shared";
import { advanceProcedure, initialQuiz, missingPartTasks, parseMusicQuick, parsePartsText, partRows, partTotals, quizCounts, quizStep, stepsFromText, type ProcedureF, type QuizItem } from "./creative";

const inv = (name: string, qty: number): Entity => ({ id: `inv-${name}`, kind: "inventory", space: "personal", created_at: "", updated_at: "", deleted_at: null, fields: { name, category: "component", qty }, field_ts: {} });

describe("music quick line", () => {
  it("reads chords, time signature, bpm and tuning", () => {
    const r = parseMusicQuick("Am F C G 6/8 112bpm drop D");
    expect(r).toEqual({ title: "Am F C G", type: "progression", body: "Am F C G", key: "Am", bpm: 112, time_sig: "6/8", tuning: "drop D" });
  });

  it("keeps the other words as the title and accepts a split bpm", () => {
    const r = parseMusicQuick("rainy intro Em D 120 bpm standard");
    expect(r.title).toBe("rainy intro");
    expect(r.bpm).toBe(120);
    expect(r.tuning).toBe("standard");
    expect(r.key).toBe("Em");
  });

  it("reads a line as said out loud: a label, joining words, at 112 and punctuation", () => {
    const r = parseMusicQuick("riff idea: Am F C G in 6/8 at 112, drop D");
    expect(r).toEqual({ title: "Am F C G", type: "riff", body: "Am F C G", key: "Am", bpm: 112, time_sig: "6/8", tuning: "drop D" });
    expect(parseMusicQuick("Cave theme @96 Dm Bb").bpm).toBe(96);
  });

  it("falls back to riff with no chords and takes an explicit type", () => {
    expect(parseMusicQuick("slide thing on the low string").type).toBe("riff");
    expect(parseMusicQuick("lyric: the gnome at the end of the world").type).toBe("lyric");
    expect(parseMusicQuick("").title).toBe("Untitled");
    expect(parseMusicQuick("Em C D G garden song")).toMatchObject({ type: "progression", title: "garden song" });
    expect(parseMusicQuick("song Hollow Light Am")).toMatchObject({ type: "song", title: "Hollow Light", key: "Am" });
  });
});

describe("parts", () => {
  it("computes have and missing, matching inventory by name when the hub has not", () => {
    const rows = partRows([{ name: "10k resistor", qty: 4 }, { name: "ESP32", qty: 1, have: 1, inventory_id: "x" }, { name: "Enclosure", qty: 1 }], [inv("10K Resistor", 2)]);
    expect(rows).toEqual([
      { name: "10k resistor", qty: 4, have: 2, missing: 2, inventory_id: "inv-10K Resistor" },
      { name: "ESP32", qty: 1, have: 1, missing: 0, inventory_id: "x" },
      { name: "Enclosure", qty: 1, have: 0, missing: 1, inventory_id: undefined },
    ]);
    expect(partTotals(rows)).toEqual({ have: 1, missing: 2 });
    expect(missingPartTasks(rows)).toEqual(["Get 2 x 10k resistor", "Get Enclosure"]);
  });

  it("parses parts rows from text", () => {
    expect(parsePartsText("2 x 10k resistor\nESP32 x3\nEnclosure\n")).toEqual([
      { name: "10k resistor", qty: 2 },
      { name: "ESP32", qty: 3 },
      { name: "Enclosure", qty: 1 },
    ]);
  });
});

describe("procedure steps", () => {
  it("takes numbered lines, fenced commands and inline commands", () => {
    const steps = stepsFromText("Do this on storage\n1. Snapshot first\n```\nzfs snapshot tank/scratch@pre\n```\n2. Verify with `zfs list -r tank/scratch`\n- Destroy as root\n    zfs destroy -r tank/scratch\n", "storage");
    expect(steps.map((s) => s.text)).toEqual(["Do this on storage", "Snapshot first", "Verify with", "Destroy as root"]);
    expect(steps[1].command).toBe("zfs snapshot tank/scratch@pre");
    expect(steps[2].command).toBe("zfs list -r tank/scratch");
    expect(steps[3].command).toBe("zfs destroy -r tank/scratch");
    expect(steps[3].user).toBe("root");
    expect(steps.every((s) => s.host === "storage")).toBe(true);
  });

  it("advances one step at a time, steps back without clearing, finishes and resets", () => {
    const f: ProcedureF = { title: "t", steps: [{ text: "a" }, { text: "b" }], current: 0 };
    const one = { ...f, ...advanceProcedure(f, "done", "2026-10-23T01:00:00.000Z") } as ProcedureF;
    expect(one.current).toBe(1);
    expect(one.steps[0].done_at).toBe("2026-10-23T01:00:00.000Z");
    expect(one.started_at).toBe("2026-10-23T01:00:00.000Z");
    expect(one.done_at).toBeUndefined();
    const back = { ...one, ...advanceProcedure(one, "back") } as ProcedureF;
    expect(back.current).toBe(0);
    expect(back.steps[0].done_at).toBeDefined();
    const fin = { ...one, ...advanceProcedure(one, "done", "2026-10-23T01:05:00.000Z") } as ProcedureF;
    expect(fin.current).toBe(2);
    expect(fin.done_at).toBe("2026-10-23T01:05:00.000Z");
    expect(advanceProcedure(fin, "done")).toEqual({});
    const reset = { ...fin, ...advanceProcedure(fin, "reset") } as ProcedureF;
    expect(reset.current).toBe(0);
    expect(reset.done_at).toBeUndefined();
    expect(reset.steps.every((s) => !s.done_at)).toBe(true);
  });
});

describe("quiz machine", () => {
  const items: QuizItem[] = [
    { q: "q1", a: "a1", hint: "h1", topic: "zfs" },
    { q: "q2", a: "a2", hint: "h2", topic: "zfs", result: "right" },
    { q: "q3", a: "a3", hint: "h3", topic: "dns" },
  ];

  it("starts at the first open item and skips answered ones", () => {
    const s0 = initialQuiz(items);
    expect(s0).toMatchObject({ index: 0, phase: "ask" });
    const s1 = quizStep(s0, "know");
    expect(s1.record).toEqual({ index: 0, result: "right" });
    expect(s1.state).toMatchObject({ index: 2, phase: "ask" });
  });

  it("not sure shows the hint once, then reveal marks revealed and ends", () => {
    let s = initialQuiz(items);
    s = quizStep(s, "wrong").state;
    expect(s.index).toBe(2);
    expect(quizStep(s, "reveal").record).toBeUndefined();
    s = quizStep(s, "unsure").state;
    expect(s.phase).toBe("hint");
    expect(quizStep(s, "unsure").state.phase).toBe("hint");
    const end = quizStep(s, "reveal");
    expect(end.record).toEqual({ index: 2, result: "revealed" });
    expect(end.state.phase).toBe("done");
    expect(quizCounts(end.state.results)).toEqual({ right: 1, wrong: 1, revealed: 1, answered: 3, total: 3 });
    expect(quizStep(end.state, "know").record).toBeUndefined();
  });

  it("is done from the start when everything has a result", () => {
    expect(initialQuiz(items.map((i) => ({ ...i, result: "right" as const }))).phase).toBe("done");
  });
});
