#!/usr/bin/env bash
set -euo pipefail

# Generates an assets bundle for the oracle agents-file writer prompt.
# Output format: one fenced block per file/excerpt, where the fence label is the filename.

OUT_FILE="${1:-oracle_agents_assets.md}"

append_full() {
  local label="$1"
  local file="$2"
  if [[ ! -f "$file" ]]; then
    echo "missing file: $file" >&2
    exit 1
  fi
  printf '```%s\n' "$label" >>"$OUT_FILE"
  cat "$file" >>"$OUT_FILE"
  printf '\n```\n\n' >>"$OUT_FILE"
}

append_excerpt() {
  local label="$1"
  local file="$2"
  local start="$3"
  local end="$4"
  if [[ ! -f "$file" ]]; then
    echo "missing file: $file" >&2
    exit 1
  fi
  printf '```%s\n' "$label" >>"$OUT_FILE"
  sed -n "${start},${end}p" "$file" >>"$OUT_FILE"
  printf '\n```\n\n' >>"$OUT_FILE"
}

: >"$OUT_FILE"

# Repo agent rules (excerpt only).
append_excerpt "AGENTS.md (excerpt: git protocol)" "AGENTS.md" 1 20

# Main planning docs (full).
append_full "MAINNET_ECON_PARITY_CHECKLIST.md" "MAINNET_ECON_PARITY_CHECKLIST.md"
append_full "MAINNET_GAP_TRACKER.md" "MAINNET_GAP_TRACKER.md"
append_full "notes/mainnet_policy_resolution_jan2026.md" "notes/mainnet_policy_resolution_jan2026.md"

# Key RFCs (full).
append_full "rfcs/rfc-pricing-and-escrow-accounting.md" "rfcs/rfc-pricing-and-escrow-accounting.md"
append_full "rfcs/rfc-challenge-derivation-and-quotas.md" "rfcs/rfc-challenge-derivation-and-quotas.md"
append_full "rfcs/rfc-mode2-onchain-state.md" "rfcs/rfc-mode2-onchain-state.md"

# Chain params definition (full).
append_full "nilchain/proto/nilchain/nilchain/v1/params.proto" "nilchain/proto/nilchain/nilchain/v1/params.proto"

# Devnet + CI gates (excerpts/full).
append_excerpt "scripts/run_devnet_alpha_multi_sp.sh (usage excerpt)" "scripts/run_devnet_alpha_multi_sp.sh" 1 60
append_excerpt "scripts/run_devnet_alpha_multi_sp.sh (param override excerpt)" "scripts/run_devnet_alpha_multi_sp.sh" 260 320
append_full "scripts/ci_e2e_gateway_retrieval_multi_sp.sh" "scripts/ci_e2e_gateway_retrieval_multi_sp.sh"
append_full "scripts/e2e_gateway_retrieval_multi_sp.sh" "scripts/e2e_gateway_retrieval_multi_sp.sh"

# Local stack + lifecycle e2e (excerpts).
append_excerpt "scripts/run_local_stack.sh (usage excerpt)" "scripts/run_local_stack.sh" 1 60
append_excerpt "scripts/e2e_lifecycle.sh (header excerpt)" "scripts/e2e_lifecycle.sh" 1 140

echo "wrote $OUT_FILE"

