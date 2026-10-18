#!/usr/bin/env bash
#
# Cross-compile lazco for one or more bun targets, archive each, and emit
# SHA256SUMS. Used by:
#   - `bun run build:binaries` (local, output in dist/ which git ignores)
#   - .github/workflows/release-npm.yml (release path)
#
# Inputs (env):
#   VERSION   required. Used in archive filenames (lazco-v<VERSION>-<target>.{tar.gz,zip})
#   TARGETS   optional. Whitespace-separated bun --target values.
#             Defaults to all five release targets.
#   OUT_DIR   optional. Defaults to dist/binaries.
#
# Output layout:
#   $OUT_DIR/<short-target>/lazco[.exe]            staged binary
#   $OUT_DIR/lazco-v$VERSION-<short-target>.{tar.gz,zip}
#   $OUT_DIR/SHA256SUMS                            one line per archive

set -euo pipefail

: "${VERSION:?VERSION env var is required}"
TARGETS="${TARGETS:-bun-darwin-arm64 bun-darwin-x64 bun-linux-x64 bun-linux-arm64 bun-windows-x64}"
OUT_DIR="${OUT_DIR:-dist/binaries}"

ENTRY="src/cli.ts"
ROOT_DIR="$(pwd)"

mkdir -p "$OUT_DIR"
rm -f "$OUT_DIR"/sha-*.sum "$OUT_DIR/SHA256SUMS"

archive_one() {
  local target="$1"
  local short="${target#bun-}"
  local stage="$OUT_DIR/$short"
  local bin_name="lazco"
  local archive_ext="tar.gz"

  case "$target" in
    bun-windows-*) bin_name="lazco.exe"; archive_ext="zip" ;;
  esac

  local out_bin="$stage/$bin_name"
  local archive_name="lazco-v${VERSION}-${short}.${archive_ext}"
  local archive_path="$OUT_DIR/$archive_name"

  echo "==> $target"
  rm -rf "$stage"
  mkdir -p "$stage"

  bun build --compile --minify "--target=$target" "$ENTRY" --outfile "$out_bin"

  cp LICENSE "$stage/LICENSE"
  if [[ -f README.md ]]; then
    cp README.md "$stage/README.md"
  fi

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

# Merge per-target sums in the original target order for stable output.
: > "$OUT_DIR/SHA256SUMS"
for target in $TARGETS; do
  short="${target#bun-}"
  sum_file="$OUT_DIR/sha-${short}.sum"
  [[ -f "$sum_file" ]] && cat "$sum_file" >> "$OUT_DIR/SHA256SUMS"
done
rm -f "$OUT_DIR"/sha-*.sum

echo
echo "SHA256SUMS:"
cat "$OUT_DIR/SHA256SUMS"

exit "$_FAILED"
