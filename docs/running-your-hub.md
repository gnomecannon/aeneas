# Running your hub

Everything after setup: updating, backups, restoring, moving to a new machine, devices, keys, web lookups,
uninstalling, and what to do when something is wrong. Setup itself is in the README.

Commands are for the hub's machine, as the user the hub runs as (not root). Where Linux and macOS differ, both are
given. `~/everythingapp` is the app folder unless you installed with `EA_DIR`.

## Where things are

| Folder | What is in it | In a backup? |
|---|---|---|
| `~/everythingapp` | The app. Replaced on each update | No (download it again) |
| `~/.local/share/everythingapp` | Your data: `hub.sqlite` (everything you made), `chats.sqlite`, the notes folder (`vault/`), `backups/`, linked accounts (`connections.json`, sealed) | `hub.sqlite` only |
| `~/.config/everythingapp` | `hub.env` (settings and the hub's main key), `backup.key`, `work.key`, `secrets.key`, `tls/` (the certificate), Tor and search settings | No, on purpose |
| `~/.local/node`, `~/.local/ollama`, `~/.local/searxng`, `~/.local/tor`, `~/.local/everythingapp-python` | Programs the installer added (only the ones it needed) | No (the installer adds them again) |

Services: on Linux, `systemctl --user status everythingapp-hub` (also `-ollama`, `-searxng`, `-tor`); on macOS,
launch agents named `app.everythingapp.hub` (and `.ollama`, `.searxng`, `.tor`) that start when you log in.

Logs: on Linux, `journalctl --user -u everythingapp-hub -e`; on macOS, `~/.local/share/everythingapp/logs/hub.log`.
Logs hold no personal text and no keys.

## Update

Run the install command again, from your home folder:

```bash
cd ~ && curl -fsSL https://raw.githubusercontent.com/gnomecannon/aeneas/main/deploy/install.sh | bash
```

It downloads the newest app, keeps `hub.env` and all your data, updates Ollama, the search server and Tor when the
installer names a newer version, restarts the hub, and prints a fresh pairing link (which you can ignore). About two
minutes. The Apple apps update through the App Store; the web app updates itself when it next opens.

## Back up and restore

### What is backed up

Every night at 3:00 the hub copies `hub.sqlite` (captures, tasks, notes, reminders, logs, people, everything you
made) into `~/.local/share/everythingapp/backups/`, encrypted to your backup key, and keeps 30 days. If the hub was
off at 3:00 (a laptop asleep, a power cut), it makes the missed one 10 minutes after it starts. The Status page
warns when the newest backup is more than 30 hours old.

Not in the backup, on purpose:

- **Chats with the assistant.** They stay on the hub only.
- **Linked accounts** (Gmail, Confluence, Steam, a password manager). Link them again after a restore.
- **Work items' key** (`work.key`). Work items are sealed with it, and erasing the work space destroys it so no
  older copy can be read. If you want work items to survive a dead disk, save a copy of `work.key` somewhere safe;
  erasing the work space then also means deleting that copy.

### Keep the recovery key

The Welcome page showed the recovery key once ("The key to your backups") and asked you to save it in your password
manager. Without it, backups cannot be opened on another machine. To see it again: Settings, Set up.

### A second copy, off this disk

Backups on the hub's own disk die with that disk. Point the hub at a second folder (an external drive, a NAS share
mounted on this machine) and each night's backup is copied there too, with 30 days kept. Add this line to
`~/.config/everythingapp/hub.env`, then restart the hub (below):

```
EA_BACKUP_COPY_DIR=/Volumes/Backup/everythingapp
```

The folder must already exist. When the drive is not plugged in, the copy is skipped and the log says so; nothing
is written to the hub's own disk instead. The copies are encrypted, so a shared drive or a cloud-synced folder sees
nothing readable.

### Restore

On the same machine, after a mistake or a damaged database:

```bash
~/everythingapp/deploy/restore.sh
```

lists the backups, newest first. Then:

```bash
~/everythingapp/deploy/restore.sh hub-20261106-030000.sqlite.age
```

It checks the backup opens and is whole before changing anything, stops the hub, keeps the current database as
`hub.sqlite.before-restore-<time>`, puts the backup in its place and starts the hub. Paired devices keep working.

On a new machine: run the install command there, copy a backup file over (from the second copy, or the old disk),
and run `restore.sh` with its path. It asks for the recovery key, since the new hub has its own backup key; the key
is not shown or written anywhere. Then open the Welcome page and save the new hub's recovery key too: backups from
now on use it. Pair your devices again (below), and link accounts again in Settings, Connections.

## Move to a new machine

When the old machine still works, move everything, including chats, keys and paired devices:

1. On the old machine, stop the hub: `systemctl --user stop everythingapp-hub` (Linux) or
   `launchctl bootout gui/$(id -u)/app.everythingapp.hub` (macOS).
2. Copy `~/.local/share/everythingapp` and `~/.config/everythingapp` to the same places on the new machine, under
   the same user name (for example `rsync -a` over SSH, or an external drive). Both folders hold keys: copy them
   only to a disk you trust, and delete any copy in between.
