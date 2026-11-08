#!/usr/bin/env bash
# A fresh pairing link for the first device, made on the hub's own machine.
#
#   ~/everythingapp/deploy/pair-link.sh [device name]
#
# The installer prints one at the end, but a pairing code works once and only for 10 minutes. Run this when that
# one has expired and no device is paired yet to make another. It asks the hub on this machine (127.0.0.1) with the
# main key from hub.env, prints the link and the code, and prints nothing secret: the code is useless after one use
# or 10 minutes.
set -euo pipefail
ENV_FILE="${EA_ENV_FILE:-$HOME/.config/everythingapp/hub.env}"
NAME="${1:-Browser}"
[ -r "$ENV_FILE" ] || { echo "error: $ENV_FILE is not here; run this on the hub's machine as the user the hub runs as" >&2; exit 1; }
get_env() { grep -E "^$1=" "$ENV_FILE" | tail -1 | cut -d= -f2- || true; }
PORT="$(get_env EA_PORT)"; PORT="${PORT:-8787}"
TOKEN="$(get_env EA_TOKEN)"
[ -n "$TOKEN" ] || { echo "error: no EA_TOKEN in $ENV_FILE" >&2; exit 1; }
# The main key goes in a header from a file descriptor, never on the command line where other users could see it.
body="$(printf '{"name":%s}' "$(printf '%s' "$NAME" | sed 's/\\/\\\\/g; s/"/\\"/g; s/^/"/; s/$/"/')")"
# Plain HTTP is answered only on 127.0.0.1 (hub/src/tls.ts), which is where this asks.
answer="$(curl -fsS --max-time 10 -X POST -H @- -H 'content-type: application/json' -d "$body" "http://127.0.0.1:$PORT/devices/pairing" <<<"authorization: Bearer $TOKEN")" || {
  echo "error: the hub on this machine did not answer on port $PORT. Is it running? Logs: journalctl --user -u everythingapp-hub (Linux) or ~/.local/share/everythingapp/logs/hub.log (Mac)" >&2
  exit 1
}
# The installer puts Node in ~/.local/node, which a new terminal does not have on its PATH; python3 also reads JSON.
NODE="$(command -v node 2>/dev/null || true)"
[ -n "$NODE" ] || { [ -x "$HOME/.local/node/bin/node" ] && NODE="$HOME/.local/node/bin/node"; }
field() {
  if [ -n "$NODE" ]; then
    printf '%s' "$answer" | "$NODE" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{process.stdout.write(String(JSON.parse(s)[process.argv[1]]??""))})' "$1"
  else
    printf '%s' "$answer" | python3 -c 'import json,sys; print(json.load(sys.stdin).get(sys.argv[1]) or "", end="")' "$1"
  fi
}
echo "Open this link on the device to pair it (it works once, for 10 minutes):"
echo
echo "    $(field web)"
echo
echo "Or type the code $(field code) in the app's setup screen, with the hub address $(field hub)."
