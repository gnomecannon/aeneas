import { useState } from "react";
import { engine } from "../sync/engine";
import { useHubReady } from "../sync/hooks";
import { JOIN_KIND, joinFields } from "../sync/join";
import { plainError } from "../lib/errors";
import { leaveSetup } from "../lib/router";

type State = { kind: "ask" } | { kind: "busy" } | { kind: "done"; text: string } | { kind: "error"; text: string };

/**
 * A new computer or tablet's join code, opened from the Camera (`everythingapp://join?...`, CONTRACT, Devices): one
 * question, then the hub reaches the device and hands it a pairing link. The code works for anyone who can see the
 * screen it is on, so the question says to say yes only to a device in front of you.
 */
export function Join({ params }: { params: URLSearchParams }) {
  const req = joinFields(params);
  const [state, setState] = useState<State>({ kind: "ask" });
  // After a start from the Camera the screen can show before the hub client exists.
  const client = useHubReady() ? engine.client : null;

  const add = async () => {
    if (!req || !client) return;
    setState({ kind: "busy" });
    try {
      const r = await client.joinDevice(req);
      setState({ kind: "done", text: "state" in r ? `Sent to ${r.name}. It finishes pairing by itself.` : `Added ${r.name}.` });
    } catch (e) {
      setState({ kind: "error", text: plainError(e) });
    }
  };

  return (
    <div className="col" style={{ maxWidth: 560 }}>
      <h1>Add a device</h1>
      <section className="card col" aria-live="polite">
        {!client ? (
          <div className="error">Pair this device with your hub first.</div>
        ) : !req ? (
          <div className="error">This code is not complete. Scan the code on the new device's screen again.</div>
        ) : state.kind === "ask" ? (
          <>
            <div><strong>Add {req.name} to your hub?</strong></div>
            <div className="muted small">{JOIN_KIND[req.platform]}.</div>
            <div>Only do this for a computer in front of you that shows this code.</div>
            <div className="row wrap">
              <button type="button" className="primary" onClick={() => void add()}>Add</button>
              <button type="button" onClick={leaveSetup}>Cancel</button>
            </div>
          </>
        ) : state.kind === "busy" ? (
          <>
            <div>Reaching {req.name}...</div>
            <div className="muted small">This can take up to two minutes.</div>
          </>
        ) : (
          <div className={state.kind === "done" ? "ok" : "error"}>{state.text}</div>
        )}
        {(state.kind === "done" || state.kind === "error" || !req || !client) && (
          <div className="row"><button type="button" onClick={leaveSetup}>Done</button></div>
        )}
      </section>
    </div>
  );
}
