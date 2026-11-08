#!/bin/bash
# Install the vault mirror as a launchd user agent on this Mac.
# Run as the normal login user, never with sudo:
#   bash tools/vault-mirror/launchd/install-mac.sh
# Options:
#   --uninstall     stop and remove the agent (keeps config, state and Keychain item)
#   --hub-url URL   write hub_url into ~/.config/everythingapp/mirror.json (needed the first time)
#   --vault-dir DIR write vault_dir into mirror.json (default: the iCloud Obsidian vault, when there is only one)
set -euo pipefail

LABEL="com.everythingapp.vault-mirror"
KEYCHAIN_SERVICE="everythingapp-hub"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PLIST_SRC="$REPO_DIR/tools/vault-mirror/launchd/$LABEL.plist"
PLIST_DST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs/everythingapp"
CONFIG_DIR="$HOME/.config/everythingapp"
CONFIG_FILE="$CONFIG_DIR/mirror.json"
OBSIDIAN_ICLOUD="$HOME/Library/Mobile Documents/iCloud~md~obsidian/Documents"
# The one vault in Obsidian's iCloud folder; with none or several, --vault-dir says which.
DEFAULT_VAULT=""
if [ -d "$OBSIDIAN_ICLOUD" ]; then
  VAULTS=()
  for d in "$OBSIDIAN_ICLOUD"/*/; do [ -d "$d" ] && VAULTS+=("${d%/}"); done
  [ "${#VAULTS[@]}" -eq 1 ] && DEFAULT_VAULT="${VAULTS[0]}"
fi
HUB_URL=""
VAULT_DIR=""
UNINSTALL=0

while [ $# -gt 0 ]; do
  case "$1" in
    --uninstall) UNINSTALL=1 ;;
    --hub-url) HUB_URL="$2"; shift ;;
    --vault-dir) VAULT_DIR="$2"; shift ;;
    -h|--help) sed -n '2,8p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

if [ "$(id -u)" -eq 0 ]; then
  echo "run this as your normal user, not with sudo" >&2
  exit 1
fi

UID_NUM="$(id -u)"
DOMAIN="gui/$UID_NUM"

if [ "$UNINSTALL" -eq 1 ]; then
  launchctl bootout "$DOMAIN" "$PLIST_DST" 2>/dev/null || true
  rm -f "$PLIST_DST"
  echo "removed $LABEL. Config at $CONFIG_FILE and the Keychain item were kept."
  exit 0
fi

NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  echo "node not found on PATH. Install Node 20 first (brew install node@20 or nodejs.org)." >&2
  exit 1
fi
NODE_BIN_DIR="$(dirname "$(readlink -f "$NODE_BIN" 2>/dev/null || echo "$NODE_BIN")")"
NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "node $("$NODE_BIN" --version) is too old; need 20 or newer" >&2
  exit 1
fi

if [ ! -x "$REPO_DIR/node_modules/.bin/tsx" ]; then
  echo "tsx is not installed. Run: cd \"$REPO_DIR\" && npm install" >&2
  exit 1
fi

if ! security find-generic-password -s "$KEYCHAIN_SERVICE" >/dev/null 2>&1; then
  echo "no Keychain item for service '$KEYCHAIN_SERVICE'." >&2
  echo "add it first (paste the hub token in place of <token>):" >&2
  echo "  security add-generic-password -a \"\$USER\" -s $KEYCHAIN_SERVICE -w '<token>' -U" >&2
  exit 1
fi

mkdir -p "$LOG_DIR" "$CONFIG_DIR" "$HOME/Library/LaunchAgents"
chmod 700 "$CONFIG_DIR"

# write or update mirror.json without a token in it
if [ ! -f "$CONFIG_FILE" ]; then
  [ -n "$VAULT_DIR" ] || VAULT_DIR="$DEFAULT_VAULT"
  if [ -z "$VAULT_DIR" ]; then
    echo "first install: give the vault folder with --vault-dir DIR (found no single vault in $OBSIDIAN_ICLOUD)" >&2
    exit 1
  fi
  if [ -z "$HUB_URL" ]; then
    echo "first install: give the hub address with --hub-url https://<hub host>" >&2
    exit 1
  fi
  cat > "$CONFIG_FILE" <<JSON
{
  "hub_url": "$HUB_URL",
  "vault_dir": "$VAULT_DIR",
  "state_file": "$CONFIG_DIR/mirror-state.json"
}
JSON
  echo "wrote $CONFIG_FILE"
else
  if [ -n "$HUB_URL" ] || [ -n "$VAULT_DIR" ]; then
    node -e '
      const fs = require("fs"); const [file, hub, vault] = process.argv.slice(1);
      const c = JSON.parse(fs.readFileSync(file, "utf8"));
      if (hub) c.hub_url = hub; if (vault) c.vault_dir = vault;
      delete c.token;
      fs.writeFileSync(file, JSON.stringify(c, null, 2) + "\n");
    ' "$CONFIG_FILE" "$HUB_URL" "$VAULT_DIR"
    echo "updated $CONFIG_FILE"
  fi
  if grep -q '"token"' "$CONFIG_FILE"; then
    echo "warning: $CONFIG_FILE contains a token key. The agent uses the Keychain; remove the key from the file." >&2
  fi
fi
chmod 600 "$CONFIG_FILE"

VAULT_CHECK="$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).vault_dir' "$CONFIG_FILE")"
if [ ! -d "$VAULT_CHECK" ]; then
  echo "vault_dir does not exist: $VAULT_CHECK" >&2
  echo "fix it in $CONFIG_FILE or pass --vault-dir" >&2
  exit 1
fi

# render the plist
sed -e "s|__REPO_DIR__|$REPO_DIR|g" -e "s|__NODE_BIN_DIR__|$NODE_BIN_DIR|g" -e "s|__HOME__|$HOME|g" "$PLIST_SRC" > "$PLIST_DST"
plutil -lint "$PLIST_DST" >/dev/null

launchctl bootout "$DOMAIN" "$PLIST_DST" 2>/dev/null || true
launchctl bootstrap "$DOMAIN" "$PLIST_DST"
launchctl kickstart -k "$DOMAIN/$LABEL"

sleep 3
echo
echo "agent $LABEL installed and started."
echo "status:   launchctl print $DOMAIN/$LABEL | grep -E 'state|pid'"
echo "log:      tail -f $LOG_DIR/vault-mirror.log"
echo "errors:   tail -f $LOG_DIR/vault-mirror.err.log"
echo "stop:     launchctl bootout $DOMAIN $PLIST_DST"
echo
tail -n 5 "$LOG_DIR/vault-mirror.log" 2>/dev/null || true
