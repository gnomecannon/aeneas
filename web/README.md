# EverythingApp web client and Windows desktop wrapper

One codebase, two targets:

- Web: a Vite + React 18 + TypeScript bundle, served from any origin on the tailnet (normally the hub itself at `https://<hub>/app/`). It is an installable PWA: manifest, service worker with an offline shell, iOS home screen meta tags.
- Windows: the same bundle inside a Tauri 2 shell with a tray icon, a global capture hotkey, a pinned always-on-top mini window, native reminder notifications, start-on-login and a zero-typing setup file.

Everything reads from a local IndexedDB copy (Dexie) and works with the hub unreachable. Edits go to an outbox and flush when online. The hub is authoritative; the contract in `packages/shared/CONTRACT.md` is the only assumption made about it.

## Prerequisites

- Node 20 or newer, npm 10.
- For the Windows build: Rust stable (1.77 or newer), the MSVC build tools (Visual Studio Build Tools with the C++ workload), and WebView2 (preinstalled on Windows 10 and 11). See https://tauri.app/start/prerequisites/ for the current list.

Install once from the repository root so the npm workspace links `@everythingapp/shared`:

```
cd <repo>
npm install
```

## Run

From `web/`:

```
npm run dev          # web client on http://localhost:5173
npm run mock-hub     # in-memory stand-in for the hub on http://localhost:8787, token "dev" (EA_PORT=8790 npm run mock-hub if 8787 is taken)
npm run serve-dist   # after npm run build: the production bundle under http://localhost:8788/app/, mounted like the hub does it
```

Open http://localhost:5173, enter the hub URL and token on the setup screen, press Test, then Save. The mock hub seeds tasks, reminders, notes, logs, facts, rules and captures, and implements every route the client uses, including `/live` SSE, `/ai/chat/stream`, the knowledge-map routes, the 422 snooze rule, `/status`, `/metrics/proof`, `/reminders/due`, the `device_id` query parameter on `/sync/changes` and `/live`, and Module 1: `/planner/today` (with a digest), `/planner/week`, `/planner/schedule` (409 on overlap unless `force`), `/planner/unschedule`, `/watches/:id/renewed`, the `watch` and `plan_rule` kinds (a watch write links its `Renew: <title>` reminder, as the hub does), and the seeded plan rules, watches, events and an open activity log. `EA_MOCK_BACKUP_AGE_H=40` makes it report a stale backup so the Status warning shows. An `activity` notify is emitted `EA_MOCK_ACTIVITY_DELAY_S` (default 20) seconds after start; `GET /planner/today?activity=1` and `GET /planner/today?digest=1` emit an activity or digest notify on demand so the banner and toast can be exercised. It keeps nothing on disk; restart it and clear local data from Settings if the seq cursor gets ahead of it.

The service worker is only registered in production builds, so PWA behaviour is checked with `npm run build` and `npm run serve-dist`, not with `npm run dev`.

Desktop development with the Tauri shell (needs the Rust toolchain):

```
npm run tauri dev
```

## Build

```
npm run typecheck    # tsc, no emit
npm run test         # vitest: sync merge and outbox flush tests, planner helpers (rules, free slots, grid placement, watch grouping, digest)
npm run build        # typecheck + vite build into dist/
```

Serve `dist/` from the hub or any static host. Every path in the bundle is relative (`base: "./"`), so it works mounted under a subpath such as `/app/`; the host must serve `sw.js`, `manifest.webmanifest` and `icons/` from the same directory as `index.html` and fall back to `index.html` for unknown paths under the mount. The client calls the hub at the URL entered in Setup, so the hub must either serve the bundle on the same origin or send CORS headers for the client origin (`Authorization` and `Content-Type` request headers, `GET, POST, PUT, PATCH, DELETE, OPTIONS`). The Tauri shell loads from `http://tauri.localhost` on Windows and always needs CORS.

### PWA

