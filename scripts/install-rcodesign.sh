#!/usr/bin/env bash
#
# Install rcodesign on a linux-x64 CI runner, so build-binaries.sh can give the
# macOS binaries an ad-hoc signature there. `bun build --compile` leaves the
# darwin-x64 binary with Bun's own signature, which no longer matches the
# file, and macOS then refuses it the keychain.
#
# Usage: scripts/install-rcodesign.sh <directory to put rcodesign in>

set -euo pipefail

VERSION="0.29.0"
SHA256="dbe85cedd8ee4217b64e9a0e4c2aef92ab8bcaaa41f20bde99781ff02e600002"
NAME="apple-codesign-${VERSION}-x86_64-unknown-linux-musl"

target_dir="${1:?usage: scripts/install-rcodesign.sh <directory>}"
download_dir="$(mktemp -d)"
trap 'rm -rf "$download_dir"' EXIT

curl -fsSL -o "$download_dir/$NAME.tar.gz" \
  "https://github.com/indygreg/apple-platform-rs/releases/download/apple-codesign%2F${VERSION}/${NAME}.tar.gz"
echo "${SHA256}  $download_dir/$NAME.tar.gz" | sha256sum -c - >/dev/null
tar -xzf "$download_dir/$NAME.tar.gz" -C "$download_dir"
mkdir -p "$target_dir"
install -m 0755 "$download_dir/$NAME/rcodesign" "$target_dir/rcodesign"
"$target_dir/rcodesign" --version
