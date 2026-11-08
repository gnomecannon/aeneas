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

The privacy policy for the apps: [PRIVACY.md](PRIVACY.md). The details: `docs/06-threat-model.md` (what protects what, and the known gaps) and `docs/privacy-network.md`
(every outside address the hub and apps can contact, and what turns each on).

## Set up

About 15 minutes in all, plus the model download (about 1.5 GB on a computer without a graphics card, up to about
20 GB with a large one).

1. On the computer that will be the hub (Linux or macOS, always on, 8 GB of memory or more), run the installer in a
   terminal. It needs no root password and asks at most two questions (whether to download the model server, and
   whether web searches should go through Tor; Enter takes the suggested answer). It installs Node, the hub as a
   service, a local model server (Ollama), a local search server when Python is there, and HTTPS. A few minutes.

   ```bash
   curl -fsSL https://raw.githubusercontent.com/gnomecannon/aeneas/main/deploy/install.sh | bash
   ```

2. Open the link it prints, in a browser on that computer or on another one on the same network. The first time,
   the browser says the connection is not private: the hub made its own certificate, so choose Advanced (or Show
   Details), then continue. The Welcome page asks your name and which modules you want, downloads the model that fits
   the machine in one click, shows the key that opens your backups (save it in your password manager), and makes a
   pairing code for your other devices. About 5 minutes plus the download.
3. Install Aeneas on your iPhone, iPad or Mac, or open the web app in a browser. (To look around before you
   have a hub, the Apple apps offer "Try it with sample data": a made-up month, kept on the device.)
4. On the Welcome page, press Make a pairing code and scan the QR code with the phone's camera (on a Mac, open the
   link). Each device gets its own key, and scanning lets it check the hub's certificate.

**Away from home.** The hub listens on your home network. To reach it from anywhere, install Tailscale (free for
personal use, tailscale.com) on the hub and your devices, then run the install command again: the hub gets an
https address on your private Tailscale network. Gmail and Confluence need that address, because Google and
Atlassian send you back only to an https name.

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
| `deploy/` | The installer (`install.sh`), `pair-link.sh`, `restore.sh`, `uninstall.sh`, starter content, the Windows build script | `bash -n deploy/install.sh` |
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
