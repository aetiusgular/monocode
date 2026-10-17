#!/bin/bash
# Builds and signs "MonoCode Computer Use.app" (wave 3, lane C, item C1).
#
#   CUA_DRIVER_BIN=/path/to/verified/cua-driver \
#   MONOCODE_HELPER_IDENTITY="MonoCode Dev" \
#   macos/computer-use-helper/bundle.sh <output folder>
#
# - Runs on the Mac only. It downloads nothing: CUA_DRIVER_BIN is a cua-driver
#   you fetched and checked yourself (the release's SHA256SUMS and its
#   Sigstore bundle with cosign; note W, section 3.2).
# - Signs with the identity you name, never one it creates (plan, section 3,
#   call 4). The same identity must sign MonoCode: the helper only answers a
#   caller signed with it, and macOS keeps the helper's grants across rebuilds
#   only while the identity stays the same.
# - DRY_RUN=1 prints the steps and touches nothing, on any system.
# - HELPER_DEBUG=1 builds a debug helper with no signing requirement built in:
#   it checks its caller by pid only and says so in its log. For a dev build
#   of MonoCode, which is not signed with your identity. Never ship it.
set -euo pipefail

out="${1:-}"
if [ -z "$out" ]; then
  echo "usage: CUA_DRIVER_BIN=... MONOCODE_HELPER_IDENTITY=... $0 <output folder>" >&2
  exit 2
fi
identity="${MONOCODE_HELPER_IDENTITY:-}"
driver="${CUA_DRIVER_BIN:-}"
if [ -z "$identity" ] || [ -z "$driver" ]; then
  echo "Set MONOCODE_HELPER_IDENTITY and CUA_DRIVER_BIN." >&2
  exit 2
fi
case "$identity" in
  *\"*|*\\*) echo "The identity may not hold quotes or backslashes." >&2; exit 2 ;;
esac

here="$(cd "$(dirname "$0")" && pwd)"
app="$out/MonoCode Computer Use.app"
requirement="identifier \"com.monocode.desktop\" and certificate leaf[subject.CN] = \"$identity\""

run() {
  if [ "${DRY_RUN:-}" = 1 ]; then
    printf 'would run:'
    printf ' %q' "$@"
    printf '\n'
  else
    "$@"
  fi
}

if [ "${DRY_RUN:-}" != 1 ]; then
  [ "$(uname -s)" = Darwin ] || { echo "Build the helper on the Mac." >&2; exit 2; }
  [ -f "$driver" ] && [ -x "$driver" ] || { echo "No cua-driver at $driver" >&2; exit 2; }
fi

if [ "${HELPER_DEBUG:-}" = 1 ]; then
  profile=debug
  run cargo build --manifest-path "$here/Cargo.toml" --target aarch64-apple-darwin
else
  profile=release
  run env MONOCODE_HELPER_CALLER_REQUIREMENT="$requirement" \
    cargo build --release --manifest-path "$here/Cargo.toml" --target aarch64-apple-darwin
fi
run rm -rf "$app"
run mkdir -p "$app/Contents/MacOS"
run cp "$here/bundle/Info.plist" "$app/Contents/Info.plist"
run cp "$here/target/aarch64-apple-darwin/$profile/monocode-computer-use-helper" "$app/Contents/MacOS/"
run cp "$driver" "$app/Contents/MacOS/cua-driver"
# Inside out: the driver first, then the bundle, both with the hardened runtime.
run codesign --force --options runtime --timestamp=none --sign "$identity" "$app/Contents/MacOS/cua-driver"
run codesign --force --options runtime --timestamp=none --sign "$identity" \
  --identifier com.monocode.computer-use-helper "$app"
run codesign --verify --strict --verbose=2 "$app"
echo "Built $app"
echo "Place it at MonoCode.app/Contents/Helpers/, or set MONOCODE_COMPUTER_USE_HELPER to it for a dev build."
