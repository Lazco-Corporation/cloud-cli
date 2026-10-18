#!/usr/bin/env bash
#
# install.sh - single installer for lazco across all 5 release platforms.
#
# Default mode: agent-friendly JSON on stdout, JSON error envelopes on stderr.
# `--human`: colored prose using the cli-output-style conventions.
#
# Subcommands: install | update | uninstall
#
# Pipe-bootstrap form:
#   curl -fsSL https://raw.githubusercontent.com/Lazco-Corporation/cloud-cli/main/scripts/install.sh | bash -s -- install
#
# Env:
#   LAZCO_INSTALL_DIR  install destination (default: $HOME/.local/bin)
#   LAZCO_REPO         override owner/repo (default: Lazco-Corporation/cloud-cli)
#   NO_COLOR           suppress colors in --human mode

set -euo pipefail

REPO="${LAZCO_REPO:-Lazco-Corporation/cloud-cli}"
DEFAULT_INSTALL_DIR="${LAZCO_INSTALL_DIR:-$HOME/.local/bin}"
BINARY_NAME="lazco"

ACTION=""
HUMAN=0
PIN_VERSION=""
INSTALL_DIR=""

# ── Colors / symbols (cli-output-style) ──────────────────────────────────────
# Resolved once after argv parsing so --human controls whether colors are set.
_CLI_RED=''; _CLI_GREEN=''; _CLI_YELLOW=''; _CLI_BLUE=''
_CLI_PURPLE=''; _CLI_CYAN=''; _CLI_GRAY=''; _CLI_NC=''
_CLI_CHECK='[ok]'; _CLI_CROSS='[x]'; _CLI_WARN='[!]'; _CLI_INFO='[i]'

resolve_colors() {
  if [[ "$HUMAN" -eq 1 && -t 1 && -z "${NO_COLOR:-}" ]]; then
    _CLI_RED=$'\033[0;31m'
    _CLI_GREEN=$'\033[0;32m'
    _CLI_YELLOW=$'\033[0;33m'
    _CLI_BLUE=$'\033[0;34m'
    _CLI_PURPLE=$'\033[0;35m'
    _CLI_CYAN=$'\033[0;36m'
    _CLI_GRAY=$'\033[0;90m'
    _CLI_NC=$'\033[0m'
    _CLI_CHECK="${_CLI_GREEN}[✓]${_CLI_NC}"
    _CLI_CROSS="${_CLI_RED}[✗]${_CLI_NC}"
    _CLI_WARN="${_CLI_YELLOW}[!]${_CLI_NC}"
    _CLI_INFO="${_CLI_CYAN}[i]${_CLI_NC}"
  fi
}

# Helpers always return 0 - `cond && cmd` would propagate the false branch's
# exit code under `set -e` and abort the script in default (non-human) mode.
log_info()    { if [[ "$HUMAN" -eq 1 ]]; then printf '%b %s\n' "$_CLI_INFO"  "$1" >&2; fi }
log_success() { if [[ "$HUMAN" -eq 1 ]]; then printf '%b %s\n' "$_CLI_CHECK" "$1" >&2; fi }
log_warn()    { if [[ "$HUMAN" -eq 1 ]]; then printf '%b %s\n' "$_CLI_WARN"  "$1" >&2; fi }

# ── JSON helpers ─────────────────────────────────────────────────────────────
# Minimal escaper for the values we actually emit (paths, versions, messages).
# Handles backslash, double quote, and the control chars we might produce.
json_str() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\n'/\\n}"
  s="${s//$'\r'/\\r}"
  s="${s//$'\t'/\\t}"
  printf '"%s"' "$s"
}

emit_error() {
  local code="$1" message="$2" details="${3:-}"
  if [[ "$HUMAN" -eq 1 ]]; then
    printf '%bError [%s]%b: %s\n' "$_CLI_RED" "$code" "$_CLI_NC" "$message" >&2
    [[ -n "$details" ]] && printf '%b%s%b\n' "$_CLI_GRAY" "$details" "$_CLI_NC" >&2
  else
    if [[ -n "$details" ]]; then
      printf '{"error":{"code":"%s","message":%s,"details":%s}}\n' \
        "$code" "$(json_str "$message")" "$details" >&2
    else
      printf '{"error":{"code":"%s","message":%s}}\n' \
        "$code" "$(json_str "$message")" >&2
    fi
  fi
  exit 1
}

