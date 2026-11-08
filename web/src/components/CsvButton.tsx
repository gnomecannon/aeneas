import { useState } from "react";
import type { Kind } from "@everythingapp/shared";
import { engine } from "../sync/engine";
import { saveBlob } from "../lib/download";
import { localDate } from "../lib/planner";

/** Downloads every item of one kind as a CSV file from the hub (all of them, not only what this screen shows). */
export function CsvButton({ kind, filter, label = "CSV" }: { kind: Kind; filter?: Record<string, string>; label?: string }) {
  const [busy, setBusy] = useState(false);
  const run = async () => {
    if (!engine.client) return;
    setBusy(true);
    try {
      const blob = await engine.client.exportCsv(kind, filter);
      const tag = filter ? Object.values(filter).join("-") : kind;
      saveBlob(blob, `${tag}-${localDate(new Date())}.csv`);
    } catch (e) {
      alert(`Export failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <button type="button" className="small ghost" disabled={busy || !engine.client} onClick={() => void run()} title="Download all of them as a spreadsheet file (CSV)">
      {busy ? "Exporting" : label}
    </button>
  );
}
