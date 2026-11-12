#!/bin/zsh
# Builds TailscaleKit (Tailscale's libtailscale, BSD-3-Clause) for the iPhone, iPad, the simulator and the Mac, into
# apple/Packages/EATailnet/TailscaleKit.xcframework, which "Tailscale in Aeneas" (EATailnet) links. Not kept in git
# (about 70 MB). Needs Xcode and Go. Pinned to one libtailscale commit; change LIBTAILSCALE_COMMIT to move it.
set -euo pipefail
LIBTAILSCALE_COMMIT=dacde75057ff350e146505829beff446e6823966
HERE=${0:a:h}
OUT=$HERE/../Packages/EATailnet/TailscaleKit.xcframework
WORK=${TMPDIR:-/tmp}/aeneas-libtailscale
command -v go >/dev/null || { echo "Go is needed (brew install go)"; exit 1; }
if [ ! -d "$WORK/.git" ]; then git clone -q https://github.com/tailscale/libtailscale "$WORK"; fi
git -C "$WORK" fetch -q origin "$LIBTAILSCALE_COMMIT"
git -C "$WORK" checkout -q --detach "$LIBTAILSCALE_COMMIT"
cd "$WORK/swift"
make ios-sim ios
# The Mac app is universal (Apple silicon and Intel), so the Mac framework is too; libtailscale's own "macos" target
# builds Apple silicon only.
(
  cd ..
  export MACOSX_DEPLOYMENT_TARGET=15.0 CGO_ENABLED=1 GOOS=darwin
  F=-mmacos-version-min=15.0
  for A in arm64 amd64; do
    CL=$([ $A = amd64 ] && echo x86_64 || echo arm64)
    GOARCH=$A CC="clang -arch $CL" CGO_CFLAGS="$F -arch $CL" CGO_LDFLAGS="$F -arch $CL" go build -buildmode=c-archive -o libtailscale_$A.a
  done
  lipo -create -output libtailscale.a libtailscale_arm64.a libtailscale_amd64.a
)
xcodebuild build -scheme "TailscaleKit (macOS)" -derivedDataPath build -configuration Release \
  -destination 'generic/platform=macOS' ARCHS="arm64 x86_64" ONLY_ACTIVE_ARCH=NO CODE_SIGNING_ALLOWED=NO -quiet
P=build/Build/Products
rm -rf "$OUT"
xcodebuild -create-xcframework \
  -framework $P/Release-iphoneos/TailscaleKit.framework \
  -framework $P/Release-iphonesimulator/TailscaleKit.framework \
  -framework $P/Release/TailscaleKit.framework \
  -output "$OUT"
echo "TailscaleKit $LIBTAILSCALE_COMMIT built into $OUT"