# ── Network / archive primitives ─────────────────────────────────────────────
# `-fsL` (no `-S`): silent on success AND failure - the JSON error envelope
# our caller emits is the only stderr line agents should see in default mode.
# Auth header is added when GH_TOKEN or GITHUB_TOKEN is set, so the same
# script works on a CI host that shares the anonymous GitHub API rate limit.
auth_header() {
  local token="${GH_TOKEN:-${GITHUB_TOKEN:-}}"
  [[ -n "$token" ]] && printf 'Authorization: Bearer %s' "$token"
}

http_get() {
  local url="$1" header
  header="$(auth_header)"
  if command -v curl >/dev/null 2>&1; then
    if [[ -n "$header" ]]; then
      curl -fsL -H "$header" "$url"
    else
      curl -fsL "$url"
    fi
  elif command -v wget >/dev/null 2>&1; then
    if [[ -n "$header" ]]; then
      wget -q --header="$header" -O- "$url"
    else
      wget -qO- "$url"
    fi
  else
    emit_error "CLI_INTERNAL" "Neither curl nor wget is available"
  fi
}

download_to() {
  local url="$1" out="$2" header
  header="$(auth_header)"
  if command -v curl >/dev/null 2>&1; then
    if [[ -n "$header" ]]; then
      curl -fsL -H "$header" -o "$out" "$url"
    else
      curl -fsL -o "$out" "$url"
    fi
  elif command -v wget >/dev/null 2>&1; then
    if [[ -n "$header" ]]; then
      wget -q --header="$header" -O "$out" "$url"
    else
      wget -qO "$out" "$url"
    fi
  else
    emit_error "CLI_INTERNAL" "Neither curl nor wget is available"
  fi
}

# A fetch that reached the server and got an HTTP error (curl exit 22, wget
# exit 8) means the release or the asset is not there. Any other failure is
# the network.
fail_fetch() {
  local rc="$1" what="$2" url="$3"
  if [[ "$rc" -eq 22 || "$rc" -eq 8 ]]; then
    emit_error "CLI_BAD_RESPONSE" "Not found on the release server: $what" \
      "{\"url\":$(json_str "$url")}"
  fi
  emit_error "CLI_NETWORK" "Download failed: $what" \
    "{\"url\":$(json_str "$url"),\"exitCode\":$rc}"
}

verify_sha256() {
  local file="$1" expected="$2" actual=""
  if command -v shasum >/dev/null 2>&1; then
    actual="$(shasum -a 256 "$file" | awk '{print $1}')"
  elif command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum "$file" | awk '{print $1}')"
  else
    emit_error "CLI_INTERNAL" "No SHA256 tool available (need shasum or sha256sum)"
  fi
  if [[ "$actual" != "$expected" ]]; then
    emit_error "CLI_BAD_RESPONSE" "Checksum mismatch" \
      "{\"expected\":$(json_str "$expected"),\"actual\":$(json_str "$actual")}"
  fi
}

# ── Platform detection ───────────────────────────────────────────────────────
# Maps to the same short-target names the release archives use:
#   darwin-arm64 darwin-x64 linux-x64 linux-arm64 windows-x64
detect_platform() {
  local raw_os raw_arch os arch
  raw_os="$(uname -s)"
  raw_arch="$(uname -m)"

  case "$raw_os" in
    Darwin*)              os=darwin ;;
    Linux*)               os=linux ;;
    MINGW*|MSYS*|CYGWIN*) os=windows ;;
    *) emit_error "CLI_INVALID_INPUT" "Unsupported OS: $raw_os" \
         "{\"os\":$(json_str "$raw_os")}" ;;
  esac

  case "$raw_arch" in
    arm64|aarch64)  arch=arm64 ;;
    x86_64|amd64)   arch=x64 ;;
    *) emit_error "CLI_INVALID_INPUT" "Unsupported architecture: $raw_arch" \
         "{\"arch\":$(json_str "$raw_arch")}" ;;
  esac

  case "$os-$arch" in
    darwin-arm64|darwin-x64|linux-x64|linux-arm64|windows-x64)
      printf '%s' "$os-$arch"
      ;;
    *)
      emit_error "CLI_INVALID_INPUT" "No release target for $os-$arch" \
        "{\"platform\":\"$os-$arch\",\"supported\":[\"darwin-arm64\",\"darwin-x64\",\"linux-x64\",\"linux-arm64\",\"windows-x64\"]}"
      ;;
  esac
}

