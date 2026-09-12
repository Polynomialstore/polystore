#!/usr/bin/env bash
set -euo pipefail
ROOT=/home/mikers/polystore-bench-336-63eb7fe7-final
SRC="$ROOT/source"
HOME_DIR="$ROOT/runs/63eb7fe7-20260912T040917Z-batch64-7680-160m-1s-a16-gmp4"
EXPECTED=63eb7fe73e4933fc6b847b76bcccb883c0484dc9
export PATH=/home/mikers/.rustup/toolchains/stable-x86_64-unknown-linux-gnu/bin:/home/mikers/.local/toolchains/go1.25.5/go/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export LD_LIBRARY_PATH="$SRC/polystore_core/target/release${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
test "$(git -C "$SRC" rev-parse HEAD)" = "$EXPECTED"
test -z "$(git -C "$SRC" status --porcelain)"
test ! -e "$HOME_DIR"
cd "$SRC"
python3 scripts/retrieval_four_validator_workload.py \
  --binary "$ROOT/build/bin/polystorechaind" \
  --library "$SRC/polystore_core/target/release/libpolystore_core.so" \
  --home "$HOME_DIR" \
  --gateway-binary "$ROOT/build/bin/polystore_gateway" \
  --cli-binary "$ROOT/build/bin/polystore_cli" \
  --product-source "$SRC" \
  --proof-exporter "$ROOT/build/bin/retrieval_inventory_exporter" \
  --build-manifest "$ROOT/build/build-manifest.json" \
  --mode native-v3-chain \
  --audit-profile normal \
  --timeout 3600 \
  --chain-max-gas 160000000 \
  --chain-capacity-profile 1kib \
  --chain-capacity-sessions 7680 \
  --chain-proof-submission-mode batch-message \
  --chain-proof-batch-size 64 \
  --chain-proof-gas-adjustment 1.6 \
  --chain-timeout-commit-ms 1000 \
  --chain-validator-gomaxprocs 4
