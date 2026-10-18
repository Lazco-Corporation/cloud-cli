#!/usr/bin/env bash
#
# Cross-compile lazco for one or more bun targets, archive each, and emit
# SHA256SUMS. Used by:
#   - `bun run build:binaries` (local, output in build/ which git ignores)
#   - .github/workflows/keychain.yml and release-npm.yml
#
# Every target embeds its own keychain module. `bun build --compile` does not
# follow the `createRequire` that `@napi-rs/keyring` uses, so each target is
# compiled from a staged copy of `src/` whose one literal
# `import("@napi-rs/keyring")` in `src/credentials/nativeKeyring.ts` names the
# target's native package instead. The build fails when the placeholder or the
# native package is missing, so no binary falls back to the file store in
# silence. Install every target's native package first:
#   bun install --frozen-lockfile --os='*' --cpu='*'
#
# Inputs (env):
#   VERSION   required. Used in archive filenames (lazco-v<VERSION>-<target>.{tar.gz,zip})
#   TARGETS   optional. Whitespace-separated bun --target values.
#             Defaults to all five release targets.
#   OUT_DIR   optional. Defaults to build/binaries.
#
# Output layout:
#   $OUT_DIR/<short-target>/lazco[.exe]            staged binary with LICENSE, README.md
#                                                  and THIRD_PARTY_NOTICES.txt
#   $OUT_DIR/lazco-v$VERSION-<short-target>.{tar.gz,zip}
#   $OUT_DIR/SHA256SUMS                            one line per archive

set -euo pipefail

: "${VERSION:?VERSION env var is required}"
TARGETS="${TARGETS:-bun-darwin-arm64 bun-darwin-x64 bun-linux-x64 bun-linux-arm64 bun-windows-x64}"
OUT_DIR="${OUT_DIR:-build/binaries}"

ROOT_DIR="$(pwd)"
STAGE_ROOT="$ROOT_DIR/build/stage"
PLACEHOLDER='import("@napi-rs/keyring")'
KEYRING_FILE="src/credentials/nativeKeyring.ts"

fail() {
  printf 'build-binaries: %s\n' "$1" >&2
  exit 1
}

# The @napi-rs/keyring package of a bun target, and its native file.
keyring_package() {
  case "$1" in
    bun-darwin-arm64) echo "keyring-darwin-arm64 keyring.darwin-arm64.node" ;;
    bun-darwin-x64) echo "keyring-darwin-x64 keyring.darwin-x64.node" ;;
    bun-linux-x64) echo "keyring-linux-x64-gnu keyring.linux-x64-gnu.node" ;;
    bun-linux-arm64) echo "keyring-linux-arm64-gnu keyring.linux-arm64-gnu.node" ;;
    bun-windows-x64) echo "keyring-win32-x64-msvc keyring.win32-x64-msvc.node" ;;
    *) return 1 ;;
  esac
}

# `bun build --compile` leaves the darwin-x64 binary with Bun's own signature,
# which no longer matches the file, and macOS then refuses it the keychain. So
# every macOS binary gets an ad-hoc signature: rcodesign on Linux
# (scripts/install-rcodesign.sh), codesign on macOS.
sign_tool() {
  if command -v rcodesign >/dev/null 2>&1; then
    echo rcodesign
  elif command -v codesign >/dev/null 2>&1; then
    echo codesign
  else
    return 1
  fi
}

sign_adhoc() {
  case "$(sign_tool)" in
    rcodesign)
      rcodesign sign "$1" >/dev/null
      rcodesign verify "$1" >/dev/null
      ;;
    codesign)
      codesign --force --sign - "$1" 2>/dev/null
      codesign --verify "$1"
      ;;
  esac
}

# Check every target before building any, so one missing package fails the whole build.
for target in $TARGETS; do
  spec="$(keyring_package "$target")" || fail "no keychain package is known for $target"
  read -r package native_file <<<"$spec"
  [[ -f "node_modules/@napi-rs/$package/$native_file" ]] ||
    fail "node_modules/@napi-rs/$package/$native_file is missing, so $target would have no keychain. Run: bun install --frozen-lockfile --os='*' --cpu='*'"