# ── Version helpers ──────────────────────────────────────────────────────────
latest_version() {
  local url="https://api.github.com/repos/$REPO/releases/latest"
  local body tag rc=0
  # Checked here because http_get runs in a subshell, where its own error would be reported twice.
  command -v curl >/dev/null 2>&1 || command -v wget >/dev/null 2>&1 \
    || emit_error "CLI_INTERNAL" "Neither curl nor wget is available"
  body="$(http_get "$url")" || rc=$?
  if [[ "$rc" -ne 0 ]]; then
    fail_fetch "$rc" "latest release of $REPO" "$url"
  fi
  # Match the first "tag_name": "vX.Y.Z" - sufficient for the GitHub schema.
  tag="$(printf '%s' "$body" \
    | grep -m1 '"tag_name"' \
    | sed -E 's/.*"tag_name"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/')"
  if [[ -z "$tag" ]]; then
    emit_error "CLI_BAD_RESPONSE" "No tag_name in latest release for $REPO"
  fi
  printf '%s' "$tag"
}

binary_filename_for() {
  local platform="$1"
  case "$platform" in
    windows-*) printf '%s' "${BINARY_NAME}.exe" ;;
    *)         printf '%s' "$BINARY_NAME" ;;
  esac
}

archive_ext_for() {
  local platform="$1"
  case "$platform" in
    windows-*) printf 'zip' ;;
    *)         printf 'tar.gz' ;;
  esac
}

current_installed_version() {
  local path="$1"
  [[ -x "$path" ]] || return 0
  # `lazco --version` prints either "X.Y.Z" or "lazco X.Y.Z"; take the last field.
  "$path" --version 2>/dev/null | head -n1 | awk '{print $NF}' || true
}

# ── Core actions ─────────────────────────────────────────────────────────────
do_install() {
  local action="${1:-install}"  # install or update - affects output payload only
  local platform tag version archive_ext archive_name base_url
  local target_dir target_path bin_in_archive
  local tmp checksum previous_version=""

  platform="$(detect_platform)"
  bin_in_archive="$(binary_filename_for "$platform")"
  archive_ext="$(archive_ext_for "$platform")"

  if [[ -n "$PIN_VERSION" ]]; then
    tag="$PIN_VERSION"
    [[ "$tag" == v* ]] || tag="v$tag"
  else
    tag="$(latest_version)"
  fi
  version="${tag#v}"

  archive_name="lazco-${tag}-${platform}.${archive_ext}"
  base_url="https://github.com/$REPO/releases/download/$tag"

  target_dir="${INSTALL_DIR:-$DEFAULT_INSTALL_DIR}"
  target_path="$target_dir/$bin_in_archive"

  if [[ -x "$target_path" ]]; then
    previous_version="$(current_installed_version "$target_path")"
  fi

  if ! mkdir -p "$target_dir" 2>/dev/null; then
    emit_error "CLI_INTERNAL" "Cannot create install directory: $target_dir" \
      "{\"dir\":$(json_str "$target_dir")}"
  fi

  tmp="$(mktemp -d)"
  # Double-quoted trap body expands $tmp now (registration time) - important
  # because `local tmp` goes out of scope before the EXIT trap fires, and
  # `set -u` would then trip over an unset variable.
  # shellcheck disable=SC2064
  trap "rm -rf '$tmp'" EXIT

  log_info "Fetching $archive_name from $base_url..."
  local rc=0
  download_to "$base_url/$archive_name" "$tmp/$archive_name" || rc=$?
  if [[ "$rc" -ne 0 ]]; then
    fail_fetch "$rc" "$archive_name" "$base_url/$archive_name"
  fi
  download_to "$base_url/SHA256SUMS" "$tmp/SHA256SUMS" || rc=$?
  if [[ "$rc" -ne 0 ]]; then
    fail_fetch "$rc" "SHA256SUMS of $tag" "$base_url/SHA256SUMS"
  fi

  checksum="$(awk -v name="$archive_name" '$2 == name || $2 == "*"name {print $1; exit}' "$tmp/SHA256SUMS")"
  if [[ -z "$checksum" ]]; then
    emit_error "CLI_BAD_RESPONSE" "Checksum entry missing for $archive_name"
  fi

  log_info "Verifying SHA256..."
  verify_sha256 "$tmp/$archive_name" "$checksum"

  log_info "Extracting..."
  case "$archive_ext" in
    tar.gz)
      tar -xzf "$tmp/$archive_name" -C "$tmp"
      ;;
    zip)
      command -v unzip >/dev/null 2>&1 \
        || emit_error "CLI_INTERNAL" "unzip is required to extract Windows archives"
      unzip -q "$tmp/$archive_name" -d "$tmp"
      ;;
  esac

  if [[ ! -f "$tmp/$bin_in_archive" ]]; then
    emit_error "CLI_BAD_RESPONSE" "Binary $bin_in_archive missing from archive"
  fi

  if ! cp "$tmp/$bin_in_archive" "$target_path" 2>/dev/null; then
    emit_error "CLI_INTERNAL" "Cannot write to $target_path" \
      "{\"path\":$(json_str "$target_path")}"
  fi
  chmod 755 "$target_path" 2>/dev/null || true

  emit_install_result "$action" "$version" "$target_path" "$platform" "$previous_version" 0
}

