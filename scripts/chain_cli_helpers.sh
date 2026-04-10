#!/usr/bin/env bash

# Shared helpers for shell scripts that need to speak to the chain CLI while the
# public protocol name and the binary's internal module namespace may differ.

detect_chain_module_cli_name() {
  local binary="${1:?binary path required}"
  local cache_var="${2:-CHAIN_MODULE_CLI_NAME}"
  local cached="${!cache_var:-}"

  if [ -n "$cached" ]; then
    printf '%s\n' "$cached"
    return 0
  fi

  local candidate help_out
  for candidate in polystorechain nilchain; do
    help_out="$("$binary" tx "$candidate" --help 2>/dev/null || true)"
    if printf '%s' "$help_out" | grep -Eq "tx ${candidate}( |$)|${candidate} transactions subcommands"; then
      printf -v "$cache_var" '%s' "$candidate"
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  echo "ERROR: failed to detect polystore module CLI namespace for $binary" >&2
  return 1
}
