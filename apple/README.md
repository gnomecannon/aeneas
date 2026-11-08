# Aeneas for iPhone, iPad, Mac and Apple Watch

The app is called Aeneas (on the App Store: Aeneas: Mind Workbench). The project, targets, schemes and folders keep the working name EverythingApp, which existing installs and settings depend on.

One SwiftUI codebase. The contract in `packages/shared/CONTRACT.md` is the source of truth; this client implements it as written.

## Layout

- `project.yml`: the xcodegen project definition. The `.xcodeproj` is generated and git-ignored.
- `Packages/EACore`: local Swift package shared by every target. Models (`Entity`, `Patch`, every kind as a Codable struct with the contract's field names), `HubTransport` with `HTTPTransport` (direct, iPhone, iPad, Mac) and `WatchRelayTransport` (through the iPhone), `HubClient` (every route, SSE readers for `/live` and `/ai/chat/stream` over HTTP), `SyncStore` (SQLite via the C API, tables `entities`, `outbox`, `meta`), `SyncEngine` (offline-first coordinator), `ReminderPlanner` and `ReminderScheduler` (local notifications), `RepeatRule` (repeat grammar), `StyleGuard` (display-side style filter), `Classifier` (offline capture classifier), `SharedConfig` (app group config and the Now snapshot for widgets).
- `EverythingApp`: the iPhone, iPad and Mac app. Today (digest, Now card, timeline, renewals due soon, free slots with Schedule here), Week (day list on iPhone, seven-column grid on iPad and Mac), Renewals (watches grouped overdue, next 30 days, later, with Renewed), Plan rules under Settings. Mac adds a menu bar extra, a floating quick-capture panel and the Control+Option+Space hotkey.
- `EverythingApp Watch`: the watchOS app (Now, one-tap activity tracker, capture with confirm, weight with the Digital Crown).
- `EverythingAppWidgets`: iOS and macOS WidgetKit small and medium widgets.
- `EverythingAppWatchWidgets`: watch face complications (circular, rectangular, inline).
- `Shared`: App Intents used by both apps (Capture, Log Weight, Mark Now Done, Start Activity; Configure Hub on the phone only).
- `screenshots`: simulator screenshots of Setup, Now, Today, Week (iPhone and iPad), Renewals and Plan rules.

Bundle ids: `$(EA_BUNDLE_PREFIX).everythingapp`, `.watchkitapp`, `.widgets`, `.share`, `.watchkitapp.watchwidgets`. App group: `group.$(EA_BUNDLE_PREFIX).everythingapp`. Both come from `Signing.xcconfig`, which holds this project's own team (`EA_TEAM_ID`) and prefix (`EA_BUNDLE_PREFIX = com.gnomecannon`). The code reads the app group from each target's Info.plist (`EAAppGroup`), so nothing else names them.

## Build it yourself

Anyone can build and change the Apple apps (the code is AGPL-3.0, see `LICENSE`; a copy you share goes under its own name, see `TRADEMARKS.md`). What you need, all from Apple:

- A Mac with Xcode 26.6 or newer, and xcodegen (`brew install xcodegen`).
- An Apple account signed in to Xcode (Xcode, Settings, Accounts). A free account works for your own devices, but apps it signs stop opening after 7 days until you build and install again, and it allows only a few apps at a time. The paid Apple Developer Program ($99 a year) makes an install last a year.
- Your own hub to pair with (see the main README).

Steps:

1. `cd apple`, then `cp Signing.local.xcconfig.example Signing.local.xcconfig`. Git ignores the copy, so your values never end up in a commit.
2. In `Signing.local.xcconfig`, set `EA_TEAM_ID` to your team's 10-character id (Xcode, Settings, Accounts, select the team) and `EA_BUNDLE_PREFIX` to a reverse-domain name of your own, such as `io.github.yourname`. Every bundle id and the app group are built from it, and they must be unique across Apple.
3. `xcodegen generate`, then `open EverythingApp.xcodeproj`, pick the `EverythingApp` scheme and your device, and Run. Xcode registers your ids and app group the first time.
4. Pair it with your hub as in step 4 below. Change anything you like and Run again; the Watch app installs with the iPhone app.

Features that need a paid account or Apple's approval for a capability may not build with a free account; if Xcode reports a capability it cannot add, remove that capability's entry from `project.yml` (and its module will simply not ask for it).

## Generate the project

Requires Xcode 26.6 and xcodegen 2.45 or newer.

    cd apple
    xcodegen generate
    open EverythingApp.xcodeproj

Build settings that xcodegen normally fills from its preset bundle are written out in `project.yml`, so generation works even when that bundle is missing.

## Select the team and run on a device

1. Sign in to Xcode with the Apple ID that owns the team in `Signing.xcconfig` (`EA_TEAM_ID`), or yours from `Signing.local.xcconfig` (Xcode, Settings, Accounts). Without a signed-in account Xcode cannot create provisioning profiles, and `xcodebuild` fails with "No profiles for" the app's bundle id.
2. Signing is automatic and the team is already set on every target. Xcode registers the app group, HealthKit and the bundle ids the first time you build for a device.
3. Select the `EverythingApp` scheme and your iPhone, iPad or Mac, then Run.
4. First launch shows Setup. Each device gets its own key from a one-time pairing code (8 characters, works once, for 10 minutes). On a device that is already paired, Settings, Connection, Pair another device shows the code in large text and as a QR code; on a new hub the Welcome page shows one. Scan it with the Camera (it opens `everythingapp://setup?hub=&code=&name=`), or type the hub address and the code on the Setup screen. The app trades the code at `POST /devices/claim` for its key, keeps the key in the Keychain (`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`, never synced, shared with the widgets, share extension and intents through the app group as the keychain access group; the data protection keychain on the Mac), registers, syncs and shows Today. A link may carry `fp=` (the SHA-256 of the hub's certificate); with an https hub only that certificate is then accepted. The `Configure Hub` intent takes the hub address, a pairing code and a name.
   - An older link with `&token=` still works: the token is traded at once (`POST /devices/exchange`) and never stored. Only a hub too old to trade it (404) or one out of reach leaves it in use, and the app trades it later.
   - An install paired before device keys trades the shared token on its next start, keeping its device id, then deletes it; the iPhone also trades for its Watch. Offline or an older hub: the token keeps working quietly and the trade is tried again later.
   - The Watch never holds a key. The iPhone keeps one for it (traded with the shared token, or claimed with a one-time code made with the iPhone's own key) and relays the Watch's requests with it, so the Watch is a device of its own on the hub.
   - Settings, Connection, Devices lists every paired device with Remove. A removed device gets 401 `device_removed` and shows "This device was removed" with Pair again; its key is deleted.
5. Permissions are asked only for modules that are on, never at launch. Right after pairing, once the modules are known, one screen lists what they need (notifications, microphone, speech, Reminders, Calendars, Contacts, Health, Photos) in plain words with the modules each is for; Continue asks each in turn, Not now asks nothing. A module switched on later (Settings, Modules, or another device over `/live`) offers its own. Otherwise a feature asks only from its own screen, when you tap something that needs it (the mic button, Allow calendar access, Sync with Apple Reminders, Sync Apple Contacts, Health Send now, Save to Photos, Settings, Notifications).

No arbitrary loads: plain `http://` is allowed only to a local hub (`NSAllowsLocalNetworking`: IP addresses, unqualified names, `.local`) and to Tailscale names under `ts.net`, whose traffic WireGuard encrypts. The Watch has no transport exceptions (it never reaches the hub itself).

Files on the iPhone, iPad and Watch carry an explicit data protection class: the sync store (and its WAL files), the Spotlight list and the Watch hum queue are complete until first user authentication (widgets, background refresh, the Watch relay and notification actions use them while locked); image caches, chat copies, shared items waiting to send, unsent hums, MIDI and wiki attachments are complete; a hum being recorded and an import being uploaded are complete unless open. The Mac relies on FileVault.

## Install the Watch app

The Watch app is embedded in the iPhone app and installs with it through the Watch app on the phone (My Watch, Available Apps). There is nothing to configure on the wrist. The Watch cannot reach the hub itself (the hub is only on the tailnet, Watch traffic does not pass through the iPhone's VPN, and the Watch cannot resolve MagicDNS names), so every hub call from the Watch is relayed through the iPhone app over WatchConnectivity (`WatchRelayTransport` and `WatchLink` in EACore): the Watch packs `{id, method, path, query, body}` into a message, the phone performs the HTTP call with its own hub URL and token and answers with `{status, data}`. The Watch registers itself as platform `watch`, named `<phone device name> Watch` (the phone fills the name in). Relays are not gated on `isReachable` (it lags; sending from an active Watch app wakes the phone app). When the phone is out of reach the Watch shows "iPhone not reachable", keeps its outbox, and retries; tapping that line opens a diagnostics sheet (session state, reachability, companion app, last relay error, and a Try now button that runs `GET /health` through the relay). Both sides log under subsystem `com.gnomecannon.everythingapp`, category `watchlink` (method and path only, never bodies or the token). Registration reuses an existing `device` row for the platform (and name on the phone) before posting `/devices/register`, so a lost reply does not create duplicate rows; it polls `/sync/changes` on foreground and every 60 s while active instead of streaming `/live`. Requests over about 60 KB are refused by the relay, which only matters for photo attachments, and those are never sent from the Watch. The phone activates its WatchConnectivity session in `application(_:didFinishLaunchingWithOptions:)`, so relayed requests work even when iOS launches the phone app in the background for them. Add the Now complication from the watch face editor; the circular one is a tap target for capture.

## Work calendar (iPhone and iPad)

Settings, Work calendar: allow calendar access, then tick the calendars that are work. On first run Exchange calendars are preselected, plus any calendar whose account contains the domain of the email in the `identity` fact keyed `job`; otherwise nothing is preselected and the list is shown. Each occurrence from 7 days back to 30 days ahead becomes an `event` in the `work` space with `source: eventkit` and `external_id` = `eventIdentifier|ISO start`, carrying only title, start, end and all_day. Location, notes, URL and attendees are never stored or sent; cancelled and declined meetings are skipped. Occurrences that vanish inside the window, or whose calendar is unticked, are soft-deleted; meetings that age out of the back of the window are kept as history. The import runs on launch, on foreground, 5 s after the Calendar store changes, and in the `<bundle id>.calendar` background refresh task. Work events show with a Work chip in Today and Week and count as busy time in the local planner.

Simulator check (Debug builds): `xcrun simctl privacy booted grant calendar com.gnomecannon.everythingapp`, then `xcrun simctl launch booted com.gnomecannon.everythingapp -EASeedWorkCalendar YES -EASection settings -EASettingsFocus workCalendar` creates a local "Work (simulator)" calendar with two events, selects it and opens the section.

## Mac

The Mac build is sandboxed, with network client, microphone (push-to-talk dictation) and the app group. The menu bar item shows the Now task and a capture field. Control+Option+Space opens the floating capture panel from any app. The hotkey is a Carbon `RegisterEventHotKey`, so it needs no accessibility permission.

## TestFlight

Archive the `EverythingApp` scheme (Product, Archive) with the Distribution certificate `Apple Distribution: <your name> (<team id>)` and upload through the Organizer. The watch app and both extensions are included in the archive. The macOS build needs a separate archive from the same scheme with My Mac selected. Bump `MARKETING_VERSION` and `CURRENT_PROJECT_VERSION` in `project.yml` before each upload.

## Verify from the command line

    cd apple/Packages/EACore && swift test
    cd apple
    xcodebuild -project EverythingApp.xcodeproj -scheme EverythingApp -destination 'platform=iOS Simulator,name=iPhone 17 Pro' CODE_SIGNING_ALLOWED=NO build
    xcodebuild -project EverythingApp.xcodeproj -scheme EverythingApp -destination 'platform=macOS,arch=arm64' CODE_SIGNING_ALLOWED=NO build
    xcodebuild -project EverythingApp.xcodeproj -scheme 'EverythingApp Watch' -destination 'platform=watchOS Simulator,name=Apple Watch Series 11 (46mm)' CODE_SIGNING_ALLOWED=NO build
    xcodebuild -project EverythingApp.xcodeproj -scheme EverythingAppWidgets -destination 'platform=iOS Simulator,name=iPhone 17 Pro' CODE_SIGNING_ALLOWED=NO build
    xcodebuild -project EverythingApp.xcodeproj -scheme EverythingAppWatchWidgets -destination 'platform=watchOS Simulator,name=Apple Watch Series 11 (46mm)' CODE_SIGNING_ALLOWED=NO build

The setup URL has a UI test that also answers the "Open in Aeneas?" prompt iOS shows for scheme URLs opened from outside the app (which is why a bare `xcrun simctl openurl` stops at that prompt):

    xcodebuild -project EverythingApp.xcodeproj -scheme EverythingApp -destination 'platform=iOS Simulator,name=iPhone 17 Pro' -derivedDataPath ~/Library/Caches/everythingapp-dd-test CODE_SIGNING_ALLOWED=NO -only-testing:EverythingAppUITests test

Every device build gets a fresh build number so watchOS picks up the embedded Watch app: run `xcrun agvtool new-version -all $(date +%Y%m%d%H%M)` in `apple/` after `xcodegen generate` and before building (the project uses apple-generic versioning; `CFBundleShortVersionString` stays 0.1.0).

Keep DerivedData outside iCloud Drive (for example `-derivedDataPath ~/Library/Caches/everythingapp-dd-test`): the repo lives in Documents and codesign rejects file-provider attributes on products built there.

`CODE_SIGNING_ALLOWED=NO` is only for simulator and local checks; the project itself stays on automatic signing with the real team. Unsigned builds cannot use the app group, so the store and config fall back to the app's own container in that case.

## Behaviour notes

- The device registers exactly once per configure and reuses the stored device id on later launches; concurrent sync and configure calls share one in-flight registration.
- Every edit is a `Patch` with `ts = now`, applied locally at once and queued in the outbox; the outbox is flushed whenever the hub answers, then `/sync/changes` is pulled until `more` is false. `/live` is held open with the bearer header and reconnects with backoff up to 30 s. A rejected patch drops the queued patches for that entity and reloads it from the hub.
- Capture goes through `POST /capture` when online (Save and sort sends `auto: true`); offline it becomes a local `capture` entity with a locally suggested kind and is pushed later.
- Reminders are planned into `UNUserNotificationCenter` on every sync from `at`, `snoozed_until` and `repeat`. Notification actions are Ack and Snooze 10 min; when friction is `reason` the snooze action has a text box for the reason (typed, dictated, or Scribble on the Watch), and an empty one opens the app's reason sheet.
- Dictation is push-to-talk: it transcribes only while the button is held and the transcript lands in the field for review. Nothing is sent until you tap Save. On the Watch the transcript goes to a confirm screen first.
- Notes: folders nest (Writing, then Comedy, then Sketches) and start collapsed; the ones opened stay open on the device. Ideas (notes tagged `idea`) are grouped by form above the folders. Tags and links come from the hub's note linker and title mentions, never typed; the editor shows Related (links, backlinks, similar). The tags field is sent only when it was changed there, so tags the linker adds while a note is open are kept.
- Display text runs through `StyleGuard` (em and en dashes become commas, filler stripped) plus any active filter rules from Memory.
- Planner (Module 1): Today and Week load `GET /planner/today` and `GET /planner/week` when the hub answers; otherwise `LocalPlanner` in EACore computes the same shape from the local store (day window 09:00 to 23:00, minus plan rule blackouts and commitments, task blocks and events) and the screen says "Planned on this device". Schedule here posts `/planner/schedule` with 3 h; a 409 comes back as `HubError.conflict` with the conflicting block, commitment or blackout and the picker offers Schedule anyway (`force`). Offline, the block is checked against local rules and patched locally. Renewed uses `/watches/:id/renewed` online and rolls `due` by `repeat` locally otherwise.
- Activity check-in: `notify` events of kind `activity` on `/live` (and, on the Watch, a new entry on the running activity log's `checkins` found by the 60 s poll) show a banner "On <value> for <h> h" with Still on it and Stop (Stop writes the `end` log). Starting an activity also schedules a local notification 3 hours later (category `EA_ACTIVITY`, actions Still on it and Stop) that the end log cancels, so the question is asked with no hub. `notify` kind `digest` becomes a local notification with the digest's first line that opens `everythingapp://today`.
- URL paths: `everythingapp://today`, `week`, `renewals`, `now`, `reminders`, `capture?text=`, `setup?hub=&code=&name=` (and `&fp=`; the older `&token=` is traded at once). The launch argument `-EASection week` (any `Section` raw value) opens that screen first, for screenshots and UI tests.
- The medium iOS widget shows the next block today under the Now task when there is one (`SharedConfig.nextBlockTitle` and `nextBlockStart`, written with the Now snapshot).


## Building from this folder

This repo lives under Documents, which is an iCloud Drive folder. The file provider adds extended attributes to build products there and codesign rejects them ("resource fork, Finder information, or similar detritus not allowed"). Always build with DerivedData outside iCloud, for example `-derivedDataPath ~/Library/Caches/everythingapp-dd`. Xcode's default DerivedData location is fine too.
