#!/usr/bin/env bash
set -euo pipefail

OUT_FILE="${1:-assets_for_prompt.md}"

files=(
  "MAINNET_GAP_TRACKER.md"
  "MAINNET_ECON_PARITY_CHECKLIST.md"
  "notes/mainnet_policy_resolution_jan2026.md"
  "ECONOMY.md"
  "retrievability-memo.md"
  "rfcs/rfc-pricing-and-escrow-accounting.md"
  "rfcs/rfc-challenge-derivation-and-quotas.md"
  "rfcs/rfc-mode2-onchain-state.md"
  "rfcs/rfc-retrieval-validation.md"
  "rfcs/rfc-retrieval-security.md"
  "rfcs/rfc-heat-and-dynamic-placement.md"
)

: > "$OUT_FILE"
for file in "${files[@]}"; do
  if [[ ! -f "$file" ]]; then
    echo "missing file: $file" >&2
    exit 1
  fi
  base="$(basename "$file")"
  printf '```%s\n' "$base" >> "$OUT_FILE"
  cat "$file" >> "$OUT_FILE"
  printf '\n```\n\n' >> "$OUT_FILE"
done

echo "wrote $OUT_FILE"

