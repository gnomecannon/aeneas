import { describe, expect, it } from "vitest";
import { HubClient } from "../sync/api";
import { applyListChanges, type MailList, type MailListAnswer, type MailSummary } from "./mail";

const msg = (id: string, at: string, over: Partial<MailSummary> = {}): MailSummary =>
  ({ id, at, from: { name: "Alex", address: "alex@example.com" }, subject: id, preview: "", automated: false, bundle: null, state: "inbox", pinned: false, seen: false, mailbox: "robin@example.com", ...over }) as MailSummary;
const settings = { mailboxes: [], snooze_times: undefined, folders: [], blocked: [] } as unknown as Omit<MailList, "messages">;

describe("applyListChanges", () => {
  it("takes out what left, puts in what changed, and keeps the list's order and length", () => {
    const copy = { ...settings, logos: { "a.example": "<svg/>" }, messages: [msg("c", "2026-11-25T10:00:00.000Z"), msg("b", "2026-11-25T09:00:00.000Z"), msg("a", "2026-11-25T08:00:00.000Z")] } as MailList;
    const a: MailListAnswer = { ...settings, cursor: "x", max: 3, gone: ["b"], changed: [msg("a", "2026-11-25T08:00:00.000Z", { seen: true }), msg("d", "2026-11-25T07:00:00.000Z"), msg("e", "2026-11-25T11:00:00.000Z", { back_at: "2026-11-25T11:30:00.000Z" })] };
    const out = applyListChanges(copy, a)!;
    expect(out.messages.map((m) => m.id)).toEqual(["e", "c", "a"]);
    expect(out.messages.find((m) => m.id === "a")!.seen).toBe(true);
    expect(out.logos).toEqual({ "a.example": "<svg/>" });
    // Equal times go by id, as the hub's list does.
    const tie = applyListChanges({ ...settings, messages: [msg("q", "2026-11-25T10:00:00.000Z")] } as MailList, { ...settings, max: 5, changed: [msg("p", "2026-11-25T10:00:00.000Z")], gone: [] })!;
    expect(tie.messages.map((m) => m.id)).toEqual(["p", "q"]);
    expect(applyListChanges(null, { ...settings, changed: [], gone: [] })).toBeNull();
  });
});

describe("HubClient.mailList", () => {
  function hub(answers: Record<string, unknown>[]) {
    const asked: string[] = [];
    const fetchImpl = (async (url: string) => {
      asked.push(new URL(url).search);
      return new Response(JSON.stringify(answers.shift()), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as ConstructorParameters<typeof HubClient>[1];
    return { asked, c: new HubClient({ hubUrl: "http://hub.test", token: "tok" }, fetchImpl) };
  }

  it("asks for the whole list once, then only for what changed", async () => {
    const { asked, c } = hub([
      { ...settings, messages: [msg("a", "2026-11-25T08:00:00.000Z")], cursor: "c1", max: 5000 },
      { ...settings, changed: [msg("b", "2026-11-25T09:00:00.000Z")], gone: [], cursor: "c2", max: 5000 },
    ]);
    expect((await c.mailList()).messages.map((m) => m.id)).toEqual(["a"]);
    expect((await c.mailList()).messages.map((m) => m.id)).toEqual(["b", "a"]);
    expect(asked).toEqual(["?since=", "?since=c1"]);
  });

  it("asks for the whole list each time from a hub from before, which sends no cursor", async () => {
    const { asked, c } = hub([{ ...settings, messages: [msg("a", "2026-11-25T08:00:00.000Z")] }, { ...settings, messages: [] }]);
    await c.mailList();
    expect((await c.mailList()).messages).toEqual([]);
    expect(asked).toEqual(["?since=", "?since="]);
  });
});

describe("applyListChanges, random changes", () => {
  it("gives the copy and the changes sorted whole and cut, as the hub's list is", () => {
    let seed = 11;
    const r = (n: number) => { seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648; return seed % n; };
    const t = (h: number) => new Date(Date.UTC(2026, 10, 10, h)).toISOString();
    const when = (m: MailSummary) => m.back_at ?? m.at;
    const ordered = (xs: MailSummary[]) => [...xs].sort((x, y) => (when(x) < when(y) ? 1 : when(x) > when(y) ? -1 : x.id < y.id ? -1 : 1));
    for (let round = 0; round < 300; round++) {
      const copy = ordered(Array.from({ length: r(30) }, (_, i) => msg(`m${i}`, t(r(200)))));
      const changed: MailSummary[] = [];
      for (const m of copy) if (r(4) === 0) changed.push(r(2) ? { ...m, seen: true } : msg(m.id, t(r(200)), r(2) ? { back_at: t(r(200)) } : {}));
      for (let i = 0; i < r(5); i++) changed.push(msg(`n${i}`, t(r(200))));
      const gone = copy.filter(() => r(6) === 0).map((m) => m.id);
      const max = 1 + r(40);
      const byId = new Map(copy.filter((m) => !gone.includes(m.id)).map((m) => [m.id, m]));
      for (const m of changed) byId.set(m.id, m);
      const out = applyListChanges({ ...settings, messages: copy } as MailList, { ...settings, changed, gone, max, cursor: "c" })!;
      expect(out.messages).toEqual(ordered([...byId.values()]).slice(0, max));
    }
  });
});
