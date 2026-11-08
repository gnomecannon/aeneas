import { useCallback, useEffect, useState } from "react";
import { applyUpdate, dismissUpdate, subscribePwa, type PwaState } from "../pwa";
import { useEscape } from "../lib/keys";

/** "Update available" toast shown when a newer shell has installed and is waiting. */
export function UpdateToast() {
  const [s, setS] = useState<PwaState | null>(null);
  useEffect(() => subscribePwa(setS), []);
  useEscape(useCallback(() => s?.updateReady && dismissUpdate(), [s?.updateReady]));
  if (!s?.updateReady) return null;
  return (
    <div className="toast" role="status" aria-live="polite">
      <span>Update available</span>
      <button className="small primary" onClick={applyUpdate}>
        Reload
      </button>
      <button className="small ghost" onClick={dismissUpdate} aria-label="Dismiss update notice">
        Later
      </button>
    </div>
  );
}
