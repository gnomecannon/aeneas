import { Fragment, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { engine } from "../sync/engine";
import { HubError } from "../sync/api";
import { META } from "../sync/db";
import { useMeta, useSyncState } from "../sync/hooks";
import { usePoll } from "../lib/usePoll";
import { useMediaQuery } from "../lib/useMediaQuery";
import { go } from "../lib/router";
import { fmtDateTime } from "../lib/time";
import { renderMarkdown } from "../lib/markdown";
import { openExternal } from "../tauri/bridge";
import {
  classifyLink,
  folderLabel,
  groupWiki,
  startsFolded,
  syncedText,
  wikiPath,
  wikiOwnImage,
  deferHubImages,
  hubFileBlob,
  hubFileUrl,
  wikiUrls,
  withoutTitle,
  type WikiHit,
  type WikiPage,
  type WikiSection,
} from "../lib/wiki";

const FOLD_KEY = "ea.wiki.folded";
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

function readFolds(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(FOLD_KEY) ?? "{}") as Record<string, boolean>;
  } catch {
    return {};
  }
}
function writeFolds(v: Record<string, boolean>) {
  try {
    localStorage.setItem(FOLD_KEY, JSON.stringify(v));
  } catch {
    /* private mode: folds last until reload */
  }
}

/**
 * The game design wiki: each project's Confluence handbook and repo docs as the hub mirrors them, read-only.
 * The open page is in the route (`#/wiki?id=`), so a reload or a pop-out window keeps it.
 */
export function Wiki({ id }: { id: string | null }) {
  const index = usePoll((c) => c.wiki(), 300_000);
  const narrow = useMediaQuery("(max-width: 767px)");
  const [q, setQ] = useState("");
  const groups = useMemo(() => (index.data ? groupWiki(index.data) : []), [index.data]);
  // On a phone the list and the page take turns.
  const showSide = !narrow || !id;

  return (
    <div className={id ? "split wiki" : "split wiki front"}>
      {showSide && (
        <div className="side wiki-side">
          <h1>Wiki</h1>
          <input type="search" placeholder="Search the wiki" aria-label="Search the wiki" value={q} onChange={(e) => setQ(e.target.value)} style={{ marginBottom: 8 }} />
          {q.trim() ? (
            <Results q={q.trim()} openId={id} />
          ) : (
            <>
              {index.unavailable && <div className="muted small">The wiki is not available on this hub yet.</div>}
              {!index.data && index.error && !index.unavailable && <div className="error">{index.error}</div>}
              {!index.data && !index.error && <div className="muted small">Loading</div>}
              {index.data && !index.data.sources.length && (
                <div className="empty">
                  Repo docs arrive from the project feed, and Confluence links in <a href="#/settings/connections">Settings, Connections</a>.
                </div>
              )}
              {groups.map((g) => (
                <section key={g.project} className="wiki-project">
                  <h3>{g.project}</h3>
                  {g.sections.map((s) => (
                    <Section key={s.source.key} section={s} openId={id} />
                  ))}
                </section>
              ))}
            </>
          )}
        </div>
      )}
      {(id || !narrow) && (
        <div className="wiki-main">
          {id ? (
            <>
              {narrow && (
                <a href={`#${wikiPath()}`} className="wiki-back">
                  {"‹"} Wiki
                </a>
              )}
              <Reader key={id} id={id} />
            </>
          ) : (
            index.data?.sources.length ? <div className="empty">Pick a page, or search the wiki.</div> : null
          )}
        </div>
      )}
    </div>
  );
}

function Section({ section, openId }: { section: WikiSection; openId: string | null }) {
  const { source, pages } = section;
  const [folds, setFolds] = useState(readFolds);
  const folded = folds[source.key] ?? startsFolded(section, openId);
  const toggle = () => {
    const next = { ...readFolds(), [source.key]: !folded };
    setFolds(next);
    writeFolds(next);
  };
  const activeRef = useRef<HTMLAnchorElement | null>(null);
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [openId]);
  return (
    <div className="wiki-section">
      <button type="button" className="wiki-section-head" aria-expanded={!folded} onClick={toggle}>
        <span className="grow">
          <span className="t">{source.name}</span>
          <span className="meta">
            {pages.length === 1 ? "1 page" : `${pages.length} pages`}, {syncedText(source.synced_at)}
          </span>
        </span>
        <span aria-hidden="true">{folded ? "▸" : "▾"}</span>
      </button>
      {source.last_error && <div className="error">{source.last_error}</div>}
      {!folded && (
        <nav className="wiki-tree" aria-label={source.name}>
          {pages.map((p, i) => {
            const folder = folderLabel(pages, i);
            return (
              <Fragment key={p.id}>
                {folder && <div className="wiki-folder" style={{ paddingLeft: 8 + Math.min(p.depth - 1, 6) * 14 }}>{folder}</div>}
                <a
                  ref={p.id === openId ? activeRef : undefined}
                  href={`#${wikiPath(p.id)}`}
                  className={p.id === openId ? "active" : ""}
                  aria-current={p.id === openId ? "page" : undefined}
                  style={{ paddingLeft: 8 + Math.min(p.depth, 6) * 14 }}
                >
                  {p.title}
                </a>
              </Fragment>
            );
          })}
          {!pages.length && <div className="muted small">No pages yet.</div>}
        </nav>
      )}
    </div>
  );
}

