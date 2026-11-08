/**
 * Each state's rate on restaurant meals, for picking a state by hand in the bill splitter (no location needed). The
 * same table as the hub's `hub/src/mealstax.ts` (as of 2026-07-01); a test keeps the two equal.
 */
export const MEALS_STATES: { code: string; name: string; pct: number }[] = [
  { code: "AL", name: "Alabama", pct: 4 }, { code: "AK", name: "Alaska", pct: 0 }, { code: "AZ", name: "Arizona", pct: 5.6 },
  { code: "AR", name: "Arkansas", pct: 6.5 }, { code: "CA", name: "California", pct: 7.25 }, { code: "CO", name: "Colorado", pct: 2.9 },
  { code: "CT", name: "Connecticut", pct: 7.35 }, { code: "DE", name: "Delaware", pct: 0 }, { code: "DC", name: "District of Columbia", pct: 10 },
  { code: "FL", name: "Florida", pct: 6 }, { code: "GA", name: "Georgia", pct: 4 }, { code: "HI", name: "Hawaii", pct: 4 },
  { code: "ID", name: "Idaho", pct: 6 }, { code: "IL", name: "Illinois", pct: 6.25 }, { code: "IN", name: "Indiana", pct: 7 },
  { code: "IA", name: "Iowa", pct: 6 }, { code: "KS", name: "Kansas", pct: 6.5 }, { code: "KY", name: "Kentucky", pct: 6 },
  { code: "LA", name: "Louisiana", pct: 5 }, { code: "ME", name: "Maine", pct: 8 }, { code: "MD", name: "Maryland", pct: 6 },
  { code: "MA", name: "Massachusetts", pct: 6.25 }, { code: "MI", name: "Michigan", pct: 6 }, { code: "MN", name: "Minnesota", pct: 6.875 },
  { code: "MS", name: "Mississippi", pct: 7 }, { code: "MO", name: "Missouri", pct: 4.225 }, { code: "MT", name: "Montana", pct: 0 },
  { code: "NE", name: "Nebraska", pct: 5.5 }, { code: "NV", name: "Nevada", pct: 6.85 }, { code: "NH", name: "New Hampshire", pct: 8.5 },
  { code: "NJ", name: "New Jersey", pct: 6.625 }, { code: "NM", name: "New Mexico", pct: 4.875 }, { code: "NY", name: "New York", pct: 4 },
  { code: "NC", name: "North Carolina", pct: 4.75 }, { code: "ND", name: "North Dakota", pct: 5 }, { code: "OH", name: "Ohio", pct: 5.75 },
  { code: "OK", name: "Oklahoma", pct: 4.5 }, { code: "OR", name: "Oregon", pct: 0 }, { code: "PA", name: "Pennsylvania", pct: 6 },
  { code: "RI", name: "Rhode Island", pct: 8 }, { code: "SC", name: "South Carolina", pct: 6 }, { code: "SD", name: "South Dakota", pct: 4.2 },
  { code: "TN", name: "Tennessee", pct: 7 }, { code: "TX", name: "Texas", pct: 6.25 }, { code: "UT", name: "Utah", pct: 6.1 },
  { code: "VT", name: "Vermont", pct: 9 }, { code: "VA", name: "Virginia", pct: 5.3 }, { code: "WA", name: "Washington", pct: 6.5 },
  { code: "WV", name: "West Virginia", pct: 6 }, { code: "WI", name: "Wisconsin", pct: 5 }, { code: "WY", name: "Wyoming", pct: 4 },
].sort((a, b) => a.name.localeCompare(b.name));

/** The note under the tax field for a state picked by hand or found from the location. */
export const stateNote = (name: string) => `${name}'s rate on restaurant meals. Your city or county may add its own.`;

/**
 * Said once before the browser is asked for a position: the browser (not the hub) works it out, and the big browsers
 * ask their company's location service to do it. The position itself then goes only to the hub.
 */
export function locationNotice(inWindowsApp: boolean, ua: string): string {
  const who = inWindowsApp || /\bEdg(e|A|iOS)?\//.test(ua) ? "Microsoft's location service"
    : /\b(Chrome|CriOS|Chromium)\//.test(ua) ? "Google's location service"
    : /\bFirefox\//.test(ua) ? "a location service (Firefox uses Google's)"
    : "your browser's location service";
  return `Your browser works out where you are, and it may ask ${who} to do that. The rough position then goes to your hub only, to find your state. Or pick your state from the list instead.`;
}
