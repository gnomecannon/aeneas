#!/usr/bin/env bash
# Update this hub to the newest code of its branch, from the app (Settings, About, Update hub) or the assistant.
#
#   bash ~/everythingapp/deploy/update.sh
#
# For a hub installed with deploy/install.sh (a git clone in ~/everythingapp, a user service). No root. In order:
#   1. git fetch the branch (main unless EA_REF says otherwise); nothing newer: stop, "up to date";
#   2. refuse when files here were changed by hand, or the branch went somewhere that is not a fast forward (a shallow
#      clone whose history does not link up is fetched in full once and asked again);
#   3. the packages (every node_modules folder) and the web app it has go aside into .update-backup; git merge
#      --ff-only, npm ci, the web app build;
#   4. restart the hub (systemd user service, or the launchd agent on a Mac) and wait for /health, twice;
#   5. when the new code does not install or the hub does not come back: back to the commit it had, with the packages
#      and web app set aside (no npm ci, so no network needed), restart;
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
# Where the packages and the web app of the version installed wait while npm ci installs new ones (it deletes
# node_modules first): a failed update puts them back, so the hub runs its old version again without the network that
# just failed.
BACKUP="$APP_DIR/.update-backup"
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

# Every node_modules folder under a folder (the root's and the workspaces', never one inside another), then web/dist.
parts_in() {
  (cd "$1" 2>/dev/null || exit 0
   find . \( -name .git -o -name .update-backup \) -prune -o -type d -name node_modules -prune -print
   if [ -d web/dist ]; then echo ./web/dist; fi) | sed 's#^\./##'
}
# The backup holds the packages of the commit this hub runs.
backup_fits() { [ -n "$FROM" ] && [ "$(cat "$BACKUP/.commit" 2>/dev/null)" = "$FROM" ]; }
# Before npm ci: each node_modules folder moves into the backup (a rename on the same disk) and the web app is copied
# there (the hub serves it until the build replaces it), with the commit they belong to. When one cannot be moved, what
# was moved goes back and the update goes on without a backup, as it did before.
set_aside() {
  backup_fits && return 0  # left by a stopped update and not put back: it already holds these packages
  rm -rf "$BACKUP"
  [ -d "$APP_DIR/node_modules" ] || return 1
  { mkdir -p "$BACKUP" && echo "$FROM" > "$BACKUP/.commit"; } || { rm -rf "$BACKUP"; return 1; }
  local p
  while IFS= read -r p; do
    [ -n "$p" ] || continue
    if [ "$p" = web/dist ]; then mkdir -p "$BACKUP/web" && cp -R "$APP_DIR/web/dist" "$BACKUP/web/dist"
    else mkdir -p "$(dirname "$BACKUP/$p")" && mv "$APP_DIR/$p" "$BACKUP/$p"; fi ||
      { echo "could not set $p aside, so this update has no backup"; put_back; return 1; }
  done <<< "$(parts_in "$APP_DIR")"
  : > "$BACKUP/.complete"
}
# The parts set aside go back. From a whole backup, whatever a failed install left goes first (every node_modules
# folder, and web/dist when the backup has one); from one a crash cut short (no .complete), only the places it emptied
# are filled. The backup goes once all is back; when something could not be moved it stays, for the next run.
put_back() {
  [ -d "$BACKUP" ] || return 0
  local p ok=0 whole="" saved
  saved="$(parts_in "$BACKUP")"
  [ -f "$BACKUP/.complete" ] && whole=1
  if [ -n "$whole" ] && [ ! -f "$BACKUP/.cleared" ]; then
    while IFS= read -r p; do
      [ -n "$p" ] || continue
      [ "$p" != web/dist ] || [ -d "$BACKUP/web/dist" ] || continue
      rm -rf "${APP_DIR:?}/$p"
      [ ! -e "$APP_DIR/$p" ] || { echo "could not remove $p, so nothing was put back"; return 1; }
    done <<< "$(parts_in "$APP_DIR")"
    : > "$BACKUP/.cleared"
  fi
  while IFS= read -r p; do
    [ -n "$p" ] || continue
    # Taken: a whole backup cannot go back there; from one a crash cut short, the app kept its own.
    if [ -e "$APP_DIR/$p" ] || [ -L "$APP_DIR/$p" ]; then [ -z "$whole" ] || ok=1; continue; fi
    { mkdir -p "$(dirname "$APP_DIR/$p")" && mv "$BACKUP/$p" "$APP_DIR/$p"; } || { echo "could not put $p back"; ok=1; }
  done <<< "$saved"
  [ "$ok" != 0 ] || rm -rf "$BACKUP"
  return "$ok"
}

