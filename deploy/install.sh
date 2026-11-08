#!/usr/bin/env bash
# Aeneas hub, one command, no root:
#
#   curl -fsSL https://raw.githubusercontent.com/gnomecannon/aeneas/main/deploy/install.sh | bash
#
# Linux (systemd user service) or macOS (launchd agent). Run it again to update. What it does:
#   1. Node 20 in ~/.local/node, unless a Node 20 or newer is already on PATH;
#   2. the app in ~/everythingapp (git clone, or the folder this script is in when run from a checkout);
#   3. its packages and the web app;
#   4. ~/.config/everythingapp/hub.env with a new random token (kept on later runs); when the hub listens on your
#      network instead of Tailscale, a self-signed certificate in ~/.config/everythingapp/tls so it answers over HTTPS;
#   5. a service that starts at login (Linux: also at boot when lingering is on), then
#      5b. a private model server when none answers here: Ollama (MIT) in ~/.local/ollama, run as your own service
#          on 127.0.0.1:11434. No model is downloaded: the Welcome page shows the one that fits and its size, and
#          fetches it when you confirm;
#      5c. private web search: SearXNG (AGPL-3.0) in ~/.local/searxng, run as your own service on 127.0.0.1:8888,
#          and the Tor Expert Bundle in ~/.local/tor: searches and page reads leave only through Tor (the hub turns
#          web lookups off when Tor is not there, unless hub.env has EA_WEB_WITHOUT_TOR=1);
#   6. HTTPS on your tailnet through Tailscale Serve when Tailscale is here, else the hub listens on your network;
#   7. prints a link that opens the Welcome page already connected: name, model, passwords, devices.
# Nothing personal is set: the Welcome page finds the graphics card and model servers, and asks the rest.
# What is downloaded, from where, and how it is checked: Node from nodejs.org and Ollama from GitHub, each against its
# published SHA-256; Tor from torproject.org, against its signed sums file; the app and SearXNG from GitHub with git,
# against their commits; npm packages against the lock file's hashes; SearXNG's Python packages from PyPI over HTTPS
# (pip, with no hashes to check against). Ollama is asked about first when someone is at the terminal.
# Before each change to the system (lingering, Tailscale Serve, opening the browser) a line says what it does.
#
# Options (environment): EA_DIR (app folder), EA_PORT (8787), EA_REPO_URL, EA_REF (main), EA_NO_TAILSCALE=1,
# EA_LAN=1 (listen on the network even with Tailscale), EA_NO_OLLAMA=1 (no model server), EA_NO_SEARXNG=1 (no web
# search), EA_TOR=0 (no Tor: web lookups stay off unless hub.env has EA_WEB_WITHOUT_TOR=1; EA_TOR=1 brings it back), EA_TOR_PORT
# (Tor's SOCKS port, 9052, away from a system Tor on 9050 and Tor Browser on 9150).
#
# For testing this script only: EA_INSTALL_TEST=1, with HOME set to a fresh temporary folder, writes every file but
# registers no service, downloads nothing large and installs nothing (the hub runs on 127.0.0.1 while the script runs).
set -euo pipefail

NODE_VERSION="${NODE_VERSION:-20.20.2}"
REPO_URL="${EA_REPO_URL:-https://github.com/gnomecannon/aeneas.git}"
REF="${EA_REF:-main}"
PORT="${EA_PORT:-8787}"
# npm's "a new version of npm is available" notice is not something to act on here; it only makes the output noisy.
export NPM_CONFIG_UPDATE_NOTIFIER=false NPM_CONFIG_FUND=false
APP_DIR="${EA_DIR:-$HOME/everythingapp}"
CONF_DIR="$HOME/.config/everythingapp"
DATA_DIR="$HOME/.local/share/everythingapp"
NODE_DIR="$HOME/.local/node"
OS="$(uname -s)"
TEST="${EA_INSTALL_TEST:-}"

# Ollama: a pinned release from github.com/ollama/ollama; its archives are checked against the release's
# sha256sum.txt and, for this version, against the sums below as well.
OLLAMA_VERSION="${EA_OLLAMA_VERSION:-0.40.14}"
OLLAMA_DIR="$HOME/.local/ollama"
OLLAMA_HERE="http://127.0.0.1:11434"
# SearXNG publishes no releases: a pinned commit of github.com/searxng/searxng (master, 2026-11-02, its CI passed on
# Python 3.11 to 3.14). Git checks the files against the commit.
SEARXNG_COMMIT="${EA_SEARXNG_COMMIT:-cccbc9e158b0ac3bb2158e9841a647a5bec57b57}"
SEARXNG_REPO="https://github.com/searxng/searxng.git"
SEARXNG_DIR="$HOME/.local/searxng"
SEARXNG_HERE="http://127.0.0.1:8888"
# Python for the search server when this machine has no Python 3.10 or newer (a Mac without Homebrew has 3.9):
# python-build-standalone (github.com/astral-sh/python-build-standalone; Python's own license, the same builds uv
# uses), a pinned release checked against the sums it publishes, in its own folder, used for SearXNG only.
PY_SA_TAG="20261021"
PY_SA_VER="3.12.15"
PY_SA_DIR="$HOME/.local/everythingapp-python"
# Tor: the Expert Bundle of the current Tor Browser release from torproject.org, checked against the release's
# sha256sums-signed-build.txt, and that file against the Tor Browser signing key when gpg is here.
TOR_DIR="$HOME/.local/tor"
TOR_PORT="${EA_TOR_PORT:-9052}"
TOR_KEY_FPR="EF6E286DDA85EA2A4BA7DE684E2C6E8793298290"
TOR_KEY_URL="https://openpgpkey.torproject.org/.well-known/openpgpkey/torproject.org/hu/kounek7zrdx745qydx6p59t9mqjpuhdf?l=torbrowser"

