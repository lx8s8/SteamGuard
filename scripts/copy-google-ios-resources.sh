#!/bin/sh
# Invoked by the iOS app target after Rust/SwiftPM compilation, before signing.
set -eu
STEAMGUARD_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
case "${PLATFORM_NAME:?Missing Xcode platform}" in
  iphoneos) STEAMGUARD_RUST_TARGET=aarch64-apple-ios ;;
  iphonesimulator)
    case "${CURRENT_ARCH:-${ARCHS:-arm64}}" in
      x86_64) STEAMGUARD_RUST_TARGET=x86_64-apple-ios ;;
      *) STEAMGUARD_RUST_TARGET=aarch64-apple-ios-sim ;;
    esac ;;
  *) echo "Unsupported Google SDK resource platform" >&2; exit 1 ;;
esac
case "${CONFIGURATION:?Missing Xcode configuration}" in
  [Rr]elease) STEAMGUARD_RUST_PROFILE=release ;;
  *) STEAMGUARD_RUST_PROFILE=debug ;;
esac
STEAMGUARD_RESOURCE_SOURCE="$STEAMGUARD_ROOT/src-tauri/plugins/cloud-auth/ios/.tauri-resources/$STEAMGUARD_RUST_TARGET/$STEAMGUARD_RUST_PROFILE"
STEAMGUARD_RESOURCE_DESTINATION="${TARGET_BUILD_DIR:?Missing app build directory}/${UNLOCALIZED_RESOURCES_FOLDER_PATH:?Missing app resources path}"
if [ ! -d "$STEAMGUARD_RESOURCE_SOURCE/GoogleSignIn_GoogleSignIn.bundle" ]; then
  echo "Google iOS SDK resources are missing; rebuild Rust before signing the app." >&2
  exit 1
fi
mkdir -p "$STEAMGUARD_RESOURCE_DESTINATION"
for STEAMGUARD_RESOURCE_BUNDLE in "$STEAMGUARD_RESOURCE_SOURCE"/*.bundle; do
  [ -d "$STEAMGUARD_RESOURCE_BUNDLE" ] || continue
  /usr/bin/ditto "$STEAMGUARD_RESOURCE_BUNDLE" "$STEAMGUARD_RESOURCE_DESTINATION/$(basename -- "$STEAMGUARD_RESOURCE_BUNDLE")"
done