if ! mkdir "$LOCK" 2>/dev/null; then
  # A lock left by an update that was killed (a reboot) is cleared after an hour.
  if [ -n "$(find "$LOCK" -maxdepth 0 -mmin +60 2>/dev/null)" ]; then rmdir "$LOCK"; mkdir "$LOCK" || exit 1
  else echo "another update is running"; exit 1; fi
fi

git -C "$APP_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1 ||
  finish failed "This hub was copied in, not installed with git, so it cannot update itself. Update it the way it was installed." 1
FROM="$(git -C "$APP_DIR" rev-parse HEAD)"

# A backup that a stopped update left (a reboot during it): put back while the code is still on the commit it belongs
# to, else of no more use.
if [ -d "$BACKUP" ]; then
  if backup_fits; then
    echo "putting back the packages a stopped update set aside"
    put_back || echo "not everything set aside could be put back"
  else rm -rf "$BACKUP"; fi
fi

status checking "Looking for a newer version"
limit 120 git -C "$APP_DIR" fetch --quiet origin "$REF" || finish failed "Could not reach the hub's code on GitHub. Try again later." 1
TO="$(git -C "$APP_DIR" rev-parse FETCH_HEAD)"
[ "$FROM" != "$TO" ] || finish up_to_date "This hub already has the newest version."
[ -z "$(git -C "$APP_DIR" status --porcelain --untracked-files=no)" ] ||
  finish failed "Files in $APP_DIR were changed by hand, so the update would overwrite them. Keep or undo those changes first (git -C $APP_DIR status shows them)." 1
follows_on() { git -C "$APP_DIR" merge-base --is-ancestor "$FROM" "$TO"; }
# A shallow clone that once took a fetch with --depth 1 (the Windows installer made those before) has a newest commit
# with no history linking it to this one, which reads as a rewritten branch: its whole history is fetched once, and
# the question asked again.
if ! follows_on && [ "$(git -C "$APP_DIR" rev-parse --is-shallow-repository 2>/dev/null)" = true ]; then
  echo "the history of this shallow clone does not link up: fetching all of it"
  limit 120 git -C "$APP_DIR" fetch --quiet --unshallow origin "$REF" || finish failed "Could not reach the hub's code on GitHub. Try again later." 1
fi
follows_on ||
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
  if ! (cd "$APP_DIR" && limit 600 npm --workspace web run build); then
    echo "the web app did not build; the hub still runs"
    # With the web app it had, when one was set aside.
    if backup_fits && [ -d "$BACKUP/web/dist" ]; then rm -rf "$APP_DIR/web/dist" && mv "$BACKUP/web/dist" "$APP_DIR/web/dist"; fi
  fi
  return 0
}
roll_back() {
  status rolling_back "$1 Going back to the version it had."
  git -C "$APP_DIR" reset --quiet --hard "$FROM"
  # Its packages and web app, set aside before the install, go back as they were: no npm ci, so no network.
  if backup_fits; then put_back || echo "not everything set aside could be put back"
  else install_code || true; fi
  restart || true
  TO="$FROM"
  if came_back; then finish rolled_back "$1 The hub is back on the version it had." 1
  else finish failed "$1 Going back did not bring the hub up either: run bash $APP_DIR/deploy/install.sh on the hub machine." 1; fi
}

status installing "Installing the new version"
set_aside
git -C "$APP_DIR" merge --quiet --ff-only "$TO" || { put_back; finish failed "git could not move to the new version." 1; }
install_code || roll_back "The new version's packages did not install."

status restarting "Restarting the hub"
restart || roll_back "The hub's service did not restart."
came_back || roll_back "The new version did not start."
# The new version runs: what was set aside is of no more use.
rm -rf "$BACKUP"

# Several people on this machine: their hubs run this code too. Only the owner's account can drop the request, and
# the root service takes nothing from it but the word update.
OWNER_FILE=/etc/aeneas/owner REQUESTS=/var/lib/aeneas/requests
if [ "$OS" = Linux ] && [ "$(cat "$OWNER_FILE" 2>/dev/null)" = "$(id -un)" ] && [ -w "$REQUESTS" ]; then
  id="update-$(date +%s)"
  printf '{"id":"%s","op":"update","name":"","color":""}' "$id" > "$REQUESTS/.$id.part" && mv "$REQUESTS/.$id.part" "$REQUESTS/$id.json"
  echo "asked the people service to update the other hubs ($id)"
fi

finish done "Updated."