say() { printf '\033[1m==>\033[0m %s\n' "$*"; }
note() { printf '    %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }
[ "$(id -u)" != 0 ] || die "run this as your own user, not root: it installs into your home folder"
command -v curl >/dev/null || die "curl is needed"
command -v tar >/dev/null || die "tar is needed"
case "$OS" in Linux|Darwin) ;; *) die "this installer is for Linux and macOS (Windows: see deploy/windows)" ;; esac
if [ -n "$TEST" ]; then
  case "$HOME" in /tmp/*|/private/tmp/*|/var/folders/*|/private/var/folders/*) ;; *) die "EA_INSTALL_TEST is for testing: set HOME to a fresh temporary folder (mktemp -d)" ;; esac
  say "Test run: files are written under $HOME; no service is registered and nothing large is downloaded"
fi

# Downloads and scratch files live here and go when the script ends.
mkdir -p "$HOME/.cache/everythingapp"
WORK="$(mktemp -d "$HOME/.cache/everythingapp/install.XXXXXX")"
HUB_TEST_PID=""
hub_test_stop() {
  [ -n "$HUB_TEST_PID" ] || return 0
  kill "$HUB_TEST_PID" 2>/dev/null || true
  for _ in $(seq 1 20); do kill -0 "$HUB_TEST_PID" 2>/dev/null || break; sleep 0.5; done
  kill -9 "$HUB_TEST_PID" 2>/dev/null || true
  HUB_TEST_PID=""
}
cleanup() { hub_test_stop; rm -rf "$WORK"; }
trap cleanup EXIT

# ---- helpers ----
# A hard time limit for commands that have none of their own (git, pip).
limit() {
  local s="$1"; shift
  if command -v timeout >/dev/null 2>&1; then timeout "$s" "$@"; else perl -e 'alarm shift; exec @ARGV or exit 127' "$s" "$@"; fi
}
# fetch OUT URL SECONDS: HTTPS only, retried, given up when it stalls for a minute.
fetch() { curl -fsSL --proto '=https' --proto-redir '=https' --retry 2 --connect-timeout 20 --max-time "$3" --speed-limit 2048 --speed-time 60 -o "$1" "$2"; }
# The first byte of URL can be read (a check that a download is there, without downloading it).
url_ok() { curl -fsSL --proto '=https' --proto-redir '=https' --max-time 30 -r 0-0 -o /dev/null "$1" 2>/dev/null; }
answers() { curl -fsS -o /dev/null --max-time 2 "$1" 2>/dev/null; }
wait_for() { local n="$1" url="$2"; for _ in $(seq 1 "$n"); do answers "$url" && return 0; sleep 1; done; return 1; }
port_busy() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
sha256() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'; else shasum -a 256 "$1" | awk '{print $1}'; fi; }
# ask QUESTION y|n: asks on the terminal and answers the default when nobody can answer (no terminal, or a test). The
# script itself may come through a pipe (curl ... | bash), so the answer is read from /dev/tty.
can_ask() { [ -z "$TEST" ] && [ -t 1 ] && { : </dev/tty; } 2>/dev/null; }
ask() {
  local a hint="y/N"; [ "$2" = y ] && hint="Y/n"
  if ! can_ask; then [ "$2" = y ]; return; fi
  printf '    %s [%s] ' "$1" "$hint" >/dev/tty
  read -r a </dev/tty || a=""
  case "$a" in [Yy]*) return 0 ;; [Nn]*) return 1 ;; *) [ "$2" = y ] ;; esac
}
# A private address: 10/8, 172.16/12, 192.168/16, 100.64/10 (Tailscale and carrier NAT), 169.254/16 (link local).
private_v4() { case "$1" in 10.*|192.168.*|169.254.*|172.1[6-9].*|172.2[0-9].*|172.3[01].*) return 0 ;; 100.*) local b="${1#100.}"; b="${b%%.*}"; [ "$b" -ge 64 ] && [ "$b" -le 127 ] 2>/dev/null ;; *) return 1 ;; esac; }
# sum_for SUMS NAME: the checksum a sums file gives for NAME ("<sum>  NAME", "<sum> *NAME" or "<sum>  ./NAME").
sum_for() { awk -v n="$2" '{ f = $2; sub(/^\*/, "", f); sub(/^\.\//, "", f); if (f == n) { print $1; exit } }' "$1"; }
free_kb() { df -Pk "$1" 2>/dev/null | awk 'NR == 2 { print $4 }'; }
# The one command that installs these packages here (Debian and Ubuntu names; the others are close).
pkg_cmd() {
  if [ "$OS" = Darwin ]; then
    if command -v brew >/dev/null 2>&1; then echo "brew install $*"; else echo "install Homebrew (brew.sh), then: brew install $*"; fi
  elif command -v apt-get >/dev/null 2>&1; then echo "sudo apt-get install -y $*"
  elif command -v dnf >/dev/null 2>&1; then echo "sudo dnf install -y $*"
  elif command -v pacman >/dev/null 2>&1; then echo "sudo pacman -S --needed $*"
  elif command -v zypper >/dev/null 2>&1; then echo "sudo zypper install -y $*"
  elif command -v apk >/dev/null 2>&1; then echo "sudo apk add $*"
  else echo "install $* with your system's package manager"; fi
}
python_git_cmd() {
  if [ "$OS" = Darwin ]; then
    if command -v brew >/dev/null 2>&1; then echo "brew install python git"; else echo "install Python 3.10 or newer from python.org, and git with: xcode-select --install"; fi
  elif command -v apt-get >/dev/null 2>&1; then echo "sudo apt-get install -y python3 python3-venv git"
  elif command -v dnf >/dev/null 2>&1; then echo "sudo dnf install -y python3 git"
  elif command -v pacman >/dev/null 2>&1; then echo "sudo pacman -S --needed python git"
  elif command -v zypper >/dev/null 2>&1; then echo "sudo zypper install -y python3 git"
  elif command -v apk >/dev/null 2>&1; then echo "sudo apk add python3 py3-pip git"
  else echo "install Python 3.10 or newer (with its venv module) and git with your system's package manager"; fi
}
# On a Mac without the command line tools, /usr/bin/git and /usr/bin/python3 only open an install window.
mac_stub() { [ "$OS" = Darwin ] && case "$1" in /usr/bin/*) ! xcode-select -p >/dev/null 2>&1 ;; *) false ;; esac; }
have_git() { local g; g="$(command -v git 2>/dev/null)" || return 1; ! mac_stub "$g"; }
# A Python 3.10 or newer whose venv module can make an environment with pip.
find_python() {
  local c p
  for c in python3.14 python3.13 python3.12 python3.11 python3.10 python3 /opt/homebrew/bin/python3 /usr/local/bin/python3; do
    p="$(command -v "$c" 2>/dev/null)" || continue
    mac_stub "$p" && continue
    if "$p" -c 'import sys, venv, ensurepip; sys.exit(0 if sys.version_info >= (3, 10) else 1)' >/dev/null 2>&1; then echo "$p"; return 0; fi
  done
  return 1
}
py_sa_sum() {
  case "$1" in
    aarch64-apple-darwin) echo a18cc33862b53bd54a148c710def5375c1b47470cccedf817a19c2d211764584 ;;
    x86_64-apple-darwin) echo 869e0b30959beccc616ce14907439f4d0b3170c5830a2362dade07f07b0ed3b8 ;;
    x86_64-unknown-linux-gnu) echo 5ff9f0602ce964a529ed1e8555d3abab6341926d724402ba9a15e9e877191124 ;;
    aarch64-unknown-linux-gnu) echo f53cca8fcd20805bddaa8bff1ef722a6918f8225d37561bd36ad901d13d580af ;;
  esac
}
# Prints the standalone Python's path, downloading it the first time (about 25 MB on a Mac, 55 to 70 MB on Linux).
# Messages go to stderr: stdout is the path.
standalone_python() {
  local triple file url want new mb
  if [ -x "$PY_SA_DIR/bin/python3" ] && grep -qx "version=$PY_SA_VER+$PY_SA_TAG" "$PY_SA_DIR/.everythingapp" 2>/dev/null; then echo "$PY_SA_DIR/bin/python3"; return 0; fi
  case "$OS-$(uname -m)" in
    Darwin-arm64) triple=aarch64-apple-darwin; mb=25 ;;
    Darwin-x86_64) triple=x86_64-apple-darwin; mb=25 ;;
    Linux-x86_64) triple=x86_64-unknown-linux-gnu; mb=68 ;;
    Linux-aarch64|Linux-arm64) triple=aarch64-unknown-linux-gnu; mb=53 ;;
    *) return 1 ;;
  esac
  file="cpython-$PY_SA_VER+$PY_SA_TAG-$triple-install_only.tar.gz"
  url="https://github.com/astral-sh/python-build-standalone/releases/download/$PY_SA_TAG/${file//+/%2B}"
  want="$(py_sa_sum "$triple")"
  if [ -n "$TEST" ]; then
    if url_ok "$url"; then note "test: $url is there (sha256 $want); not downloaded" >&2; fi
    return 1
  fi
  say "This computer has no Python 3.10 or newer, which web search needs. Downloading Python $PY_SA_VER for it alone (python-build-standalone, about $mb MB from GitHub, checked against its published checksum) into $PY_SA_DIR" >&2
  if ! fetch "$WORK/$file" "$url" 900; then say "The Python download did not finish" >&2; return 1; fi
  if [ "$(sha256 "$WORK/$file")" != "$want" ]; then say "The Python download does not match its published checksum, so it was not used" >&2; rm -f "$WORK/$file"; return 1; fi
  new="$PY_SA_DIR.new"; rm -rf "$new"; mkdir -p "$new"
  if ! tar -xzf "$WORK/$file" -C "$new" --strip-components=1 || [ ! -x "$new/bin/python3" ]; then say "The Python download could not be unpacked" >&2; rm -rf "$new" "$WORK/$file"; return 1; fi
  rm -f "$WORK/$file"
  rm -rf "$PY_SA_DIR" && mv "$new" "$PY_SA_DIR" || return 1
  printf 'version=%s\n' "$PY_SA_VER+$PY_SA_TAG" > "$PY_SA_DIR/.everythingapp"
  if ! "$PY_SA_DIR/bin/python3" -c 'import venv, ensurepip' >/dev/null 2>&1; then say "The downloaded Python does not run here" >&2; return 1; fi
  echo "$PY_SA_DIR/bin/python3"
}
xml_esc() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }
# Values in a systemd unit, kept literal: an Environment= value (quoted; % is a specifier there), and one word of
# ExecStart= (where $ also expands; quoted only when it holds a space, a quote or a backslash).
sd_env() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/%/%%/g'; }
sd_word() {
  local w; w="$(printf '%s' "$1" | sed -e 's/%/%%/g' -e 's/\$/$$/g')"
  case "$w" in *[[:space:]\\\"]*) printf '"%s"' "$(printf '%s' "$w" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')" ;; *) printf '%s' "$w" ;; esac
}

# hub.env, read and written one line at a time (the file keeps its mode 600). env_changed says the hub needs a restart.
env_changed=0
get_env() { sed -n "s/^$1=//p" "$ENV_FILE" | tail -1; }
set_env() {
  grep -Fxq -- "$1=$2" "$ENV_FILE" && [ "$(grep -c "^$1=" "$ENV_FILE")" = 1 ] && return 0
  local tmp; tmp="$(mktemp "$CONF_DIR/.hub.env.XXXXXX")"
  grep -v "^$1=" "$ENV_FILE" > "$tmp" || true
  printf '%s=%s\n' "$1" "$2" >> "$tmp"
  cat "$tmp" > "$ENV_FILE"; rm -f "$tmp"
  env_changed=1
}
unset_env() {
  grep -q "^$1=" "$ENV_FILE" || return 0
  local tmp; tmp="$(mktemp "$CONF_DIR/.hub.env.XXXXXX")"
  grep -v "^$1=" "$ENV_FILE" > "$tmp" || true
  cat "$tmp" > "$ENV_FILE"; rm -f "$tmp"
  env_changed=1
}

# svc_write ID DESCRIPTION WORKDIR [KEY=VALUE ...] -- COMMAND [ARGS ...]
# A user service that starts at login and comes back when it stops: Linux ~/.config/systemd/user/everythingapp-ID.service,
# macOS ~/Library/LaunchAgents/app.everythingapp.ID.plist (its log in ~/.local/share/everythingapp/logs/ID.log).
# SVC_AFTER names a unit it starts after (Linux). svc_changed=1 when the file is new or different.
svc_changed=0
svc_write() {
  local sid="$1" desc="$2" wd="$3" file new arg
  shift 3
  new="$WORK/svc.$sid"
  if [ "$OS" = Linux ]; then
    file="$HOME/.config/systemd/user/everythingapp-$sid.service"
    {
      echo "[Unit]"
      echo "Description=$desc"
      if [ -n "${SVC_AFTER:-}" ]; then echo "After=$SVC_AFTER"; echo "Wants=$SVC_AFTER"; fi
      echo
      echo "[Service]"
      echo "Type=simple"
      echo "WorkingDirectory=$(printf '%s' "$wd" | sed 's/%/%%/g')"
      while [ "$#" -gt 0 ] && [ "$1" != -- ]; do echo "Environment=\"$(sd_env "$1")\""; shift; done
      shift
      printf 'ExecStart=%s' "$(sd_word "$1")"; shift
      for arg in "$@"; do printf ' %s' "$(sd_word "$arg")"; done
      echo
      echo "Restart=always"
      echo "RestartSec=5"
      echo "NoNewPrivileges=true"
      echo
      echo "[Install]"
      echo "WantedBy=default.target"
    } > "$new"
  else
    file="$HOME/Library/LaunchAgents/app.everythingapp.$sid.plist"
    mkdir -p "$DATA_DIR/logs"
    {
      echo '<?xml version="1.0" encoding="UTF-8"?>'
      echo '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">'
      echo '<plist version="1.0"><dict>'
      echo "<key>Label</key><string>app.everythingapp.$sid</string>"
      echo "<key>WorkingDirectory</key><string>$(xml_esc "$wd")</string>"
      echo '<key>EnvironmentVariables</key><dict>'
      while [ "$#" -gt 0 ] && [ "$1" != -- ]; do echo "<key>$(xml_esc "${1%%=*}")</key><string>$(xml_esc "${1#*=}")</string>"; shift; done
      shift
      echo '</dict>'
      echo '<key>ProgramArguments</key><array>'
      for arg in "$@"; do echo "<string>$(xml_esc "$arg")</string>"; done
      echo '</array>'
      echo '<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>5</integer>'
      echo "<key>StandardOutPath</key><string>$(xml_esc "$DATA_DIR/logs/$sid.log")</string><key>StandardErrorPath</key><string>$(xml_esc "$DATA_DIR/logs/$sid.log")</string>"
      echo '</dict></plist>'
    } > "$new"
  fi
  mkdir -p "$(dirname "$file")"
  svc_changed=0
  if [ ! -f "$file" ] || ! cmp -s "$new" "$file"; then cat "$new" > "$file"; svc_changed=1; fi
  return 0
}
svc_logs() { if [ "$OS" = Linux ]; then echo "journalctl --user -u everythingapp-$1"; else echo "$DATA_DIR/logs/$1.log"; fi; }
# svc_apply ID CHANGED: running, and restarted when its file or its program changed.
svc_apply() {
  local sid="$1" changed="$2" label="app.everythingapp.$1" try
  if [ -n "$TEST" ]; then note "test: the $sid service file is written, not started"; return 0; fi
  if [ "$OS" = Linux ]; then
    systemctl --user daemon-reload
    systemctl --user enable "everythingapp-$sid.service" >/dev/null 2>&1 || true
    if [ "$changed" = 1 ] || ! systemctl --user is-active --quiet "everythingapp-$sid.service"; then
      systemctl --user restart "everythingapp-$sid.service" || { say "The $sid service did not start; see: $(svc_logs "$sid")"; return 1; }
    fi
  else
    if [ "$changed" = 1 ] || ! launchctl print "gui/$(id -u)/$label" >/dev/null 2>&1; then
      launchctl bootout "gui/$(id -u)/$label" >/dev/null 2>&1 || true
      for _ in $(seq 1 20); do launchctl print "gui/$(id -u)/$label" >/dev/null 2>&1 || break; sleep 0.5; done
      for try in 1 2 3; do
        launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/$label.plist" 2>/dev/null && break
        if [ "$try" = 3 ]; then say "launchd did not start $label; see: $(svc_logs "$sid")"; return 1; fi
        sleep 2
      done
    fi
  fi
  return 0
}
svc_stop() {
  [ -z "$TEST" ] || return 0
  if [ "$OS" = Linux ]; then systemctl --user stop "everythingapp-$1.service" >/dev/null 2>&1 || true
  else launchctl bootout "gui/$(id -u)/app.everythingapp.$1" >/dev/null 2>&1 || true; fi
}
svc_remove() {
  svc_stop "$1"
  if [ "$OS" = Linux ]; then
    [ -n "$TEST" ] || systemctl --user disable "everythingapp-$1.service" >/dev/null 2>&1 || true
    rm -f "$HOME/.config/systemd/user/everythingapp-$1.service"
    [ -n "$TEST" ] || systemctl --user daemon-reload || true
  else
    rm -f "$HOME/Library/LaunchAgents/app.everythingapp.$1.plist"
  fi
}

# ---- 1. Node ----
node_ok() { command -v node >/dev/null && [ "$(node -v | sed 's/^v//; s/\..*//')" -ge 20 ] 2>/dev/null; }
[ -x "$NODE_DIR/bin/node" ] && export PATH="$NODE_DIR/bin:$PATH"
if ! node_ok; then
  case "$(uname -m)" in x86_64) arch=x64 ;; aarch64|arm64) arch=arm64 ;; *) die "unsupported processor $(uname -m)" ;; esac
  plat=linux; [ "$OS" = Darwin ] && plat=darwin
  say "Node $NODE_VERSION into $NODE_DIR (from nodejs.org, checked against its published SHA-256)"
  tmp="$(mktemp -d)"
  node_file="node-v$NODE_VERSION-$plat-$arch.tar.gz"
  fetch "$tmp/SHASUMS256.txt" "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt" 60 || die "nodejs.org did not answer for Node's checksums; run this again later"
  want="$(sum_for "$tmp/SHASUMS256.txt" "$node_file")"
  [ -n "$want" ] || die "nodejs.org lists no checksum for $node_file"
  fetch "$tmp/node.tar.gz" "https://nodejs.org/dist/v$NODE_VERSION/$node_file" 600 || die "the Node download did not finish; run this again later"
  [ "$(sha256 "$tmp/node.tar.gz")" = "$want" ] || { rm -rf "$tmp"; die "the Node download does not match its published checksum, so it was not used"; }
  rm -rf "$NODE_DIR" && mkdir -p "$NODE_DIR"
  tar -xzf "$tmp/node.tar.gz" -C "$NODE_DIR" --strip-components=1
  rm -rf "$tmp"
  export PATH="$NODE_DIR/bin:$PATH"
