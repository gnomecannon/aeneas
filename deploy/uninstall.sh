#!/usr/bin/env bash
# Take Aeneas off this machine: the services the installer made (hub, Ollama, search, Tor), their programs,
# and the app folder. Your data and keys are NOT deleted: the script ends by naming the two folders that hold them,
# so you can copy them somewhere first and delete them yourself once you are sure.
#
#   ~/everythingapp/deploy/uninstall.sh
#
# Asks once before changing anything. Nothing is sent anywhere.
set -euo pipefail
say() { printf '==> %s\n' "$*"; }
[ "$(id -u)" != 0 ] || { echo "error: run this as the user the hub runs as, not root" >&2; exit 1; }
OS="$(uname -s)"
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONF_DIR="$HOME/.config/everythingapp"
ENV_FILE="$CONF_DIR/hub.env"
get_env() { [ -r "$ENV_FILE" ] && grep -E "^$1=" "$ENV_FILE" | tail -1 | cut -d= -f2- || true; }
DATA_DIR="$(get_env EA_DATA_DIR)"; DATA_DIR="${DATA_DIR:-$HOME/.local/share/everythingapp}"
PORT="$(get_env EA_PORT)"; PORT="${PORT:-8787}"

echo "This stops and removes the Aeneas hub and the services the installer set up with it, and deletes:"
echo "  $APP_DIR (the app)"
for d in "$HOME/.local/ollama" "$HOME/.local/searxng" "$HOME/.local/tor" "$HOME/.local/everythingapp-python"; do [ ! -f "$d/.everythingapp" ] || echo "  $d"; done
echo "  $HOME/.cache/everythingapp"
echo "It keeps your data ($DATA_DIR) and keys and settings ($CONF_DIR)."
if [ -t 0 ]; then
  printf 'Go ahead? [y/N] '; read -r a; case "$a" in y|Y|yes) ;; *) echo "Nothing was changed."; exit 0 ;; esac
else
  [ "${EA_UNINSTALL_YES:-}" = 1 ] || { echo "Run this in a terminal, or with EA_UNINSTALL_YES=1." >&2; exit 1; }
fi

for s in hub ollama searxng tor; do
  if [ "$OS" = Linux ]; then
    systemctl --user disable --now "everythingapp-$s.service" >/dev/null 2>&1 || true
    rm -f "$HOME/.config/systemd/user/everythingapp-$s.service"
  else
    launchctl bootout "gui/$(id -u)/app.everythingapp.$s" >/dev/null 2>&1 || true
    rm -f "$HOME/Library/LaunchAgents/app.everythingapp.$s.plist"
  fi
done
[ "$OS" != Linux ] || systemctl --user daemon-reload >/dev/null 2>&1 || true
say "Services stopped and removed"

# Only the HTTPS address the installer added for the hub's port; other Tailscale Serve settings stay.
if command -v tailscale >/dev/null 2>&1 && tailscale serve status 2>/dev/null | grep -q ":$PORT"; then
  tailscale serve --https="$PORT" off >/dev/null 2>&1 && say "Tailscale Serve no longer serves port $PORT" || say "Tailscale Serve still serves port $PORT; remove it with: tailscale serve --https=$PORT off"
fi

# Programs the installer put there (each marked with its .everythingapp file); one you installed yourself stays.
for d in "$HOME/.local/ollama" "$HOME/.local/searxng" "$HOME/.local/tor" "$HOME/.local/everythingapp-python"; do
  if [ -f "$d/.everythingapp" ]; then rm -rf "$d"; say "Removed $d"; fi
done
rm -rf "$HOME/.cache/everythingapp"
case "$APP_DIR" in "$HOME"/*) rm -rf "$APP_DIR"; say "Removed $APP_DIR" ;; *) say "$APP_DIR is outside your home folder and was left" ;; esac

echo
echo "Left in place, for you to keep or delete:"
echo "  $DATA_DIR   your data, backups and notes"
echo "  $CONF_DIR   hub.env, the backup and work keys, the certificate"
echo "  ~/.local/node  Node, if the installer put it there and nothing else uses it"
echo "  Ollama's models (usually ~/.ollama/models), several GB"
[ "$OS" != Linux ] || echo "  Lingering (services running while logged out): loginctl disable-linger $USER  turns it off"
echo "Paired phones and computers stop syncing; remove the app from them as usual."