do_update() {
  local platform target_dir target_path bin
  local current latest_tag latest_ver

  platform="$(detect_platform)"
  bin="$(binary_filename_for "$platform")"
  target_dir="${INSTALL_DIR:-$DEFAULT_INSTALL_DIR}"
  target_path="$target_dir/$bin"

  if [[ ! -x "$target_path" ]]; then
    emit_error "CLI_INVALID_INPUT" "lazco not installed at $target_path; run install first" \
      "{\"path\":$(json_str "$target_path")}"
  fi

  current="$(current_installed_version "$target_path")"

  if [[ -n "$PIN_VERSION" ]]; then
    latest_tag="$PIN_VERSION"
    [[ "$latest_tag" == v* ]] || latest_tag="v$latest_tag"
  else
    latest_tag="$(latest_version)"
  fi
  latest_ver="${latest_tag#v}"

  if [[ -n "$current" && "$current" == "$latest_ver" ]]; then
    emit_install_result "update" "$current" "$target_path" "$platform" "$current" 1
    return
  fi

  PIN_VERSION="$latest_tag"
  do_install "update"
}

do_uninstall() {
  local platform target_dir target_path bin removed_version=""
  platform="$(detect_platform)"
  bin="$(binary_filename_for "$platform")"
  target_dir="${INSTALL_DIR:-$DEFAULT_INSTALL_DIR}"
  target_path="$target_dir/$bin"

  if [[ -e "$target_path" ]]; then
    removed_version="$(current_installed_version "$target_path")"
    if ! rm -f "$target_path" 2>/dev/null; then
      emit_error "CLI_INTERNAL" "Cannot remove $target_path" \
        "{\"path\":$(json_str "$target_path")}"
    fi
    emit_uninstall_result "$target_path" "$removed_version" 1
  else
    emit_uninstall_result "$target_path" "" 0
  fi
}

# ── Output emitters ──────────────────────────────────────────────────────────
emit_install_result() {
  local action="$1" version="$2" path="$3" platform="$4" prev="$5" noop="$6"
  local install_dir
  install_dir="$(dirname "$path")"

  if [[ "$HUMAN" -eq 1 ]]; then
    if [[ "$noop" -eq 1 ]]; then
      log_success "Already at latest version ($version)"
    else
      log_success "$action complete"
    fi
    printf '\n'
    printf '  Action:   %b%s%b\n'  "$_CLI_CYAN" "$action"   "$_CLI_NC"
    printf '  Version:  %b%s%b\n'  "$_CLI_CYAN" "$version"  "$_CLI_NC"
    printf '  Platform: %b%s%b\n'  "$_CLI_CYAN" "$platform" "$_CLI_NC"
    printf '  Path:     %b%s%b\n'  "$_CLI_BLUE" "$path"     "$_CLI_NC"
    if [[ -n "$prev" ]]; then
      printf '  Previous: %b%s%b\n' "$_CLI_GRAY" "$prev" "$_CLI_NC"
    fi
    printf '\n'
    case ":$PATH:" in
      *":$install_dir:"*) ;;
      *)
        log_warn "$install_dir is not in your PATH"
        log_info "Add: export PATH=\"$install_dir:\$PATH\""
        ;;
    esac
  else
    local prev_json="null"
    [[ -n "$prev" ]] && prev_json="$(json_str "$prev")"
    local noop_json="false"
    [[ "$noop" -eq 1 ]] && noop_json="true"
    printf '{"action":%s,"version":%s,"path":%s,"platform":%s,"previousVersion":%s,"noop":%s}\n' \
      "$(json_str "$action")" \
      "$(json_str "$version")" \
      "$(json_str "$path")" \
      "$(json_str "$platform")" \
      "$prev_json" \
      "$noop_json"
  fi
}