fi
NODE_BIN="$(command -v node)"
say "Node $(node -v)"

# ---- 2. the app ----
# Only a script run from a file uses the checkout it sits in: piped in (curl | bash) there is no file, and the folder
# the terminal happens to be in (say ~/everythingapp/hub) is not a checkout to run from without updating it.
here=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then here="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd || true)"; fi
if [ -n "$here" ] && [ -f "$here/../hub/package.json" ] && [ -z "${EA_DIR:-}" ]; then
  APP_DIR="$(cd "$here/.." && pwd)"
  say "Using the checkout at $APP_DIR"
elif [ -d "$APP_DIR/.git" ]; then
  say "Updating $APP_DIR"
  git -C "$APP_DIR" fetch -q origin "$REF" && git -C "$APP_DIR" checkout -q "$REF" && git -C "$APP_DIR" pull -q --ff-only origin "$REF"
elif have_git; then
  say "Downloading the app into $APP_DIR"
  git clone -q --depth 1 --branch "$REF" "$REPO_URL" "$APP_DIR"
elif [ "$OS" = Darwin ]; then
  # A new Mac has only a stand-in for git (/usr/bin/git) that asks for Apple's Command Line Tools. They are Apple's
  # own, free, and need no Apple account: the simplest way to git for someone who has never used a terminal.
  if [ -z "$TEST" ]; then
    say "Asking macOS to install Apple's Command Line Tools, which bring git: a window opens"
    xcode-select --install >/dev/null 2>&1 || true
  fi
  die "git is needed to download the app with its files checked, and this Mac does not have it yet. In the window that opened, press Install (about 1 GB from Apple, 5 to 15 minutes; no window? run: xcode-select --install). When it says the software was installed, run the same install command again"
else
  # A snapshot of a branch has no published checksum to check it against; git checks every file against its commit.
  die "git is needed to download the app with its files checked. To fix it: $(pkg_cmd git), then run this again"
fi

# ---- 3. packages and the web app ----
if [ -n "$TEST" ]; then
  note "test: packages and the web app are not installed again"
else
  say "Installing packages (a minute or two the first time)"
  (cd "$APP_DIR" && npm ci --no-audit --no-fund --loglevel=error >/dev/null)
  (cd "$APP_DIR" && npm --workspace web run build >/dev/null 2>&1) || say "The web app did not build; the hub still runs"
fi

# ---- 4. settings ----
mkdir -p "$CONF_DIR" "$DATA_DIR/vault" "$DATA_DIR/backups"
chmod 700 "$CONF_DIR" "$DATA_DIR"
ENV_FILE="$CONF_DIR/hub.env"
tailscale_ok=0
if [ -z "${EA_NO_TAILSCALE:-}" ] && command -v tailscale >/dev/null && tailscale status >/dev/null 2>&1; then tailscale_ok=1; fi
if [ "$OS" = Darwin ]; then tz="$(readlink /etc/localtime 2>/dev/null | sed 's#.*/zoneinfo/##')"; else tz="$(timedatectl show -p Timezone --value 2>/dev/null || cat /etc/timezone 2>/dev/null || true)"; fi
lan_ip() {
  if [ "$OS" = Darwin ]; then ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null; else hostname -I 2>/dev/null | awk '{print $1}'; fi
}
# Every IPv4 address of this machine except loopback.
all_v4() {
  if [ "$OS" = Darwin ]; then ifconfig 2>/dev/null | awk '/inet / && $2 !~ /^127\./ { print $2 }'
  else hostname -I 2>/dev/null | tr ' ' '\n' | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' | grep -v '^127\.' || true; fi
}
if [ ! -f "$ENV_FILE" ]; then
  token="$(head -c 64 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 48)"
  bind=127.0.0.1; public=""
  if [ "$tailscale_ok" = 0 ] || [ -n "${EA_LAN:-}" ]; then
    # Listening on the network is for a home network. A machine with a public address (a rented server) would put the
    # hub on the internet, so that needs EA_LAN=1 said on purpose.
    open_ip=""
    for a in $(all_v4); do private_v4 "$a" || open_ip="$a"; done
    if [ -n "$open_ip" ] && [ "${EA_LAN:-}" != 1 ]; then
      say "This machine has a public internet address ($open_ip), so the hub listens only on this machine, not on the network"
      note "Install Tailscale (tailscale.com) and run this again, or set EA_LAN=1 if this really is a private network"
    else
      bind=0.0.0.0; ip="$(lan_ip || true)"; [ -n "$ip" ] && public="http://$ip:$PORT"
      say "The hub will listen on your network (port $PORT, HTTPS with its own certificate)"
    fi
  fi
  umask 077
  cat > "$ENV_FILE" <<EOF
