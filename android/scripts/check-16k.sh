#!/usr/bin/env bash
#
# Google Play's 16 KB page size check, for APKs and app bundles:
#
#   android/scripts/check-16k.sh <app.apk|app.aab>...
#
# For an APK:
#   - `zipalign -c -P 16 -v 4` must report "Verification successful" (a
#     native library stored uncompressed must start on a 16 KB boundary; ours
#     are compressed, see useLegacyPackaging, so this is the 4-byte check for
#     everything else plus the 16 KB one for anything stored);
#   - every LOAD segment of every lib/<64-bit ABI>/*.so (the engine,
#     libshroudlycore_jni.so, and hev) must be aligned to 0x4000 or more.
#     32-bit ABIs are shown, not required (Play asks for 64-bit only).
# For a bundle (needs java, and bundletool: BUNDLETOOL is the path of
# bundletool-all-<v>.jar; without it the pinned release below is downloaded
# and checked against its SHA-256):
#   - its BundleConfig is shown (uncompressNativeLibraries, alignment);
#   - the APKs Play would make from it (bundletool build-apks: every ABI and
#     density split) are each checked as above, and the base one must keep
#     extractNativeLibs="true": the libraries are stored compressed
#     (useLegacyPackaging) and have to be unpacked at install.
#
# Tools: zipalign from $ANDROID_HOME/build-tools/36.0.0 (BUILD_TOOLS to change),
# llvm-readelf from the NDK ($ANDROID_NDK_HOME, else $ANDROID_HOME/ndk/<newest>).

set -euo pipefail

: "${ANDROID_HOME:?ANDROID_HOME must point at the Android SDK}"
BT="${BUILD_TOOLS:-$ANDROID_HOME/build-tools/36.0.0}"
ZIPALIGN="$BT/zipalign"
AAPT2="$BT/aapt2"
NDK="${ANDROID_NDK_HOME:-}"
# Not set, or set to something that is not an NDK: the newest one in the SDK.
if [ -z "$NDK" ] || [ ! -d "$NDK/toolchains" ]; then NDK="$(ls -d "$ANDROID_HOME"/ndk/*/ 2>/dev/null | sort -V | tail -1)"; fi
READELF="$(ls "${NDK%/}"/toolchains/llvm/prebuilt/*/bin/llvm-readelf 2>/dev/null | head -1 || true)"
[ -x "$ZIPALIGN" ] || { echo "no zipalign at $ZIPALIGN" >&2; exit 2; }
[ -n "$READELF" ] && [ -x "$READELF" ] || { echo "no llvm-readelf in the NDK (${NDK:-none})" >&2; exit 2; }
[ $# -gt 0 ] || { echo "usage: $0 <app.apk|app.aab>..." >&2; exit 2; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

BUNDLETOOL_VERSION=1.18.3
BUNDLETOOL_SHA256=a099cfa1543f55593bc2ed16a70a7c67fe54b1747bb7301f37fdfd6d91028e29
# Sets BUNDLETOOL (called outside any pipe, so the setting stays).
ensure_bundletool() {
  if [ -z "${BUNDLETOOL:-}" ]; then
    BUNDLETOOL="$TMP/bundletool-all-$BUNDLETOOL_VERSION.jar"
    curl -fsSL -o "$BUNDLETOOL" \
      "https://github.com/google/bundletool/releases/download/$BUNDLETOOL_VERSION/bundletool-all-$BUNDLETOOL_VERSION.jar"
    local got
    got="$( (sha256sum "$BUNDLETOOL" 2>/dev/null || shasum -a 256 "$BUNDLETOOL") | cut -d' ' -f1)"
    [ "$got" = "$BUNDLETOOL_SHA256" ] || { echo "bundletool $BUNDLETOOL_VERSION: SHA-256 $got is not the pinned one" >&2; exit 2; }
  fi
}
bundletool() { java -jar "$BUNDLETOOL" "$@"; }
FAILED=0
bad() { echo "  FAIL: $*"; FAILED=1; }

# check_apk <apk> [quiet]: quiet prints nothing for an APK without native
# libraries that passes (bundletool's language and density splits).
check_apk() {
  local apk="$1" quiet="${2:-}" name out dir so abi aligns min zipok
  name="$(basename "$apk")"
  out="$("$ZIPALIGN" -c -P 16 -v 4 "$apk" 2>&1 || true)"
  zipok=0; grep -q "Verification successful" <<<"$out" && zipok=1
  dir="$TMP/$(basename "$apk" .apk)-$RANDOM"
  mkdir -p "$dir"
  unzip -qo "$apk" 'lib/*' -d "$dir" 2>/dev/null || true
  if [ -n "$quiet" ] && [ "$zipok" = 1 ] && [ ! -d "$dir/lib" ]; then QUIET_OK=$((QUIET_OK + 1)); return; fi
  echo "== $name"
  if [ "$zipok" = 1 ]; then
    echo "  zipalign -c -P 16 -v 4: Verification successful"
  else
    bad "zipalign -c -P 16 -v 4: $(tail -3 <<<"$out" | tr '\n' ' ')"
  fi
  [ -d "$dir/lib" ] || { echo "  no native libraries"; return; }
  while IFS= read -r so; do
    abi="$(basename "$(dirname "$so")")"
    aligns="$("$READELF" -lW "$so" | awk '$1 == "LOAD" { print $NF }')"
    [ -n "$aligns" ] || { bad "$abi/$(basename "$so"): no LOAD segments"; continue; }
    min="$(while read -r a; do printf '%d\n' "$a"; done <<<"$aligns" | sort -n | head -1)"
    case "$abi" in
      arm64-v8a|x86_64)
        if [ "$min" -ge 16384 ]; then
          echo "  $abi/$(basename "$so"): LOAD align $(tr '\n' ' ' <<<"$aligns")ok"
        else
          bad "$abi/$(basename "$so"): LOAD align $(tr '\n' ' ' <<<"$aligns")(needs 0x4000)"
        fi ;;
      *) echo "  $abi/$(basename "$so"): LOAD align $(tr '\n' ' ' <<<"$aligns")(32-bit, not required)" ;;
    esac
  done < <(find "$dir/lib" -name '*.so' | sort)
}

