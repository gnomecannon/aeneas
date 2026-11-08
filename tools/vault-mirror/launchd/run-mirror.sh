#!/bin/bash
# Wrapper launched by com.everythingapp.vault-mirror.plist on the Mac that holds the vault.
# Reads the hub token from the login Keychain and starts the mirror in watch mode.
# The token never touches a file. Add it once with:
#   security add-generic-password -a "$USER" -s everythingapp-hub -w '<token>' -U
set -euo pipefail

REPO_DIR="${EA_REPO_DIR:-__REPO_DIR__}"
NODE_BIN_DIR="${EA_NODE_BIN_DIR:-__NODE_BIN_DIR__}"
KEYCHAIN_SERVICE="everythingapp-hub"

export PATH="$NODE_BIN_DIR:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

if ! token="$(security find-generic-password -s "$KEYCHAIN_SERVICE" -w 2>/dev/null)"; then
  echo "$(date '+%Y-%m-%d %H:%M:%S') FATAL no Keychain item with service '$KEYCHAIN_SERVICE'. Add it with: security add-generic-password -a \"\$USER\" -s $KEYCHAIN_SERVICE -w '<token>' -U" >&2
  sleep 30
  exit 1
fi
export EA_TOKEN="$token"
unset token

cd "$REPO_DIR/tools/vault-mirror"
exec "$NODE_BIN_DIR/npx" --no-install tsx src/cli.ts watch
