#!/usr/bin/env bash
# Several people on one hub machine, each with a hub of their own (docs/multi-person.md).
#
#   sudo bash deploy/people.sh setup --name <owner's name> [--color '#rrggbb']
#        once: the model gate, the list of people, and the owner's own hub sent through the gate
#   sudo bash deploy/people.sh add <name> [--color '#rrggbb']
#        a Linux account for that person (no password, no login) running their own hub on its own port and address
#   sudo bash deploy/people.sh list
#   sudo bash deploy/people.sh pair <name>
#        a new pairing link for that person's first device (the one `add` printed lasts 10 minutes)
#   sudo bash deploy/people.sh update
#        every other person's hub to the owner's current code and shared model settings (after update-hub-user.sh)
#   sudo bash deploy/people.sh remove <name> [--erase <name again>]
#        stops their hub and its address; their data stays in their account unless --erase (which deletes it for good)
#   sudo bash deploy/people.sh unsetup
#        the owner's hub back on the model server directly and the gate stopped (other people's hubs must be removed first)
#
# Run with sudo as the machine's owner (the account whose hub is installed with install-hub-user.sh). Each person's
# data lives in their own account's home (mode 700), so one hub cannot read another's. The model server is shared through
# the gate (hub/src/gate.ts): a chat goes before background work, two people asking at once take turns, and only the
# owner can add or remove models. Nothing secret is printed.
set -euo pipefail

die() { echo "error: $*" >&2; exit 1; }
log() { printf '==> %s\n' "$*"; }

[ "$(id -u)" = 0 ] || die "run with sudo"
OWNER="${SUDO_USER:-}"
[ -n "$OWNER" ] && [ "$OWNER" != root ] || die "run with sudo from the owner's account, not as root directly"
OWNER_HOME="$(getent passwd "$OWNER" | cut -d: -f6)"
OWNER_REPO="${EA_OWNER_REPO:-$OWNER_HOME/everythingapp}"
OWNER_ENV="$OWNER_HOME/.config/everythingapp/hub.env"
REGISTRY_DIR=/etc/aeneas
REGISTRY="$REGISTRY_DIR/people.json"
GATE_PORT="${EA_GATE_PORT:-11435}"
GATE_URL="http://127.0.0.1:$GATE_PORT"
FIRST_PORT=8788
# Colors people pick their hub out by, in the order they are given out.
PALETTE=("#2f8f83" "#c27c2c" "#7a5cc7" "#c4506a" "#3a7bc8" "#6b9a3a" "#b8860b" "#8a6d5a")
EXCLUDES=(--exclude .git --exclude node_modules --exclude hub/data --exclude .env --exclude analysis --exclude 'web/src-tauri/target' --exclude 'web/src-tauri/gen' --exclude apple)

[ -d "$OWNER_REPO/hub" ] || die "no repo at $OWNER_REPO (set EA_OWNER_REPO)"
[ -f "$OWNER_ENV" ] || die "no $OWNER_ENV: install the owner's hub first (deploy/install-hub-user.sh)"
command -v python3 >/dev/null || die "python3 is required"
command -v rsync >/dev/null || die "rsync is required"

