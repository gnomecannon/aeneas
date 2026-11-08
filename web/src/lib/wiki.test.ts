import { describe, expect, it } from "vitest";
import {
  FOLD_OVER,
  atlassianCallback,
  classifyLink,
  folderLabel,
  groupWiki,
  deferHubImages,
  hubFileBlob,
  hubFileUrl,
  spacesChanged,
  startsFolded,
  syncedText,
  wikiPath,
  wikiUrls,
  withoutTitle,
  type WikiIndex,
  type WikiPageRef,
  type WikiSourceInfo,
} from "./wiki";

const source = (key: string, kind: WikiSourceInfo["kind"], project: string): WikiSourceInfo => ({
  key, kind, project, name: `${project} ${kind}`, url: null, synced_at: null, last_error: null, pages: 0,
});
const page = (id: string, source_key: string, depth = 0): WikiPageRef => ({
  id, source: source_key.startsWith("repo") ? "repo" : "confluence", source_key, project: "", title: id, crumbs: [], depth, url: null, updated_at: "2026-10-29T00:00:00Z", words: 1,
});

describe("groupWiki", () => {
  it("groups sources by project, Confluence first, with their pages in the hub's order", () => {
    const index: WikiIndex = {
      sources: [source("repo:Starfall", "repo", "Starfall"), source("confluence:DUSK", "confluence", "Starfall"), source("repo:Alder", "repo", "Alder")],
      pages: [page("r2", "repo:Starfall"), page("c1", "confluence:DUSK"), page("r1", "repo:Starfall"), page("c2", "confluence:DUSK", 1), page("a1", "repo:Alder")],
    };
    const g = groupWiki(index);
    expect(g.map((x) => x.project)).toEqual(["Starfall", "Alder"]);
    expect(g[0].sections.map((s) => s.source.key)).toEqual(["confluence:DUSK", "repo:Starfall"]);
    expect(g[0].sections[0].pages.map((p) => p.id)).toEqual(["c1", "c2"]);
    expect(g[0].sections[1].pages.map((p) => p.id)).toEqual(["r2", "r1"]);
    expect(g[1].sections[0].pages.map((p) => p.id)).toEqual(["a1"]);
  });

  it("keeps a source with no pages", () => {
    expect(groupWiki({ sources: [source("confluence:X", "confluence", "X")], pages: [] })[0].sections[0].pages).toEqual([]);
  });

  it("labels a repo folder above its first doc only", () => {
    const at = (id: string, crumbs: string[]) => ({ ...page(id, "repo:D", crumbs.length), crumbs });
    const pages = [at("readme", []), at("art", ["Art"]), at("combat", ["Design"]), at("economy", ["Design"]), at("boss", ["Design", "Bosses"])];
    expect(pages.map((_, i) => folderLabel(pages, i))).toEqual([null, "Art", "Design", null, "Design › Bosses"]);
    const conf = [{ ...page("c1", "confluence:X", 1), crumbs: ["Home"] }];
    expect(folderLabel(conf, 0)).toBeNull();
  });

  it("folds long sections unless they hold the open page", () => {
    const pages = Array.from({ length: FOLD_OVER + 1 }, (_, i) => page(`p${i}`, "repo:D"));
    const section = { source: source("repo:D", "repo", "D"), pages };
    expect(startsFolded(section, null)).toBe(true);
    expect(startsFolded(section, "p3")).toBe(false);
    expect(startsFolded({ ...section, pages: pages.slice(0, 3) }, null)).toBe(false);
  });
});

