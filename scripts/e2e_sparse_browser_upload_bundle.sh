#!/usr/bin/env bash
# Browser sparse upload smoke with provider bundle uploads enabled.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

export SPARSE_BUNDLE_UPLOADS=1
export SPARSE_FILE_SIZE_BYTES="${SPARSE_FILE_SIZE_BYTES:-196608}"

"$ROOT_DIR/scripts/e2e_browser_smoke_no_gateway.sh"