- `public/manifest.webmanifest`: name EverythingApp, short name Everything, `display: standalone`, `start_url: ./#/now`, `scope: ./`, icons 192 and 512 (plus a maskable 512) from `public/icons/`, colours from the design tokens.
- `sw/sw.js` is the service worker source. The `ea-service-worker` plugin in `vite.config.ts` writes `dist/sw.js` with the precache list (index.html, every hashed asset, manifest, icons) and a version hash. Navigations and `index.html` are network first with the cached copy as the offline fallback; hashed assets are cache first; manifest and icons are cache first with a background refresh; nothing outside the mount (`/sync`, `/live`, `/health`, every API route) is intercepted.
- Updates: a newer worker installs and waits, the client shows an "Update available" toast, Reload posts `SKIP_WAITING` and the page reloads once the new worker controls it. The worker also checks for updates when the tab becomes visible and hourly.
- `src/pwa.ts` registers `./sw.js` with scope `./` (so `/app/sw.js` with scope `/app/` on the hub), captures `beforeinstallprompt` for the Install button in Settings, and exposes the shell version and a manifest check that Settings shows under App.
- iOS: `apple-mobile-web-app-capable`, `apple-mobile-web-app-status-bar-style` and an `apple-touch-icon` are set in `index.html`; install with Share then Add to Home Screen.
- Icons: `npm run icon` regenerates the Tauri source icon and the PWA icons with `scripts/make-icon.mjs` (no dependencies), then runs `tauri icon`.

### Windows build

On the Windows machine, from `web/`:

```
npm run tauri build
```

Produces an `.exe` installer and an `.msi` under `src-tauri/target/release/bundle/`. The identifier is `com.gnomecannon.everythingapp`, product name EverythingApp. To only check the Rust side compiles:

```
cd src-tauri
cargo check
```

Icons live in `src-tauri/icons/`. Regenerate them with `npm run icon` (writes a 1024 px source PNG and the PWA icons with `scripts/make-icon.mjs`, then runs `tauri icon`).

### Zero-typing setup on Windows

On startup, when no hub URL or token is stored, the desktop shell reads a setup file from the Tauri app config directory:

```
%APPDATA%\com.gnomecannon.everythingapp\config.json      (Windows, normally C:\Users\<you>\AppData\Roaming\com.gnomecannon.everythingapp\config.json)
~/Library/Application Support/com.gnomecannon.everythingapp/config.json   (macOS)
```

```json
{ "hub_url": "https://hub.your-tailnet.ts.net:8787", "token": "<EA_TOKEN>", "device_name": "Desk PC" }
```

