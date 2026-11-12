#!/usr/bin/env bash
# Build the Windows hub installer, dist/Aeneas-Hub-Setup-VERSION.exe, and its SHA-256, on Linux with NSIS 3
# (apt-get install nsis). On Windows use build.ps1. Homebrew's makensis 3.13 crashes on macOS 26 (std::bad_alloc as
# soon as a script has a section, 2026-11-10), so a Mac cannot build it for now.
#
#   bash deploy/windows/installer/build.sh 1.0.2
#
# The installer carries deploy/install.ps1 as it is at this checkout; that script installs the hub from the public
# repository's main branch.
set -euo pipefail
VERSION="${1:?give the version, like 1.0.2}"
case "$VERSION" in *[!0-9.]*|"") echo "the version is numbers and dots, like 1.0.2" >&2; exit 1 ;; esac
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
OUT="$REPO/dist"
mkdir -p "$OUT"
command -v makensis >/dev/null || { echo "makensis is needed: apt-get install nsis (Linux); on Windows use build.ps1" >&2; exit 1; }
makensis -V2 -DVERSION="$VERSION" -DOUTDIR="$OUT" "$HERE/aeneas-hub.nsi"
EXE="$OUT/Aeneas-Hub-Setup-$VERSION.exe"
( cd "$OUT" && shasum -a 256 "$(basename "$EXE")" > "$(basename "$EXE").sha256" )
echo "built $EXE ($(du -h "$EXE" | cut -f1)), sha256 $(cut -d' ' -f1 "$EXE.sha256")"