3. On the new machine, run the install command. It keeps the copied `hub.env`, keys and certificate.
4. If the hub's address changed (a new Tailscale name, a new home network address), pair each device again. If the
   address stayed the same, devices carry on as before.
5. When the new hub works, run `~/everythingapp/deploy/uninstall.sh` on the old machine, then delete its two
   folders.

With a different user name on the new machine, edit the paths in `hub.env` after step 2.

## Devices

- **Pair a device:** on the web app, Settings, Connection, Pair another device, then scan the QR code with the
  phone's camera (on a Mac, open the link). A code works once, for 10 minutes. On the hub's machine,
  `~/everythingapp/deploy/pair-link.sh "Name"` prints a link too.
- **Remove a device** (sold, lost, replaced): Settings, Connection, Devices, Remove. Its key stops working at once,
  together with its Watch's. A removed phone, iPad or web app wipes its local copy the next time it reaches the hub.
- **A lost phone:** remove it as above from any other device. Its local copy stays on the phone until it next
  connects, so also use Find My to erase it.

## Other people on this machine

On a Linux hub with Tailscale, someone else can have a hub of their own here: Settings, People on this machine, Add.
The first time, that page shows a command to run once in a terminal on this machine (`sudo bash
~/everythingapp/deploy/people.sh setup --name "Your name"`). Each person's data is in their own account, apart from
yours, but anyone with admin rights on this machine, you included, can open it: tell them. After updating your own
hub, `sudo bash ~/everythingapp/deploy/people.sh update` brings everyone else's to the same version. Everything else,
including stopping a hub and deleting someone's data: `docs/multi-person.md`.

## Keys

- **The hub's main key** (`EA_TOKEN` in `hub.env`) only works on the hub's own machine; devices use keys of their
  own. To change it, put a new value of at least 24 letters and digits there and restart the hub. Devices are not
  affected.
- **The backup key** is never replaced by the hub. Keep the recovery key for as long as you keep backups made with
  it.
- **`secrets.key`** seals linked accounts and model keys. Lost, it costs linking those accounts again.

## Restart the hub

After editing `hub.env`:

```bash
systemctl --user restart everythingapp-hub              # Linux
launchctl kickstart -k gui/$(id -u)/app.everythingapp.hub   # macOS
```

## Away from home

The hub listens on your home network. To reach it from anywhere, install Tailscale on the hub and your devices and
run the install command again: the hub gets an https address on your private Tailscale network, and devices paired
after that use it. Pair existing devices again once.

## Web lookups and Tor

Web lookups (the assistant searching the web and reading pages) are off until you turn the module on. When on,
searches and page reads go out only through Tor, which the installer sets up: search engines and sites see the words
searched and a Tor address, never your home address, and your internet provider sees only that you use Tor. If Tor
is not working, the assistant has no web lookups and says so; nothing goes out directly. On a network that blocks
Tor (some providers and countries do), the installer notices and switches Tor to Snowflake bridges by itself: the
searches stay just as private, and a few outside servers see that this address uses Snowflake (listed in
`docs/privacy-network.md`).

What Tor does not hide: the words you search (a search for your own name and street identifies you whatever the
address), and a very well resourced observer watching both your home connection and the far end at once can match
them up by timing. For most people and most threats, searches through Tor are not traceable back to the hub.

To go without Tor (faster, but engines and sites see your home address), install with `EA_TOR=0` and add
`EA_WEB_WITHOUT_TOR=1` to `hub.env`. To turn Tor back on, run the install command with `EA_TOR=1`.

## Uninstall

```bash
~/everythingapp/deploy/uninstall.sh
```

It asks once, then stops and removes the hub and the services and programs the installer added, and the app folder.
It keeps your data and keys, and names the folders that hold them: copy what you want to keep, then delete them
yourself. Remove the apps from your devices as usual.

## When something is wrong

| What you see | What to do |
|---|---|
| The app says it cannot reach the hub | Is the hub's machine on and awake? On it, `curl -sk https://127.0.0.1:8787/health` should answer `{"ok":true}` (use `http` if the hub is on Tailscale). If not, read the log and restart the hub. Away from home, is Tailscale on, on the device? |
| "This device was removed" or "unknown key" | The device was removed, or the hub was restored without its device keys: pair it again |
| The browser warns the connection is not private | Expected on the home network: the hub made its own certificate. Choose Advanced, then continue |
| No backup for more than a day (Status page) | Read the log for `[backup]`. Was the recovery key saved? Is the disk full (`df -h ~`)? |
| "second copy not made" in the log | The `EA_BACKUP_COPY_DIR` drive is not plugged in or not mounted |
| The assistant does not answer | Settings, Set up: is a model chosen and downloaded? Is Ollama running (`systemctl --user status everythingapp-ollama`)? |
| The assistant says web lookups are off | Turn on the Web lookups module; if it is on, Tor is not running (`systemctl --user status everythingapp-tor`), run the install command again |
| The installer stops with a message | It says what is missing (git, curl, Python for search, an admin step for lingering) and the command to fix it; then run it again |

Every outside address the hub and apps can contact, and what turns each on, is in `docs/privacy-network.md`; what
protects what, in `docs/06-threat-model.md`.
