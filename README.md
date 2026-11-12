# Aeneas

A private personal system you run yourself: capture, tasks and a planner, notes with automatic links and tags,
reminders, search, quick logs, and an assistant with a memory, on iPhone, Apple Watch, iPad, Mac, Windows and the
web. Everything lives on one hub on a computer you own; your devices talk only to it.

On the App Store it is Aeneas: Mind Workbench. Folders, services and settings keep the working name `everythingapp`,
which existing installs depend on.

## Privacy

- Your data stays on your hub and your own devices. There is no server of ours, no account with us, no telemetry.
- Each device has its own key, from a pairing code that works once for 10 minutes; any device can be removed.
- Devices reach the hub over Tailscale (WireGuard, end to end), or over HTTPS on your home network with a pinned
  certificate. Backups and every copy sent to another machine are encrypted with a key only you hold.
- The assistant runs on a model on your own machine. A cloud model is an option you turn on, and work items never
  go to it. Web lookups are off until you turn them on; then searches go through a search server on your hub to a
  short list of engines it names (DuckDuckGo, Brave, Mwmbl, Wikipedia), optionally through Tor.
- A new install sends nothing to any company. Where a feature you turn on needs one (a browser's dictation, a cloud
  model, a sign-in), it says which company and what goes before it starts. Every outside address is listed in
  `docs/privacy-network.md`.
- Every module is something you switch on; each says what it reads, and your devices ask only for the permissions of
  the modules you chose.
- Several people can share one hub machine, each with a hub of their own, kept apart from the others'. Anyone with
  admin (root or sudo) rights on that machine can still read every hub's files, so share a machine only with people
  who trust its admin (see Someone else in the house, below).

The privacy policy for the apps: [PRIVACY.md](PRIVACY.md). The details: `docs/06-threat-model.md` (what protects what, and the known gaps) and `docs/privacy-network.md`
(every outside address the hub and apps can contact, and what turns each on).

## Set up

About 15 minutes in all, plus the model download (about 1.5 GB on a computer without a graphics card, up to about
20 GB with a large one).

1. On the computer that will be the hub (Linux, macOS or Windows, always on, 8 GB of memory or more), run the
   installer in a terminal. It needs no root password and asks at most three questions (whether to download the model
   server, where to keep the models, and whether web searches should go through Tor; Enter takes the suggested answer).
   It installs Node, the hub as a service, a local model server (Ollama), a local search server when Python is there,
   and HTTPS. A few minutes.

   ```bash
   curl -fsSL https://raw.githubusercontent.com/gnomecannon/aeneas/main/deploy/install.sh | bash
   ```

   On Windows 10 or 11: download `Aeneas-Hub-Setup.exe` from the Releases page
   (github.com/gnomecannon/aeneas/releases) and run it (see A Windows PC as the hub, below).

   Either way, setup asks how your phone and computers reach the hub: Direct link (the default: no account, the QR
   code carries the hub's key, works at home and away), Tailscale, or your home Wi-Fi only. Each has a note on what
   it involves, and [docs/connections.md](docs/connections.md) compares them; Settings can change it later.

2. Open the link it prints, in a browser on that computer or on another one on the same network. The first time,
   the browser says the connection is not private: the hub made its own certificate, so choose Advanced (or Show
   Details), then continue. The Welcome page asks your name and which modules you want, downloads the model that fits
   the machine in one click, shows the key that opens your backups (save it in your password manager), and makes a
   pairing code for your other devices. About 5 minutes plus the download.
3. Install Aeneas on your iPhone, iPad or Mac, or open the web app in a browser. (To look around before you
   have a hub, the Apple apps offer "Try it with sample data": a made-up month, kept on the device.) On Android,
   install the APK from the Releases page (or from F-Droid once it is listed).
4. On the Welcome page, press Make a pairing code and scan the QR code with the phone's camera (on a Mac, open the
   link). Each device gets its own key, and scanning lets it check the hub's certificate.

**Away from home.** Direct link and Tailscale both work away from home; Home Wi-Fi only does not. Gmail and
Confluence need the hub's Tailscale address, because Google and Atlassian send you back only to an https name.

**A Windows PC as the hub.** A gaming PC with a good graphics card makes a fast hub (tested on Windows 11 Pro 24H2,
build 26200, with an RTX 4090). What is different there:

- One installer, `Aeneas-Hub-Setup.exe`, does all of it: the hub, Ollama, Tor and private search, and Tailscale when
  you choose it and the PC does not have it (each download checked against its published checksum). Run it again to update; Settings,
  Apps, Aeneas hub removes it and keeps your data. Windows shows a SmartScreen warning the first time, since the
  installer is not code-signed yet: More info, then Run anyway.
