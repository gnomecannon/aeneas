#!/usr/bin/env bash
# The Mac app for download outside the App Store: archived, signed with your Developer ID, notarized by Apple and
# stapled, so it opens on any Mac without a warning. Writes dist/EverythingApp-mac-<version>-<build>.zip and its
# .sha256 beside it.
#
#   deploy/mac-release.sh
#
# Once, before the first run (both need the Apple Developer account's holder):
#   1. A Developer ID Application certificate: Xcode, Settings, Accounts, your team, Manage Certificates, +,
#      Developer ID Application. It stays in this Mac's keychain.
#   2. Notary credentials in the keychain, under the name this script uses (it asks for an app-specific password,
#      made at account.apple.com, Sign-In and Security, App-Specific Passwords):
#        xcrun notarytool store-credentials everythingapp-notary --apple-id YOU@EXAMPLE.COM --team-id YOURTEAMID
# The team and bundle prefix come from apple/Signing.xcconfig, or Signing.local.xcconfig when you build under your
# own account. EA_NOTARY_PROFILE names other stored credentials.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROFILE="${EA_NOTARY_PROFILE:-everythingapp-notary}"
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
security find-identity -v -p codesigning | grep -q "Developer ID Application: .*($TEAM)" ||
  die "no Developer ID Application certificate for team $TEAM in this Mac's keychain (step 1 above)"
xcrun notarytool history --keychain-profile "$PROFILE" >/dev/null 2>&1 ||
  die "no notary credentials named $PROFILE in the keychain (step 2 above)"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/ea-mac-release.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
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
  <key>teamID</key><string>$TEAM</string>
  <key>signingStyle</key><string>automatic</string>
</dict></plist>
PLIST
say "signing with Developer ID"
xcodebuild -exportArchive -archivePath "$WORK/ea.xcarchive" -exportPath "$WORK/export" -exportOptionsPlist "$WORK/ExportOptions.plist" \
  -allowProvisioningUpdates > "$WORK/export.log" 2>&1 || { grep -iE "error" "$WORK/export.log" | head -20; die "the export failed"; }
APP="$WORK/export/EverythingApp.app"
[ -d "$APP" ] || die "the export has no EverythingApp.app"
VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Contents/Info.plist")"
BUILD="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$APP/Contents/Info.plist")"

say "notarizing $VERSION ($BUILD) with Apple (a few minutes)"
ditto -c -k --keepParent "$APP" "$WORK/notarize.zip"
xcrun notarytool submit "$WORK/notarize.zip" --keychain-profile "$PROFILE" --wait --timeout 30m | tee "$WORK/notary.log"
grep -q "status: Accepted" "$WORK/notary.log" || {
  id="$(sed -n 's/^ *id: //p' "$WORK/notary.log" | head -1)"
  [ -z "$id" ] || xcrun notarytool log "$id" --keychain-profile "$PROFILE" | head -40
  die "Apple did not accept it"
}
xcrun stapler staple "$APP" >/dev/null
spctl -a -vv "$APP" 2>&1 | grep -q "Notarized Developer ID" || die "the stapled app does not pass Gatekeeper"

mkdir -p "$REPO/dist"
OUT="$REPO/dist/EverythingApp-mac-$VERSION-$BUILD.zip"
rm -f "$OUT"
ditto -c -k --keepParent "$APP" "$OUT"
(cd "$REPO/dist" && shasum -a 256 "$(basename "$OUT")" > "$(basename "$OUT").sha256")
say "done: $OUT"
cat "$OUT.sha256"
