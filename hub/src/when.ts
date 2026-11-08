/**
 * Small natural-time parser for capture text. Handles "tomorrow", "tonight", "in 20 minutes",
 * "at 5pm", "next monday", "on friday". Returns the ISO time and the text with the time phrase removed.
 */
const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

export function parseWhen(text: string, now: Date = new Date()): { at: string | null; rest: string } {
  let rest = text;
  let base: Date | null = null;
  let hour: number | null = null;
  let minute = 0;
  let explicitTime = false;

  const take = (re: RegExp, fn: (m: RegExpMatchArray) => void) => {
    const m = re.exec(rest);
    if (m) { fn(m); rest = (rest.slice(0, m.index) + " " + rest.slice(m.index + m[0].length)).replace(/\s+/g, " ").trim(); }
  };

  take(/\bin\s+(\d+)\s*(min|mins|minutes|minute|h|hr|hrs|hour|hours|d|day|days|week|weeks|wk)\b/i, (m) => {
    const n = parseInt(m[1], 10);
    const u = m[2].toLowerCase();
    const d = new Date(now);
    if (u.startsWith("min")) d.setMinutes(d.getMinutes() + n);
    else if (u.startsWith("h")) d.setHours(d.getHours() + n);
    else if (u.startsWith("d")) d.setDate(d.getDate() + n);
    else d.setDate(d.getDate() + 7 * n);
    base = d; explicitTime = true;
  });
  take(/\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i, (m) => {
    hour = parseInt(m[1], 10) % 12 + (m[3].toLowerCase() === "pm" ? 12 : 0);
    minute = m[2] ? parseInt(m[2], 10) : 0;
  });
  take(/\bat\s+(\d{1,2}):(\d{2})\b/, (m) => { hour = parseInt(m[1], 10); minute = parseInt(m[2], 10); });
  // "at 7" with no am or pm: 1 to 6 are the afternoon or evening, 7 to 11 the morning, 12 noon ("tomorrow at 7" was 9 AM
  // with "at 7" left in the title).
  take(/\bat\s+(\d{1,2})\b(?![:.]\d)/i, (m) => { const h = parseInt(m[1], 10); if (h >= 1 && h <= 12) { hour = h <= 6 ? h + 12 : h; minute = 0; } });
  // Before 4 AM "tomorrow" is the coming day, as the owner means it before sleeping and as the assistant reads it.
  take(/\btomorrow\b/i, () => { const d = new Date(now); if (now.getHours() >= 4) d.setDate(d.getDate() + 1); base = d; });
  take(/\btonight\b/i, () => { base = new Date(now); if (hour === null) hour = 20; });
  // A short day name counts only after on, this, next or by ("buy sun block" is not Sunday); a full name anywhere.
  take(/\b(?:(this|next|on|by)\s+(sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)|(?:(this|next|on|by)\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday))\b/i, (mm) => {
    const m = [mm[0], mm[1] ?? mm[3], mm[2] ?? mm[4]] as unknown as RegExpMatchArray;
    const name = m[2].toLowerCase();
    const idx = DAYS.findIndex((d) => d.startsWith(name.slice(0, 3)));
    const d = new Date(now);
    let delta = (idx - d.getDay() + 7) % 7;
    if (delta === 0 || (m[1] ?? "").toLowerCase() === "next") delta = delta === 0 ? 7 : delta;
    d.setDate(d.getDate() + delta);
    base = d;
  });
  take(/\btoday\b/i, () => { base = new Date(now); });

  if (!base && hour === null) return { at: null, rest: rest.trim() };
  const d: Date = base ?? new Date(now);
  if (!explicitTime) {
    d.setHours(hour ?? 9, minute, 0, 0);
    if (d <= now) {
      // "at 5pm" with no day and the hour already gone means tomorrow.
      if (!base) d.setDate(d.getDate() + 1);
      else if (hour === null) d.setHours(9, 0, 0, 0);
    }
  }
  return { at: d.toISOString(), rest: rest.replace(/\s+(at|on)\s*$/i, "").trim() };
}
