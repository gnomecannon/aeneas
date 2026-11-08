# vault-mirror

Two-way mirror between a folder of markdown files (the Obsidian vault on the Mac) and the hub's `/vault/*` routes. Runs on the Mac that holds the vault, as the login user. See `CONTRACT.md` section 3, Vault, for the routes and the conflict rule.

## Run

```bash
cd tools/vault-mirror
npm run dry-run     # print the plan, change nothing
npm run once        # one pass
npm run watch       # one pass, then every 60 s and 2 s after a local change
```

## Config

Environment variables win over the file. The file is `~/.config/everythingapp/mirror.json` (or the path in `EA_MIRROR_CONFIG`):

```json
{
  "hub_url": "https://hub.your-tailnet.ts.net",
  "vault_dir": "/Users/you/Library/Mobile Documents/iCloud~md~obsidian/Documents/My Vault",
  "state_file": "/Users/you/.config/everythingapp/mirror-state.json"
}
```

| key | env | meaning |
|---|---|---|
| `hub_url` | `EA_HUB_URL` | base URL of the hub, no trailing slash |
| `token` | `EA_TOKEN` | bearer token. Keep it out of the file; the launchd wrapper reads it from the Keychain |
| `vault_dir` | `EA_VAULT_DIR` | folder to mirror |
| `state_file` | `EA_STATE_FILE` | where last-sync hashes are kept. Default `~/.config/everythingapp/mirror-state.json` |

## What it never mirrors

- directories `.obsidian`, `.trash` and any directory starting with a dot
- names that look like secrets: recovery or backup codes, passwords, credentials, 2FA, seed phrases, private keys (built in, in both directions)
- anything matching a line in `<vault_dir>/.mirrorignore`. Lines are globs: `Private/` ignores a folder, `*.draft.md` ignores by name, `Writing/Journal*.md` ignores by path.
- anything matching a line in `~/.config/everythingapp/vault-mirror-ignore.txt` (or the file `EA_MIRROR_IGNORE` names): the same globs, kept outside the vault so the list of what stays private is not itself in a synced folder.

## Decision table

State remembers, per path, the hash and mtime of the last synced version on each side. "Changed" means the current hash differs from the remembered one.

| local | hub | result |
|---|---|---|
| new | absent | PUT |
| absent | new | written locally |
| changed | same | PUT |
| same | changed | written locally |
| changed | changed | hub wins. Local version saved as `Name (conflict YYYY-MM-DD HHmm).md` next to it, hub content written over the original, nothing PUT. The conflict copy is uploaded on the next pass |
| deleted | same | DELETE on hub |
| deleted | changed | hub wins, file written back |
| same or changed | deleted | local file moved to `.trash/` |
| new | new, different content | treated as both changed |
| new | new, identical content | recorded, no transfer |

Hashes are sha256 of the content with a BOM stripped and line endings normalized to LF, so CRLF-only differences are not changes.

## Tests

```bash
npm test
```

`test/fake-hub.ts` is an in-memory hub with the four vault routes. `scripts/fake-hub.ts` starts it as a real server for manual runs:

```bash
npm run fake-hub -- --port 8799 --seed /path/to/some/markdown
EA_HUB_URL=http://127.0.0.1:8799 EA_TOKEN=test-token EA_VAULT_DIR=/tmp/vault-copy EA_STATE_FILE=/tmp/mirror-state.json npm run dry-run
```

## Mac agent

`launchd/install-mac.sh` installs `launchd/com.everythingapp.vault-mirror.plist` into `~/Library/LaunchAgents` with `RunAtLoad` and `KeepAlive`. Logs go to `~/Library/Logs/everythingapp/` and hold counts, hub routes and status codes, never a note's file name or an error's text (`npm run dry-run` names each file on screen). The agent runs `launchd/run-mirror.sh`, which reads the token with `security find-generic-password -s everythingapp-hub -w`. Steps are in `deploy/RUNBOOK.md` section C.


## macOS launchd note

A launchd agent cannot read files under Documents, Desktop or Downloads without a privacy grant, so the installer must be run from a copy of the repo outside those folders, for example `~/Library/Application Support/EverythingApp/repo`.
