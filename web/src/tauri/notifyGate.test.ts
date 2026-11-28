import { describe, expect, it } from "vitest";
import { notifyWith, type NotifyApi } from "./notifyGate";

function fake(granted: boolean, answer = "granted") {
  const calls = { asked: 0, sent: [] as string[] };
  const api: NotifyApi = {
    isPermissionGranted: async () => granted,
    requestPermission: async () => { calls.asked++; return answer; },
    sendNotification: (o) => { calls.sent.push(o.title); },
  };
  return { api, calls };
}

describe("system notifications", () => {
  it("are never asked for by a notification itself: without permission nothing is sent and the system is not asked", async () => {
    const f = fake(false);
    expect(await notifyWith(f.api, "Reminder", "Call the vet")).toBe(false);
    expect(f.calls).toEqual({ asked: 0, sent: [] });
  });

  it("go out once allowed, after the screen to open is set", async () => {
    const f = fake(true);
    const order: string[] = [];
    expect(await notifyWith(f.api, "Reminder", "Call the vet", false, async () => { order.push("target"); })).toBe(true);
    expect(f.calls).toEqual({ asked: 0, sent: ["Reminder"] });
    expect(order).toEqual(["target"]);
  });

  it("are asked for only where the person turns them on, and a refusal sends nothing", async () => {
    const yes = fake(false, "granted");
    expect(await notifyWith(yes.api, "Aeneas", "Notifications work.", true)).toBe(true);
    expect(yes.calls).toEqual({ asked: 1, sent: ["Aeneas"] });
    const no = fake(false, "denied");
    expect(await notifyWith(no.api, "Aeneas", "Notifications work.", true)).toBe(false);
    expect(no.calls).toEqual({ asked: 1, sent: [] });
  });
});