# Aeneas hub settings. The model, owner name and connections are set in the app (Welcome, Settings).
EA_PORT=$PORT
EA_BIND_HOST=$bind
EA_PUBLIC_URL=$public
EA_TOKEN=$token
EA_DATA_DIR=$DATA_DIR
EA_VAULT_DIR=$DATA_DIR/vault
EA_BACKUP_DIR=$DATA_DIR/backups
EA_WORK_KEY_FILE=$CONF_DIR/work.key
EA_TZ=${tz:-UTC}
EA_ALLOW_CLOUD_DEFAULT=false
EA_NO_DOTENV=1
EOF
  umask 022
  say "Settings written to $ENV_FILE with a new token"
else
  say "Keeping the settings in $ENV_FILE"
fi
PORT="$(get_env EA_PORT)"; PORT="${PORT:-8787}"
# The hub's database is a plain file on this disk (only work items are sealed): say whether the disk is encrypted.
disk_state() {
  local dev
  if [ "$OS" = Darwin ]; then
    if fdesetup status 2>/dev/null | grep -q "FileVault is On"; then echo on; else echo off; fi
  else
    dev="$(df -P "$DATA_DIR" 2>/dev/null | awk 'NR == 2 { print $1 }')"
    if [ -n "$dev" ] && lsblk -s -rno TYPE "$dev" 2>/dev/null | grep -qx crypt; then echo on; else echo off; fi
  fi
}
if [ "$(disk_state)" = on ]; then
  say "The disk the hub keeps its data on is encrypted"
else
  say "A note, nothing to do now: this computer's disk is not encrypted. Your backups are encrypted either way; someone who took the disk itself could read the hub's data. If that matters to you, turn on FileVault (Mac), or choose disk encryption the next time you install Linux on it"
fi

# ---- 4b. HTTPS on your network ----
# A hub that listens on the network serves HTTPS with its own certificate. Devices pin it by its fingerprint, so it
# lives 10 years and later runs keep it. Plain HTTP stays only for this machine (Tailscale Serve, health checks).
TLS_DIR="$CONF_DIR/tls"
host_short() { local h; h="$(hostname -s 2>/dev/null || hostname 2>/dev/null || true)"; h="${h%%.*}"; case "$h" in *[!A-Za-z0-9-]*) echo "" ;; *) echo "$h" ;; esac; }
make_tls() {
  local crt="$TLS_DIR/hub.crt" key="$TLS_DIR/hub.key" have host lhost ip san cnf pub
  have="$(get_env EA_TLS_CERT)"
  if [ -n "$have" ] && [ "$have" != "$crt" ]; then say "Keeping the certificate named in $ENV_FILE"; return 0; fi
  if ! command -v openssl >/dev/null 2>&1; then
    say "openssl is not here, so your network sees the hub without encryption. To fix it: $(pkg_cmd openssl), then run this again"
    return 0
  fi
  if [ -s "$crt" ] && [ -s "$key" ] && openssl x509 -checkend 2592000 -noout -in "$crt" >/dev/null 2>&1; then
    say "Keeping the hub's certificate in $TLS_DIR (devices that pinned it go on working)"
  else
    host="$(host_short)"
    lhost="$host"
    if [ "$OS" = Darwin ]; then lhost="$(scutil --get LocalHostName 2>/dev/null || echo "$host")"; fi
    case "$lhost" in *[!A-Za-z0-9-]*) lhost="$host" ;; esac
    ip="$(lan_ip || true)"
    case "$ip" in *[!0-9.]*) ip="" ;; esac
    san="IP:127.0.0.1,DNS:localhost"
    [ -z "$ip" ] || san="IP:$ip,$san"
    [ -z "$host" ] || san="$san,DNS:$host"
    [ -z "$lhost" ] || san="$san,DNS:$lhost.local"
    mkdir -p "$TLS_DIR"; chmod 700 "$TLS_DIR"
    cnf="$WORK/tls.cnf"
    printf '[req]\ndistinguished_name = dn\nprompt = no\n[dn]\nCN = Aeneas hub%s\n[v3]\nbasicConstraints = critical, CA:FALSE\nkeyUsage = critical, digitalSignature\nextendedKeyUsage = serverAuth\nsubjectAltName = %s\n' "${host:+ $host}" "$san" > "$cnf"
    if ! (umask 077 && openssl ecparam -name prime256v1 -genkey -noout -out "$key.new" 2>/dev/null) ||
       ! openssl req -new -x509 -sha256 -days 3650 -key "$key.new" -config "$cnf" -extensions v3 -out "$crt.new" 2>/dev/null; then
      rm -f "$key.new" "$crt.new"
      say "openssl could not make a certificate, so your network sees the hub without encryption"
      return 0
    fi
    chmod 600 "$key.new"; chmod 644 "$crt.new"
    mv -f "$key.new" "$key"; mv -f "$crt.new" "$crt"
    say "Made the hub's own certificate for HTTPS on your network, valid for 10 years ($crt, for ${san//,/, })"
  fi
  set_env EA_TLS_CERT "$crt"
  set_env EA_TLS_KEY "$key"
  pub="$(get_env EA_PUBLIC_URL)"
  case "$pub" in
    http://127.*|http://localhost*) ;;
    http://*) set_env EA_PUBLIC_URL "https://${pub#http://}" ;;
    "") ip="$(lan_ip || true)"; case "$ip" in ""|*[!0-9.]*) ;; *) set_env EA_PUBLIC_URL "https://$ip:$PORT" ;; esac ;;
  esac
  return 0
}
case "$(get_env EA_BIND_HOST)" in ""|127.*|localhost|::1) ;; *) make_tls ;; esac

# ---- 5. the service ----
start_cmd="$NODE_BIN $APP_DIR/node_modules/.bin/tsx src/main.ts serve"
hub_test_start() {
  mkdir -p "$DATA_DIR/logs"
  # Only on 127.0.0.1 while testing, whatever hub.env says.
  (cd "$APP_DIR/hub" && set -a && . "$ENV_FILE" && set +a && export EA_BIND_HOST=127.0.0.1 && exec "$NODE_BIN" "$APP_DIR/node_modules/.bin/tsx" src/main.ts serve) >>"$DATA_DIR/logs/hub.log" 2>&1 &
  HUB_TEST_PID=$!
}
if [ "$OS" = Linux ]; then
  [ -n "$TEST" ] || command -v systemctl >/dev/null || die "systemd is needed to keep the hub running (or run: cd $APP_DIR/hub && $start_cmd)"
  unit_dir="$HOME/.config/systemd/user"; mkdir -p "$unit_dir"
  cat > "$unit_dir/everythingapp-hub.service" <<EOF
[Unit]
Description=Aeneas hub
After=network-online.target

[Service]
Type=simple
WorkingDirectory=$APP_DIR/hub
EnvironmentFile=$ENV_FILE
Environment=PATH=$(dirname "$NODE_BIN"):$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=$start_cmd
Restart=always
RestartSec=3
NoNewPrivileges=true

[Install]
WantedBy=default.target
EOF
  if [ -z "$TEST" ]; then
    systemctl --user daemon-reload
    systemctl --user enable --now everythingapp-hub.service >/dev/null 2>&1
    systemctl --user restart everythingapp-hub.service
    if [ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null)" != yes ]; then
      say "Turning on lingering for $USER (loginctl enable-linger), so the hub keeps running after you log out and starts at boot"
      loginctl enable-linger "$USER" 2>/dev/null || say "That needs an admin. To keep the hub running after you log out: sudo loginctl enable-linger $USER"
    fi
  fi
  logs="journalctl --user -u everythingapp-hub -f"
else
  agents="$HOME/Library/LaunchAgents"; mkdir -p "$agents" "$DATA_DIR/logs"
  plist="$agents/app.everythingapp.hub.plist"
  {
    echo '<?xml version="1.0" encoding="UTF-8"?>'
    echo '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">'
    echo '<plist version="1.0"><dict>'
    echo '<key>Label</key><string>app.everythingapp.hub</string>'
    echo "<key>WorkingDirectory</key><string>$APP_DIR/hub</string>"
    echo '<key>ProgramArguments</key><array>'
    echo "<string>/bin/bash</string><string>-c</string><string>set -a; . '$ENV_FILE'; set +a; exec $start_cmd</string>"
    echo '</array>'
    echo "<key>EnvironmentVariables</key><dict><key>PATH</key><string>$(dirname "$NODE_BIN"):$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string></dict>"
    echo '<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>'
    echo "<key>StandardOutPath</key><string>$DATA_DIR/logs/hub.log</string><key>StandardErrorPath</key><string>$DATA_DIR/logs/hub.log</string>"
    echo '</dict></plist>'
  } > "$plist"
  if [ -z "$TEST" ]; then
    # bootout returns before the old one is gone; bootstrap fails (error 5) until it is.
    launchctl bootout "gui/$(id -u)/app.everythingapp.hub" >/dev/null 2>&1 || true
    for _ in $(seq 1 20); do launchctl print "gui/$(id -u)/app.everythingapp.hub" >/dev/null 2>&1 || break; sleep 0.5; done
    for try in 1 2 3; do launchctl bootstrap "gui/$(id -u)" "$plist" 2>/dev/null && break; [ "$try" = 3 ] && die "launchd did not start the hub"; sleep 2; done
  fi
  logs="tail -f $DATA_DIR/logs/hub.log"
fi
if [ -n "$TEST" ]; then
  note "test: the hub runs on 127.0.0.1 while this script runs, not as a service"
  hub_test_start
