# 06. Threat model

Written 2026-11-05 and checked against the code that day, then updated the same day once Phase 2 of `docs/05-public-release.md` was built (branch `release-phase-1-2`; the owner's own hub runs it once it is deployed). Each control is marked:

- **Built**: in the code now.
- **Not built yet**: planned, with the phase that builds it.

Anything else that is missing is listed under "Known gaps". The standard is rule 6: everything the project controls is private and encrypted, reaches only the devices the user set up, and holds up to a careful Tor user at DEF CON. Every outside address is in `docs/privacy-network.md`. The rules each module meets are the last section of `packages/shared/CONTRACT.md`.

## The system

One hub (Node and SQLite) runs on a machine the owner controls. Devices talk only to it: the iPhone, iPad and Mac apps, the Watch (through the iPhone), the web app in a browser or on the home screen, and the Windows app. Devices reach the hub over Tailscale, or over the home network in LAN mode. The hub can copy backups to a second machine the owner controls, talk to model servers (local by default, a cloud model only when allowed) and read services the owner signs in to.

## Assets

| Asset | Where it is | What is in it |
|---|---|---|
| The hub database | `hub.sqlite` and its WAL file in the hub's data folder | Every record: tasks, events, reminders, people, facts, captures, the notes index, renewals, health and sensor readings, records filed from mail. Work items are sealed |
| The notes folder | `vault/` in the data folder; mirrored to the owner's Obsidian vault on their Mac by `tools/vault-mirror` | Every personal note as markdown |
| Chats | `chats.sqlite` in the data folder | Assistant chats, the model call audit, host command approvals, photos sent to the assistant |
| Backups | The backup folder on the hub (30 days of nightly copies), copies on the backup host, the Litestream replica | Copies of `hub.sqlite`, some settings files, gallery pictures and hum recordings. Never chats, the work key, sign-ins or hub.env |
| Device caches | Apple apps: a local SQLite copy and outbox, plus the hub address and token in the app group's settings. Web app: IndexedDB with the records and the token. Windows app: the same, plus `config.json` | The records each device syncs, and the means to reach the hub |
| Service sign-ins | `connections.json` (mode 600, with a `.bak` copy), and model keys in `ai.json`; both sealed (AES-256-GCM) since 2026-11-06 with `secrets.key`, kept beside `hub.env` and the work key, outside the data folder and in no backup | The owner's Google and Atlassian app ids and secrets and their refresh tokens, the Steam key and ID, password manager sessions, the built-in vault's master password |
| The model's prompts | Built on the hub for each chat, filing, mail read and note link; sent to the model server | Memory facts, the chat, tool results (records, page text, command output), pictures |
| The hub's own secrets | `hub.env` (the hub token, cloud keys, the image service token), the work key file, feed keys | The keys to everything above |
| Logs | The journal or `hub.log` | Ids, counts, kinds, durations, status codes and module names only (`hub/test/log-privacy.test.ts`) |

## Controls

| Control | State | What it does |
|---|---|---|
| Tailscale (WireGuard) | Built | Devices reach the hub through an encrypted tunnel. The hub listens on `127.0.0.1` and Tailscale Serve gives it HTTPS with a certificate for its `*.ts.net` name |
| HTTPS off Tailscale | Built | In LAN mode the installer makes a self-signed certificate and the hub serves HTTPS; plain HTTP is answered only on 127.0.0.1 (`hub/src/tls.ts`). Pairing links carry the certificate's SHA-256 (`fp=`) so a device accepts that certificate and no other |
| A key per device | Built | Each device gets its own key through a pairing code that works once and expires in 10 minutes (`hub/src/devicekeys.ts`). The hub keeps only each key's SHA-256. No link or QR code holds a lasting secret, and any device can be removed on its own. The hub's main key (`EA_TOKEN`) stays in hub.env for the hub's own scripts; a device that still holds it trades it for its own key on its next sync |
| Token checks | Built | Compared in constant time. Failed tries from one caller are slowed, up to 5 s each |
| One-door keys | Built | The calendar feed key reads the calendar feed only, the sensor key posts readings only, the feed token posts project and wiki feeds only |
| Work items sealed | Built | AES-256-GCM with the entity id as associated data (`hub/src/workkey.ts`). The key file is kept apart from the database and in no backup. Erasing the work space destroys the key, so every older copy holds work items nobody can read. Work items never go to a cloud model or into a file that leaves a device |
| Chats kept apart | Built | `chats.sqlite` is never backed up (`hub/test/privacy.test.ts`). Deleting a chat deletes its photos |
| Backups written safely | Built | Written whole, then renamed; mode 600; a damaged copy is skipped |
| Backups encrypted | Built | Every nightly backup, the settings, gallery and recording copies sent to the backup host, and the Litestream replica are encrypted with age to the hub's backup key (`hub/src/backupkey.ts`); the owner saves its recovery key in a password manager from the Welcome page. The nightly copies need only the key's public half. Litestream reads back its own uploads, so it holds the private half while it runs, passed in its environment from the key file and never written to a config file |
| Disk encryption check | Built | The hub checks whether the disk holding its data folder is encrypted (FileVault; LUKS, ZFS encryption, eCryptfs or fscrypt on Linux) and says so on the Welcome page's backup step and in `/status`. The live database stays plain because Litestream must read it |
| Cloud models opt-in | Built | Off by default (`EA_ALLOW_CLOUD_DEFAULT=false`). A request must allow the cloud. Work items and private facts are taken out and keys, tokens and passwords redacted before it leaves |
| Web search and page reads | Built: page reads refuse addresses on the owner's network; searches and page reads go out only through Tor (`EA_TOR_SOCKS`, `hub/src/ai/web.ts` `webPrivate`), and without Tor the assistant has no web tools at all unless the owner sets `EA_WEB_WITHOUT_TOR=1` (since 2026-11-06). The installer sets up a local SearXNG at a pinned commit and its own Tor for SearXNG and the page reads, without asking (`EA_TOR=0` skips it) | The assistant searches through the owner's own SearXNG and reads public pages only |
| Host commands | Built | Reading commands run at once; anything that changes a machine, reads a secret file or uses a password manager secret waits for the owner's approval. Secrets are referenced by name and taken out of command output |
| No relay or server of the project's | Built (decided 2026-11-05): no such server exists | Services that need a key use the owner's own app or key. The guided screen for making one is not built yet (Phase 3). Nothing about a user reaches the project |
| Logs without secrets or personal text | Built | `errCode` and `logHost` in `hub/src/logsafe.ts`, checked by a test over every log call |
| Nothing phones home | Built, apart from the Apple gaps below | `docs/privacy-network.md`, checked by `hub/test/no-phone-home.test.ts` |
| The system service sandbox | Built for the system unit (`deploy/systemd`: `ProtectSystem=strict`, `ProtectHome`, no capabilities) | The user service and the macOS LaunchAgent have `NoNewPrivileges` only |

## Adversaries

### Someone on the same network
A café or hotel network, or a guest on the home network.
- Protected (Built): on Tailscale every byte between device and hub is WireGuard, and the hub port is not open on the network at all.
- Protected (Built): in LAN mode, HTTPS with a pinned certificate, so a device notices a machine in the middle.
- Gaps: the web app in a browser cannot pin; it shows the browser's warning for the self-signed certificate and relies on the person checking it. A model server reached over plain HTTP on the home network (not the tailnet) is readable.

### A stolen or lost phone, locked
- Protected (Built): iOS encrypts the app's files; after a restart nothing is readable until the passcode is entered. The Watch holds no hub address or token.
- Protected (Built): the owner removes that one phone from another device and its key stops working; the other devices carry on.
- Gaps: the app's files use iOS's default protection, readable by forensic tools once the phone has been unlocked since it started (Phase 2 lists complete file protection for the phone, Watch and Mac caches). The hub token sits in the app group's settings file, not the Keychain, so it is also in an unencrypted Finder or iTunes backup of the phone. Until per-device keys land, losing a phone means changing the token on every device (`deploy/RUNBOOK.md` J4).

### A stolen hub disk
- Protected (Built): the disk encryption check, so the owner knows the disk is encrypted at rest; age-encrypted backups in the backup folder.
- Gaps: without disk encryption, everything is readable: the database, chats, `connections.json` (the sign-ins and the built-in vault's master password), `hub.env` (the hub's main key and cloud keys) and the notes folder. The work key and the backup key are on the same disk, so sealed work items and the backups are readable too. `connections.json` and `ai.json` are sealed with `secrets.key`, which keeps them out of anything that copies the data folder alone (a stray rsync, a folder image, a support bundle), but that key is on the same disk, so only disk encryption protects them from someone holding the disk.

### A compromised backup host
- Protected (Built): chats, the work key, `connections.json` and `hub.env` are never copied there, and work items arrive sealed.
- Protected (Built): every database copy, settings file, gallery picture, recording and the Litestream replica is age-encrypted before it leaves the hub, so the host holds only ciphertext it cannot open.
- Gaps: copies written before this change stay plain on the host until the owner removes them (`deploy/RUNBOOK.md` F9). Encrypted or not, the host sees file sizes and times, and can delete or withhold copies, so a restore drill (`deploy/restore-drill-user.sh`) stays the check that backups work.

### A rogue device on the tailnet
A machine of the owner's that is compromised, or a device that still holds an old token.
- Protected (Built): the hub answers nothing without a valid key, and failed tries are slowed. Tailscale's access rules can stop other tailnet machines reaching the hub's port at all.
- Protected (Built): every device has its own key, so an old device is removed by itself, and a pairing code is useless after one use or 10 minutes.
- Gaps: the hub's main key still opens everything, and links and QR codes made before 2026-11-05 carry it, so it should be changed once every device has its own key. The model servers on the tailnet (Ollama on another machine) take requests from any tailnet device without a key.

### Cloud model providers
- Protected (Built): nothing goes to a cloud model unless the request allows it, and then work items and private facts are taken out and keys, tokens and passwords redacted. The default model is local.
- Gaps: when the owner allows the cloud for a chat, that chat, the memory facts that are not private and the tool results go to the provider by design, and the provider's own retention rules apply. Redaction is by pattern, so a secret in an unusual form can pass.

### The services the user signs in to
Google, Atlassian, Steam, Letterboxd and the password managers.
- Protected (Built): each sees only what its own API returns to the hub, plus the hub's address and when it calls. Gmail access is read-only and mail is read by the local model, never sent on. Sign-in secrets stay on the hub; devices see only whether a service is linked.
- Protected (Built): the owner's own app or key for each service, with no relay of the project's in between. The guided screen for making one is Phase 3.
- Gaps: Steam's API takes the key and Steam ID in the address. The Apple app's sign-in sheet shares Safari's cookies with the service.

### Someone holding an unlocked device
- Protected (Built): a change on a machine waits for an approval tap, and work items can be erased with their key.
- Protected (Built): the owner can remove that device's key from another device.
- Gaps: whoever holds the unlocked device can do everything the owner can, approvals included; there is no app lock (Face ID or a PIN) in the Apple, web or Windows apps.

### A poisoned dependency
- Protected (Built): `package-lock.json` pins every npm package with its hash and installs use `npm ci`. The hub names 11 runtime packages and the web app 13 (each pulls in more); the Apple apps use no third-party packages. Licenses are checked by hand today.
- Gaps: a bad update runs with the hub's full access: every record, every key, and SSH to the owner's machines. The user service the owner runs is not sandboxed the way the system unit is. Phase 5 adds a license and source check (cargo-deny for the Windows app's Rust crates) to the build.

### Content that carries instructions
A mail, a web page, a wiki page or a shared article written to steer the model.
- Protected (Built): mail is read by a background job with no tools. Changes on machines wait for approval. Pictures in model replies, notes, the journal and wiki pages are links and load nothing on their own, so text cannot send data out by naming a picture. Page reads refuse the owner's own network.
- Gaps: a capture is filed by a chat that can read web pages, so a captured or shared text that names an address could make the model read it, with data in the address.

## Known gaps

1. The hub's main key still opens everything, and links made before 2026-11-05 carry it: change it once every device has its own key.
2. The live database, chats, notes and sign-ins are plain at rest unless the disk is encrypted (the hub checks and says so; sign-in keys encrypted at rest is Phase 3).
3. The web app cannot pin the LAN certificate; it relies on the browser's warning.
4. Device caches: default iOS file protection, the Apple token outside the Keychain, the web and Windows apps' token in IndexedDB.
5. No app lock on any device.
6. The Apple apps load Steam pictures and outside wiki pictures from other sites, and dictation can use Apple's servers (`docs/privacy-network.md`).
7. The web app has no Content-Security-Policy.
8. The user service runs without the system unit's sandbox.
9. Several people on one machine (`docs/multi-person.md`): each hub's files are readable only by its own account, but anyone with admin (root or sudo) rights on the machine can read every hub's database, notes, chats and keys, and the machine owner usually has those rights. The app says so before someone is added and after; only encryption with a key that never reaches the machine would close this.