The values are applied as if Setup had been saved. Once the hub answers `/health`, the file is rewritten without `token` (the token lives only in the app's IndexedDB from then on). If the hub is not reachable yet, the token stays in the file and the next start retries. Settings shows the resolved path, the last result, and a button to read the file again. Access goes through the Tauri fs plugin scoped to exactly `$APPCONFIG/config.json` (read, write, exists), see `src-tauri/capabilities/default.json`.

## Layout

```
src/sync/       Dexie schema, merge rules, hub client, sync engine, edit helpers, hooks
src/views/      Today, Now, Week, PlanRules, Renewals, Capture, Inbox, Tasks, Reminders, Notes, NotesMap, Logs, Memory, Assistant, Search, Status, Settings, Setup
src/components/ Shell (rail and bottom tabs), status dot, reminder banner, activity banner and digest toast, timeline, task picker, update toast, markdown, sparkline
src/lib/        time, planner helpers (local dates, plan rules, free slots, grid placement, watch grouping, digest), markdown, reminders, hash router, keyboard shortcuts, entity links
src/pwa.ts      service worker registration, update flow, install prompt
src/tauri/      bridge to the Tauri APIs (no-ops in a browser) and the setup file logic
sw/             service worker source (built into dist/sw.js)
public/         manifest, icons, favicon
src-tauri/      Rust shell: tray, hotkey, pinned mode, capture window, autostart, window state, fs plugin
scripts/        mock-hub.ts, make-icon.mjs, serve-dist.mjs
screenshots/    Status, Today, Week, Renewals, Health, Pet, Sensors, Food at desktop and 390 px, the activity and sensor banners, PWA and module check lists
```

## Behaviour notes

- Sync: register once, pull `/sync/changes` until `more` is false, then hold `/live` open with a bearer header (manual SSE parsing over `fetch`, since `EventSource` cannot send headers) and pull on every `change` event. Reconnect with backoff from 1 s to 30 s.
- Edits apply to IndexedDB first, then queue a patch with `ts = now`. Patch timestamps are strictly increasing within the process so two writes to one field in the same millisecond cannot collide under the hub's `ts > field_ts` rule. On `rejected`, the entity is refetched.
- Reminders due are computed locally every 30 s from `at`, `snoozed_until` and `acknowledged_at`; the banner is non-blocking and the Tauri shell also fires a native notification. The strip at the top of Now uses `GET /reminders/due?within=720` when the hub has it (refreshed every 60 s and whenever a reminder changes, ids mapped back onto the local copies) and falls back to the local "due today" computation otherwise.
- Status view: `GET /status` and `GET /metrics/proof?days=14`, refreshed every 60 s while the tab is visible. Shows hub version and uptime, database size and seq, entity counts, devices with relative last-seen times, the latest backup with a warning past 30 h, AI backends and 24 h call stats, the next due reminder and unsorted captures, then the 14-day proof table (tiny inline SVG bars) and the friction list with links to each item. A hub without these routes gets a "not available on this hub" note instead of an error.
- `device_id` is sent as a query parameter on `/sync/changes` and `/live` once the device is registered, so the hub can keep `last_seen` current.
- Today: `GET /planner/today`, refreshed every 60 s while visible and whenever the sync cursor moves (a `change` event). The digest as plain lines, the Now card, a renewals strip for watches due within 30 days, then the day as a vertical timeline: commitments (blackouts hatched), task blocks, events from the local store, reminders inline at their times, the current time marker and free slots with Schedule here, which opens a picker of `next` tasks; one tap calls `POST /planner/schedule` with 3 h. A 409 shows the conflicting item inline with a Schedule anyway button. With the hub unreachable the same shape is computed from the local copy (`src/sync/planner.ts`) and the view says so.
- Week: `GET /planner/week?start=`. Desktop: a seven-column grid, rows are the hours from 09:00 to 23:00, blackouts hatched, commitments grey, preferences dashed, blocks as cards (click opens the task, drag moves it, x unschedules), events, reminders as dots, free slots with a plus that opens the picker, the current time line, and a sidebar of unscheduled `next` tasks that drag onto the grid (dropped at the half hour under the pointer, `force` false, 409 shown inline). Phone: a day switcher and the day's timeline; each free slot's Schedule button opens the picker. Previous and next week, This week, and a link to the plan rules.
- Renewals: `watch` entities grouped into overdue, next 30 days and later, with category chip, due date and days left, cost, lead days, the linked reminder's state, probe status for certificates, and a Renewed button (`POST /watches/:id/renewed`, hub only). Create and edit go through the entity path, so they work offline; the hub links the Renew reminder when it sees the watch.
- Plan rules (`#/plan-rules`, linked from Week and Settings): `plan_rule` entities with title, type, days as toggle chips, start and end, an alternating anchor date for every-other-week rules, note and active.
- Notify events on `/live`: `activity` shows a non-blocking banner with Still on it (dismiss) and Stop (`POST /log` with `note: end`, or the entity path offline); `digest` shows a toast with the first digest line and a link to Today. Under Tauri both also fire a native notification.
- Keyboard (desktop widths): `t` goes to Today, `w` to Week, `c` opens Capture and focuses the textarea, `n` goes to Now, `/` focuses search, `Escape` closes the reminder banner, the update toast and open task or reminder editors. Letters are ignored while typing in a field. In Tasks, `next` items have Move up and Move down buttons and accept `Alt+Up` and `Alt+Down`, as the keyboard alternative to dragging.
- Accessibility: every button has an accessible name, focus rings are visible on links, buttons, summaries and the map nodes, the status dot text uses `--text-2` (at least 4.5:1 on both backgrounds, checked by `src/lib/contrast.test.ts`), and `prefers-reduced-motion` disables transitions.
- Mobile: the layout uses `100dvh` and `env(safe-area-inset-bottom)`; while the on-screen keyboard is up (visual viewport much shorter than the layout viewport) the bottom tab bar is hidden so it cannot cover the capture Save button. The proof table switches to short column labels under 480 px so it fits 390 px without a horizontal scroll.
- Offline fallbacks: capture, convert, snooze, ack, search, related notes and the map all have local versions that run from the IndexedDB copy when the hub is unreachable.
- Windows: Ctrl+Shift+Space opens the capture window. The tray menu has Show, Capture, Pin mini window and Quit. Closing the main window hides it to the tray. Pinned mode is 360 x 600, always on top, no decorations.