fi
restart_hub() {
  if [ -n "$TEST" ]; then hub_test_stop; hub_test_start
  elif [ "$OS" = Linux ]; then systemctl --user restart everythingapp-hub.service
  else launchctl kickstart -k "gui/$(id -u)/app.everythingapp.hub"; fi
}
say "Waiting for the hub"
for _ in $(seq 1 40); do curl -fsS --max-time 2 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && break; sleep 1; done
curl -fsS --max-time 3 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 || die "the hub did not start; see: $logs"
env_changed=0
if [ ! -f "$DATA_DIR/.seeded" ]; then
  (cd "$APP_DIR/hub" && set -a && . "$ENV_FILE" && set +a && "$NODE_BIN" "$APP_DIR/node_modules/.bin/tsx" src/main.ts seed >/dev/null) && touch "$DATA_DIR/.seeded"
fi

# ---- 5b. a private model server ----
# Ollama is installed only when no model server answers where the Welcome page looks (setup.ts findServers) and
# none is chosen in the hub's settings, so a machine that already has one is not touched. Models wait for the
# owner's click on the Welcome page.
ollama_pinned_sum() {
  [ "$OLLAMA_VERSION" = 0.40.14 ] || return 0
  case "$1" in
    ollama-darwin.tgz) echo f3bf9a528e908da0da5a2b3a4ad3252a369d62186501dc4880261e8d9023bff5 ;;
    ollama-linux-amd64.tar.zst) echo 993e83d08c3d13d17c55009a3e2664c8a25445e644aec3a68bef5abb6abce67d ;;
    ollama-linux-arm64.tar.zst) echo 39bb333b7b4c0bafcdd7fad35eab1ae9aaf4518ea0f2c731de4376e3a29c94d0 ;;
    ollama-linux-amd64-rocm.tar.zst) echo 5b1b0a7a6370755a3472b1fb2a63e569a5b0114acef2a9067047bf8e5d98ecc1 ;;
  esac
}
ollama_size() {
  case "$1" in
    ollama-darwin.tgz) echo "about 190 MB" ;;
    ollama-linux-amd64-rocm.tar.zst) echo "about 1.1 GB more, for the AMD graphics card" ;;
    *) echo "about 1.6 GB" ;;
  esac
}
model_server_here() {
  local u
  for u in "$(get_env EA_OLLAMA_URL)" "$OLLAMA_HERE"; do
    if [ -n "$u" ] && answers "${u%/}/api/tags"; then echo "$u"; return 0; fi
  done
  for u in "$(get_env EA_OPENAI_URL)" http://127.0.0.1:1234/v1 http://127.0.0.1:8080/v1 http://127.0.0.1:8000/v1 http://127.0.0.1:1337/v1; do
    if [ -n "$u" ] && answers "${u%/}/models"; then echo "$u"; return 0; fi
  done
  return 0
}
# A model server or a cloud key is set in hub.env or in the Welcome page's ai.json (no value is printed).
model_chosen() {
  local f k wk
  [ -z "$(get_env EA_OLLAMA_URL)$(get_env EA_OPENAI_URL)$(get_env EA_ANTHROPIC_API_KEY)" ] || return 0
  f="$(get_env EA_DATA_DIR)/ai.json"
  [ -f "$f" ] || return 1
  k="$(get_env EA_SECRETS_KEY_FILE)"
  if [ -z "$k" ]; then wk="$(get_env EA_WORK_KEY_FILE)"; k="$(dirname "${wk:-$CONF_DIR/work.key}")/secrets.key"; fi
  # The hub seals ai.json with secrets.key (hub/src/secretbox.ts: "sb1:" + base64 of IV, tag, text; the name as AAD).
  "$NODE_BIN" -e '
    const fs = require("fs"), c = require("crypto");
    try {
      let raw = fs.readFileSync(process.argv[1], "utf8");
      if (raw.startsWith("sb1:")) {
        const b = Buffer.from(raw.slice(4), "base64"), d = c.createDecipheriv("aes-256-gcm", fs.readFileSync(process.argv[2]), b.subarray(0, 12));
        d.setAAD(Buffer.from("ai.json")); d.setAuthTag(b.subarray(12, 28));
        raw = Buffer.concat([d.update(b.subarray(28)), d.final()]).toString("utf8");
      }
      const j = JSON.parse(raw);
      process.exit(j.ollama_url || j.openai_url || j.anthropic_key ? 0 : 1);
    } catch { process.exit(1); }' "$f" "$k"
}
ollama_step() {
  local own="" found asset rocm="" a base want pinned new obin need v changed=0
  if [ -n "${EA_NO_OLLAMA:-}" ]; then say "EA_NO_OLLAMA is set, so no model server is installed"; return 0; fi
  [ -f "$OLLAMA_DIR/.everythingapp" ] && own=1
  if [ "$own" != 1 ]; then
    if [ -n "${EA_OLLAMA_URL:-}" ] && [ -z "$(get_env EA_OLLAMA_URL)" ]; then
      set_env EA_OLLAMA_URL "${EA_OLLAMA_URL%/}"
      say "The hub uses the Ollama at ${EA_OLLAMA_URL%/}"
      return 0
    fi
    found="$(model_server_here)"
    if [ -n "$found" ]; then say "A model server already answers at $found, so nothing is installed or changed for models"; return 0; fi
    if model_chosen; then say "A model is already chosen in the hub's settings, so nothing is installed or changed for models"; return 0; fi
    if command -v ollama >/dev/null 2>&1; then
      say "Ollama is installed ($(command -v ollama)) but does not answer on 127.0.0.1:11434. Start it (ollama serve), then run this again; nothing was changed"
      return 0
    fi
    if port_busy 11434; then say "Something that is not Ollama uses port 11434, so Ollama was not installed"; return 0; fi
    if [ -e "$OLLAMA_DIR" ]; then say "$OLLAMA_DIR exists and was not made by this installer; it is left as it is, and Ollama was not installed"; return 0; fi
  fi
  case "$OS-$(uname -m)" in
    Darwin-*) asset=ollama-darwin.tgz ;;
    Linux-x86_64) asset=ollama-linux-amd64.tar.zst; if [ -e /dev/kfd ]; then rocm=ollama-linux-amd64-rocm.tar.zst; fi ;;
    Linux-aarch64|Linux-arm64) asset=ollama-linux-arm64.tar.zst ;;
    *) say "Ollama has no build for this processor ($(uname -m)); the Welcome page can use a model server elsewhere"; return 0 ;;
  esac
  if [ "$OS" = Darwin ]; then
    v="$(sw_vers -productVersion 2>/dev/null || echo 0)"
    if [ "${v%%.*}" -lt 14 ] 2>/dev/null; then say "Ollama needs macOS 14 or newer (this Mac has $v), so it was not installed"; return 0; fi
  fi
  if [ "$own" = 1 ] && grep -qx "version=$OLLAMA_VERSION" "$OLLAMA_DIR/.everythingapp"; then
    say "Ollama $OLLAMA_VERSION is already in $OLLAMA_DIR"
  else
    if [ "$OS" = Linux ] && ! command -v zstd >/dev/null 2>&1; then
      say "Ollama for Linux comes packed with zstd, which is not here. To fix it: $(pkg_cmd zstd), then run this again"
      return 0
    fi
    need=$((2 * 1048576))
    if [ "$OS" = Linux ]; then need=$((7 * 1048576)); fi
    if [ -n "$rocm" ]; then need=$((need + 3 * 1048576)); fi
    if [ "$(free_kb "$HOME")" -lt "$need" ] 2>/dev/null; then
      say "Ollama needs about $((need / 1048576)) GB free in your home folder and there is less, so it was not installed"
      return 0
    fi
    if [ "$own" != 1 ]; then
      say "The assistant needs a model server on this machine: Ollama $OLLAMA_VERSION (MIT), $(ollama_size "$asset") from GitHub (github.com/ollama/ollama), checked against its published checksum. No model is downloaded now; the Welcome page shows the one that fits and its size first"
      if ! ask "Download and install Ollama now?" y; then
        say "Ollama was not installed. The Welcome page can use a model server elsewhere; run this again to install it (EA_NO_OLLAMA=1 skips this question)"
        return 0
      fi
    fi
    base="https://github.com/ollama/ollama/releases/download/v$OLLAMA_VERSION"
    if ! fetch "$WORK/ollama-sums.txt" "$base/sha256sum.txt" 60; then
      say "GitHub did not answer for Ollama's checksums, so Ollama was not installed. Run this again later"
      return 0
    fi
    new="$OLLAMA_DIR.new"
    rm -rf "$new"; mkdir -p "$new"
    for a in $asset $rocm; do
      want="$(sum_for "$WORK/ollama-sums.txt" "$a")"
      pinned="$(ollama_pinned_sum "$a")"
      if [ -z "$want" ] || { [ -n "$pinned" ] && [ "$pinned" != "$want" ]; }; then
        say "The published checksum of $a is missing or not the one this installer knows, so Ollama was not installed"
        rm -rf "$new"; return 0
      fi
      if [ -n "$TEST" ]; then
        if url_ok "$base/$a"; then note "test: $base/$a is there (sha256 $want); not downloaded"; else say "test: $base/$a does not answer"; fi
        continue
      fi
      say "Downloading Ollama $OLLAMA_VERSION ($a, $(ollama_size "$a")) from GitHub"
      if ! fetch "$WORK/$a" "$base/$a" 7200; then say "The download of $a did not finish, so Ollama was not installed. Run this again later"; rm -rf "$new"; return 0; fi
      if [ "$(sha256 "$WORK/$a")" != "$want" ]; then say "The download of $a does not match its published checksum, so it was not used"; rm -rf "$new" "$WORK/$a"; return 0; fi
      case "$a" in
        *.tgz) tar -xzf "$WORK/$a" -C "$new" ;;
        *.tar.zst) zstd -dcq "$WORK/$a" | tar -xf - -C "$new" ;;
      esac || { say "$a could not be unpacked, so Ollama was not installed"; rm -rf "$new" "$WORK/$a"; return 0; }
      rm -f "$WORK/$a"
    done
    if [ -n "$TEST" ]; then
      rm -rf "$new"
    else
      [ "$own" != 1 ] || svc_stop ollama
      rm -rf "$OLLAMA_DIR.old"
      if [ -d "$OLLAMA_DIR" ] && ! mv "$OLLAMA_DIR" "$OLLAMA_DIR.old"; then say "$OLLAMA_DIR could not be replaced"; rm -rf "$new"; return 0; fi
      if ! mv "$new" "$OLLAMA_DIR"; then say "Ollama could not be put in $OLLAMA_DIR"; return 0; fi
      rm -rf "$OLLAMA_DIR.old"
      printf 'version=%s\n' "$OLLAMA_VERSION" > "$OLLAMA_DIR/.everythingapp"
      say "Ollama $OLLAMA_VERSION is in $OLLAMA_DIR"
    fi
    changed=1
  fi
  obin="$OLLAMA_DIR/bin/ollama"
  if [ "$OS" = Darwin ] || { [ -z "$TEST" ] && [ ! -x "$obin" ]; }; then obin="$OLLAMA_DIR/ollama"; fi
  if [ -z "$TEST" ] && [ ! -x "$obin" ]; then say "The Ollama download has no ollama program where expected, so it is not started"; return 0; fi
  # OLLAMA_NO_CLOUD: Ollama's own switch for its cloud features (models run on ollama.com, its web search), off here.
  svc_write ollama "Ollama for Aeneas (local models)" "$OLLAMA_DIR" OLLAMA_HOST=127.0.0.1:11434 OLLAMA_NO_CLOUD=1 -- "$obin" serve
  [ "$changed" != 1 ] || svc_changed=1
  svc_apply ollama "$svc_changed" || return 0
  if [ -z "$TEST" ] && ! wait_for 30 "$OLLAMA_HERE/api/tags"; then say "Ollama does not answer yet; see: $(svc_logs ollama)"; fi
  [ -n "$(get_env EA_OLLAMA_URL)" ] || set_env EA_OLLAMA_URL "$OLLAMA_HERE"
  say "Ollama runs on 127.0.0.1:11434 as your own service; the Welcome page fetches the model when you confirm it"
  return 0
}
ollama_step || say "The model server step stopped early; the hub runs without it"