uid_of() { id -u "$1"; }
home_of() { getent passwd "$1" | cut -d: -f6; }
# A command as another account, with its systemd user session.
as_user() {
  local u="$1"; shift
  local uid; uid="$(uid_of "$u")"
  sudo -u "$u" env HOME="$(home_of "$u")" XDG_RUNTIME_DIR="/run/user/$uid" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$uid/bus" PATH="$(home_of "$u")/.local/node/bin:/usr/local/bin:/usr/bin:/bin" "$@"
}
env_get() { [ -f "$1" ] && grep -E "^$2=" "$1" | tail -1 | cut -d= -f2- || true; }
# Set KEY=VALUE in an env file in place (its owner and mode stay).
env_set() {
  python3 - "$1" "$2" "$3" <<'EOF'
import sys
path, key, value = sys.argv[1:4]
lines = open(path).read().splitlines()
out, done = [], False
for l in lines:
    if l.startswith(key + "="):
        if not done: out.append(f"{key}={value}"); done = True
        continue
    out.append(l)
if not done: out.append(f"{key}={value}")
with open(path, "r+") as f:
    f.seek(0); f.write("\n".join(out) + "\n"); f.truncate()
EOF
}
registry() { python3 - "$REGISTRY" "$@" <<'EOF'
import json, sys, os
path, op, *args = sys.argv[1:]
people = json.load(open(path)) if os.path.exists(path) else []
def save():
    tmp = path + ".tmp"
    with open(tmp, "w") as f: json.dump(people, f, indent=2); f.write("\n")
    os.chmod(tmp, 0o644); os.replace(tmp, path)
if op == "get":
    key, val, field = args
    for p in people:
        if str(p.get(key, "")).lower() == val.lower(): print(p.get(field, "")); break
elif op == "ports":
    print(" ".join(str(p["port"]) for p in people))
elif op == "colors":
    print(" ".join(p.get("color", "") for p in people))
elif op == "users":
    print(" ".join(p["user"] for p in people if not p.get("owner")))
elif op == "add":
    name, user, port, color, owner, added = args
    people[:] = [p for p in people if p["user"] != user]
    people.append({"name": name, "user": user, "port": int(port), "color": color, "owner": owner == "1", "added": added})
    save()
elif op == "remove":
    people[:] = [p for p in people if p["user"] != args[0]]; save()
elif op == "list":
    for p in people: print("\t".join([p["name"], p["user"], str(p["port"]), p.get("color", ""), "owner" if p.get("owner") else ""]))
EOF
}
tailnet_name() { tailscale status --json 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))' 2>/dev/null || hostname; }
port_taken() {
  local p="$1"
  ss -ltnH 2>/dev/null | awk '{print $4}' | grep -Eq "[:.]$p\$" && return 0
  tailscale serve status 2>/dev/null | grep -Eq ":$p( |\$)" && return 0
  for q in $(registry ports); do [ "$q" = "$p" ] && return 0; done
  return 1
}
next_port() { local p=$FIRST_PORT; while port_taken "$p"; do p=$((p + 1)); done; echo "$p"; }
next_color() {
  local used; used=" $(registry colors) "
  for c in "${PALETTE[@]}"; do case "$used" in *" $c "*) ;; *) echo "$c"; return ;; esac; done
  echo "${PALETTE[0]}"
}
wait_health() {
  local port="$1"
  for _ in $(seq 1 40); do curl -fsS --max-time 3 "http://127.0.0.1:$port/health" >/dev/null 2>&1 && return 0; sleep 1; done
  return 1
}
# Stop everything an account runs (its systemd user session too) and delete it with its home folder.
erase_account() {
  local acct="$1" uid; uid="$(uid_of "$acct")"
  loginctl disable-linger "$acct" 2>/dev/null || true
  systemctl stop "user@$uid.service" 2>/dev/null || true
  pkill -KILL -u "$acct" 2>/dev/null || true
  for _ in $(seq 1 20); do pgrep -u "$acct" >/dev/null || break; sleep 0.5; done
  userdel -r "$acct" 2>&1 | grep -v "mail spool" || true
  getent passwd "$acct" >/dev/null && die "could not delete the account $acct"
  return 0
}
valid_color() { [[ "$1" =~ ^#[0-9a-fA-F]{6}$ ]] || die "a color is #rrggbb, like #2f8f83"; }
slug_of() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9' | cut -c1-20; }
# Settings every hub on the machine shares with the owner's: the model and how it is run, web search, the day's clock.
SHARED_KEYS=(EA_OLLAMA_MODEL EA_OLLAMA_NUM_CTX EA_OLLAMA_KEEP_ALIVE EA_OLLAMA_THINK EA_BACKGROUND_AI EA_SEARXNG_URL EA_TOR_SOCKS EA_TZ)
copy_shared() {
  local env_file="$1"
  for k in "${SHARED_KEYS[@]}"; do
    local v; v="$(env_get "$OWNER_ENV" "$k")"
    [ -n "$v" ] && env_set "$env_file" "$k" "$v"
  done
  env_set "$env_file" EA_OLLAMA_URL "$GATE_URL"
  # The background reader waits for a button, as on the owner's hub when it has no setting (the GPU may be gaming).
  [ -n "$(env_get "$env_file" EA_BACKGROUND_AI)" ] || env_set "$env_file" EA_BACKGROUND_AI ask
}

cmd="${1:-}"; shift || true
case "$cmd" in
setup)
  NAME=""; COLOR=""
  while [ $# -gt 0 ]; do case "$1" in --name) NAME="$2"; shift ;; --color) COLOR="$2"; shift ;; *) die "unknown argument $1" ;; esac; shift; done
  [ -n "$NAME" ] || die "give --name <the owner's name>, shown on their devices"
  [ -n "$COLOR" ] && valid_color "$COLOR"
  install -d -m 755 "$REGISTRY_DIR"
  [ -n "$COLOR" ] || COLOR="$(registry get user "$OWNER" color)"
  [ -n "$COLOR" ] || COLOR="$(next_color)"
  OWNER_PORT="$(env_get "$OWNER_ENV" EA_PORT)"; OWNER_PORT="${OWNER_PORT:-8787}"
  UPSTREAM="$(env_get "$OWNER_ENV" EA_OLLAMA_URL)"
  if [ "$UPSTREAM" = "$GATE_URL" ]; then UPSTREAM="$(env_get "$OWNER_ENV" EA_GATE_UPSTREAM)"; fi
  [ -n "$UPSTREAM" ] || die "the owner's hub has no EA_OLLAMA_URL; pick a model on its Welcome page first"
  MODEL="$(env_get "$OWNER_ENV" EA_OLLAMA_MODEL)"
  NODE="$OWNER_HOME/.local/node/bin/node"
  [ -x "$NODE" ] || die "no Node at $NODE"
  log "model gate on 127.0.0.1:$GATE_PORT in front of $UPSTREAM"
  UNIT_DIR="$OWNER_HOME/.config/systemd/user"
  sudo -u "$OWNER" mkdir -p "$UNIT_DIR"
  sudo -u "$OWNER" tee "$UNIT_DIR/aeneas-gate.service" >/dev/null <<EOF
[Unit]
Description=Aeneas model gate (shares the model server between the hubs on this machine)
After=network-online.target

[Service]
Type=simple
WorkingDirectory=$OWNER_REPO/hub
Environment=EA_GATE_PORT=$GATE_PORT
Environment=EA_GATE_UPSTREAM=$UPSTREAM
Environment=EA_GATE_SLOTS=${EA_GATE_SLOTS:-1}
Environment=EA_GATE_MODELS=$MODEL
Environment=PATH=$OWNER_HOME/.local/node/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=$NODE $OWNER_REPO/node_modules/.bin/tsx src/main.ts gate
Restart=always
RestartSec=2
NoNewPrivileges=true

[Install]
WantedBy=default.target
EOF
  as_user "$OWNER" systemctl --user daemon-reload
  as_user "$OWNER" systemctl --user enable --now aeneas-gate.service
  as_user "$OWNER" systemctl --user restart aeneas-gate.service
  for _ in $(seq 1 20); do curl -fsS --max-time 2 "$GATE_URL/gate/status" >/dev/null 2>&1 && break; sleep 1; done
  curl -fsS --max-time 2 "$GATE_URL/gate/status" >/dev/null || { as_user "$OWNER" journalctl --user -u aeneas-gate -n 20 --no-pager; die "the gate did not start"; }
  curl -fsS --max-time 5 "$GATE_URL/api/version" >/dev/null || die "the gate is up but the model server at $UPSTREAM does not answer through it"
  log "the owner's hub ($NAME) through the gate"
  env_set "$OWNER_ENV" EA_GATE_UPSTREAM "$UPSTREAM"
  env_set "$OWNER_ENV" EA_OLLAMA_URL "$GATE_URL"
  env_set "$OWNER_ENV" EA_HUB_NAME "$NAME"
  env_set "$OWNER_ENV" EA_HUB_COLOR "$COLOR"
  as_user "$OWNER" systemctl --user restart everythingapp-hub
  wait_health "$OWNER_PORT" || die "the owner's hub did not come back on port $OWNER_PORT; undo with: sudo bash deploy/people.sh unsetup"
  registry add "$NAME" "$OWNER" "$OWNER_PORT" "$COLOR" 1 "$(date -u +%FT%TZ)"
  log "done: $NAME's hub at https://$(tailnet_name):$OWNER_PORT, color $COLOR"
  ;;

unsetup)
  [ -z "$(registry users)" ] || die "remove the other people first: $(registry users)"
  UPSTREAM="$(env_get "$OWNER_ENV" EA_GATE_UPSTREAM)"
  [ -n "$UPSTREAM" ] || die "the owner's hub was never sent through the gate"
  env_set "$OWNER_ENV" EA_OLLAMA_URL "$UPSTREAM"
  as_user "$OWNER" systemctl --user restart everythingapp-hub
  as_user "$OWNER" systemctl --user disable --now aeneas-gate.service || true
  OWNER_PORT="$(env_get "$OWNER_ENV" EA_PORT)"
  wait_health "${OWNER_PORT:-8787}" || die "the owner's hub did not come back"
  log "the owner's hub talks to $UPSTREAM directly again; the gate is stopped"
  ;;

add)
  NAME="${1:-}"; shift || true
  COLOR=""
  while [ $# -gt 0 ]; do case "$1" in --color) COLOR="$2"; shift ;; *) die "unknown argument $1" ;; esac; shift; done
  [[ "$NAME" =~ ^[A-Za-z][A-Za-z\ \'.-]{0,29}$ ]] || die "give the person's name (letters, up to 30)"
  curl -fsS --max-time 2 "$GATE_URL/gate/status" >/dev/null || die "the gate is not running: run setup first"
  SLUG="$(slug_of "$NAME")"; [ -n "$SLUG" ] || die "that name gives no account name"
  ACCT="aeneas-$SLUG"
  [ -z "$(registry get user "$ACCT" user)" ] || die "$NAME already has a hub (account $ACCT)"
  [ -z "$(registry get name "$NAME" user)" ] || die "someone named $NAME already has a hub"
  getent passwd "$ACCT" >/dev/null && die "the account $ACCT already exists; pick another name or remove it"
  [ -n "$COLOR" ] && valid_color "$COLOR"
  [ -n "$COLOR" ] || COLOR="$(next_color)"
  PORT="$(next_port)"
  log "account $ACCT for $NAME (no password, no login)"
  useradd -m -s /usr/sbin/nologin -c "Aeneas hub for $NAME" "$ACCT"
  HOME_DIR="$(home_of "$ACCT")"
  chmod 700 "$HOME_DIR"
  loginctl enable-linger "$ACCT"
  UIDN="$(uid_of "$ACCT")"
  for _ in $(seq 1 30); do [ -S "/run/user/$UIDN/bus" ] && break; sleep 1; done
  [ -S "/run/user/$UIDN/bus" ] || die "no systemd user session for $ACCT"
  log "copying the owner's hub code"
  rsync -a "${EXCLUDES[@]}" "$OWNER_REPO/" "$HOME_DIR/everythingapp/"
  chown -R "$ACCT:$ACCT" "$HOME_DIR/everythingapp"
  log "installing $NAME's hub on port $PORT"
  INSTALL_LOG="$(mktemp)"
  # Its own Tailscale step fails in an account that is not the Tailscale operator; this script does that one as root.
  if ! as_user "$ACCT" env EA_OLLAMA_URL="$GATE_URL" EA_OLLAMA_MODEL="$(env_get "$OWNER_ENV" EA_OLLAMA_MODEL)" \
    bash "$HOME_DIR/everythingapp/deploy/install-hub-user.sh" --from-dir "$HOME_DIR/everythingapp" --port "$PORT" --serve-port "$PORT" >"$INSTALL_LOG" 2>&1; then
    tail -30 "$INSTALL_LOG"; rm -f "$INSTALL_LOG"
    die "installing $NAME's hub failed; the account $ACCT is left as it is (sudo bash deploy/people.sh remove-account $ACCT --erase $ACCT to start over)"
  fi
  grep -E '^\[(node|npm|env)\]' "$INSTALL_LOG" | sed 's/^/    /' || true
  rm -f "$INSTALL_LOG"
  ENV_FILE="$HOME_DIR/.config/everythingapp/hub.env"
  ADDR="https://$(tailnet_name):$PORT"
  [ -f "$ENV_FILE" ] || die "the install left no $ENV_FILE"
  copy_shared "$ENV_FILE"
  env_set "$ENV_FILE" EA_HUB_NAME "$NAME"
  env_set "$ENV_FILE" EA_HUB_COLOR "$COLOR"
  env_set "$ENV_FILE" EA_OWNER_NAME "$NAME"
  # Pairing links carry the address devices use, not the 127.0.0.1 the script asks on.
  env_set "$ENV_FILE" EA_PUBLIC_URL "$ADDR"
  # This machine's disks and temperatures are the owner's business, and this account has no keys to anyone's machines.
  env_set "$ENV_FILE" EA_HOST_SENSORS false
  as_user "$ACCT" systemctl --user restart everythingapp-hub
  wait_health "$PORT" || { as_user "$ACCT" journalctl --user -u everythingapp-hub -n 30 --no-pager; die "$NAME's hub did not start"; }
  tailscale serve --bg --https="$PORT" "http://127.0.0.1:$PORT" >/dev/null
  registry add "$NAME" "$ACCT" "$PORT" "$COLOR" 0 "$(date -u +%FT%TZ)"
  log "$NAME's hub is ready"
  echo "  address  $ADDR"
  echo "  color    $COLOR"
  echo "  account  $ACCT (data in $HOME_DIR, readable only by that account)"
  echo
  echo "First device (works once, for 10 minutes; 'people.sh pair \"$NAME\"' makes another):"
  as_user "$ACCT" bash "$HOME_DIR/everythingapp/deploy/pair-link.sh" "$NAME's first device" || true
  echo
  echo "They need to reach this machine on the tailnet: share it with them from the Tailscale admin console (Machines,"
  echo "this machine, Share), and they use only $ADDR."
  ;;

pair)
  NAME="${1:-}"; ACCT="$(registry get name "$NAME" user)"
  [ -n "$ACCT" ] || die "no hub for $NAME (see: people.sh list)"
  as_user "$ACCT" bash "$(home_of "$ACCT")/everythingapp/deploy/pair-link.sh" "$NAME's device"
  ;;

list)
  [ -f "$REGISTRY" ] || die "no people yet: run setup"
  printf '%-16s %-20s %-7s %-8s %-8s %s\n' NAME ACCOUNT PORT COLOR STATE ADDRESS
  DNS="$(tailnet_name)"
  registry list | while IFS=$'\t' read -r name user port color owner; do
    state=down
    curl -fsS --max-time 3 "http://127.0.0.1:$port/health" >/dev/null 2>&1 && state=up
    printf '%-16s %-20s %-7s %-8s %-8s %s\n' "$name${owner:+ (owner)}" "$user" "$port" "$color" "$state" "https://$DNS:$port"
  done
  printf '\ngate: '; curl -fsS --max-time 3 "$GATE_URL/gate/status" 2>/dev/null | python3 -c 'import json,sys; s=json.load(sys.stdin); print(len(s["running"]), "running,", len(s["waiting"]), "waiting,", s["slots"], "place(s)")' || echo "not running"
  ;;

update)
  [ -f "$REGISTRY" ] || die "no people yet"
  for ACCT in $(registry users); do
    NAME="$(registry get user "$ACCT" name)"; PORT="$(registry get user "$ACCT" port)"
    HOME_DIR="$(home_of "$ACCT")"
    log "$NAME ($ACCT, port $PORT)"
    rsync -a --delete "${EXCLUDES[@]}" "$OWNER_REPO/" "$HOME_DIR/everythingapp/"
    chown -R "$ACCT:$ACCT" "$HOME_DIR/everythingapp"
    as_user "$ACCT" bash -c 'cd "$HOME/everythingapp" && npm ci --omit=dev --no-audit --no-fund 2>&1 | tail -1'
    copy_shared "$HOME_DIR/.config/everythingapp/hub.env"
    as_user "$ACCT" systemctl --user restart everythingapp-hub
    wait_health "$PORT" && echo "    up" || echo "    DID NOT COME BACK: journalctl as $ACCT"
  done
  # The gate runs the owner's code: restart it on the new version too, and keep its model list the owner's model.
  sed -i "s|^Environment=EA_GATE_MODELS=.*|Environment=EA_GATE_MODELS=$(env_get "$OWNER_ENV" EA_OLLAMA_MODEL)|" "$OWNER_HOME/.config/systemd/user/aeneas-gate.service"
  as_user "$OWNER" systemctl --user daemon-reload
  as_user "$OWNER" systemctl --user restart aeneas-gate.service
  ;;

remove)
  NAME="${1:-}"; shift || true
  ERASE=""
  while [ $# -gt 0 ]; do case "$1" in --erase) ERASE="$2"; shift ;; *) die "unknown argument $1" ;; esac; shift; done
  ACCT="$(registry get name "$NAME" user)"
  [ -n "$ACCT" ] || die "no hub for $NAME"
  [ "$ACCT" != "$OWNER" ] || die "that is the owner's own hub"
  PORT="$(registry get name "$NAME" port)"
  if [ -n "$ERASE" ] && [ "$ERASE" != "$NAME" ]; then die "--erase needs the name again, exactly: --erase \"$NAME\""; fi
  as_user "$ACCT" systemctl --user disable --now everythingapp-hub || true
  tailscale serve --https="$PORT" off >/dev/null 2>&1 || true
  loginctl disable-linger "$ACCT" || true
  registry remove "$ACCT"
  if [ -n "$ERASE" ]; then
    erase_account "$ACCT"
    log "$NAME's hub, account and data are deleted"
  else
    usermod -L "$ACCT"
    log "$NAME's hub is stopped and its address is off. Their data stays in $(home_of "$ACCT") (account $ACCT, locked)."
    echo "  To delete it for good: sudo bash deploy/people.sh remove-account $ACCT --erase $ACCT"
  fi
  ;;

remove-account)
  ACCT="${1:-}"; [ "${2:-}" = --erase ] && [ "${3:-}" = "$ACCT" ] || die "usage: people.sh remove-account <account> --erase <account>"
  [[ "$ACCT" == aeneas-* ]] || die "only aeneas-* accounts"
  [ -z "$(registry get user "$ACCT" user)" ] || die "$ACCT still has a hub: remove it first"
  getent passwd "$ACCT" >/dev/null || die "no account $ACCT"
  erase_account "$ACCT"
  log "account $ACCT and its data are deleted"
  ;;

*)
  sed -n '2,22p' "$0"; exit 2 ;;
esac
