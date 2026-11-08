/** The one-time question before the first dictation in a browser, naming whose speech service hears the audio. */
export function DictationNotice({ d }: { d: { notice: string | null; accept(): void; decline(): void } }) {
  if (!d.notice) return null;
  return (
    <div className="card col small" role="alertdialog" aria-label="Before you talk" style={{ marginTop: 8 }}>
      <span>{d.notice}</span>
      <div className="row">
        <button type="button" className="small primary" onClick={d.accept}>Use it</button>
        <button type="button" className="small ghost" onClick={d.decline}>Not now</button>
      </div>
    </div>
  );
}