# ---- 5c. private web search (SearXNG, optionally through Tor) ----
TOR_SOCKS=""
tor_signed() { # SUMS SIG: the sums file carries a good signature by the Tor Browser signing key
  local gh st ok=1
  gh="$(mktemp -d "$WORK/gnupg.XXXXXX")"; chmod 700 "$gh"
  if fetch "$gh/key" "$TOR_KEY_URL" 60 && gpg --homedir "$gh" --batch --quiet --import "$gh/key" >/dev/null 2>&1; then
    st="$(gpg --homedir "$gh" --batch --status-fd 1 --verify "$2" "$1" 2>/dev/null || true)"
    if printf '%s\n' "$st" | awk -v f="$TOR_KEY_FPR" '$2 == "VALIDSIG" && $NF == f { found = 1 } END { exit found ? 0 : 1 }'; then ok=0; fi
  fi
  gpgconf --homedir "$gh" --kill all >/dev/null 2>&1 || true
  rm -rf "$gh"
  return "$ok"
}
# torrc for the installer's Tor, into $WORK/torrc (needs conf, data, TOR_DIR, TOR_PORT). With conf/bridges saying
# snowflake, Tor reaches its network through Snowflake bridges with the bundle's own lyrebird and bridge lines
# (pluggable_transports/pt_config.json): for networks that block Tor's relays, where direct Tor never connects.
tor_torrc() {
  local pt="$TOR_DIR/tor/pluggable_transports"
  {
    echo "# Tor for Aeneas. Written by the installer, and written again on each run: changes here are replaced."
    echo "SocksPort 127.0.0.1:$TOR_PORT"
    echo "SocksPolicy accept 127.0.0.1"
    echo "SocksPolicy reject *"
    echo "# Names are looked up through Tor (socks5h), never on this machine."
    echo "SafeSocks 1"
    echo "ClientOnly 1"
    echo "AvoidDiskWrites 1"
    echo "DataDirectory \"$(tor_esc "$data")\""
    echo "GeoIPFile \"$(tor_esc "$TOR_DIR/data/geoip")\""
    echo "GeoIPv6File \"$(tor_esc "$TOR_DIR/data/geoip6")\""
    echo "Log notice stdout"
    if [ "$(cat "$conf/bridges" 2>/dev/null)" = snowflake ] && [ -f "$pt/pt_config.json" ]; then
      echo "# Through Snowflake bridges: this network did not let Tor reach its relays directly (EA_TOR_BRIDGES=off tries direct again)."
      echo "UseBridges 1"
      "$NODE_BIN" -e '
        const [file, dir] = process.argv.slice(1);
        const c = JSON.parse(require("fs").readFileSync(file, "utf8"));
        const plug = String(c.pluggableTransports?.snowflake ?? "").split("${pt_path}").join(dir + "/");
        const lines = c.bridges?.snowflake ?? [];
        if (!plug || !lines.length) process.exit(1);
        console.log(plug);
        for (const b of lines) console.log("Bridge " + b);' "$pt/pt_config.json" "$pt"
    fi
  } > "$WORK/torrc"
}
tor_esc() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }
tor_step() {
  local own="" want_tor have asset ver base file want new tbin conf data torrc changed=0 ok
  [ -f "$TOR_DIR/.everythingapp" ] && own=1
  case "${EA_TOR:-}" in
    1|yes|true|on) want_tor=1 ;;
    0|no|false|off) want_tor=0 ;;
    *)
      # Not asked: web lookups (off until turned on in the app) go out only through Tor, so search engines and sites
      # see a Tor address, never the home one. Without Tor the hub has no web lookups at all.
      if [ "$own" != 1 ] && [ -z "$(get_env EA_TOR_SOCKS)" ]; then
        say "Web lookups (off until you turn them on in the app) go out only through Tor, so search engines and sites never see your home address. Setting up Tor from torproject.org (about 30 MB; EA_TOR=0 skips it)"
      fi
      want_tor=1
      ;;
  esac
  have="$(get_env EA_TOR_SOCKS)"
  if [ "$want_tor" = 0 ]; then
    if [ "$own" = 1 ]; then
      svc_remove tor
      rm -rf "$TOR_DIR"
      [ "$have" != "127.0.0.1:$TOR_PORT" ] || unset_env EA_TOR_SOCKS
      say "Tor is removed: web lookups are off unless hub.env has EA_WEB_WITHOUT_TOR=1"
    fi
    return 0
  fi
  if [ -n "$have" ] && [ "$have" != "127.0.0.1:$TOR_PORT" ]; then
    TOR_SOCKS="$have"
    say "The hub already sends page reads through Tor at $have; searches use it too"
    return 0
  fi
  if [ "$own" != 1 ]; then
    if port_busy "$TOR_PORT"; then say "Port $TOR_PORT is in use, so Tor was not installed. Choose another with EA_TOR_PORT and run this again"; return 0; fi
    if [ -e "$TOR_DIR" ]; then say "$TOR_DIR exists and was not made by this installer; it is left as it is, and Tor was not installed"; return 0; fi
  fi
  case "$OS-$(uname -m)" in
    Darwin-arm64) asset=macos-aarch64 ;;
    Darwin-x86_64) asset=macos-x86_64 ;;
    Linux-x86_64) asset=linux-x86_64 ;;
    Linux-aarch64|Linux-arm64) asset=linux-aarch64 ;;
    *) say "The Tor Expert Bundle has no build for this processor ($(uname -m)), so Tor was not installed"; return 0 ;;
  esac
  ver="${EA_TOR_VERSION:-}"
  if [ -z "$ver" ]; then
    ver="$(curl -fsS --proto '=https' --max-time 30 https://aus1.torproject.org/torbrowser/update_3/release/downloads.json 2>/dev/null |
      "$NODE_BIN" -e 'let s = ""; process.stdin.on("data", (d) => { s += d; }).on("end", () => { try { process.stdout.write(String(JSON.parse(s).version ?? "")); } catch {} });' || true)"
  fi
  case "$ver" in ""|*[!0-9.]*) say "torproject.org did not say which Tor is current, so Tor was not installed. Run this again later"; return 0 ;; esac
  if [ "$own" = 1 ] && grep -qx "version=$ver" "$TOR_DIR/.everythingapp"; then
    say "Tor $ver is already in $TOR_DIR"
  else
    base="https://dist.torproject.org/torbrowser/$ver"
    file="tor-expert-bundle-$asset-$ver.tar.gz"
    if ! fetch "$WORK/tor-sums.txt" "$base/sha256sums-signed-build.txt" 60; then say "torproject.org did not answer for Tor's checksums, so Tor was not installed"; return 0; fi
    if command -v gpg >/dev/null 2>&1; then
      if ! fetch "$WORK/tor-sums.txt.asc" "$base/sha256sums-signed-build.txt.asc" 60 || ! tor_signed "$WORK/tor-sums.txt" "$WORK/tor-sums.txt.asc"; then
        say "Tor's checksums do not carry a good signature by the Tor Browser key ($TOR_KEY_FPR), so Tor was not installed"
        return 0
      fi
      say "Tor's checksums are signed by the Tor Browser key"
    else
      say "gpg is not here, so Tor is checked against its published checksum but not its signature. To check both on the next run: $(pkg_cmd gnupg)"
    fi
    want="$(sum_for "$WORK/tor-sums.txt" "$file")"
    if [ -z "$want" ]; then say "Tor $ver lists no checksum for $file, so Tor was not installed"; return 0; fi
    if [ -n "$TEST" ]; then
      if url_ok "$base/$file"; then note "test: $base/$file is there (sha256 $want); not downloaded"; else say "test: $base/$file does not answer"; fi
    else
      say "Downloading Tor $ver ($file, about 20 to 35 MB) from torproject.org"
      if ! fetch "$WORK/$file" "$base/$file" 1800; then say "The Tor download did not finish, so Tor was not installed"; return 0; fi
      if [ "$(sha256 "$WORK/$file")" != "$want" ]; then say "The Tor download does not match its published checksum, so it was not used"; rm -f "$WORK/$file"; return 0; fi
      new="$TOR_DIR.new"; rm -rf "$new"; mkdir -p "$new"
      if ! tar -xzf "$WORK/$file" -C "$new" || [ ! -x "$new/tor/tor" ]; then say "The Tor download has no tor program where expected, so Tor was not installed"; rm -rf "$new"; return 0; fi
      [ "$own" != 1 ] || svc_stop tor
      rm -rf "$TOR_DIR.old"
      if [ -d "$TOR_DIR" ] && ! mv "$TOR_DIR" "$TOR_DIR.old"; then say "$TOR_DIR could not be replaced"; rm -rf "$new"; return 0; fi
      if ! mv "$new" "$TOR_DIR"; then say "Tor could not be put in $TOR_DIR"; return 0; fi
      rm -rf "$TOR_DIR.old"
      printf 'version=%s\n' "$ver" > "$TOR_DIR/.everythingapp"
      say "Tor $ver is in $TOR_DIR"
    fi
    changed=1
  fi
  tbin="$TOR_DIR/tor/tor"
  conf="$CONF_DIR/tor"; data="$DATA_DIR/tor"; torrc="$conf/torrc"
  mkdir -p "$conf" "$data"; chmod 700 "$conf" "$data"
  # Bridges: EA_TOR_BRIDGES=snowflake or off; otherwise what an earlier run found (conf/bridges), else direct first.
  case "${EA_TOR_BRIDGES:-}" in
    snowflake) echo snowflake > "$conf/bridges" ;;
    off|0|no) rm -f "$conf/bridges" ;;
  esac
  tor_torrc
  if [ ! -f "$torrc" ] || ! cmp -s "$WORK/torrc" "$torrc"; then cat "$WORK/torrc" > "$torrc"; changed=1; fi
  if [ "$OS" = Linux ]; then
    svc_write tor "Tor for Aeneas (searches and page reads)" "$TOR_DIR" "LD_LIBRARY_PATH=$TOR_DIR/tor" -- "$tbin" -f "$torrc"
  else
    # The Expert Bundle's macOS tor carries an ad-hoc signature that no longer matches it (tested 16.0: "invalid
    # signature"), and Apple Silicon kills such a program at once (OS_REASON_CODESIGNING), so Tor never ran on a Mac.
    # The archive was checked against Tor's published checksum above; signing it ad hoc here only lets macOS load it.
    if [ -z "$TEST" ] && [ -x "$tbin" ] && ! codesign -v "$tbin" >/dev/null 2>&1; then
      if codesign --force --sign - "$tbin" >/dev/null 2>&1; then say "Signed Tor for this Mac (its download's signature did not match it; the download itself matched its checksum)"; changed=1
      else say "macOS will not run Tor as downloaded, and it could not be signed here; web lookups stay off"; fi
    fi
    svc_write tor "Tor for Aeneas (searches and page reads)" "$TOR_DIR" -- "$tbin" -f "$torrc"
  fi
  [ "$changed" != 1 ] || svc_changed=1
  svc_apply tor "$svc_changed" || return 0
  if [ -z "$TEST" ]; then
    say "Waiting for Tor to connect (up to 2 minutes the first time)"
    ok=0
    for _ in $(seq 1 24); do
      if curl -fsS --max-time 10 --socks5-hostname "127.0.0.1:$TOR_PORT" https://check.torproject.org/api/ip 2>/dev/null | grep -q '"IsTor": *true'; then ok=1; break; fi
      sleep 5
    done
    # Stuck before any relay answered and not on bridges yet: this network blocks Tor's relays. Snowflake gets
    # through most such blocks; the choice is kept for later runs.
    if [ "$ok" = 0 ] && [ -z "${EA_TOR_BRIDGES:-}" ] && [ ! -f "$conf/bridges" ] && [ -f "$TOR_DIR/tor/pluggable_transports/pt_config.json" ]; then
      say "Tor could not reach its relays directly (some networks block them); trying again through Snowflake bridges, which take a little longer"
      echo snowflake > "$conf/bridges"
      tor_torrc && cat "$WORK/torrc" > "$torrc"
      svc_apply tor 1 || return 0
      for _ in $(seq 1 36); do
        if curl -fsS --max-time 10 --socks5-hostname "127.0.0.1:$TOR_PORT" https://check.torproject.org/api/ip 2>/dev/null | grep -q '"IsTor": *true'; then ok=1; break; fi
        sleep 5
      done
    fi
    if [ "$ok" = 1 ]; then say "Tor is connected$([ -f "$conf/bridges" ] && echo " (through Snowflake bridges)")"; else say "Tor is still connecting; searches wait for it (see: $(svc_logs tor))"; fi
  fi
  set_env EA_TOR_SOCKS "127.0.0.1:$TOR_PORT"
  TOR_SOCKS="127.0.0.1:$TOR_PORT"
  say "Page reads go through Tor at 127.0.0.1:$TOR_PORT (EA_TOR=0 turns it off)"
  return 0
}
searxng_settings() { # writes settings.yml (a new secret the first time); 0 when it changed
  local conf="$CONF_DIR/searxng" secret
  mkdir -p "$conf"; chmod 700 "$conf"
  if [ ! -s "$conf/secret_key" ]; then (umask 077 && head -c 64 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 48 > "$conf/secret_key"); fi
  secret="$(cat "$conf/secret_key")"
  {
    echo "# SearXNG for Aeneas. Written by the installer, and written again on each run: changes here are replaced."
    echo "# Only these engines are asked (the Web lookups module names them): each sees the words searched and the address"
    echo "# the search leaves from (Tor's, when it is set up). SearXNG's own default list asks many more, Google and Bing among them."
    echo "use_default_settings:"
    echo "  engines:"
    echo "    keep_only:"
    echo "      - duckduckgo"
    echo "      - brave"
    echo "      - mwmbl"
    echo "      - wikipedia"
    echo "# Through Tor, DuckDuckGo and Brave often refuse (a CAPTCHA, too many requests); Mwmbl, a non-profit open index,"
    echo "# answers through Tor, so it is switched on, and Wikipedia gives results as well as its info box."
    echo "engines:"
    echo "  - name: mwmbl"
    echo "    disabled: false"
    echo "  - name: wikipedia"
    echo "    display_type: [\"infobox\", \"list\"]"
    echo "general:"
    echo "  debug: false"
    echo "  instance_name: \"Aeneas search\""
    echo "  enable_metrics: false"
    echo "search:"
    echo "  safe_search: 0"
    echo "  autocomplete: \"\""
    echo "  formats:"
    echo "    - html"
    echo "    - json"
    echo "server:"
    echo "  bind_address: \"127.0.0.1\""
    echo "  port: 8888"
    echo "  secret_key: \"$secret\""
    echo "  base_url: false"
    echo "  limiter: false"
    echo "  public_instance: false"
    echo "  image_proxy: true"
    echo "  method: \"GET\""
    echo "valkey:"
    echo "  url: false"
    if [ -n "$TOR_SOCKS" ]; then
      echo "outgoing:"
      echo "  proxies:"
      echo "    all://:"
      echo "      - socks5h://$TOR_SOCKS"
      echo "  # SearXNG checks at start that it really goes out through Tor, and does not start otherwise."
      echo "  using_tor_proxy: true"
      echo "  extra_proxy_timeout: 10"
    fi
  } > "$WORK/settings.yml"
  if [ -f "$conf/settings.yml" ] && cmp -s "$WORK/settings.yml" "$conf/settings.yml"; then return 1; fi
  (umask 077 && cat "$WORK/settings.yml" > "$conf/settings.yml")
  chmod 600 "$conf/settings.yml"
  return 0
}
git_pinned() { # DIR: the pinned SearXNG commit alone, checked by git
  local d="$1"
  mkdir -p "$d" &&
    git -C "$d" -c init.defaultBranch=main init -q &&
    git -C "$d" remote add origin "$SEARXNG_REPO" &&
    GIT_TERMINAL_PROMPT=0 limit 600 git -C "$d" fetch -q --depth 1 origin "$SEARXNG_COMMIT" &&
    git -C "$d" -c advice.detachedHead=false checkout -q FETCH_HEAD &&
    [ "$(git -C "$d" rev-parse HEAD)" = "$SEARXNG_COMMIT" ]
}
searxng_step() {
  local own="" cur py src venv cache changed=0 vstr
  if [ -n "${EA_NO_SEARXNG:-}" ]; then say "EA_NO_SEARXNG is set, so no web search is installed"; return 0; fi
  [ -f "$SEARXNG_DIR/.everythingapp" ] && own=1
  cur="$(get_env EA_SEARXNG_URL)"
  if [ -z "$cur" ] && [ -n "${EA_SEARXNG_URL:-}" ]; then cur="${EA_SEARXNG_URL%/}"; set_env EA_SEARXNG_URL "$cur"; fi
  if [ "$own" != 1 ]; then
    if [ -n "$cur" ]; then
      say "Web search uses $cur; it is left as it is"
      [ -z "$TOR_SOCKS" ] || note "Searches there go through Tor only if that SearXNG is set up for it"
      return 0
    fi
    if port_busy 8888; then
      if answers "$SEARXNG_HERE/config"; then set_env EA_SEARXNG_URL "$SEARXNG_HERE"; say "A SearXNG already answers on 127.0.0.1:8888; the hub uses it"
      else say "Something else uses port 8888, so SearXNG was not installed"; fi
      return 0
    fi
    if [ -e "$SEARXNG_DIR" ]; then say "$SEARXNG_DIR exists and was not made by this installer; it is left as it is, and SearXNG was not installed"; return 0; fi
  fi
  py="$(find_python || true)"
  if [ -z "$py" ] && have_git; then py="$(standalone_python || true)"; fi
  if [ -z "$py" ] || ! have_git; then
    local lack="Python 3.10 or newer with its venv module"
    if [ -n "$py" ]; then lack="git"; elif have_git; then :; else lack="$lack, and git"; fi
    say "Skipped web search for now (it is off to start anyway): it needs $lack, which this computer does not have. Everything else works. To add it later: $(python_git_cmd), then run the same install command again"
    return 0
  fi
  src="$SEARXNG_DIR/src"; venv="$SEARXNG_DIR/venv"; cache="$HOME/.cache/everythingapp/searxng"
  if [ "$own" = 1 ] && grep -qx "commit=$SEARXNG_COMMIT" "$SEARXNG_DIR/.everythingapp" && [ -x "$venv/bin/python" ]; then
    say "SearXNG ${SEARXNG_COMMIT:0:12} is already in $SEARXNG_DIR"
  elif [ -n "$TEST" ]; then
    if url_ok "https://github.com/searxng/searxng/commit/$SEARXNG_COMMIT"; then note "test: SearXNG commit $SEARXNG_COMMIT is there; not fetched, no Python environment made ($py)"
    else say "test: the SearXNG commit does not answer"; fi
    changed=1
  else
    say "Installing SearXNG (commit ${SEARXNG_COMMIT:0:12}) into $SEARXNG_DIR with $py (a few minutes the first time)"
    mkdir -p "$SEARXNG_DIR"
    rm -rf "$src.new" "$venv.new"
    if ! git_pinned "$src.new"; then say "GitHub did not give the SearXNG commit, so SearXNG was not installed. Run this again later"; rm -rf "$src.new"; return 0; fi
    # The environment is run as venv/bin/python -m, so it keeps working after it is moved into place.
    if ! "$py" -m venv "$venv.new" ||
       ! limit 900 "$venv.new/bin/python" -m pip install --disable-pip-version-check --no-input -q -U pip setuptools wheel ||
       ! limit 1800 "$venv.new/bin/python" -m pip install --disable-pip-version-check --no-input -q -r "$src.new/requirements.txt" -r "$src.new/requirements-server.txt"; then
      say "SearXNG's Python packages could not be installed, so SearXNG was not installed"
      rm -rf "$src.new" "$venv.new"; return 0
    fi
    # The version SearXNG shows, written once so it never asks git at run time.
    vstr="$(git -C "$src.new" show -s --date='format:%Y.%m.%d' --format='%cd+%h' | sed 's/\.0/./g')"
    printf 'VERSION_STRING = "%s"\nVERSION_TAG = "%s"\nDOCKER_TAG = "%s"\nGIT_URL = "https://github.com/searxng/searxng"\nGIT_BRANCH = "master"\n' "$vstr" "$vstr" "${vstr/+/-}" > "$src.new/searx/version_frozen.py"
    [ "$own" != 1 ] || svc_stop searxng
    rm -rf "$src" "$venv"
    if ! mv "$src.new" "$src" || ! mv "$venv.new" "$venv"; then say "SearXNG could not be put in $SEARXNG_DIR"; return 0; fi
    printf 'commit=%s\n' "$SEARXNG_COMMIT" > "$SEARXNG_DIR/.everythingapp"
    changed=1
  fi
  if searxng_settings; then changed=1; fi
  mkdir -p "$cache"; chmod 700 "$cache"
  # Its cache stays in the owner's own folder, not the shared temporary one.
  if [ -n "$TOR_SOCKS" ] && [ "$TOR_SOCKS" = "127.0.0.1:$TOR_PORT" ]; then
    SVC_AFTER=everythingapp-tor.service svc_write searxng "SearXNG for Aeneas (private web search)" "$src" "SEARXNG_SETTINGS_PATH=$CONF_DIR/searxng/settings.yml" "PYTHONPATH=$src" "TMPDIR=$cache" -- "$venv/bin/python" -m granian --interface wsgi --host 127.0.0.1 --port 8888 searx.webapp:app
  else
    svc_write searxng "SearXNG for Aeneas (private web search)" "$src" "SEARXNG_SETTINGS_PATH=$CONF_DIR/searxng/settings.yml" "PYTHONPATH=$src" "TMPDIR=$cache" -- "$venv/bin/python" -m granian --interface wsgi --host 127.0.0.1 --port 8888 searx.webapp:app
  fi
  [ "$changed" != 1 ] || svc_changed=1
  svc_apply searxng "$svc_changed" || return 0
  if [ -z "$TEST" ] && ! wait_for 90 "$SEARXNG_HERE/healthz"; then say "SearXNG does not answer yet; see: $(svc_logs searxng)"; fi
  [ -n "$(get_env EA_SEARXNG_URL)" ] || set_env EA_SEARXNG_URL "$SEARXNG_HERE"
  if [ -n "$TOR_SOCKS" ]; then say "Web search runs on 127.0.0.1:8888 and goes out only through Tor"; else say "Web search runs on 127.0.0.1:8888, and stays off in the app until Tor is set up (run this again)"; fi
  return 0
}
tor_step || say "The Tor step stopped early; web lookups stay off until Tor is set up (run this again)"
searxng_step || say "The web search step stopped early; the hub runs without it"

