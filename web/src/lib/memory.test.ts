import { describe, expect, it } from "vitest";
import { detectHost, deriveHosts, paramNames, renderDefaults, renderSnippet, snippetSegments, splitPreflight } from "./memory";
import type { Entity } from "@everythingapp/shared";

const body = "zfs snapshot {{pool}}/{{dataset}}@{{ tag }}\nzfs list -t snapshot {{pool}}/{{dataset}}";

describe("snippet params", () => {
  it("lists names once in order of first appearance", () => {
    expect(paramNames(body)).toEqual(["pool", "dataset", "tag"]);
  });

  it("splits the body into text and highlighted param segments", () => {
    const segs = snippetSegments("echo {{a}} and {{b}}!");
    expect(segs).toEqual([{ text: "echo " }, { text: "{{a}}", param: "a" }, { text: " and " }, { text: "{{b}}", param: "b" }, { text: "!" }]);
    expect(snippetSegments("no params")).toEqual([{ text: "no params" }]);
  });

  it("prefills the render form from declared defaults and adds undeclared body params", () => {
    const rows = renderDefaults({ body, params: [{ name: "pool", default: "tank", description: "zpool" }, { name: "dataset", default: "media" }] });
    expect(rows).toEqual([
      { name: "pool", value: "tank", description: "zpool" },
      { name: "dataset", value: "media", description: undefined },
      { name: "tag", value: "", description: undefined },
    ]);
  });

  it("renders locally with defaults filling the rest and reports missing names", () => {
    const s = { body, params: [{ name: "pool", default: "tank" }] };
    expect(renderSnippet(s, { dataset: "media", tag: "pre" })).toBe("zfs snapshot tank/media@pre\nzfs list -t snapshot tank/media");
    expect(() => renderSnippet(s, { dataset: "media" })).toThrow("missing tag");
  });
});

describe("pre-flight blocks", () => {
  it("marks the block from a Pre-flight line to the next blank line", () => {
    const reply = "Do this.\n\nPre-flight: snapshot first.\n- zfs snapshot tank/media@pre\n- verify with zfs list\n\n```\nzfs destroy tank/media\n```";
    const segs = splitPreflight(reply);
    expect(segs.map((s) => s.preflight)).toEqual([false, true, false]);
    expect(segs[1].text).toBe("Pre-flight: snapshot first.\n- zfs snapshot tank/media@pre\n- verify with zfs list");
    expect(segs[2].text).toBe("```\nzfs destroy tank/media\n```");
  });

  it("leaves replies without one untouched", () => {
    expect(splitPreflight("plain reply\n\nsecond paragraph")).toEqual([{ preflight: false, text: "plain reply\n\nsecond paragraph" }]);
  });
});

describe("host detection", () => {
  const hosts = ["pve1", "storage", "core"];
  it("finds the most mentioned known host by whole word", () => {
    expect(detectHost("ssh root@pve1 then check storage. pve1.local is down.", hosts)).toBe("pve1");
    expect(detectHost("The corefile is on storage", hosts)).toBe("storage");
    expect(detectHost("nothing here", hosts)).toBeNull();
  });
  it("breaks ties by first mention", () => {
    expect(detectHost("storage then pve1", hosts)).toBe("storage");
  });
});

describe("deriveHosts", () => {
  it("counts runbooks, journal entries and snippets and includes host facts", () => {
    const e = (kind: string, fields: Record<string, unknown>, created_at = "2026-10-01T00:00:00.000Z"): Entity =>
      ({ id: Math.random().toString(36), kind, space: "personal", created_at, updated_at: created_at, deleted_at: null, fields, field_ts: {} }) as Entity;
    const hosts = deriveHosts([
      e("runbook", { host: "pve1", title: "Runbook: pve1" }),
      e("journal", { host: "pve1", at: "2026-10-20T10:00:00.000Z", what: "x", risk: "low" }),
      e("journal", { host: "pve1", at: "2026-10-22T10:00:00.000Z", what: "y", risk: "low" }),
      e("snippet", { host: "pve1", title: "s", os: "linux", language: "bash", body: "" }),
      e("fact", { category: "host", key: "host:core", value: "router" }),
    ]);
    expect(hosts).toEqual([
      { host: "core", runbooks: 0, journal_entries: 0, last_change: null, snippets: 0 },
      { host: "pve1", runbooks: 1, journal_entries: 2, last_change: "2026-10-22T10:00:00.000Z", snippets: 1 },
    ]);
  });
});