describe("classifyLink", () => {
  it("opens mirrored pages in the wiki", () => {
    expect(classifyLink("everythingapp://wiki?id=repo%3AStarfall%3ADocs%2FCombat.md")).toEqual({ kind: "page", id: "repo:Starfall:Docs/Combat.md" });
    expect(classifyLink("everythingapp://wiki/?id=confluence%3A123")).toEqual({ kind: "page", id: "confluence:123" });
  });

  it("scrolls to headings and sends web links out", () => {
    expect(classifyLink("#combat-loop")).toEqual({ kind: "anchor", id: "combat-loop" });
    expect(classifyLink("https://x.atlassian.net/wiki/search?text=a")).toEqual({ kind: "external", url: "https://x.atlassian.net/wiki/search?text=a" });
    expect(classifyLink("mailto:a@b.c")).toEqual({ kind: "external", url: "mailto:a@b.c" });
  });

  it("leaves anything else alone", () => {
    expect(classifyLink(null)).toEqual({ kind: "none" });
    expect(classifyLink("#")).toEqual({ kind: "none" });
    expect(classifyLink("everythingapp://wiki?x=1")).toEqual({ kind: "none" });
    expect(classifyLink("#/wiki?id=a")).toEqual({ kind: "anchor", id: "/wiki?id=a" });
  });
});

describe("addresses", () => {
  it("puts the page in the route", () => {
    expect(wikiPath()).toBe("/wiki");
    expect(wikiPath("repo:D:Docs/A b.md")).toBe("/wiki?id=repo%3AD%3ADocs%2FA%20b.md");
  });

  it("loads saved images from the hub with the key in a header, never in the address", async () => {
    expect(hubFileUrl("https://hub.example/", "/wiki/media/1/a.png")).toBe("https://hub.example/wiki/media/1/a.png");
    const url = wikiUrls("http://127.0.0.1:8788");
    expect(url("/wiki/media/9/x.png", "image")).toBe("http://127.0.0.1:8788/wiki/media/9/x.png");
    expect(deferHubImages('<p><img src="http://127.0.0.1:8788/wiki/media/9/x.png" alt="x"/><img src="https://e.com/a.png"/></p>', "http://127.0.0.1:8788"))
      .toBe('<p><img data-hub-src="http://127.0.0.1:8788/wiki/media/9/x.png" alt="x"/><img src="https://e.com/a.png"/></p>');
    let sent: RequestInit | undefined;
    const fake = (async (_u: RequestInfo | URL, init?: RequestInit) => { sent = init; return new Response(new Blob(["png"]), { status: 200 }); }) as typeof fetch;
    const blob = await hubFileBlob("http://127.0.0.1:8788/wiki/media/9/x.png", "ead1_k", fake);
    expect(blob.startsWith("blob:")).toBe(true);
    expect((sent?.headers as Record<string, string>).Authorization).toBe("Bearer ead1_k");
    expect(url("#intro", "link")).toBe("#intro");
    expect(url("everythingapp://wiki?id=a", "link")).toBe("everythingapp://wiki?id=a");
    expect(url("/elsewhere", "link")).toBeNull();
    expect(wikiUrls("")("/wiki/media/9/x.png", "image")).toBeNull();
  });

  it("names the Atlassian callback from the hub address", () => {
    expect(atlassianCallback("core.example.ts.net/")).toBe("https://core.example.ts.net/connections/atlassian/return");
  });
});

describe("reader helpers", () => {
  it("drops a first heading that repeats the title", () => {
    expect(withoutTitle("# Combat Loop\n\nBody", "Combat Loop")).toBe("Body");
    expect(withoutTitle("# **Combat** Loop\nBody", "Combat Loop")).toBe("Body");
    expect(withoutTitle("# Other\n\nBody", "Combat Loop")).toBe("# Other\n\nBody");
    expect(withoutTitle("Intro\n# Combat Loop", "Combat Loop")).toBe("Intro\n# Combat Loop");
  });

  it("says when a source was last read", () => {
    const now = new Date("2026-10-29T12:00:00Z");
    expect(syncedText(null, now)).toBe("not synced yet");
    expect(syncedText("2026-10-29T11:59:50Z", now)).toBe("synced just now");
    expect(syncedText("2026-10-29T09:00:00Z", now)).toBe("synced 3h ago");
  });

  it("knows when the chosen spaces differ", () => {
    expect(spacesChanged(["A", "B"], ["B", "A"])).toBe(false);
    expect(spacesChanged(["A"], ["A", "B"])).toBe(true);
    expect(spacesChanged([], [])).toBe(false);
    expect(spacesChanged(["C"], ["A"])).toBe(true);
  });
});