- With Tailscale chosen, the installer opens the browser to sign in to Tailscale, and once more to turn on HTTPS for
  a new tailnet, and keeps Tailscale running while nobody is logged in. With Home Wi-Fi only, it makes the hub's own
  certificate and a firewall rule that lets only the hub's own program take connections, on private networks only.
- Windows asks once for permission (an administrator) during the install, to start the hub at boot before anyone
  logs in (and, when chosen, to install Tailscale or add that firewall rule). Said no to the boot task alone, the hub starts when you log in instead.
- The hub asks Windows not to sleep while the PC is on AC power (the screen still turns off); a sleeping PC cannot
  answer your phone. Your phone keeps working offline and catches up when the hub is back.
- The installer asks where to keep the models (1.5 to 19 GB each). Where they are only changes how fast a model loads
  after 5 quiet minutes (an NVMe SSD about 5 to 10 seconds for a large
  one, a hard drive about 2 minutes), never how fast it answers. Network drives cannot hold them: the hub runs before
  anyone logs in and cannot reach them.
- While a game (any program drawing hard on the card) runs, background work that needs the model (sorting notes,
  reading mail, learning from an import) waits, so the game keeps the card. Chats still answer.
- Not on Windows: several people on one machine (Linux only).
- Everything lives in `%LOCALAPPDATA%\AeneasHub`. Updating, backups, restoring and uninstalling on Windows:
  `docs/running-your-hub.md`.

**Someone else in the house.** On a Linux hub with Tailscale, each person can have a hub of their own on the same
machine: their own notes, chats, settings and devices, apart from yours, sharing the machine's model fairly (a reply
goes before background work, and two people asking at once take turns).

1. Once, on the hub's machine, in a terminal (it asks for your password):

   ```bash
   sudo bash ~/everythingapp/deploy/people.sh setup --name "Your name"
   ```

2. In the app: Settings, People on this machine, type their name, Add. In a minute or two it shows their hub's address
   and a QR code.
3. Share the hub's machine with them in the Tailscale admin console (Machines, the machine, Share), and they scan
   the QR code with their phone after installing Aeneas and Tailscale.

Their data lives in their own account on the machine, which the other hubs cannot open. Anyone with admin (root or
sudo) rights on the machine, you included, can open it: tell them before they start. Details: `docs/multi-person.md`.

**After setup.** Updating, backups and a second copy off the hub's disk, restoring, moving to a new machine,
removing a device, uninstalling and fixing problems: `docs/running-your-hub.md`.

**Advanced additions.** Services that need your own key or app come with a step-by-step guide in Settings,
Connections, with the values to copy filled in and a check at the end: Steam playtime (about 2 minutes), Confluence
(about 10) and Gmail (10 to 15). Each module says before you turn it on whether it needs one.

## Layout

| Path | What it is | Check |
|---|---|---|
| `packages/shared/CONTRACT.md` | The contract every part implements: data model, API, sync rules, hub obligations, privacy rules | read it first |
| `packages/shared/` | Zod types and shared helpers | `npm --workspace packages/shared test` |
| `hub/` | The hub: one TypeScript process, SQLite, Hono. Sync, reminders, notes, search, the assistant, backups | `npm --workspace hub test` |
| `web/` | The web app and the Windows app (Tauri) | `npm --workspace web test` |
| `apple/` | SwiftUI apps for iPhone, iPad, Mac and Watch, with widgets (`xcodegen generate`) | `cd apple/Packages/EACore && swift test` |
| `deploy/` | The installers (`install.sh` for Linux and macOS, `install.ps1` for Windows), `pair-link.sh`, `restore.sh`, `uninstall.sh` and their Windows twins in `deploy/windows`, the Windows hub service (`hub-service.ps1`), starter content, the Windows build script | `bash -n deploy/install.sh` |
| `tools/` | The license check, the public copy tools and an Obsidian vault mirror | `npm run license-check` |

## Develop

```bash
npm install
npm --workspace hub run dev
npm --workspace web run dev
```

The hub reads `hub/.env` (copy `hub/.env.example`); with nothing set it listens on 8787 with its data under
`hub/data`. Open the web app on the same machine, and connect with the hub's main key (`EA_TOKEN`, accepted only from
the hub's own machine unless `EA_MAIN_KEY_FROM` names another caller) or a pairing code.

## License

Aeneas is free software under the GNU Affero General Public License, version 3 only (`AGPL-3.0-only`): see [LICENSE](LICENSE). Anyone may use, change and share it; whoever runs a changed copy as a service for other people must offer those people the changed source. Every third-party package it uses is under an open-source license that allows this (`npm run license-check`).

The Apple apps are also sold on the App Store; the hub and the Windows app are free here. Contributions are welcome under the terms in [CONTRIBUTING.md](CONTRIBUTING.md), and the name and icon are covered by [TRADEMARKS.md](TRADEMARKS.md).
