#!/usr/bin/env bash
# Put a backup back on the hub, on the same machine or a new one where the installer has run.
#
#   ~/everythingapp/deploy/restore.sh                       lists the backups, newest first
#   ~/everythingapp/deploy/restore.sh hub-YYYYMMDD-HHMMSS.sqlite.age    restores that one (a name in the backups folder,
#                                                                         or the path of a copy from elsewhere)
#
# What it does: checks the backup opens and is whole BEFORE anything changes, stops the hub, moves the current
# database aside as hub.sqlite.before-restore-<time> (kept, never deleted), puts the backup in its place, and starts
# the hub. On a new machine the backup was made with the old hub's key: it asks for the recovery key you saved
# (one line starting AGE-SECRET-KEY-1), typed or pasted without showing, and never written anywhere.
#
# What a backup holds and what it does not: docs/running-your-hub.md, "Back up and restore".
set -euo pipefail
ENV_FILE="${EA_ENV_FILE:-$HOME/.config/everythingapp/hub.env}"
say() { printf '==> %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }
[ "$(id -u)" != 0 ] || die "run this as the user the hub runs as, not root"
[ -r "$ENV_FILE" ] || die "$ENV_FILE is not here; run this on the hub's machine as the user the hub runs as"
get_env() { grep -E "^$1=" "$ENV_FILE" | tail -1 | cut -d= -f2- || true; }
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="$(get_env EA_DATA_DIR)"; DATA_DIR="${DATA_DIR:-$HOME/.local/share/everythingapp}"
BACKUP_DIR="$(get_env EA_BACKUP_DIR)"; BACKUP_DIR="${BACKUP_DIR:-$DATA_DIR/backups}"
NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ] || [ "$("$NODE_BIN" -v | sed 's/^v//; s/\..*//')" -lt 20 ] 2>/dev/null; then NODE_BIN="$HOME/.local/node/bin/node"; fi
[ -x "$NODE_BIN" ] || die "Node 20 or newer is not here; run the install command first"
TSX="$APP_DIR/node_modules/.bin/tsx"
[ -x "$TSX" ] || die "the app is not installed in $APP_DIR; run the install command first"

if [ "$#" -eq 0 ]; then
  say "Backups in $BACKUP_DIR, newest first:"
  ls -1t "$BACKUP_DIR" 2>/dev/null | grep -E '^hub-[0-9]{8}-[0-9]{6}\.sqlite\.age$' | head -40 || echo "  (none)"
  echo "Restore one with: $0 <name>"
  exit 0
fi
src="$1"
[ -f "$src" ] || src="$BACKUP_DIR/$1"
[ -f "$src" ] || die "$1 is not a file, and not a backup in $BACKUP_DIR"
src="$(cd "$(dirname "$src")" && pwd)/$(basename "$src")"

OS="$(uname -s)"
stop_hub() { if [ "$OS" = Linux ]; then systemctl --user stop everythingapp-hub.service; else launchctl bootout "gui/$(id -u)/app.everythingapp.hub" >/dev/null 2>&1 || true; fi; }
start_hub() {
  if [ "$OS" = Linux ]; then systemctl --user start everythingapp-hub.service
  else launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/app.everythingapp.hub.plist" 2>/dev/null || launchctl kickstart -k "gui/$(id -u)/app.everythingapp.hub"; fi
}
restore_to() { # DEST: decrypt and check into DEST (which must not exist), with the key file and EA_RECOVERY_KEY if set
  (cd "$APP_DIR/hub" && set -a && . "$ENV_FILE" && set +a && "$NODE_BIN" "$TSX" src/main.ts restore "$src" "$1")
}

# 1. Check it opens and is whole, into a scratch file, before anything changes.
work="$(mktemp -d "${TMPDIR:-/tmp}/everythingapp-restore.XXXXXX")"; chmod 700 "$work"
trap 'rm -rf "$work"' EXIT
say "Checking $(basename "$src")"
if ! out="$(restore_to "$work/check.sqlite" 2>&1)"; then
  if printf '%s' "$out" | grep -q "not encrypted with this key\|no backup key"; then
    [ -t 0 ] || die "this backup was made with another key; run this in a terminal to give the recovery key"
    echo "This backup was made with another hub's key. Paste the recovery key you saved (AGE-SECRET-KEY-1...);"
    echo "it is not shown, and not written anywhere:"
    IFS= read -rs EA_RECOVERY_KEY; echo
    export EA_RECOVERY_KEY
    out="$(restore_to "$work/check.sqlite" 2>&1)" || die "$(printf '%s' "$out" | tail -1)"
  else
    die "$(printf '%s' "$out" | tail -1)"
  fi
fi
printf '%s\n' "$out" | tail -1
rm -f "$work/check.sqlite"

# 2. Swap it in with the hub stopped; the current database is kept beside it.
live="$DATA_DIR/hub.sqlite"
kept="$live.before-restore-$(date +%Y%m%d-%H%M%S)"
say "Stopping the hub"
stop_hub
if [ -f "$live" ]; then
  mv "$live" "$kept"
  for x in wal shm; do [ ! -f "$live-$x" ] || mv "$live-$x" "$kept-$x"; done
  say "The database it had is kept as $kept"
fi
if ! restore_to "$live" >/dev/null 2>&1; then
  [ ! -f "$kept" ] || mv "$kept" "$live"
  start_hub || true
  die "the backup could not be put in place; the hub's own database is back and the hub restarted"
fi
unset EA_RECOVERY_KEY
say "Starting the hub"
start_hub
say "Done. Devices paired before keep working when this machine's device-keys.json is the one they paired with;"
say "otherwise pair them again (Settings, Connection). Notes missing from the notes folder are written back from it."