# ---- 6. the address devices use ----
address="$(get_env EA_PUBLIC_URL)"
if [ "$tailscale_ok" = 1 ] && [ "$(get_env EA_BIND_HOST)" = 127.0.0.1 ]; then
  if [ -n "$TEST" ]; then
    note "test: Tailscale Serve is not changed"
  elif say "Setting up Tailscale Serve: HTTPS on port $PORT for your own devices on the tailnet, to the hub on this machine" && tailscale serve --bg --https="$PORT" "http://127.0.0.1:$PORT" >/dev/null 2>&1; then
    dns="$(tailscale status --json 2>/dev/null | sed -n 's/.*"DNSName": *"\([^"]*\)\.".*/\1/p' | head -1)"
    [ -n "$dns" ] && address="https://$dns:$PORT"
  else
    say "Tailscale did not let $USER serve HTTPS. Once, as an admin: sudo tailscale set --operator=$USER ; then run this again"
  fi
fi
[ -n "$address" ] || address="http://127.0.0.1:$PORT"
set_env EA_PUBLIC_URL "$address"
if [ "$env_changed" = 1 ]; then
  say "Restarting the hub with the new settings"
  restart_hub
  ok=0
  for _ in $(seq 1 40); do if curl -fsS --max-time 2 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then ok=1; break; fi; sleep 1; done
  [ "$ok" = 1 ] || say "The hub did not answer after the restart; see: $logs"
fi
tls_cert="$(get_env EA_TLS_CERT)"
if [ -n "$tls_cert" ] && [ -f "$tls_cert" ]; then
  if [ -n "$TEST" ]; then
    if curl -fsS --max-time 5 --cacert "$tls_cert" "https://127.0.0.1:$PORT/health" >/dev/null 2>&1; then note "test: the hub answers HTTPS with its certificate"; else say "test: the hub does not answer HTTPS with its certificate"; fi
  fi
  say "The first time, your browser will say the connection is not private. That is expected: the hub made its own certificate instead of buying one. Choose Advanced (Chrome, Edge, Firefox) or Show Details (Safari), then continue to the site. The phone and Mac apps check this certificate by themselves when you scan the pairing code. To be sure it is your hub, its fingerprint is:"
  note "$(openssl x509 -noout -fingerprint -sha256 -in "$tls_cert" 2>/dev/null | sed 's/^.*=//')"
fi

# ---- 7. done ----
# A one-time pairing code for this computer's browser, asked of the hub on 127.0.0.1 with the main key from
# hub.env (sent in a header from stdin, never on a command line). The link holds no lasting secret: it works once,
# for 10 minutes, and deploy/pair-link.sh makes another.
pair_json=""
for _ in 1 2 3 4 5 6 7 8 9 10; do
  pair_json="$(curl -fsS --max-time 5 -X POST -H @- -H 'content-type: application/json' -d '{"name":"Browser"}' "http://127.0.0.1:$PORT/devices/pairing" <<<"authorization: Bearer $(get_env EA_TOKEN)" 2>/dev/null)" && break
  sleep 1
done
pair_field() { printf '%s' "$pair_json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(String(JSON.parse(s)[process.argv[1]]??""))}catch{}})' "$1"; }
link="$(pair_field web)"
echo
say "The hub is running at $address"
if [ -n "$link" ]; then
  echo "    To finish, open this link in a browser on this computer, or on another computer on the same network"
  echo "    (it works once, for 10 minutes). The page that opens walks you through the rest:"
  echo
  echo "    $link"
  echo
  echo "    If it has expired: $APP_DIR/deploy/pair-link.sh"
else
  echo "    The hub did not answer for a pairing code. Once it is up, run: $APP_DIR/deploy/pair-link.sh"
fi
echo
case "$address" in http://1*|http://192*) echo "    Your network sees the hub without encryption. Tailscale (tailscale.com) gives it HTTPS: install it, then run this again." ;; esac
echo "    Logs: $logs"
echo "    Update later: run the same command again."
if [ -z "${SSH_CONNECTION:-}" ] && [ -n "$link" ]; then
  if [ "$OS" = Darwin ] || { [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ] && command -v xdg-open >/dev/null; }; then
    echo "    Opening the link in your browser now."
    if [ "$OS" = Darwin ]; then open "$link" 2>/dev/null || true; else xdg-open "$link" >/dev/null 2>&1 || true; fi
  fi
fi
