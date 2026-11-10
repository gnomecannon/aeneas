#!/usr/bin/env bash
# Several people on one hub machine, each with a hub of their own (docs/multi-person.md). Linux hubs on Tailscale.
#
#   sudo bash deploy/people.sh setup --name <your name> [--color '#rrggbb']
#        once: the model gate, the list of people, your own hub sent through the gate, and the small root service that
#        lets your hub add people from the app (Settings, People on this machine)
#   sudo bash deploy/people.sh add <name> [--color '#rrggbb']
#        the same as Add a person in the app: a Linux account for that person (no password, no login) running their own
#        hub on its own port and address, and a pairing link for their first device
#   sudo bash deploy/people.sh list
#   sudo bash deploy/people.sh pair <name>
#        a new pairing link for that person's first device (the one `add` printed lasts 10 minutes)
#   sudo bash deploy/people.sh update
#        every other person's hub to your current code and shared model settings (after updating your own hub)
#   sudo bash deploy/people.sh remove <name> [--erase <name again>]
#        stops their hub and its address; their data stays in their account unless --erase (which deletes it for good)
#   sudo bash deploy/people.sh unsetup
#        your hub back on the model server directly, the gate and the root service stopped (remove the others first)
#
# Each person's data lives in their own account's home (mode 700), so one hub cannot read another's. Anyone with admin
# (root or sudo) rights on this machine can still read every account's files, the owner included: tell the people
# you add. The model server is shared through the gate (hub/src/gate.ts): a chat goes before background work, two people
# asking at once take turns, and only the owner can add or remove models. Nothing secret is printed.
set -euo pipefail

REGISTRY_DIR=/etc/aeneas
REGISTRY="$REGISTRY_DIR/people.json"
OWNER_FILE="$REGISTRY_DIR/owner"
STATE_DIR=/var/lib/aeneas
REQUESTS="$STATE_DIR/requests"
RESULTS="$STATE_DIR/results"
ROOT_COPY=/usr/local/sbin/aeneas-people
GATE_PORT="${EA_GATE_PORT:-11435}"
GATE_URL="http://127.0.0.1:$GATE_PORT"
FIRST_PORT=8788
# Colors people pick their hub out by, in the order they are given out.
PALETTE=("#2f8f83" "#c27c2c" "#7a5cc7" "#c4506a" "#3a7bc8" "#6b9a3a" "#b8860b" "#8a6d5a")
TAR_EXCLUDES=(--exclude=./.git --exclude=./node_modules --exclude=./hub/data --exclude=./.env --exclude=./analysis --exclude=./web/src-tauri/target --exclude=./web/src-tauri/gen --exclude=./apple --exclude=./design)

