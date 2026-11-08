#!/bin/bash
# Update the hub on the hub machine. Run as a sudo-capable user:
#   sudo bash /opt/everythingapp/deploy/update-hub.sh                 # git pull if /opt/everythingapp is a clone
#   sudo bash /opt/everythingapp/deploy/update-hub.sh --from-dir /home/<hub-user>/everythingapp
# Options:
#   --from-dir <path>  rsync a fresh copy of the repo over /opt/everythingapp
#   --branch <name>    branch to pull (default: current)
set -euo pipefail

REPO_DIR="/opt/everythingapp"
SERVICE_USER="everythingapp"
SERVICE_GROUP="everythingapp"
DATA_DIR="/var/lib/everythingapp"
ENV_FILE="/etc/everythingapp/hub.env"
UNIT_NAME="everythingapp-hub.service"
FROM_DIR=""
BRANCH=""

log() { printf '\n==> %s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --from-dir) FROM_DIR="$2"; shift ;;
    --branch)   BRANCH="$2"; shift ;;
    -h|--help)  sed -n '2,8p' "$0"; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
  shift
done

[ "$(id -u)" -eq 0 ] || die "run with sudo"
[ -d "$REPO_DIR" ] || die "$REPO_DIR missing; run install-hub.sh first"
[ -f "$ENV_FILE" ] || die "$ENV_FILE missing; run install-hub.sh first"
PORT="$(sed -n 's/^EA_PORT=//p' "$ENV_FILE" | tail -n 1)"; PORT="${PORT:-8787}"

log "fetching code"
if [ -n "$FROM_DIR" ]; then
  FROM_DIR="$(cd "$FROM_DIR" && pwd)" || die "--from-dir path does not exist"
  [ -f "$FROM_DIR/package.json" ] || die "$FROM_DIR is not the repo"
  rsync -a --delete \
    --exclude node_modules --exclude '.env' --exclude '*/.env' --exclude analysis/ \
    --exclude 'web/src-tauri/target' --exclude '.DS_Store' \
    "$FROM_DIR/" "$REPO_DIR/"
  echo "rsynced from $FROM_DIR"
elif [ -d "$REPO_DIR/.git" ]; then
  BEFORE="$(git -C "$REPO_DIR" rev-parse --short HEAD)"
  git -C "$REPO_DIR" fetch --quiet origin
  [ -z "$BRANCH" ] || git -C "$REPO_DIR" checkout --quiet "$BRANCH"
  git -C "$REPO_DIR" pull --ff-only --quiet
  echo "git $BEFORE -> $(git -C "$REPO_DIR" rev-parse --short HEAD)"
else
  die "$REPO_DIR is not a git clone; pass --from-dir <path>"
fi
chown -R "$SERVICE_USER:$SERVICE_GROUP" "$REPO_DIR"

log "installing dependencies"
run_as_service() { sudo -u "$SERVICE_USER" -H env HOME="$DATA_DIR" PATH="$PATH" "$@"; }
( cd "$REPO_DIR" && run_as_service npm ci --omit=dev --no-audit --no-fund 2>&1 | tail -n 3 )
if grep -q '"start": *"tsx' "$REPO_DIR/hub/package.json" && [ ! -x "$REPO_DIR/node_modules/.bin/tsx" ]; then
  ( cd "$REPO_DIR" && run_as_service npm ci --no-audit --no-fund 2>&1 | tail -n 3 )
fi

log "refreshing the systemd unit and restarting"
install -m 644 "$REPO_DIR/deploy/systemd/$UNIT_NAME" "/etc/systemd/system/$UNIT_NAME"
systemctl daemon-reload
systemctl restart "$UNIT_NAME"

log "health"
HEALTH=""
for _ in $(seq 1 30); do
  if HEALTH="$(curl -fsS "http://127.0.0.1:$PORT/health" 2>/dev/null)"; then break; fi
  sleep 1
done
if [ -z "$HEALTH" ]; then
  journalctl -u "$UNIT_NAME" --no-pager -n 40 || true
  die "hub did not answer on /health within 30 s"
fi
echo "$HEALTH"
systemctl --no-pager --lines=0 status "$UNIT_NAME" | sed -n '1,4p'