emit_uninstall_result() {
  local path="$1" removed_version="$2" removed="$3"
  if [[ "$HUMAN" -eq 1 ]]; then
    if [[ "$removed" -eq 1 ]]; then
      log_success "Removed $path"
      [[ -n "$removed_version" ]] && printf '  Version:  %b%s%b\n' "$_CLI_GRAY" "$removed_version" "$_CLI_NC"
    else
      log_warn "Not installed at $path"
    fi
  else
    local removed_json="false"
    [[ "$removed" -eq 1 ]] && removed_json="true"
    local ver_json="null"
    [[ -n "$removed_version" ]] && ver_json="$(json_str "$removed_version")"
    printf '{"action":"uninstall","path":%s,"removed":%s,"removedVersion":%s}\n' \
      "$(json_str "$path")" "$removed_json" "$ver_json"
  fi
}

# ── Help ─────────────────────────────────────────────────────────────────────
print_help() {
  cat <<EOF
lazco installer

USAGE
  install.sh <command> [options]

COMMANDS
  install     Download and install the latest release (or --version)
  update     Update an existing install to the latest release (or --version)
  uninstall  Remove the installed binary

OPTIONS
  --version <v>   Pin to a specific version (e.g. v0.1.0). Defaults to latest.
  --dir <path>    Install directory. Defaults to \$LAZCO_INSTALL_DIR or \$HOME/.local/bin.
  --human         Human-readable colored output. Default is JSON.
  -h, --help      Show this help.

ENV
  LAZCO_INSTALL_DIR  Default install directory.
  LAZCO_REPO         Override owner/repo (default: Lazco-Corporation/cloud-cli).
  GH_TOKEN           Optional GitHub token, for a host that hits the API rate limit.
  NO_COLOR           Suppress colors in --human mode.

OUTPUT
  Default mode emits JSON on stdout and JSON error envelopes on stderr,
  matching the lazco CLI's agent-first error contract:
    {"error":{"code":"CLI_*","message":"...","details":{}}}

EXAMPLES
  # Install latest (agent mode)
  curl -fsSL https://raw.githubusercontent.com/Lazco-Corporation/cloud-cli/main/scripts/install.sh \\
    | bash -s -- install

  # Pin a version, human output
  ./install.sh install --version v0.1.0 --human

  # Update if a newer release exists
  ./install.sh update

  # Remove
  ./install.sh uninstall
EOF
}

# ── Argv parsing ─────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    install|update|uninstall)
      if [[ -n "$ACTION" ]]; then
        emit_error "CLI_INVALID_INPUT" "Multiple commands given" \
          "{\"first\":$(json_str "$ACTION"),\"second\":$(json_str "$1")}"
      fi
      ACTION="$1"
      shift
      ;;
    --human)
      HUMAN=1
      shift
      ;;
    --version)
      [[ $# -ge 2 ]] || emit_error "CLI_INVALID_INPUT" "--version requires a value"
      PIN_VERSION="$2"
      shift 2
      ;;
    --version=*)
      PIN_VERSION="${1#*=}"
      shift
      ;;
    --dir)
      [[ $# -ge 2 ]] || emit_error "CLI_INVALID_INPUT" "--dir requires a value"
      INSTALL_DIR="$2"
      shift 2
      ;;
    --dir=*)
      INSTALL_DIR="${1#*=}"
      shift
      ;;
    -h|--help)
      print_help
      exit 0
      ;;
    *)
      emit_error "CLI_INVALID_INPUT" "Unknown argument: $1" "{\"arg\":$(json_str "$1")}"
      ;;
  esac
done

resolve_colors

if [[ -z "$ACTION" ]]; then
  emit_error "CLI_INVALID_INPUT" "Missing command" \
    '{"expected":["install","update","uninstall"]}'
fi

case "$ACTION" in
  install)   do_install "install" ;;
  update)    do_update ;;
  uninstall) do_uninstall ;;
esac
