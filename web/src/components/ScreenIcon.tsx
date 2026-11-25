import type { ReactNode } from "react";

/**
 * One small line drawing for each screen, by its bar id (packages/shared `BAR_SCREENS`), for the phone's bottom bar
 * and the page that edits it. Each means what the Apple apps' symbol for that screen means (`Section.symbol`): a sun
 * for Today, a tray for Unsorted Info, a paw for the pet. Drawn on a 24 by 24 grid in the color of the words around
 * them.
 */
const dot = (x: number, y: number) => `M${x} ${y}h.01`;

export const SCREEN_ICONS: Record<string, ReactNode> = {
  today: <><circle cx="12" cy="12" r="4" /><path d="M12 2.5v2M12 19.5v2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M2.5 12h2M19.5 12h2M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4" /></>,
  assistant: <><path d="M4.5 4h8A1.5 1.5 0 0 1 14 5.5v5a1.5 1.5 0 0 1-1.5 1.5H8l-3 2.5V12h-.5A1.5 1.5 0 0 1 3 10.5v-5A1.5 1.5 0 0 1 4.5 4z" /><path d="M17 9h2.5A1.5 1.5 0 0 1 21 10.5v5a1.5 1.5 0 0 1-1.5 1.5H19v2.5L16 17h-4.5a1.5 1.5 0 0 1-1.4-1" /></>,
  capture: <><path d="M11 4.5H5.5A1.5 1.5 0 0 0 4 6v12.5A1.5 1.5 0 0 0 5.5 20H18a1.5 1.5 0 0 0 1.5-1.5V13" /><path d="M17.8 3.2a1.9 1.9 0 0 1 2.7 2.7L12 14.4l-3.4.7.7-3.4z" /></>,
  library: <><rect x="3.5" y="3.5" width="7" height="7" rx="1.5" /><rect x="13.5" y="3.5" width="7" height="7" rx="1.5" /><rect x="3.5" y="13.5" width="7" height="7" rx="1.5" /><rect x="13.5" y="13.5" width="7" height="7" rx="1.5" /></>,
  search: <><circle cx="11" cy="11" r="6.5" /><path d="M20.5 20.5l-4.9-4.9" /></>,
  inbox: <><path d="M3 13.5L5.6 5.5a1 1 0 0 1 1-.7h10.8a1 1 0 0 1 1 .7l2.6 8V18a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18z" /><path d="M3 13.5h5l1.2 2.5h5.6l1.2-2.5h5" /></>,
  tasks: <path d="M3.5 6.2l1.6 1.6 2.9-3.1M11.5 6.5h9M3.5 12.2l1.6 1.6 2.9-3.1M11.5 12.5h9M3.5 18.2l1.6 1.6 2.9-3.1M11.5 18.5h9" />,
  week: <><rect x="3.5" y="5" width="17" height="15.5" rx="2" /><path d="M3.5 10h17M8 3v4M16 3v4" /></>,
  renewals: <path d="M20 11.5A8 8 0 0 0 5.6 7M4.5 3.5V7H8M4 12.5A8 8 0 0 0 18.4 17M19.5 20.5V17H16" />,
  dashboard: <path d="M4 4v16h16.5M7.5 15.5l3.5-4.5 3 2.5L19 8" />,
  notes: <><path d="M7 3h7l4.5 4.5V19.5A1.5 1.5 0 0 1 17 21H7a1.5 1.5 0 0 1-1.5-1.5v-15A1.5 1.5 0 0 1 7 3z" /><path d="M14 3v4.5h4.5M9 12.5h6M9 16h6" /></>,
  memory: <><path d="M12 5.5A3 3 0 0 0 6.4 4.3 3.2 3.2 0 0 0 4 9a3.3 3.3 0 0 0 .3 5.3A3.2 3.2 0 0 0 7.5 18.8 2.7 2.7 0 0 0 12 17.5z" /><path d="M12 5.5a3 3 0 0 1 5.6-1.2A3.2 3.2 0 0 1 20 9a3.3 3.3 0 0 1-.3 5.3 3.2 3.2 0 0 1-3.2 4.5A2.7 2.7 0 0 1 12 17.5" /><path d="M8.5 10.5c1.3 0 2.3.6 2.3 1.7M15.5 9c-1.3 0-2.3.7-2.3 1.8" /></>,
  people: <><circle cx="9" cy="8" r="3.2" /><path d="M3 20c0-3.2 2.7-5.5 6-5.5s6 2.3 6 5.5M15.5 5.1a3.2 3.2 0 0 1 0 5.8M17.5 14.9c2.1.8 3.5 2.7 3.5 5.1" /></>,
  reference: <><path d="M6.5 3H18a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H6.5A1.5 1.5 0 0 1 5 19.5v-15A1.5 1.5 0 0 1 6.5 3z" /><path d="M8.5 3v18M12 8h4M12 11.5h4" /></>,
  ops: <><rect x="3.5" y="3.5" width="17" height="5" rx="1.2" /><rect x="3.5" y="9.5" width="17" height="5" rx="1.2" /><rect x="3.5" y="15.5" width="17" height="5" rx="1.2" /><path d={`${dot(7, 6)}${dot(7, 12)}${dot(7, 18)}`} /></>,
  sensors: <><path d="M10 5a2 2 0 0 1 4 0v8.6a4 4 0 1 1-4 0z" /><path d="M12 9.5v6" /><path d={dot(12, 16.8)} /></>,
  projects: <path d="M3.5 20.5l8.8-8.8M10.3 7.7l4.2-4.2 6 6-4.2 4.2z" />,
  procedures: <path d="M4.3 5.6l1.5-1v4.6M4.2 14.8a1.4 1.4 0 0 1 2.7.5c0 1.2-2.7 2-2.7 3.5H7M11 6.5h9.5M11 16.8h9.5" />,
  music: <><path d="M9 17.5V5.5l10-2v12" /><circle cx="6.5" cy="17.5" r="2.5" /><circle cx="16.5" cy="15.5" r="2.5" /></>,
  wiki: <><rect x="3.5" y="4" width="4.5" height="16" rx="1" /><rect x="9.75" y="4" width="4.5" height="16" rx="1" /><rect x="16" y="4" width="4.5" height="16" rx="1" /><path d="M3.5 8H8M9.75 8h4.5M16 8h4.5" /></>,
  images: <><rect x="3" y="7" width="15" height="12.5" rx="1.5" /><path d="M6.5 4h13A1.5 1.5 0 0 1 21 5.5v10.5M3.5 16.5l4-4 3 3 2.5-2 4.5 4.5" /><path d={dot(8, 10.5)} /></>,
  quiz: <><path d="M5.5 3.5h13A1.5 1.5 0 0 1 20 5v9.5a1.5 1.5 0 0 1-1.5 1.5H11l-4.5 4v-4h-1A1.5 1.5 0 0 1 4 14.5V5a1.5 1.5 0 0 1 1.5-1.5z" /><path d="M10 8a2 2 0 1 1 3 1.7c-.7.4-1 .8-1 1.5" /><path d={dot(12, 13.3)} /></>,
  layouts: <><rect x="3.5" y="4" width="17" height="16" rx="1.5" /><path d="M3.5 9.5h17M10 9.5V20" /></>,
  health: <path d="M12 20.5s-8-4.6-8-10.4a4.4 4.4 0 0 1 8-2.5 4.4 4.4 0 0 1 8 2.5c0 5.8-8 10.4-8 10.4z" />,
  logs: <><rect x="3.5" y="3.5" width="17" height="17" rx="2.5" /><path d="M9.3 12.3s-2.8-1.6-2.8-3.6a1.5 1.5 0 0 1 2.8-.8 1.5 1.5 0 0 1 2.8.8c0 2-2.8 3.6-2.8 3.6zM14.5 8.5H17M14.5 11.5H17M7 16h10" /></>,
  pet: <><path d="M12 12.5c-2.5 0-5 2.2-5 4.6 0 1.7 1.3 2.4 2.6 2.4 1 0 1.6-.5 2.4-.5s1.4.5 2.4.5c1.3 0 2.6-.7 2.6-2.4 0-2.4-2.5-4.6-5-4.6z" /><ellipse cx="6" cy="10.5" rx="1.5" ry="2" /><ellipse cx="9.5" cy="6" rx="1.5" ry="2" /><ellipse cx="14.5" cy="6" rx="1.5" ry="2" /><ellipse cx="18" cy="10.5" rx="1.5" ry="2" /></>,
  food: <path d="M6 3v5a3 3 0 0 0 6 0V3M9 3v18M17.5 21V3c-2 1.5-3.2 4.5-3.2 8.5h3.2" />,
  mail: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3.5 7.5L12 13.5l8.5-6" /></>,
  lists: <><rect x="3.5" y="3.5" width="17" height="17" rx="2.5" /><path d="M8 12.5l3 3 5.5-6.5" /></>,
  games: <><path d="M7.5 7h9a5 5 0 0 1 4.9 4l.9 4.5a2.6 2.6 0 0 1-4.6 2.1L15.5 15h-7l-2.2 2.6a2.6 2.6 0 0 1-4.6-2.1l.9-4.5A5 5 0 0 1 7.5 7z" /><path d={`M7.5 9.8v3M6 11.3h3${dot(15.5, 10.5)}${dot(17.5, 12.5)}`} /></>,
  films: <><rect x="3.5" y="4" width="17" height="16" rx="2" /><path d="M8 4v16M16 4v16M3.5 9H8M3.5 15H8M16 9h4.5M16 15h4.5" /></>,
  // Headphones: what you listen to (the Apple apps' symbol is headphones too). Song ideas keep the note.
  listening: <><path d="M4 16.5v-4a8 8 0 0 1 16 0v4" /><rect x="3.5" y="14" width="4" height="6.5" rx="1.5" /><rect x="16.5" y="14" width="4" height="6.5" rx="1.5" /></>,
  calc: <><rect x="5" y="3" width="14" height="18" rx="2" /><path d={`M8.5 7.5h7${dot(8.5, 12)}${dot(12, 12)}${dot(15.5, 12)}${dot(8.5, 16.5)}${dot(12, 16.5)}${dot(15.5, 16.5)}`} /></>,
  status: <path d="M3 12h4l2.5-6.5 4 13 2.5-6.5h5" />,
};

/** A screen nobody drew yet (a newer hub's): a plain rounded square, so the place still has something to press. */
const UNKNOWN = <rect x="4" y="4" width="16" height="16" rx="3" />;

export function ScreenIcon({ id }: { id: string }) {
  return (
    <svg className="screen-icon" viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      {SCREEN_ICONS[id] ?? UNKNOWN}
    </svg>
  );
}
