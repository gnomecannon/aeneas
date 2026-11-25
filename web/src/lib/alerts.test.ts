import { describe, expect, it } from "vitest";
import type { AppleReminderAlerts, Entity } from "@everythingapp/shared";
import { alertOn, appleAlarmsWaiting, shownAlerts, tasksAlertingHere } from "./alerts";
import { dueReminders } from "./reminders";
import type { AlertInfo } from "../sync/api";

const LIST: AlertInfo[] = [
  { id: "reminder", title: "Reminders", summary: "", module: "notifications", on: true },
  { id: "mail", title: "New mail", summary: "", module: "mail_inbox", on: false },
  { id: "disk", title: "Hub disk space", summary: "", on: true },
];

describe("alert switches", () => {
  it("a kind is on unless the list says off; an unknown kind and an older hub's missing list are on", () => {
    expect(alertOn(LIST, "reminder")).toBe(true);
    expect(alertOn(LIST, "mail")).toBe(false);
    expect(alertOn(LIST, "something-new")).toBe(true);
    expect(alertOn(null, "mail")).toBe(true);
  });

  it("the settings page lists a kind only while its module is on; a kind of no module always shows", () => {
    const on = (id: string | undefined) => id !== "mail_inbox";
    expect(shownAlerts(LIST, on).map((a) => a.id)).toEqual(["reminder", "disk"]);
    expect(shownAlerts(LIST, () => true).map((a) => a.id)).toEqual(["reminder", "mail", "disk"]);
    expect(shownAlerts(null, () => true)).toEqual([]);
  });
});

describe("tasks also in Apple Reminders", () => {
  const task = (id: string, apple?: Record<string, unknown>): Entity => ({
    id, kind: "task", space: "personal", created_at: "2026-11-20T08:00:00.000Z", updated_at: "2026-11-20T08:00:00.000Z", field_ts: {},
    fields: { title: id, status: "scheduled", order: 1, remind_at: "2026-11-24T09:00:00.000Z", ...(apple ? { apple } : {}) },
  } as unknown as Entity);
  const TASKS = [
    task("in-apple", { id: "ext-1", list: "L1", list_title: "Home" }),
    task("made-in-a-list", { id: "", list: "", list_title: "Home" }),
    task("plain"),
  ];
  const setting = (aeneas: boolean, apple = true, waiting: AppleReminderAlerts["waiting"] = []): AppleReminderAlerts =>
    ({ aeneas, apple, apple_alarms: apple || waiting.length > 0, waiting, needs: "1.0.19" });
  const banner = (apple: AppleReminderAlerts | null) => dueReminders(tasksAlertingHere(TASKS, apple), new Date("2026-11-24T09:01:00.000Z")).map((d) => d.entity.id);

  it("the banner shows every due task while Alert from Aeneas is on, and on a hub without the switches", () => {
    expect(banner(setting(true))).toEqual(["in-apple", "made-in-a-list", "plain"]);
    expect(banner(null)).toEqual(["in-apple", "made-in-a-list", "plain"]);
    expect(banner(setting(true, false))).toEqual(["in-apple", "made-in-a-list", "plain"]);
  });

  it("Alert from Aeneas off leaves out only a task tied to an Apple Reminders item", () => {
    expect(banner(setting(false))).toEqual(["made-in-a-list", "plain"]);
  });

  it("says which devices Alert from Apple Reminders waits for, only while it is off and waits", () => {
    expect(appleAlarmsWaiting(null)).toBeNull();
    expect(appleAlarmsWaiting(setting(true))).toBeNull();
    expect(appleAlarmsWaiting(setting(true, false))).toBeNull();
    const w = appleAlarmsWaiting(setting(true, false, [{ id: "d1", name: "Jamie's Mac", platform: "mac", version: "1.0.18" }, { id: "d2", name: "Alex's iPad", platform: "ipad", version: null }]));
    expect(w).toBe("Apple Reminders keeps its alerts until every iPhone, iPad and Mac runs 1.0.19 or later. Still to update: Jamie's Mac (1.0.18), Alex's iPad.");
    expect(w).not.toMatch(/[\u2013\u2014!]/);
  });
});