# A request from the app (serve-requests) reports progress and its result in this file; empty from a terminal.
RESULT="${EA_PEOPLE_RESULT:-}"
case "$RESULT" in ""|/var/lib/aeneas/results/*.json) ;; *) RESULT="" ;; esac
result() { # state [key value]...
  [ -n "$RESULT" ] || return 0
  python3 - "$RESULT" "$@" <<'EOF'
import json, os, sys
path, state, *kv = sys.argv[1:]
try:
    with open(path) as f: r = json.load(f)
except Exception: r = {}
r["state"] = state
for k, v in zip(kv[::2], kv[1::2]):
    try: r[k] = json.loads(v) if v[:1] in "{[" else v
    except Exception: r[k] = v
tmp = path + ".tmp"
fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o640)
with os.fdopen(fd, "w") as f: json.dump(r, f)
# Readable by the owner's account (its group) and nobody else's.
gid = int(os.environ.get("RESULT_GID") or -1)
if gid >= 0: os.chown(tmp, -1, gid)
os.chmod(tmp, 0o640)
os.replace(tmp, path)
EOF
}
die() { echo "error: $*" >&2; result failed error "$*"; exit 1; }
log() { printf '==> %s\n' "$*"; result working step "$*"; }

[ "$(id -u)" = 0 ] || die "run with sudo"
OWNER="${SUDO_USER:-}"
if [ -z "$OWNER" ] || [ "$OWNER" = root ]; then OWNER="$(cat "$OWNER_FILE" 2>/dev/null || true)"; fi
[ -n "$OWNER" ] && [ "$OWNER" != root ] || die "run with sudo from your own account (the one your hub runs in), not as root directly"
OWNER_HOME="$(getent passwd "$OWNER" | cut -d: -f6)"
OWNER_GROUP="$(id -gn "$OWNER")"
export RESULT_GID; RESULT_GID="$(id -g "$OWNER")"
OWNER_REPO="${EA_OWNER_REPO:-$OWNER_HOME/everythingapp}"
OWNER_ENV="$OWNER_HOME/.config/everythingapp/hub.env"

command -v python3 >/dev/null || die "python3 is required"
command -v tailscale >/dev/null || die "Tailscale is required: each person's hub gets its own address on your tailnet"

uid_of() { id -u "$1"; }
home_of() { getent passwd "$1" | cut -d: -f6; }
# A command as another account, with its systemd user session.
as_user() {
  local u="$1"; shift
  local uid; uid="$(uid_of "$u")"
  sudo -u "$u" env HOME="$(home_of "$u")" XDG_RUNTIME_DIR="/run/user/$uid" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$uid/bus" PATH="$(home_of "$u")/.local/node/bin:/usr/local/bin:/usr/bin:/bin" "$@"
}
# Files in someone's home are read and written as that account, never as root: a link planted there cannot make root
# read or write anything else.
env_get_as() { sudo -u "$1" sh -c '[ -f "$1" ] && grep -E "^$2=" "$1" | tail -1 | cut -d= -f2- || true' sh "$2" "$3"; }
env_set_as() {
  sudo -u "$1" python3 - "$2" "$3" "$4" <<'EOF'
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
owner_env() { env_get_as "$OWNER" "$OWNER_ENV" "$1"; }
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
    name, user, port, color, owner, added, address = args
    people[:] = [p for p in people if p["user"] != user]
    people.append({"name": name, "user": user, "port": int(port), "color": color, "owner": owner == "1", "added": added, "address": address})
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
# The owner's hub code, read as the owner and written as the person: root only passes the bytes along.
copy_code() {
  local acct="$1" dest; dest="$(home_of "$acct")/everythingapp"
  as_user "$acct" bash -c 'mkdir -p "$1" && find "$1" -mindepth 1 -maxdepth 1 ! -name node_modules -exec rm -rf {} +' sh "$dest"
  sudo -u "$OWNER" tar -C "$OWNER_REPO" -cf - "${TAR_EXCLUDES[@]}" . | sudo -u "$acct" tar -C "$dest" -xf - --no-same-owner
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
valid_name() { [[ "$1" =~ ^[A-Za-z][A-Za-z\ \'.-]{0,29}$ ]]; }
valid_color() { [[ "$1" =~ ^#[0-9a-fA-F]{6}$ ]] || die "a color is #rrggbb, like #2f8f83"; }
slug_of() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9' | cut -c1-20; }
# Settings every hub on the machine shares with the owner's: the model and how it is run, web search, the day's clock.
SHARED_KEYS=(EA_OLLAMA_MODEL EA_OLLAMA_NUM_CTX EA_OLLAMA_KEEP_ALIVE EA_OLLAMA_THINK EA_BACKGROUND_AI EA_SEARXNG_URL EA_TOR_SOCKS EA_TZ)
copy_shared() {
  local acct="$1" env_file="$2"
  for k in "${SHARED_KEYS[@]}"; do
    local v; v="$(owner_env "$k")"
    [ -n "$v" ] && env_set_as "$acct" "$env_file" "$k" "$v"
  done
  env_set_as "$acct" "$env_file" EA_OLLAMA_URL "$GATE_URL"
  # The background reader waits for a button, as on the owner's hub when it has no setting (the GPU may be gaming).
  [ -n "$(env_get_as "$acct" "$env_file" EA_BACKGROUND_AI)" ] || env_set_as "$acct" "$env_file" EA_BACKGROUND_AI ask
}
pairing_json() { # account, device name
  as_user "$1" env EA_PAIR_JSON=1 bash "$(home_of "$1")/everythingapp/deploy/pair-link.sh" "$2"
}
ADMIN_NOTE="Their data is kept apart from yours and from everyone else's, but anyone with admin (root or sudo) rights on this machine, you included, can still open it. Tell them before they start."

cmd="${1:-}"; shift || true
case "$cmd" in
setup)
  NAME=""; COLOR=""
  while [ $# -gt 0 ]; do case "$1" in --name) NAME="$2"; shift ;; --color) COLOR="$2"; shift ;; *) die "unknown argument $1" ;; esac; shift; done
  [ -n "$NAME" ] || NAME="$(owner_env EA_HUB_NAME)"
  [ -n "$NAME" ] || die "give --name <your name>, shown on your devices"
  valid_name "$NAME" || die "a name is letters, up to 30"
  [ -n "$COLOR" ] && valid_color "$COLOR"
  [ "$(uname -s)" = Linux ] || die "people.sh is for Linux hubs"
  [ -d "$OWNER_REPO/hub" ] || die "no repo at $OWNER_REPO (set EA_OWNER_REPO)"
  [ -n "$(owner_env EA_PORT)" ] || die "no $OWNER_ENV: install your hub first (deploy/install.sh)"
  command -v sudo >/dev/null || die "sudo is required"
  install -d -m 755 "$REGISTRY_DIR"
  [ -n "$COLOR" ] || COLOR="$(registry get user "$OWNER" color)"
  [ -n "$COLOR" ] || COLOR="$(next_color)"
  OWNER_PORT="$(owner_env EA_PORT)"; OWNER_PORT="${OWNER_PORT:-8787}"
  UPSTREAM="$(owner_env EA_OLLAMA_URL)"
  if [ "$UPSTREAM" = "$GATE_URL" ]; then UPSTREAM="$(owner_env EA_GATE_UPSTREAM)"; fi
  [ -n "$UPSTREAM" ] || die "your hub has no model server yet; pick a model on its Welcome page first"
  MODEL="$(owner_env EA_OLLAMA_MODEL)"
  NODE="$OWNER_HOME/.local/node/bin/node"
  [ -x "$NODE" ] || NODE="$(sudo -u "$OWNER" bash -lc 'command -v node' 2>/dev/null || true)"
  [ -x "$NODE" ] || die "no Node for $OWNER"
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
Environment=PATH=$(dirname "$NODE"):/usr/local/bin:/usr/bin:/bin
ExecStart=$NODE $OWNER_REPO/node_modules/.bin/tsx src/main.ts gate
Restart=always
RestartSec=2
NoNewPrivileges=true

[Install]
WantedBy=default.target
EOF
  loginctl enable-linger "$OWNER" 2>/dev/null || true
  as_user "$OWNER" systemctl --user daemon-reload
  as_user "$OWNER" systemctl --user enable --now aeneas-gate.service
  as_user "$OWNER" systemctl --user restart aeneas-gate.service
  for _ in $(seq 1 20); do curl -fsS --max-time 2 "$GATE_URL/gate/status" >/dev/null 2>&1 && break; sleep 1; done
  curl -fsS --max-time 2 "$GATE_URL/gate/status" >/dev/null || { as_user "$OWNER" journalctl --user -u aeneas-gate -n 20 --no-pager; die "the gate did not start"; }
  curl -fsS --max-time 5 "$GATE_URL/api/version" >/dev/null || die "the gate is up but the model server at $UPSTREAM does not answer through it"

  log "the service that lets your hub add people from the app"
  # A root-owned copy of this script, so nothing in your account can change what runs as root.
  install -m 755 -o root -g root "$0" "$ROOT_COPY"
  printf '%s\n' "$OWNER" > "$OWNER_FILE"; chmod 644 "$OWNER_FILE"
  # Your hub drops requests here (only your account can); root takes them one at a time and writes the result beside.
  install -d -m 755 -o root -g root "$STATE_DIR"
  install -d -m 770 -o root -g "$OWNER_GROUP" "$REQUESTS"
  install -d -m 750 -o root -g "$OWNER_GROUP" "$RESULTS"
  cat > /etc/systemd/system/aeneas-people.path <<EOF
[Unit]
Description=Aeneas: requests from $OWNER's hub to add a person

[Path]
DirectoryNotEmpty=$REQUESTS

[Install]
WantedBy=paths.target
EOF
  cat > /etc/systemd/system/aeneas-people.service <<EOF
[Unit]
Description=Aeneas: add the people $OWNER's hub asked for

[Service]
Type=oneshot
ExecStart=$ROOT_COPY serve-requests
TimeoutStartSec=30min
EOF
  systemctl daemon-reload
  systemctl enable --now aeneas-people.path >/dev/null

  log "your hub ($NAME) through the gate"
  env_set_as "$OWNER" "$OWNER_ENV" EA_GATE_UPSTREAM "$UPSTREAM"
  env_set_as "$OWNER" "$OWNER_ENV" EA_OLLAMA_URL "$GATE_URL"
  env_set_as "$OWNER" "$OWNER_ENV" EA_HUB_NAME "$NAME"
  env_set_as "$OWNER" "$OWNER_ENV" EA_HUB_COLOR "$COLOR"
  as_user "$OWNER" systemctl --user restart everythingapp-hub
  wait_health "$OWNER_PORT" || die "your hub did not come back on port $OWNER_PORT; undo with: sudo bash deploy/people.sh unsetup"
  registry add "$NAME" "$OWNER" "$OWNER_PORT" "$COLOR" 1 "$(date -u +%FT%TZ)" "https://$(tailnet_name):$OWNER_PORT"
  log "done: $NAME's hub at https://$(tailnet_name):$OWNER_PORT, color $COLOR"
  echo
  echo "To add someone: Settings, People on this machine, Add a person (or: sudo bash deploy/people.sh add <name>)."
  echo "Each person's data is kept apart from the others', but anyone with admin rights on this machine can open it."
  ;;

unsetup)
  [ -z "$(registry users)" ] || die "remove the other people first: $(registry users)"
  UPSTREAM="$(owner_env EA_GATE_UPSTREAM)"
  [ -n "$UPSTREAM" ] || die "your hub was never sent through the gate"
  env_set_as "$OWNER" "$OWNER_ENV" EA_OLLAMA_URL "$UPSTREAM"
  as_user "$OWNER" systemctl --user restart everythingapp-hub
  as_user "$OWNER" systemctl --user disable --now aeneas-gate.service || true
  systemctl disable --now aeneas-people.path >/dev/null 2>&1 || true
  rm -f /etc/systemd/system/aeneas-people.path /etc/systemd/system/aeneas-people.service "$ROOT_COPY" "$OWNER_FILE"
  rm -rf "$REQUESTS" "$RESULTS"
  systemctl daemon-reload
  OWNER_PORT="$(owner_env EA_PORT)"
  wait_health "${OWNER_PORT:-8787}" || die "your hub did not come back"
  log "your hub talks to $UPSTREAM directly again; the gate and the root service are stopped"
  ;;

add)
  NAME="${1:-}"; shift || true
  COLOR=""
  while [ $# -gt 0 ]; do case "$1" in --color) COLOR="$2"; shift ;; *) die "unknown argument $1" ;; esac; shift; done
  valid_name "$NAME" || die "give the person's name (letters, up to 30)"
  curl -fsS --max-time 2 "$GATE_URL/gate/status" >/dev/null || die "the model gate is not running: run setup first"
  SLUG="$(slug_of "$NAME")"; [ -n "$SLUG" ] || die "that name gives no account name"
  ACCT="aeneas-$SLUG"
  [ -z "$(registry get user "$ACCT" user)" ] || die "$NAME already has a hub"
  [ -z "$(registry get name "$NAME" user)" ] || die "someone named $NAME already has a hub"
  getent passwd "$ACCT" >/dev/null && die "the account $ACCT already exists (a hub stopped earlier keeps it); pick another name"
  [ -n "$COLOR" ] && valid_color "$COLOR"
  [ -n "$COLOR" ] || COLOR="$(next_color)"
  PORT="$(next_port)"
  ADDR="https://$(tailnet_name):$PORT"
  result working name "$NAME" color "$COLOR" address "$ADDR" account "$ACCT"
  log "Making an account for $NAME"
  useradd -m -s /usr/sbin/nologin -c "Aeneas hub for $NAME" "$ACCT"
  HOME_DIR="$(home_of "$ACCT")"
  chmod 700 "$HOME_DIR"
  loginctl enable-linger "$ACCT"
  UIDN="$(uid_of "$ACCT")"
  for _ in $(seq 1 30); do [ -S "/run/user/$UIDN/bus" ] && break; sleep 1; done
  [ -S "/run/user/$UIDN/bus" ] || die "no systemd user session for $ACCT"
  log "Copying the hub's code"
  copy_code "$ACCT"
  log "Installing $NAME's hub (a minute or two)"
  INSTALL_LOG="$(mktemp)"
  # Its own Tailscale step fails in an account that is not the Tailscale operator; this script does that one as root.
  if ! as_user "$ACCT" env EA_OLLAMA_URL="$GATE_URL" EA_OLLAMA_MODEL="$(owner_env EA_OLLAMA_MODEL)" \
    bash "$HOME_DIR/everythingapp/deploy/install-hub-user.sh" --from-dir "$HOME_DIR/everythingapp" --port "$PORT" --serve-port "$PORT" >"$INSTALL_LOG" 2>&1; then
    tail -30 "$INSTALL_LOG"; rm -f "$INSTALL_LOG"
    die "installing $NAME's hub failed; the account $ACCT is left as it is (sudo bash deploy/people.sh remove-account $ACCT --erase $ACCT to start over)"
  fi
  grep -E '^\[(node|npm|env)\]' "$INSTALL_LOG" | sed 's/^/    /' || true
  rm -f "$INSTALL_LOG"
  ENV_FILE="$HOME_DIR/.config/everythingapp/hub.env"
  sudo -u "$ACCT" test -f "$ENV_FILE" || die "the install left no $ENV_FILE"
  log "Settings for $NAME's hub"
  copy_shared "$ACCT" "$ENV_FILE"
  env_set_as "$ACCT" "$ENV_FILE" EA_HUB_NAME "$NAME"
  env_set_as "$ACCT" "$ENV_FILE" EA_HUB_COLOR "$COLOR"
  env_set_as "$ACCT" "$ENV_FILE" EA_OWNER_NAME "$NAME"
  # Pairing links carry the address devices use, not the 127.0.0.1 the script asks on.
  env_set_as "$ACCT" "$ENV_FILE" EA_PUBLIC_URL "$ADDR"
  # This machine's disks and temperatures are the owner's business, and this account has no keys to anyone's machines.
  env_set_as "$ACCT" "$ENV_FILE" EA_HOST_SENSORS false
  as_user "$ACCT" systemctl --user restart everythingapp-hub
  wait_health "$PORT" || { as_user "$ACCT" journalctl --user -u everythingapp-hub -n 30 --no-pager; die "$NAME's hub did not start"; }
  log "Giving $NAME's hub its address"
  tailscale serve --bg --https="$PORT" "http://127.0.0.1:$PORT" >/dev/null
  registry add "$NAME" "$ACCT" "$PORT" "$COLOR" 0 "$(date -u +%FT%TZ)" "$ADDR"
  PAIR="$(pairing_json "$ACCT" "$NAME's phone" || true)"
  [ -n "$PAIR" ] || PAIR='{}'
  result done pairing "$PAIR" note "$ADMIN_NOTE"
  echo "$NAME's hub is ready"
  echo "  address  $ADDR"
  echo "  color    $COLOR"
  echo "  account  $ACCT (data in $HOME_DIR, readable only by that account and by this machine's admins)"
  echo
  echo "First device (works once, for 10 minutes; 'people.sh pair \"$NAME\"' makes another):"
  as_user "$ACCT" bash "$HOME_DIR/everythingapp/deploy/pair-link.sh" "$NAME's first device" || true
  echo
  echo "They need to reach this machine on the tailnet: share it with them from the Tailscale admin console (Machines,"
  echo "this machine, Share), and they use only $ADDR."
  echo "$ADMIN_NOTE"
  ;;

pair)
  NAME="${1:-}"; ACCT="$(registry get name "$NAME" user)"
  [ -n "$ACCT" ] && [ "$ACCT" != "$OWNER" ] || die "no hub for $NAME (see: people.sh list)"
  if [ -n "$RESULT" ]; then
    PAIR="$(pairing_json "$ACCT" "$NAME's device")" || die "$NAME's hub did not answer"
    result done name "$NAME" pairing "$PAIR"
  else
    as_user "$ACCT" bash "$(home_of "$ACCT")/everythingapp/deploy/pair-link.sh" "$NAME's device"
  fi
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
  # The root copy follows your current code when you run this with sudo (so you chose to). A request from your hub
  # (its own update finished) does not: code your account can change never becomes the script root runs.
  [ -z "$RESULT" ] && [ -f "$ROOT_COPY" ] && install -m 755 -o root -g root "$OWNER_REPO/deploy/people.sh" "$ROOT_COPY"
  for ACCT in $(registry users); do
    NAME="$(registry get user "$ACCT" name)"; PORT="$(registry get user "$ACCT" port)"
    log "$NAME ($ACCT, port $PORT)"
    copy_code "$ACCT"
    as_user "$ACCT" bash -c 'cd "$HOME/everythingapp" && npm ci --omit=dev --no-audit --no-fund 2>&1 | tail -1'
    copy_shared "$ACCT" "$(home_of "$ACCT")/.config/everythingapp/hub.env"
    as_user "$ACCT" systemctl --user restart everythingapp-hub
    wait_health "$PORT" && echo "    up" || echo "    DID NOT COME BACK: journalctl as $ACCT"
  done
  # The gate runs the owner's code: restart it on the new version too, and keep its model list the owner's model.
  sudo -u "$OWNER" sed -i "s|^Environment=EA_GATE_MODELS=.*|Environment=EA_GATE_MODELS=$(owner_env EA_OLLAMA_MODEL)|" "$OWNER_HOME/.config/systemd/user/aeneas-gate.service"
  as_user "$OWNER" systemctl --user daemon-reload
  as_user "$OWNER" systemctl --user restart aeneas-gate.service
  result done
  ;;

remove|stop)
  NAME="${1:-}"; shift || true
  ERASE=""
  while [ $# -gt 0 ]; do case "$1" in --erase) ERASE="$2"; shift ;; *) die "unknown argument $1" ;; esac; shift; done
  ACCT="$(registry get name "$NAME" user)"
  [ -n "$ACCT" ] || die "no hub for $NAME"
  [ "$ACCT" != "$OWNER" ] || die "that is your own hub"
  PORT="$(registry get name "$NAME" port)"
  if [ -n "$ERASE" ] && [ "$ERASE" != "$NAME" ]; then die "--erase needs the name again, exactly: --erase \"$NAME\""; fi
  [ "$cmd" = stop ] && ERASE=""
  as_user "$ACCT" systemctl --user disable --now everythingapp-hub || true
  tailscale serve --https="$PORT" off >/dev/null 2>&1 || true
  loginctl disable-linger "$ACCT" || true
  registry remove "$ACCT"
  if [ -n "$ERASE" ]; then
    erase_account "$ACCT"
    log "$NAME's hub, account and data are deleted"
  else
    usermod -L "$ACCT"
    echo "$NAME's hub is stopped and its address is off. Their data stays in $(home_of "$ACCT") (account $ACCT, locked)."
    echo "  To delete it for good: sudo bash deploy/people.sh remove-account $ACCT --erase $ACCT"
  fi
  result done name "$NAME" account "$ACCT"
  ;;

remove-account)
  ACCT="${1:-}"; [ "${2:-}" = --erase ] && [ "${3:-}" = "$ACCT" ] || die "usage: people.sh remove-account <account> --erase <account>"
  [[ "$ACCT" == aeneas-* ]] || die "only aeneas-* accounts"
  [ -z "$(registry get user "$ACCT" user)" ] || die "$ACCT still has a hub: remove it first"
  getent passwd "$ACCT" >/dev/null || die "no account $ACCT"
  erase_account "$ACCT"
  log "account $ACCT and its data are deleted"
  ;;

serve-requests)
  # Run by aeneas-people.service (root) when the owner's hub drops a request. Only add, pair, stop and update are
  # taken; a request names a person (update names nobody), never a path or a command, and every field is checked here
  # before anything runs.
  find "$RESULTS" -maxdepth 1 -type f -mtime +1 -delete 2>/dev/null || true
  for f in "$REQUESTS"/*.json; do
    [ -e "$f" ] || continue
    REQ="$(python3 - "$f" <<'EOF'
import json, os, re, sys
try:
    fd = os.open(sys.argv[1], os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd) as fh: r = json.loads(fh.read(4096))
    rid, op, name, color = str(r.get("id", "")), str(r.get("op", "")), str(r.get("name", "")), str(r.get("color", ""))
    ok = re.fullmatch(r"[a-z0-9-]{8,40}", rid) and (
        (op in ("add", "pair", "stop") and re.fullmatch(r"[A-Za-z][A-Za-z '.-]{0,29}", name)
         and (color == "" or re.fullmatch(r"#[0-9a-fA-F]{6}", color)))
        or (op == "update" and name == "" and color == ""))
    print("\t".join([rid, op, name, color]) if ok else "")
except Exception:
    print("")
EOF
)"
    [ -n "$REQ" ] || { rm -f "$f"; continue; }
    IFS=$'\t' read -r RID OP PNAME PCOLOR <<<"$REQ"
    RESULT="$RESULTS/$RID.json"
    # The result exists before the request goes, so the hub never sees neither.
    result working op "$OP" name "$PNAME"
    rm -f "$f"
    args=("$OP"); [ "$OP" = update ] || args+=("$PNAME"); [ "$OP" = add ] && [ -n "$PCOLOR" ] && args+=(--color "$PCOLOR")
    # Each request in its own process, so one that fails does not stop the others.
    ( env -u SUDO_USER EA_PEOPLE_RESULT="$RESULT" "$ROOT_COPY" "${args[@]}" ) >/dev/null 2>&1 || true
  done
  ;;

*)
  sed -n '2,24p' "$0"; exit 2 ;;
esac
