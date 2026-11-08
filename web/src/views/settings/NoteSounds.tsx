import { useState } from "react";
import { onComputer, setSoundOnThisComputer, soundOnThisComputer, updateFeel, useFeel } from "../../feel/store";
import { previewFeel } from "../../feel/FeelLayer";
import { KEYS, SCALES, SCALE_NAMES, SYNTHS, SYNTH_NAMES } from "../../feel/theory";
import type { Feel } from "../../feel/prefs";
import { SubPage, Toggle } from "./common";

export function NoteSounds() {
  const f = useFeel();
  const [here, setHere] = useState(soundOnThisComputer);
  const set = (patch: Partial<Feel>, debounceMs = 0) => updateFeel(patch, debounceMs);
  const eff = f.effective;
  const playing = `${eff.key} ${SCALE_NAMES[eff.scale].toLowerCase()}`;
  const music = !f.follow_music ? `Playing ${playing}.` : eff.from ? `Playing ${playing} from “${eff.from.title || eff.from.key}”.` : "No music idea has a key yet.";

  return (
    <SubPage path="/settings/theme/sounds">
      <Toggle checked={f.sound} onChange={(sound) => set({ sound })} label="A note on every tap" />
      {onComputer && (
        <Toggle
          checked={here}
          disabled={!f.sound}
          onChange={(on) => {
            setHere(on);
            setSoundOnThisComputer(on);
          }}
          label="Also on this computer"
          note="Computers stay quiet until this is on. The switch above is for every device."
        />
      )}
      <div>
        <label htmlFor="feel-vol">Volume {Math.round(f.volume * 100)}%</label>
        <input id="feel-vol" type="range" min={0} max={1} step={0.05} value={f.volume} onChange={(e) => set({ volume: Number(e.target.value) }, 400)} />
      </div>
      <div className="feel-grid">
        <div>
          <label htmlFor="feel-synth">Synth</label>
          <select
            id="feel-synth"
            value={f.synth}
            onChange={(e) => {
              set({ synth: e.target.value as Feel["synth"] });
              previewFeel();
            }}
          >
            {SYNTHS.map((s) => (
              <option key={s} value={s}>
                {SYNTH_NAMES[s]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="feel-key">Key</label>
          <select id="feel-key" value={f.key} disabled={f.follow_music} onChange={(e) => set({ key: e.target.value as Feel["key"] })}>
            {KEYS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="feel-scale">Scale</label>
          <select
            id="feel-scale"
            value={f.scale}
            disabled={f.follow_music}
            onChange={(e) => {
              set({ scale: e.target.value as Feel["scale"] });
              previewFeel();
            }}
          >
            {(Object.keys(SCALES) as Feel["scale"][]).map((s) => (
              <option key={s} value={s}>
                {SCALE_NAMES[s]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="feel-oct">Octave</label>
          <select id="feel-oct" value={f.octave} onChange={(e) => set({ octave: Number(e.target.value) })}>
            {[2, 3, 4, 5, 6].map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        </div>
      </div>
      <Toggle checked={f.follow_music} onChange={(follow_music) => set({ follow_music })} label="Follow my music" note={<span role="status">{music}</span>} />
      <Toggle checked={f.hold} onChange={(hold) => set({ hold })} label="Hold notes" note="Keep pressing to hold the note. A quick tap still plays a short one." />
      <Toggle checked={f.drag_bend} onChange={(drag_bend) => set({ drag_bend })} label="Bend while dragging" note="Drag up or down to move through the scale, left or right to darken or brighten the sound." />
      <section className="col">
        <h2 className="settings-h">Try it</h2>
        <div className="try-pad" data-feel-try="" role="img" aria-label="Press, hold and drag here to hear the current settings">
          <span className="muted small">Press, hold and drag here</span>
        </div>
        <div className="row">
          <button type="button" onClick={() => previewFeel()}>
            Play a phrase
          </button>
        </div>
      </section>
    </SubPage>
  );
}
