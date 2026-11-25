# Aeneas for iPhone, iPad, Mac and Apple Watch

The app is called Aeneas (on the App Store: Aeneas: Mind Workbench) and is built as Aeneas.app. The project, targets, schemes, folders and the app's Swift module keep the working name EverythingApp, which existing installs and settings depend on.

One SwiftUI codebase. The contract in `packages/shared/CONTRACT.md` is the source of truth; this client implements it as written.

## Targets

`project.yml` is the xcodegen definition; the `.xcodeproj` it makes is git-ignored and never edited by hand. Minimum systems: iOS and iPadOS 18, macOS 15, watchOS 11.

| Target | Runs on | What it is |
| --- | --- | --- |
| `EverythingApp` | iPhone, iPad, Mac | The app, from `EverythingApp/` and `Shared/`. The Mac build is for Apple silicon only (iroh's Mac library is arm64 only). |
| `EverythingAppWidgets` | iPhone, iPad, Mac | The Now widget (small and medium, with a Done button). On iPhone and iPad also its Lock Screen sizes and the Capture and Log controls, and on iPhone the Live Activity for a running activity or focus block. |
| `EverythingAppShare` | iPhone, iPad | The share sheet: text, a link or an image goes to Capture. What cannot reach the hub waits in the app group until the app sends it. |
| `EverythingApp Watch` | Apple Watch | One SwiftUI target, embedded in the iPhone app: Ask, Capture and Hum on the first page, then Now, Today, and with Health on Log, Activity and Weight. |
| `EverythingAppWatchWidgets` | Apple Watch | Complications: Now, Next up, and one tap Ask, Capture and Hum. |
| `EverythingAppUITests` | iPhone simulator | Pairing with a code, the removed screen, and setup links. |

Schemes: `EverythingApp` (the app with its extensions and the Watch app), `EverythingApp Watch`, `EverythingAppWidgets` and `EverythingAppWatchWidgets`.

## Packages and folders

- `Packages/EACore`: shared by every target. The contract's models (`Entity`, `Patch`, each kind as a Codable struct with the contract's field names), `HubClient` (every route; `/live` and `/ai/chat/stream` over HTTP), `HTTPTransport` and, on the Watch, `WatchRelayTransport`, `SyncStore` (SQLite through the C API), `SyncEngine` (offline first: the outbox, `/sync/changes` and `/live`), reminder planning, the local planner, `SharedConfig` (settings in the app group and the snapshot the widgets read), the Watch link and sample mode. Its tests run with `swift test`.
- `Packages/EALink`: Direct link for the iPhone, iPad and Mac app: a hub saved as `iroh://<hub key>` is reached over iroh. Swift Package Manager fetches n0's `iroh-ffi` at the pinned version and checks its framework against the pinned checksum.
- `Packages/EAWhisper`: the Watch app only. Captures written down on the Watch itself with Whisper, through argmax's WhisperKit at the pinned version (MIT, with Apache-2.0 parts), on Watches WhisperKit lists as able to run it (Series 9, Ultra 2 and later). The model is not in the app: the iPhone fetches its pinned files once and the Watch receives them over WatchConnectivity (`SpeechModel` in EACore). The Watch loads the model while its voice page is in front (`WatchSpeech.warm`), and tells the iPhone how long loading and hearing last took, as numbers only (`SpeechTimings`, in its WatchConnectivity application context; the iPhone's log, category `watchspeech`), so a real Watch can be read without having it at hand. `-EAWatchHearingBench YES` on a Debug Watch build times the models on the Watch with a bundled sample. Its tests (WhisperKit's device table) run with `swift test`.
- `Packages/EATailnet`: Tailscale inside Aeneas (Tailscale's libtailscale, as TailscaleKit) for the iPhone, iPad and Mac app. `TailscaleKit.xcframework` is not in git: `scripts/build-tailscalekit.sh` builds it from a pinned commit.
- `Shared`: in both the app and the Watch app. The App Intents for Siri, Shortcuts and the Action Button (Ask, Capture, Log Weight, Mood, Caffeine, Medication and Blood Pressure, Mark Now Done, Start Activity, Add Task, Complete Task; Configure Hub and Open Screen on iPhone, iPad and Mac), the Live Activity's attributes, and the choice of voice that answers are read aloud in.
- `EverythingApp/Resources`: `SampleHub.json` and `SampleMealsTax.json`, for sample mode.
- `screenshots`: simulator screenshots, and in `screenshots/app-store` the ones for the store listing.

## Build it yourself

Anyone can build and change the Apple apps (the code is AGPL-3.0, see `LICENSE`; a copy you share goes under its own name, see `TRADEMARKS.md`). You need:

- A Mac with Xcode 26.6 or newer, xcodegen 2.45 or newer (`brew install xcodegen`) and Go (`brew install go`, for TailscaleKit).
- An Apple account signed in to Xcode (Xcode, Settings, Accounts). A free account works for your own devices, but apps it signs stop opening after 7 days until you build and install again, and it allows only a few apps at a time. The paid Apple Developer Program ($99 a year) makes an install last a year.
- Your own hub to pair with (see the main README), or none at all to look around in sample mode.

Steps:

1. `cd apple`, then `scripts/build-tailscalekit.sh` once (again only when its pinned commit changes).
2. `cp Signing.local.xcconfig.example Signing.local.xcconfig` and put your team and prefix in the copy (see Signing).
3. `xcodegen generate`, then `open EverythingApp.xcodeproj`. Run `xcodegen generate` again after adding or removing a file.
4. Pick the `EverythingApp` scheme and your iPhone, iPad or Mac, then Run. Xcode registers your bundle ids and app group the first time. The Watch app installs with the iPhone app.

Features that need a paid account or Apple's approval for a capability may not build with a free account; if Xcode reports a capability it cannot add, remove that capability's entry from `project.yml` (its module then never asks for it).

Build settings that xcodegen normally fills from its preset bundle are written out in `project.yml`, so generation works even when that bundle is missing.

## Signing

`Signing.xcconfig` holds the project's own team (`EA_TEAM_ID`) and the prefix every id is built from (`EA_BUNDLE_PREFIX = com.gnomecannon`). Leave it as it is for your own copy: it includes `Signing.local.xcconfig` when that file exists, and the values there win. Git ignores the local file, so your values never end up in a commit.

- `EA_TEAM_ID`: Xcode, Settings, Accounts, your team, the 10 character Team ID (a free account has one too).
- `EA_BUNDLE_PREFIX`: a reverse-domain name of your own, such as `io.github.yourname`. Ids must be unique across Apple.

From the prefix come the bundle ids (`<prefix>.everythingapp`, `.widgets`, `.share`, `.watchkitapp` and `.watchkitapp.watchwidgets`) and the app group `group.<prefix>.everythingapp`, which the app, the widgets, the share extension and the Watch share, and which is also the Keychain access group for the device key. The code reads the app group from each target's Info.plist (`EAAppGroup`), so nothing else names it.

Signing is automatic. With no account signed in to Xcode, a device build fails with "No profiles for" a bundle id. `CODE_SIGNING_ALLOWED=NO` is only for compiling and local checks: an unsigned build cannot use the app group, so its store and settings fall back to the app's own container, and it cannot pair (KeychainRefused). For a simulator that pairs, build with `CODE_SIGN_IDENTITY=-`.

## Sample mode

With no hub, Setup offers Try it with sample data: the app runs on a made-up month, with no hub and no network. Every answer comes from `EverythingApp/Resources/SampleHub.json`, a recording of a demo hub whose dates move to the viewer's today, on whatever day it is read (`SampleTransport` in EACore); what had happened by the time it was recorded has happened by now (a 7:30 AM weigh-in read at 12:30 AM sits 10 minutes before the first time the sample was read that day), and the device's copy moves on with the days as the answers do, edits included (`SyncEngine.catchUpSample`). The bill splitter's Use my location reads `SampleMealsTax.json`. Edits stay on the device. Leaving sample mode (the Sample data banner) or pairing a hub wipes the sample and every change made to it. Apple Contacts, Calendar and Reminders stay off in sample mode, so no sample data reaches the device's own stores.

To record the sample again, follow the steps at the top of `Packages/EACore/Tests/EACoreTests/SampleRecorderTests.swift`; `SampleHubTests` then checks the recording on every day of the week.

## Pairing

First launch shows Setup. Each device gets its own key from a one-time pairing code (8 characters, works once, for 10 minutes). On a device that is already paired, Settings, Connection, Pair another device shows the code in large text and as a QR code (on a Mac also the link, to copy); on a new hub the Welcome page shows one. Scan it with the Camera (it opens `everythingapp://setup?hub=&code=&name=`), or type the hub address and the code on the Setup screen. The app trades the code at `POST /devices/claim` for its key, keeps the key in the Keychain (`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`, never synced, shared with the widgets, share extension and intents through the app group; the data protection keychain on the Mac), registers, syncs and shows Today. A link may carry `fp=` (the SHA-256 of the hub's certificate); with an https hub only that certificate is then accepted. The `Configure Hub` intent takes the hub address, a pairing code and a name.

- An older link with `&token=` still works: the token is traded at once (`POST /devices/exchange`) and never stored. Only a hub too old to trade it, or one out of reach, leaves it in use until the app can trade it.
- The Watch never holds a key. The iPhone keeps one for it and relays the Watch's requests with it, so the Watch is a device of its own on the hub.
- Settings, Connection, Devices lists every paired device with Remove. A removed device hears `device_removed` and shows "This device was removed" with Pair again. Its key, its local copy and what the app kept from the hub go.

## Permissions and privacy

Permissions are asked only for modules that are on, never at launch. Right after pairing, once the modules are known, one screen lists what they need (notifications, microphone, speech recognition where it is used, Reminders, Calendars, Contacts, Health, Photos, location) in plain words with the modules each is for; Continue asks each in turn, Not now asks nothing. A module switched on later (Settings, Modules, or another device over `/live`) offers its own. Otherwise a feature asks only on its own screen, when you tap something that needs it.

No arbitrary loads: plain `http://` is allowed only to a local hub (`NSAllowsLocalNetworking`: IP addresses, unqualified names, `.local`) and to Tailscale names under `ts.net`, whose traffic WireGuard encrypts. A Direct link hub is reached over iroh. The Watch has no transport exceptions; it never reaches the hub itself.

Files on the iPhone, iPad and Watch carry an explicit data protection class: the sync store (and its WAL files), the Spotlight list and the Watch hum queue are complete until first user authentication (widgets, background refresh, the Watch relay and notification actions use them while locked); image caches, chat copies, shared items waiting to send, unsent hums, MIDI and wiki attachments are complete; a hum being recorded and an import being uploaded are complete unless open. The Mac relies on FileVault.

## Apple Watch

The Watch app is embedded in the iPhone app and installs with it (the Watch app on the iPhone, My Watch, Available Apps). There is nothing to set up on the wrist. Every hub call from the Watch is relayed through the iPhone app over WatchConnectivity (`WatchRelayTransport` and `WatchLink` in EACore): the Watch packs `{id, method, path, query, body}` into a message, and the iPhone performs it with its hub address and the Watch's key and answers with `{status, data}`; an answer too big for one message comes back compressed, in parts. Hums go as file transfers and wait in a queue on each side. The Watch reads `/sync/changes` on return to the screen and every 60 s while it is open instead of streaming `/live`, keeps its own outbox while the iPhone is out of reach and says so; tapping that line opens the relay diagnostics. The iPhone activates its WatchConnectivity session at launch, so relayed requests work when iOS starts the app in the background for them. When what the complications show (Now, the running activity, Next up) changes on the iPhone, it sends that to the Watch, which draws them again without waiting for its own sync. Both sides log under the target's bundle id, category `watchlink` (method and path only, never bodies or keys).

## Work calendar

Settings, Calendar and work: allow calendar access, then tick the calendars that are work. On first run Exchange calendars are preselected, plus any calendar whose account contains the domain of the email in the `identity` fact keyed `job`; otherwise nothing is preselected and the list is shown. Each occurrence from 7 days back to 30 days ahead becomes an `event` in the `work` space with `source: eventkit` and `external_id` = `eventIdentifier|ISO start`, carrying only title, start, end and all_day. Location, notes, URL and attendees are never stored or sent; cancelled and declined meetings are skipped. Occurrences that vanish inside the window, or whose calendar is unticked, are soft-deleted; meetings that age out of the back of the window are kept as history. The import runs on launch, on return to the app, 5 s after the Calendar store changes, and on iPhone and iPad in the `<bundle id>.calendar` background refresh task; the Mac imports the same meetings, keyed by the calendar server's id. Work events show with a Work chip in Today and Week and count as busy time in the local planner.

Calendar colors: every event the app brings in from Apple Calendar (the work import, the personal calendar's single events and repeating occurrences) or copies into it also carries `calendar_key`, `apple:<account>/<calendar>` (the calendar's source and title); an event from before gets it on its next sync. The app tells the hub which calendars it brings events from, with their own colors (`PUT /prefs/feel/calendars`), when one is new or changed and otherwise at most once a day. Today and Week draw each event in its calendar's color (the owner's choice in Settings, Theme, Calendar colors, else the calendar's own), with a light tint under the words and a solid bar, and an event on no calendar in the theme's accent.

Simulator check (Debug builds): `xcrun simctl privacy booted grant calendar com.gnomecannon.everythingapp`, then `xcrun simctl launch booted com.gnomecannon.everythingapp -EASeedWorkCalendar YES -EASection settings -EASettingsPage calendar` creates a local "Work (simulator)" calendar with two events, selects it and opens the page.

## Mac

The Mac app is sandboxed, with the hardened runtime. The menu bar item shows the Now task and a capture field. A global shortcut opens the floating Quick Capture panel from any app: Control Shift Space unless another is chosen in Settings, Privacy on this device (a Mac set up before the choice existed keeps Control Option Space). It is a Carbon `RegisterEventHotKey`, so it needs no accessibility permission. Debug builds take launch arguments for checks without clicking (`EverythingApp/Debug/DebugHooksMac.swift`).

Wide windows: a screen that is 1040 points wide or more (the part of the window beside the sidebar, so a window of about 1270 points) lays itself out for the width; below that every screen is as on the iPhone. Collections become grids of cards (People, Memory, Renewals, Lists, Games, Films, Projects, Snippets, the change journal, Procedures, Health, Sensors, Settings, Machines, Plan rules, Job applications, Unsorted Info, what Search finds), Tasks becomes a board with its statuses side by side as columns, the Logs blocks and the Tech Overview's parts sit side by side, Notes, the Wiki and the Assistant keep their list beside what is open (a chat is at most 980 points wide and a wiki page's text 900, so lines stay readable), Now shows its queue beside the task, Capture lists today's captures beside the box, and pages with many sections (a machine, a person, a project, a health measure, the pet, Food, Music) show two lists side by side. The helpers are in `EverythingApp/Views/UI.swift` (`WideLayout`, `WideReader`, `CardGrid`, `AdaptiveColumns`, `SplitList`). A list whose rows are swiped (delete, archive, park) becomes cards on the Mac only, where the same actions are in the right-click menu; on the iPad it stays a list at every width. `-EAWideLayouts NO` on a Debug build keeps the narrow layouts at any width.

## Verify from the command line

Keep DerivedData outside iCloud Drive (`-derivedDataPath`): this repository lives in Documents, and codesign rejects the file provider's attributes on products built there.

    cd apple/Packages/EACore && swift test
    cd apple
    xcodebuild -project EverythingApp.xcodeproj -scheme EverythingApp -destination 'generic/platform=iOS Simulator' -configuration Debug -derivedDataPath ~/Library/Caches/everythingapp-dd CODE_SIGNING_ALLOWED=NO build
    xcodebuild -project EverythingApp.xcodeproj -scheme EverythingApp -destination 'platform=macOS,arch=arm64' -configuration Debug -derivedDataPath ~/Library/Caches/everythingapp-dd CODE_SIGNING_ALLOWED=NO build
    xcodebuild -project EverythingApp.xcodeproj -scheme 'EverythingApp Watch' -destination 'generic/platform=watchOS Simulator' -configuration Debug -derivedDataPath ~/Library/Caches/everythingapp-dd CODE_SIGNING_ALLOWED=NO build

The UI tests also answer the "Open in Aeneas?" prompt iOS shows for scheme links opened from outside the app (which is why a bare `xcrun simctl openurl` stops at that prompt). They need a locally signed build (`CODE_SIGN_IDENTITY=-`, which needs no Apple account): an unsigned one cannot keep the device key in the Keychain, so pairing fails with KeychainRefused. The pairing test runs only with a hub and a fresh code (`POST /devices/pairing`, 10 minutes), on a simulator that is not paired yet:

    xcodebuild -project EverythingApp.xcodeproj -scheme EverythingApp -destination 'platform=iOS Simulator,name=iPhone 17 Pro' -derivedDataPath ~/Library/Caches/everythingapp-dd-test CODE_SIGN_IDENTITY=- -only-testing:EverythingAppUITests build-for-testing
    TEST_RUNNER_EA_HUB=http://127.0.0.1:8790 TEST_RUNNER_EA_CODE=ABCD-EFGH xcodebuild -project EverythingApp.xcodeproj -scheme EverythingApp -destination 'platform=iOS Simulator,name=iPhone 17 Pro' -derivedDataPath ~/Library/Caches/everythingapp-dd-test CODE_SIGN_IDENTITY=- -only-testing:EverythingAppUITests test-without-building

iCloud Drive can leave copies named like `File 2.swift` after a branch switch, and they break the build. Delete such a copy when git does not track it and it is the same as its original.

## Releases

`MARKETING_VERSION` and `CURRENT_PROJECT_VERSION` in `project.yml` are the version and build. Archive the `EverythingApp` scheme (Product, Archive) for iOS, which brings the Watch app and the extensions with it, and again with My Mac selected, then upload from the Organizer. Every device build needs a new build number for watchOS to pick up the embedded Watch app: run `xcrun agvtool new-version -all $(date +%Y%m%d%H%M)` in `apple/` after `xcodegen generate` and before building.

## Behaviour notes

- The device registers once per pairing and reuses its device id on later launches; sync and pairing at the same time share one registration.
- Every edit is a `Patch` stamped with the time it was made, applied locally at once and queued in the outbox; the outbox is sent whenever the hub answers, then `/sync/changes` is read until `more` is false. `/live` is held open with the device key and reconnects with backoff up to 30 s. A refused patch drops the queued patches for that item and reloads it from the hub; the refusal is kept in Settings until it is cleared.
- Capture goes through `POST /capture` with `auto: true` when the hub answers, under an id the device made, so a capture sent again after a lost reply is the one the hub already has; offline it becomes a local `capture` with `sort: true`, and the hub sorts it when it arrives. The share sheet works the same way and waits at most a few seconds before leaving it to the app.
- The Now widget's Done goes straight to the hub. One the hub does not take (out of reach, or a Direct link hub, which widgets cannot reach) waits in the app group, and the app's next sync sends it.
- Reminders are planned into `UNUserNotificationCenter` from `remind_at`, `snoozed_until` and `repeat`, after a sync or an edit and only when the plan changed. The alert actions are Done and Snooze 10 min; with friction `reason` the snooze action has a text box for the reason (typed, dictated, or Scribble on the Watch), and an empty one opens the app's reason sheet. The hub's announcement of a due reminder and the alert this device planned for that time are one alert.
- Dictation: tap the mic to start and again to stop; in the Assistant a pause after speaking can send (a setting), and on Capture Save also ends it. On iOS 26 and macOS 26 it runs on Apple's SpeechAnalyzer on the device and needs only the microphone; earlier systems use SFSpeechRecognizer, on the device when it can. Nothing reaches the hub until Save or Send.
- Use Claude (when the hub has a cloud model) is each chat's own choice, off for a new chat, as on the web.
- Notes: folders nest (Writing, then Comedy, then Sketches) and start collapsed; the ones opened stay open on the device. Ideas (notes tagged `idea`) are grouped by form above the folders. Tags and links come from the hub's note linker and title mentions, never typed; the editor shows Related (links, backlinks, similar). The tags field is sent only when it was changed there, so tags the linker adds while a note is open are kept.
- Display text runs through `StyleGuard` (em and en dashes become commas, filler stripped) plus any active filter rules from Memory.
- Today is a status board (`TodayBoardView`; its rules are `TodayBoard` in EACore, the same cases as the web app's `todayBoard.ts`, tested in `TodayBoardTests`). At the top the Now line (what is under way and how long it has left, else what is next and how long until it, else that nothing else is scheduled), the free time now or next, and Tech's light. Then five cards, one column on an iPhone, two on an iPad and up to five across a wide Mac window (`TodayBoard.columns`): Needs you (actions only, numbered, each with its buttons; a charge on autopay is never one), Schedule (all-day events and whole-day plan rules first, then the timeline, then the people in today's plans), To do (the task being done with its buttons and the other open tasks, each with a done circle and Start), Today so far (today's numbers, and the diary's lines, finished tasks and logs in the order they happened; capturing is the Capture tab's, there on every screen) and Coming up (tomorrow, dates). The day is drawn once, as the Schedule card's timeline, and a charge on autopay is not on Today at all: it pays itself, and Renewals lists it. Swiping left or right shows another day's plan as a timeline, with the renewals to make that day (never one on autopay). With nothing being done, Now lists the open tasks, each with Start.
- Planner: Today and Week load `GET /planner/today` and `GET /planner/week` when the hub answers; otherwise `LocalPlanner` in EACore computes the same shape from the local store (day window 09:00 to 23:00, minus plan rule blackouts and commitments, task blocks and events; a preference weighs a slot and an info rule is a note, so neither takes time, as on the hub) and the screen says "Planned on this device". Both load again only when what they show changed. Schedule here posts `/planner/schedule` with 3 h; a 409 comes back as `HubError.conflict` with the conflicting block, commitment or blackout, and the picker offers Schedule anyway (`force`). Offline, the block is checked against local rules and patched locally. Renewed uses `/watches/:id/renewed` online and rolls `due` by `repeat` locally otherwise.
- Activity check-in: `notify` events of kind `activity` on `/live` (and, on the Watch, a new entry on the running activity log's `checkins` found by the 60 s poll) show a banner "On <value> for <h> h" with Still on it and Stop (Stop writes the `end` log). Starting an activity also schedules a local notification 3 hours later (category `EA_ACTIVITY`, the same two actions), which the end log cancels, so the question is asked with no hub. `notify` kind `digest` becomes a local notification with the digest's first line that opens `everythingapp://today`.
- Modules switched off (Settings, Modules) hide their screens on every device; with Health off the Watch shows no logging and Siri logs no health records.
- Alerts (Settings, Notifications): each kind of alert has its own switch, kept on the hub for every device (`alerts` in `GET /modules` and in the `modules` event on `/live`, `PUT /modules/alerts`). The page lists them under the hub's titles, leaving out an alert whose module is off; a hub from before the switches lists none and every kind is on. The hub holds back a kind that is off, and what a device plans or shows by itself obeys the switch too, from the copy kept in the app group beside the module switches (`SharedConfig.alerts`, on the Watch through the iPhone): a reminder's planned notification (`reminder`; off takes the planned ones away, on brings them back), and the check-in notification three hours into an activity and the check-in banner found by a pull (`activity`). Reminder alerts off in Settings, Modules still stops every notification of the device.
- Links: `everythingapp://today`, `week`, `renewals`, `now`, `reminders`, `capture?text=`, `section/<name>`, `item/<id>`, `wiki?id=`, and `setup?hub=&code=&name=` (and `&fp=`; the older `&token=` is traded at once). The launch argument `-EASection week` (any `Section` raw value) opens that screen first, for screenshots and UI tests.
- The medium widget shows the next block today under the Now task when there is one (`SharedConfig.nextBlockTitle` and `nextBlockStart`, written with the Now snapshot).
