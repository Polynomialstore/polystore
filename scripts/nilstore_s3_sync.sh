#!/usr/bin/env bash
set -euo pipefail

#
# Fast mirror helper using aws-cli against NilGateway's path-style S3 surface.
#
# Examples:
#   # Upload a directory into deal #0 (bucket deal-0)
#   ./scripts/nilstore_s3_sync.sh upload 0 ./mydir
#
#   # Download entire deal #0 to ./out
#   ./scripts/nilstore_s3_sync.sh download 0 ./out
#

MODE="${1:-}"
DEAL_ID="${2:-}"
PATH_ARG="${3:-}"

if [[ -z "${MODE}" || -z "${DEAL_ID}" || -z "${PATH_ARG}" ]]; then
  echo "usage: $0 <upload|download> <deal_id> <path>" >&2
  exit 1
fi

ENDPOINT_URL="${NILSTORE_S3_ENDPOINT:-http://localhost:8080}"
BUCKET="deal-${DEAL_ID}"

if ! command -v aws >/dev/null 2>&1; then
  echo "error: aws-cli not found. Install aws-cli or use curl against ${ENDPOINT_URL}." >&2
  exit 1
fi

# aws-cli typically signs requests; NilGateway ignores auth headers for devnet.
export AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-test}"
export AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-test}"
export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-us-east-1}"

if [[ "${MODE}" == "upload" ]]; then
  if [[ ! -d "${PATH_ARG}" ]]; then
    echo "error: upload path must be a directory: ${PATH_ARG}" >&2
    exit 1
  fi
  aws --endpoint-url "${ENDPOINT_URL}" s3 sync "${PATH_ARG}" "s3://${BUCKET}/"
  exit 0
fi

if [[ "${MODE}" == "download" ]]; then
  mkdir -p "${PATH_ARG}"
  aws --endpoint-url "${ENDPOINT_URL}" s3 sync "s3://${BUCKET}/" "${PATH_ARG}"
  exit 0
fi

echo "error: unknown mode: ${MODE}" >&2
exit 1

