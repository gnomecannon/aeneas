#!/usr/bin/env bash
# Rootless hub install: everything under the invoking user's home, no sudo.
#
#   bash deploy/install-hub-user.sh --from-dir ~/everythingapp [--port 8787] [--serve-port 8787]
#
# Requirements on the host: Linux x86_64 or arm64, systemd user session with lingering enabled
# (loginctl enable-linger), curl, tar. Tailscale Serve is configured when the user is the
# Tailscale operator; otherwise that one step is printed for a sudo-capable user to run.
#
# Layout:
#   ~/.local/node/            Node 20 (downloaded tarball, no package manager)
#   ~/everythingapp/          the repo (rsync target or git clone)
#   ~/.config/everythingapp/hub.env
#   ~/.local/share/everythingapp/{hub.sqlite,vault,backups}
#   ~/.config/systemd/user/everythingapp-hub.service
set -euo pipefail

NODE_VERSION="${NODE_VERSION:-20.20.2}"
FROM_DIR=""
PORT=8787
SERVE_PORT=8787
# No model server or model is assumed: pass EA_OLLAMA_URL and EA_OLLAMA_MODEL, or pick them on the Welcome page.
OLLAMA_URL="${EA_OLLAMA_URL:-}"
OLLAMA_MODEL="${EA_OLLAMA_MODEL:-}"

while [ $# -gt 0 ]; do
  case "$1" in
    --from-dir) FROM_DIR="$2"; shift ;;
    --port) PORT="$2"; shift ;;
    --serve-port) SERVE_PORT="$2"; shift ;;
    --node-version) NODE_VERSION="$2"; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

die() { echo "error: $*" >&2; exit 1; }
[ -n "$FROM_DIR" ] || die "give --from-dir <path to the repo on this host>"
[ -d "$FROM_DIR/hub" ] || die "$FROM_DIR does not look like the repo (no hub/ directory)"
command -v curl >/dev/null || die "curl is required"
command -v tar >/dev/null || die "tar is required"
systemctl --user is-system-running >/dev/null 2>&1 || die "no systemd user session; log in once with a real session or enable lingering"
case "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null)" in
  yes) ;;
  *) echo "warning: lingering is off; the hub will stop at logout. Run: loginctl enable-linger $USER (may need sudo)" >&2 ;;
esac

REPO="$(cd "$FROM_DIR" && pwd)"
CONF_DIR="$HOME/.config/everythingapp"
DATA_DIR="$HOME/.local/share/everythingapp"
NODE_DIR="$HOME/.local/node"
UNIT_DIR="$HOME/.config/systemd/user"
mkdir -p "$CONF_DIR" "$DATA_DIR/vault" "$DATA_DIR/backups" "$UNIT_DIR" "$HOME/.local/bin"

# ---- Node 20 in the home directory ----
arch="$(uname -m)"
case "$arch" in
  x86_64) narch=x64 ;;
  aarch64|arm64) narch=arm64 ;;
  *) die "unsupported arch $arch" ;;
esac
need_node=1
if [ -x "$NODE_DIR/bin/node" ]; then
  have="$("$NODE_DIR/bin/node" -v | sed 's/^v//')"
  [ "${have%%.*}" -ge 20 ] && need_node=0
fi
if [ "$need_node" = 1 ]; then
  echo "[node] installing v$NODE_VERSION to $NODE_DIR"
  tmp="$(mktemp -d)"
  curl -fsSL -o "$tmp/node.tar.xz" "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-$narch.tar.xz"
  rm -rf "$NODE_DIR"
  mkdir -p "$NODE_DIR"
  tar -xJf "$tmp/node.tar.xz" -C "$NODE_DIR" --strip-components=1
  rm -rf "$tmp"
fi
export PATH="$NODE_DIR/bin:$PATH"
echo "[node] $(node -v), npm $(npm -v)"

# ---- dependencies ----
echo "[npm] installing workspaces in $REPO"
(cd "$REPO" && npm ci --omit=dev --no-audit --no-fund 2>&1 | tail -2)

# ---- env file ----
ENV_FILE="$CONF_DIR/hub.env"
if [ ! -f "$ENV_FILE" ]; then
  token="$(head -c 64 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 48)"
  umask 077
  cat > "$ENV_FILE" <<EOF
EA_PORT=$PORT
EA_TOKEN=$token
EA_DATA_DIR=$DATA_DIR
EA_VAULT_DIR=$DATA_DIR/vault
EA_BACKUP_DIR=$DATA_DIR/backups
EA_WORK_KEY_FILE=$(dirname "$ENV_FILE")/work.key
EA_OLLAMA_URL=$OLLAMA_URL
EA_OLLAMA_MODEL=$OLLAMA_MODEL
EA_ANTHROPIC_API_KEY=
EA_ANTHROPIC_MODEL=claude-sonnet-5-5
EA_ALLOW_CLOUD_DEFAULT=false
EA_TZ=$(if [ "$(uname -s)" = Darwin ]; then readlink /etc/localtime 2>/dev/null | sed "s#.*/zoneinfo/##"; else timedatectl show -p Timezone --value 2>/dev/null || cat /etc/timezone 2>/dev/null || echo UTC; fi)
EA_NO_DOTENV=1
EOF
  umask 022
  echo "[env] wrote $ENV_FILE (new token generated)"
else
  echo "[env] keeping existing $ENV_FILE"
fi

# ---- user service ----
cat > "$UNIT_DIR/everythingapp-hub.service" <<EOF
[Unit]
Description=EverythingApp hub (rootless)
After=network-online.target

[Service]
Type=simple
WorkingDirectory=$REPO/hub
EnvironmentFile=$ENV_FILE
Environment=PATH=$NODE_DIR/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=$NODE_DIR/bin/node --import tsx src/main.ts serve
Restart=always
RestartSec=3
NoNewPrivileges=true

[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
systemctl --user enable --now everythingapp-hub.service
sleep 3
systemctl --user restart everythingapp-hub.service
for i in $(seq 1 20); do
  if curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then break; fi
  sleep 1
done
curl -fsS "http://127.0.0.1:$PORT/health" || { journalctl --user -u everythingapp-hub -n 30 --no-pager; die "hub did not come up on port $PORT"; }
echo

# ---- seed once ----
if [ ! -f "$DATA_DIR/.seeded" ]; then
  (cd "$REPO/hub" && set -a && . "$ENV_FILE" && set +a && node "$REPO/node_modules/.bin/tsx" src/main.ts seed) && touch "$DATA_DIR/.seeded"
fi

# ---- Tailscale Serve on its own port (does not touch an existing 443 proxy) ----
if command -v tailscale >/dev/null; then
  if tailscale serve --bg --https="$SERVE_PORT" "http://127.0.0.1:$PORT" >/dev/null 2>&1; then
    echo "[serve] https://$(tailscale status --json 2>/dev/null | sed -n 's/.*"DNSName": *"\([^"]*\)\.".*/\1/p' | head -1):$SERVE_PORT"
  else
    echo "[serve] could not configure Tailscale Serve as $USER. A sudo-capable user can run:"
    echo "        sudo tailscale set --operator=$USER && tailscale serve --bg --https=$SERVE_PORT http://127.0.0.1:$PORT"
  fi
fi

echo
# The token is not printed: installer output ends up in terminal scrollback, ssh logs and pasted transcripts.
echo "hub token: in $ENV_FILE (mode 600). Read it into the Mac Keychain with RUNBOOK step B4; it is never printed."
echo "service: systemctl --user status everythingapp-hub   logs: journalctl --user -u everythingapp-hub -f"