done
if [[ "$TARGETS" == *bun-darwin-* ]]; then
  sign_tool >/dev/null ||
    fail "the macOS binaries need an ad-hoc signature: run on macOS, or install rcodesign with scripts/install-rcodesign.sh"
fi
[[ "$(grep -cF "$PLACEHOLDER" "$KEYRING_FILE")" == "1" ]] ||
  fail "$KEYRING_FILE must hold exactly one $PLACEHOLDER"

mkdir -p "$OUT_DIR"
rm -f "$OUT_DIR"/sha-*.sum "$OUT_DIR/SHA256SUMS"

archive_one() {
  local target="$1"
  local short="${target#bun-}"
  local stage="$OUT_DIR/$short"
  local source_copy="$STAGE_ROOT/$short"
  local bin_name="lazco"
  local archive_ext="tar.gz"
  local package native_file

  read -r package native_file <<<"$(keyring_package "$target")"
  case "$target" in
    bun-windows-*) bin_name="lazco.exe"; archive_ext="zip" ;;
  esac

  local out_bin="$stage/$bin_name"
  local archive_name="lazco-v${VERSION}-${short}.${archive_ext}"
  local archive_path="$OUT_DIR/$archive_name"

  echo "==> $target (@napi-rs/$package, $native_file)"
  rm -rf "$stage" "$source_copy"
  mkdir -p "$stage" "$source_copy"

  # The copy sits below the repo root, so its imports still resolve in node_modules/.
  cp -R src "$source_copy/src"
  cp package.json "$source_copy/package.json"
  local rewritten="$source_copy/$KEYRING_FILE"
  sed "s|import(\"@napi-rs/keyring\")|import(\"@napi-rs/$package\")|" "$KEYRING_FILE" >"$rewritten"
  grep -qF "import(\"@napi-rs/$package\")" "$rewritten" ||
    fail "the keychain import of $target was not rewritten"

  bun build --compile --minify "--target=$target" "$source_copy/src/cli.ts" --outfile "$out_bin"
  case "$target" in
    bun-darwin-*) sign_adhoc "$out_bin" || fail "the ad-hoc signature of $target failed" ;;
  esac

  cp LICENSE "$stage/LICENSE"
  if [[ -f README.md ]]; then
    cp README.md "$stage/README.md"
  fi
  bun scripts/third-party-notices.ts "@napi-rs/$package" >"$stage/THIRD_PARTY_NOTICES.txt"

  rm -f "$archive_path"
  case "$archive_ext" in
    tar.gz)
      tar -C "$stage" -czf "$archive_path" .
      ;;
    zip)
      ( cd "$stage" && zip -qr "$ROOT_DIR/$archive_path" . )
      ;;
  esac

  # Per-target sum file - merged into SHA256SUMS after all jobs finish.
  # Avoids racing concurrent appenders on a shared file.
  ( cd "$OUT_DIR" && shasum -a 256 "$archive_name" > "sha-${short}.sum" )

  echo "    -> $archive_path"
}

# Every target cross-compiles on one host, so the targets build concurrently.
declare -a _PIDS=()
for target in $TARGETS; do
  archive_one "$target" &
  _PIDS+=($!)
done

_FAILED=0
for pid in "${_PIDS[@]}"; do
  wait "$pid" || _FAILED=1
done
rm -rf "$STAGE_ROOT"
[[ "$_FAILED" == "0" ]] || fail "a target failed to build"

# Merge per-target sums in the original target order for stable output.
: > "$OUT_DIR/SHA256SUMS"
for target in $TARGETS; do
  short="${target#bun-}"
  sum_file="$OUT_DIR/sha-${short}.sum"
  [[ -f "$sum_file" ]] || fail "no checksum was written for $target"
  cat "$sum_file" >> "$OUT_DIR/SHA256SUMS"
done
rm -f "$OUT_DIR"/sha-*.sum

echo
echo "SHA256SUMS:"
cat "$OUT_DIR/SHA256SUMS"
