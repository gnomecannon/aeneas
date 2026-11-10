#!/usr/bin/env bash
# Update this hub to the newest code of its branch, from the app (Settings, About, Update hub) or the assistant.
#
#   bash ~/everythingapp/deploy/update.sh
#
# For a hub installed with deploy/install.sh (a git clone in ~/everythingapp, a user service). No root. In order:
#   1. git fetch the branch (main unless EA_REF says otherwise); nothing newer: stop, "up to date";
#   2. refuse when files here were changed by hand, or the branch went somewhere that is not a fast forward;
#   3. git merge --ff-only, npm ci, the web app build;
#   4. restart the hub (systemd user service, or the launchd agent on a Mac) and wait for /health, twice;
#   5. when the new code does not install or the hub does not come back: back to the commit it had, npm ci, restart;
#   6. on a machine with several people (deploy/people.sh), ask its root service to move their hubs to this code.
# Progress goes to $EA_UPDATE_DIR/status.json (the hub reads it) and its output to $EA_UPDATE_DIR/update.log.
# The hub starts this outside its own service (systemd-run, or a new session on a Mac), so the restart does not stop it.
set -uo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONF_DIR="$HOME/.config/everythingapp"
ENV_FILE="$CONF_DIR/hub.env"
env_value() { [ -f "$ENV_FILE" ] && sed -n "s/^$1=//p" "$ENV_FILE" | tail -n 1; }
DATA_DIR="$(env_value EA_DATA_DIR)"; DATA_DIR="${DATA_DIR:-$HOME/.local/share/everythingapp}"
UPDATE_DIR="${EA_UPDATE_DIR:-$DATA_DIR/update}"
PORT="${EA_PORT:-$(env_value EA_PORT)}"; PORT="${PORT:-8787}"
REF="${EA_REF:-main}"
OS="$(uname -s)"
mkdir -p "$UPDATE_DIR"
STATUS="$UPDATE_DIR/status.json"
LOCK="$UPDATE_DIR/lock"
export NPM_CONFIG_UPDATE_NOTIFIER=false NPM_CONFIG_FUND=false
[ -x "$HOME/.local/node/bin/node" ] && export PATH="$HOME/.local/node/bin:$PATH"

# A run the hub started already writes its output to update.log; from a terminal it goes there too.
if [ -z "${EA_UPDATE_LOGGED:-}" ]; then exec >>"$UPDATE_DIR/update.log" 2>&1; fi
echo "==== $(date -u +%Y-%m-%dT%H:%M:%SZ) update of $APP_DIR ($REF)"

FROM=""; TO=""
# state, message: written whole under another name first, so the hub never reads half of it.
status() {
  node -e '
    const fs = require("fs");
    const [file, state, message, from, to] = process.argv.slice(1);
    const s = { state, message, from: from || null, to: to || null, at: new Date().toISOString() };
    fs.writeFileSync(file + ".tmp", JSON.stringify(s));
    fs.renameSync(file + ".tmp", file);
  ' "$STATUS" "$1" "$2" "$FROM" "$TO"
  echo "-- $1: $2"
}
finish() { status "$1" "$2"; rmdir "$LOCK" 2>/dev/null; exit "${3:-0}"; }
# Every network or build step has a limit, so a stuck one cannot hold the update (and the lock) for ever.
limit() { local s="$1"; shift; perl -e 'alarm shift; exec @ARGV or die "cannot run $ARGV[0]\n"' "$s" "$@"; }

if ! mkdir "$LOCK" 2>/dev/null; then
  # A lock left by an update that was killed (a reboot) is cleared after an hour.
  if [ -n "$(find "$LOCK" -maxdepth 0 -mmin +60 2>/dev/null)" ]; then rmdir "$LOCK"; mkdir "$LOCK" || exit 1
  else echo "another update is running"; exit 1; fi
fi

git -C "$APP_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1 ||
  finish failed "This hub was copied in, not installed with git, so it cannot update itself. Update it the way it was installed." 1
FROM="$(git -C "$APP_DIR" rev-parse HEAD)"

status checking "Looking for a newer version"
limit 120 git -C "$APP_DIR" fetch --quiet origin "$REF" || finish failed "Could not reach the hub's code on GitHub. Try again later." 1
TO="$(git -C "$APP_DIR" rev-parse FETCH_HEAD)"
[ "$FROM" != "$TO" ] || finish up_to_date "This hub already has the newest version."
[ -z "$(git -C "$APP_DIR" status --porcelain --untracked-files=no)" ] ||
  finish failed "Files in $APP_DIR were changed by hand, so the update would overwrite them. Keep or undo those changes first (git -C $APP_DIR status shows them)." 1
git -C "$APP_DIR" merge-base --is-ancestor "$FROM" "$TO" ||
  finish failed "The newest version does not follow on from this one (the branch was rewritten). Update from a terminal with git." 1

health() { curl -fsS --max-time 3 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; }
restart() {
  if [ "$OS" = Darwin ]; then launchctl kickstart -k "gui/$(id -u)/app.everythingapp.hub"
  else systemctl --user restart everythingapp-hub.service; fi
}
# Up within a minute, and still up a little later: a hub that starts and then falls over does not count.
came_back() {
  local ok=""
  for _ in $(seq 1 60); do if health; then ok=1; break; fi; sleep 1; done
  [ -n "$ok" ] || return 1
  sleep 8
  health
}
install_code() {
  (cd "$APP_DIR" && limit 900 npm ci --no-audit --no-fund --loglevel=error) || return 1
  (cd "$APP_DIR" && limit 600 npm --workspace web run build) || echo "the web app did not build; the hub still runs"
  return 0
}
roll_back() {
  status rolling_back "$1 Going back to the version it had."
  git -C "$APP_DIR" reset --quiet --hard "$FROM"
  install_code || true
  restart || true
  TO="$FROM"
  if came_back; then finish rolled_back "$1 The hub is back on the version it had." 1
  else finish failed "$1 Going back did not bring the hub up either: run bash $APP_DIR/deploy/install.sh on the hub machine." 1; fi
}

status installing "Installing the new version"
git -C "$APP_DIR" merge --quiet --ff-only "$TO" || finish failed "git could not move to the new version." 1
install_code || roll_back "The new version's packages did not install."

status restarting "Restarting the hub"
restart || roll_back "The hub's service did not restart."
came_back || roll_back "The new version did not start."

# Several people on this machine: their hubs run this code too. Only the owner's account can drop the request, and
# the root service takes nothing from it but the word update.
OWNER_FILE=/etc/aeneas/owner REQUESTS=/var/lib/aeneas/requests
if [ "$OS" = Linux ] && [ "$(cat "$OWNER_FILE" 2>/dev/null)" = "$(id -un)" ] && [ -w "$REQUESTS" ]; then
  id="update-$(date +%s)"
  printf '{"id":"%s","op":"update","name":"","color":""}' "$id" > "$REQUESTS/.$id.part" && mv "$REQUESTS/.$id.part" "$REQUESTS/$id.json"
  echo "asked the people service to update the other hubs ($id)"
fi

finish done "Updated."
