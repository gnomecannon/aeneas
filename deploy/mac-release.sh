#!/usr/bin/env bash
# The Mac app for download outside the App Store: archived, signed with your Developer ID, notarized by Apple and
# stapled, so it opens on any Mac without a warning. Writes dist/Aeneas-mac-<version>-<build>.zip (Aeneas.app inside)
# and its .sha256 beside it.
#
#   deploy/mac-release.sh
#
# Signing and notarizing go through the Apple account signed in to Xcode (Xcode, Settings, Accounts), with its
# cloud-managed Developer ID certificate: no certificate file or app-specific password is kept on this Mac. The
# account's holder signs in there once. The team comes from apple/Signing.xcconfig, or Signing.local.xcconfig when you
# build under your own account.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
say() { printf '==> %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }
[ "$(uname -s)" = Darwin ] || die "this builds on a Mac"
setting() { # NAME: from Signing.local.xcconfig when it sets it, else Signing.xcconfig
  local v=""
  [ ! -f "$REPO/apple/Signing.local.xcconfig" ] || v="$(sed -n "s/^$1 *= *//p" "$REPO/apple/Signing.local.xcconfig" | tail -1)"
  [ -n "$v" ] || v="$(sed -n "s/^$1 *= *//p" "$REPO/apple/Signing.xcconfig" | tail -1)"
  printf '%s' "$v"
}
TEAM="$(setting EA_TEAM_ID)"
[ -n "$TEAM" ] || die "no EA_TEAM_ID in apple/Signing.xcconfig"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/ea-mac-release.XXXXXX")"
# Kept when notarization outlasts the wait, so the export can be finished later without sending it again.
KEEP=0
trap '[ "$KEEP" = 1 ] || rm -rf "$WORK"' EXIT
cd "$REPO/apple"
xattr -cr . 2>/dev/null || true
say "archiving"
xcodebuild -project EverythingApp.xcodeproj -scheme EverythingApp -configuration Release -destination 'generic/platform=macOS' \
  -derivedDataPath "$HOME/Library/Caches/everythingapp-dd-release" -archivePath "$WORK/ea.xcarchive" \
  -allowProvisioningUpdates archive > "$WORK/archive.log" 2>&1 || { grep -E "error:" "$WORK/archive.log" | head -20; die "the archive failed"; }

cat > "$WORK/ExportOptions.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>method</key><string>developer-id</string>
  <key>destination</key><string>upload</string>
  <key>teamID</key><string>$TEAM</string>
  <key>signingStyle</key><string>automatic</string>
</dict></plist>
PLIST
say "signing with Developer ID and sending it to Apple to notarize"
xcodebuild -exportArchive -archivePath "$WORK/ea.xcarchive" -exportPath "$WORK/export" -exportOptionsPlist "$WORK/ExportOptions.plist" \
  -allowProvisioningUpdates > "$WORK/export.log" 2>&1 || { grep -iE "error" "$WORK/export.log" | head -20; die "the export failed"; }

say "waiting for Apple's notarization (minutes, sometimes over an hour)"
ok=0
for _ in $(seq 1 180); do
  if xcodebuild -exportNotarizedApp -archivePath "$WORK/ea.xcarchive" -exportPath "$WORK/final" > "$WORK/notarized.log" 2>&1; then ok=1; break; fi
  grep -qiE "invalid|rejected" "$WORK/notarized.log" && { tail -5 "$WORK/notarized.log"; die "Apple did not accept it"; }
  sleep 30
done
if [ "$ok" != 1 ]; then
  KEEP=1
  die "Apple has not finished notarizing after 90 minutes. Once it has, finish with:
  xcodebuild -exportNotarizedApp -archivePath \"$WORK/ea.xcarchive\" -exportPath \"$WORK/final\"
(then rename EverythingApp.app to Aeneas.app and zip it as this script does)"
fi
SRC="$WORK/final/EverythingApp.app"
[ -d "$SRC" ] || die "the notarized export has no EverythingApp.app"
# The bundle keeps its working name inside (executable, identifiers); the folder people see is Aeneas.app. A bundle's
# folder name is not part of its signature, so the rename leaves the signature and the stapled ticket intact.
APP="$WORK/final/Aeneas.app"
mv "$SRC" "$APP"
VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Contents/Info.plist")"
BUILD="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$APP/Contents/Info.plist")"
xcrun stapler validate "$APP" >/dev/null || die "no notarization ticket is stapled to the app"
codesign --verify --deep --strict "$APP" || die "the signature does not hold after the rename"
spctl -a -vv "$APP" 2>&1 | grep -q "Notarized Developer ID" || die "the app does not pass Gatekeeper"

mkdir -p "$REPO/dist"
OUT="$REPO/dist/Aeneas-mac-$VERSION-$BUILD.zip"
rm -f "$OUT"
ditto -c -k --keepParent "$APP" "$OUT"
(cd "$REPO/dist" && shasum -a 256 "$(basename "$OUT")" > "$(basename "$OUT").sha256")
say "done: $OUT"
cat "$OUT.sha256"
