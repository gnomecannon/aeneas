import { useEffect, useRef, useState } from "react";
import type { HubUpdateInfo, HubUpdateRun } from "../../sync/api";
import { engine } from "../../sync/engine";
import { fmtDateTime } from "../../lib/time";
import { errorText } from "./common";
import { useHubReady } from "../../sync/hooks";

const RUNNING: HubUpdateRun["state"][] = ["starting", "checking", "installing", "restarting", "rolling_back"];
const STATE_WORDS: Record<HubUpdateRun["state"], string> = {
  starting: "Starting",
  checking: "Looking for the newest version",
  installing: "Installing",
  restarting: "Restarting the hub",
  rolling_back: "Going back to the version it had",
  done: "Updated",
  up_to_date: "Already up to date",
  rolled_back: "Went back to the version it had",
  failed: "Did not update",
};

/**
 * Settings, About: the hub's own software. Check fetches its branch and lists what is new; Update hub runs the update
 * on the hub machine (it restarts, and goes back by itself when the new version does not start). The assistant can do
 * the same (update_hub).
 */
export function HubUpdateCard() {
  const [info, setInfo] = useState<HubUpdateInfo | null>(null);
  const [busy, setBusy] = useState<"" | "check" | "start">("");
  const [error, setError] = useState("");
  /** While an update runs: the hub restarts, so a failed read means "restarting", not an error. */
  const [watching, setWatching] = useState(false);
  const [unreachable, setUnreachable] = useState(false);
  const since = useRef(0);

  const ready = useHubReady();
  useEffect(() => {
    engine.client?.hubUpdate().then(
      (i) => {
        setInfo(i);
        if (i.running) setWatching(true);
      },
      (e) => setError(errorText(e)),
    );
  }, [ready]);

  useEffect(() => {
    if (!watching) return;
    since.current = since.current || Date.now();
    const timer = window.setInterval(() => {
      // Ten minutes is far past any update (npm ci, a build, a restart): stop asking and leave what was last seen.
      if (Date.now() - since.current > 10 * 60_000) {
        setWatching(false);
        return;
      }
      engine.client?.hubUpdate().then(
        (i) => {
          setUnreachable(false);
          setInfo(i);
          if (!i.running) {
            setWatching(false);
            since.current = 0;
            // What is newer now, against the version it runs after the update.
            if (i.last_run?.state === "done") void engine.client?.checkHubUpdate().then(setInfo, () => {});
          }
        },
        () => setUnreachable(true),
      );
    }, 3000);
    return () => window.clearInterval(timer);
  }, [watching]);

  const check = async () => {
    if (!engine.client) return;
    setBusy("check");
    setError("");
    try {
      setInfo(await engine.client.checkHubUpdate());
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy("");
    }
  };

  const start = async () => {
    if (!engine.client) return;
    setBusy("start");
    setError("");
    try {
      const r = await engine.client.startHubUpdate();
      setInfo((i) => (i ? { ...i, running: true, last_run: r.run, can_update: false } : i));
      setWatching(true);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy("");
    }
  };

  if (!engine.client) return null;
  const run = info?.last_run ?? null;
  const running = watching || !!(run && RUNNING.includes(run.state) && info?.running);

  return (
    <div className="card col">
      <h2>Hub software</h2>
      {!info ? (
        <div className="muted small">{error || "checking"}</div>
      ) : (
        <>
          <div className="small">
            {info.commit ? `This hub runs version ${info.commit.slice(0, 7)}${info.committed_at ? ` from ${fmtDateTime(info.committed_at)}` : ""}.` : "This hub's version is not known."}
          </div>
          {running && run ? (
            <div className="small" role="status">
              {STATE_WORDS[run.state]}
              {unreachable ? ": the hub is restarting, this page reconnects by itself" : run.message && run.message !== STATE_WORDS[run.state] ? `: ${run.message}` : ""}
            </div>
          ) : (
            <>
              {info.checked_at && info.behind === 0 && !info.reason && <div className="ok small">Up to date (checked {fmtDateTime(info.checked_at)}).</div>}
              {info.behind > 0 && (
                <div className="col small">
                  <div>
                    {info.behind === 1 ? "1 change is" : `${info.behind} changes are`} newer than this hub:
                  </div>
                  <ul className="small" style={{ margin: "4px 0 0 18px", padding: 0 }}>
                    {info.changes.slice(0, 8).map((c) => (
                      <li key={c.commit}>{c.title}</li>
                    ))}
                    {info.changes.length > 8 && <li className="muted">and {info.behind - 8} more</li>}
                  </ul>
                </div>
              )}
              {info.reason && <div className="muted small">{info.reason}</div>}
              {run && !RUNNING.includes(run.state) && (
                <div className={`small ${run.state === "failed" || run.state === "rolled_back" ? "error" : "muted"}`}>
                  Last update {fmtDateTime(run.at)}: {run.message}
                </div>
              )}
            </>
          )}
          {error && (
            <div className="error small" role="status">
              {error}
            </div>
          )}
          <div className="row">
            {info.installed_with_git && (
              <button onClick={() => void check()} disabled={!!busy || running}>
                {busy === "check" ? "Checking" : "Check for updates"}
              </button>
            )}
            {info.can_update && !running && (
              <button className="primary" onClick={() => void start()} disabled={!!busy}>
                {busy === "start" ? "Starting" : "Update hub"}
              </button>
            )}
          </div>
          {info.can_update && !running && <div className="muted small">The hub restarts in a minute or two, and goes back to this version by itself if the new one does not start. You can also ask the assistant to update the hub.</div>}
        </>
      )}
    </div>
  );
}
