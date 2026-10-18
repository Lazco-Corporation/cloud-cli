#!/usr/bin/env bash
# Point git at .githooks and check that every tool the hooks call is installed.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

missing=()
for tool in bun git gitleaks; do
  if command -v "$tool" >/dev/null 2>&1; then
    printf '[ok] %s\n' "$tool"
  else
    printf '[x] %s not found\n' "$tool" >&2
    missing+=("$tool")
  fi
done

if ! bunx biome --version >/dev/null 2>&1; then
  printf '[x] biome not found. Run bun install first.\n' >&2
  missing+=("biome")
fi

if [[ ${#missing[@]} -gt 0 ]]; then
  printf 'Install %s, then run scripts/setup-hooks.sh again.\n' "${missing[*]}" >&2
  exit 1
fi

git config core.hooksPath .githooks
chmod +x .githooks/*
printf '[ok] core.hooksPath is .githooks (pre-commit: gitleaks and Biome, pre-push: gitleaks, check, type check, unit tests)\n'
