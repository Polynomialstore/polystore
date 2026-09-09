#!/usr/bin/env bash
set -euo pipefail

if [[ "${GITHUB_ACTIONS:-}" != "true" || "${RUNNER_OS:-}" != "Linux" ]]; then
  echo "This helper is only for Linux GitHub Actions runners." >&2
  exit 1
fi

# GitHub's Ubuntu image preinstalls Google Chrome and its apt source. Playwright
# downloads Chromium itself, and the Tauri build only needs Ubuntu packages, so
# neither job should depend on the unrelated Chrome repository being consistent.
sources_dir="${APT_SOURCES_DIR:-/etc/apt/sources.list.d}"
for source in \
  "$sources_dir/google-chrome.list" \
  "$sources_dir/google-chrome.sources"
do
  if [[ -f "$source" ]]; then
    sudo mv -- "$source" "$source.disabled"
  fi
done