/** Search as you type, a quarter second after the last key. */
function Results({ q, openId }: { q: string; openId: string | null }) {
  const [hits, setHits] = useState<WikiHit[] | null>(null);
  const [err, setErr] = useState("");
  const ready = useSyncState().status !== "setup";
  useEffect(() => {
    const c = engine.client;
    if (!c) return;
    const ctl = new AbortController();
    const t = setTimeout(() => {
      c.wikiSearch(q, 30, ctl.signal).then(
        (r) => {
          setHits(r.results);
          setErr("");
        },
        (e) => {
          if (!ctl.signal.aborted) setErr(msg(e));
        },
      );
    }, 250);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [q, ready]);
  if (err) return <div className="error">{err}</div>;
  if (!hits) return <div className="muted small">Searching</div>;
  if (!hits.length) return <div className="muted small">Nothing in the wiki matches.</div>;
  return (
    <nav className="list" aria-label="Search results">
      {hits.map((h) => (
        <a key={h.id} href={`#${wikiPath(h.id)}`} className={`item wiki-hit${h.id === openId ? " active" : ""}`}>
          <span className="body">
            <span className="t">{h.title}</span>
            <span className="meta">
              {h.project}, {h.source === "confluence" ? "Confluence" : "repo docs"}
            </span>
            {h.snippet && <span className="snippet">{h.snippet}</span>}
          </span>
        </a>
      ))}
    </nav>
  );
}

function Reader({ id }: { id: string }) {
  const hubUrl = useMeta<string>(META.hubUrl) ?? "";
  const token = useMeta<string>(META.token) ?? "";
  const [page, setPage] = useState<WikiPage | null>(null);
  const [err, setErr] = useState<{ text: string; gone: boolean } | null>(null);
  const body = useRef<HTMLDivElement | null>(null);
  // On a cold start the hub client appears a moment after the first render.
  const ready = useSyncState().status !== "setup";

  useEffect(() => {
    const c = engine.client;
    if (!c) return;
    let live = true;
    c.wikiPage(id).then(
      (p) => live && setPage(p),
      (e) => live && setErr({ text: msg(e), gone: e instanceof HubError && e.status === 404 }),
    );
    return () => {
      live = false;
    };
  }, [id, ready]);

  useEffect(() => {
    if (page) window.scrollTo(0, 0);
  }, [page]);

  const html = useMemo(
    () => (page ? deferHubImages(renderMarkdown(withoutTitle(page.markdown, page.title), { breaks: false, headingShift: 1, anchors: true, url: wikiUrls(hubUrl), loadImage: wikiOwnImage(hubUrl) }), hubUrl) : ""),
    [page, hubUrl],
  );

  // The page's own pictures load with the key in a header, as blob: addresses, and are let go when the page changes.
  useEffect(() => {
    const el = body.current;
    if (!el || !token) return;
    const made: string[] = [];
    let live = true;
    el.querySelectorAll<HTMLImageElement>("img[data-hub-src]").forEach((img) => {
      const src = img.getAttribute("data-hub-src");
      if (!src) return;
      hubFileBlob(src, token).then((u) => { if (live) { made.push(u); img.src = u; } else URL.revokeObjectURL(u); }, () => { img.alt = `${img.alt || "Picture"} (could not load)`; });
    });
    return () => { live = false; made.forEach((u) => URL.revokeObjectURL(u)); };
  }, [html, token]);

  // Links to other mirrored pages open here; headings scroll; everything else leaves for the browser.
  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    const a = (e.target as HTMLElement).closest("a");
    if (!a || !body.current?.contains(a)) return;
    const link = classifyLink(a.getAttribute("href"));
    if (link.kind === "none") return;
    e.preventDefault();
    if (link.kind === "external" && hubUrl && link.url.startsWith(hubFileUrl(hubUrl, "/wiki/media/"))) {
      // An attachment on the hub: fetched with the key in a header and opened from memory, never with the key in a link.
      hubFileBlob(link.url, token).then((u) => { window.open(u, "_blank", "noopener"); setTimeout(() => URL.revokeObjectURL(u), 60_000); }, () => undefined);
      return;
    }
    if (link.kind === "page") go(wikiPath(link.id));
    else if (link.kind === "anchor") body.current.querySelector(`[id="h-${CSS.escape(link.id)}"]`)?.scrollIntoView({ block: "start" });
    else void openExternal(link.url).catch(() => undefined);
  };

  if (err) {
    return (
      <div className="card col">
        <div>{err.gone ? "This page is no longer in the wiki. It may have moved or been removed at its source." : `Could not open the page: ${err.text}`}</div>
        <div>
          <a href={`#${wikiPath()}`}>Back to the wiki</a>
        </div>
      </div>
    );
  }
  if (!page) return <div className="muted">Loading</div>;
  const trail = [page.project, page.source_name, ...page.crumbs].filter(Boolean);
  const confluence = page.url;
  return (
    <article className="wiki-page">
      <div className="muted small wiki-crumbs">{trail.join(" › ")}</div>
      <h1 className="wiki-title">{page.title}</h1>
      <div className="row muted small wiki-meta">
        <span>Updated {fmtDateTime(page.updated_at)}</span>
        {confluence && (
          <a
            href={confluence}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => {
              e.preventDefault();
              void openExternal(confluence).catch(() => undefined);
            }}
          >
            Open in Confluence
          </a>
        )}
      </div>
      <div ref={body} className="md wiki-doc" onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />
    </article>
  );
}