check_aab() {
  local aab="$1" apks
  ensure_bundletool
  echo "== $(basename "$aab") (bundle)"
  echo "  BundleConfig:"
  bundletool dump config --bundle="$aab" | grep -i -A3 'uncompressNativeLibraries\|alignment' | sed 's/^/    /' || echo "    (no native library settings: the defaults)"
  apks="$TMP/$(basename "$aab" .aab).apks"
  bundletool build-apks --bundle="$aab" --output="$apks" --overwrite >/dev/null
  mkdir -p "$TMP/apks"
  unzip -qo "$apks" -d "$TMP/apks"
  local a masters=0 manifest
  QUIET_OK=0
  while IFS= read -r a; do
    check_apk "$a" quiet
    case "$(basename "$a")" in
      base-master*.apk)
        masters=$((masters + 1))
        # Captured first: grep -q on a pipe can end the writer early.
        manifest="$("$AAPT2" dump xmltree --file AndroidManifest.xml "$a")"
        grep -q 'extractNativeLibs([^)]*)=true' <<<"$manifest" ||
          bad "$(basename "$a") does not set extractNativeLibs=true: its compressed libraries could not be loaded" ;;
    esac
  done < <(find "$TMP/apks" -name '*.apk' | sort)
  echo "== $QUIET_OK more splits without native libraries (languages, densities): zipalign -c -P 16 -v 4 ok"
  if [ "$masters" = 0 ]; then
    bad "no base-master APK in what bundletool made"
  else
    echo "== base-master APKs ($masters, one per SDK range): extractNativeLibs=true (the libraries are unpacked to nativeLibraryDir)"
  fi
}

for f in "$@"; do
  [ -f "$f" ] || { bad "no such file: $f"; continue; }
  case "$f" in
    *.apk) check_apk "$f" ;;
    *.aab) check_aab "$f" ;;
    *) bad "not an .apk or .aab: $f" ;;
  esac
done

if [ "$FAILED" = 0 ]; then echo "16 KB check passed"; else echo "16 KB check FAILED"; exit 1; fi
