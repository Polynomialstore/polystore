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

compute_retrieval_session_id_hex() {
  local chain_dir="${1:?chain dir required}"
  local owner="${2:?owner required}"
  local deal_id="${3:?deal id required}"
  local provider="${4:?provider required}"
  local manifest_root="${5:?manifest root required}"
  local start_mdu_index="${6:?start mdu index required}"
  local start_blob_index="${7:?start blob index required}"
  local blob_count="${8:?blob count required}"
  local nonce="${9:?nonce required}"
  local expires_at="${10:?expires_at required}"

  (
    cd "$chain_dir"
    go run ./tools/compute_retrieval_session_id \
      --owner "$owner" \
      --deal-id "$deal_id" \
      --provider "$provider" \
      --manifest-root "$manifest_root" \
      --start-mdu-index "$start_mdu_index" \
      --start-blob-index "$start_blob_index" \
      --blob-count "$blob_count" \
      --nonce "$nonce" \
      --expires-at "$expires_at"
  )
}
