import { useCallback, useEffect, useState } from "react";
import { getJoinedNote, onJoinedNote, setJoinedNote } from "../sync/join";
import { useEscape } from "../lib/keys";

/**
 * After this device joined a hub with a phone's yes, which hub it joined ("This device joined Jamie's hub."), until
 * the person closes it. Setup is gone by then, so the note waits here.
 */
export function JoinedToast() {
  const [note, setNote] = useState(getJoinedNote());
  useEffect(() => onJoinedNote(setNote), []);
  const close = useCallback(() => setJoinedNote(null), []);
  useEscape(useCallback(() => { if (getJoinedNote()) close(); }, [close]));
  if (!note) return null;
  return (
    <div className="toast" role="status" aria-live="polite">
      <span>{note}</span>
      <button type="button" className="small primary" onClick={close}>OK</button>
    </div>
  );
}
