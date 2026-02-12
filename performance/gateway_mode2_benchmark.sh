#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: ./performance/gateway_mode2_benchmark.sh [options]

Options:
  --sizes "MB1,MB2,..."     Comma-separated payload sizes in MiB (default: 64,128,256)
  --iterations N             Number of runs per size (default: 1)
  --gateway URL              Gateway URL (default: http://localhost:8080)
  --chain-id ID              Chain ID for chain query (default: test-1)
  --chain-home PATH          nilchaind home used by CLI queries (default: ../_artifacts/nilchain_data)
  --chain-node URL           Chain RPC node (default: tcp://127.0.0.1:26657)
  --creator ADDRESS          Optional deal creator for /gateway/create-deal
  --service-hint HINT        Mode 2 service hint, e.g. "General:rs=8+4" (default)
  --iterations-out PATH      Output directory for artifacts (default: .artifacts/gateway_mode2_benchmark)
  --output-prefix PREFIX     Output file name prefix (default: mode2-bench)
  --upload-timeout-seconds N Timeout for each upload call in seconds (default: 1800)
  --chain-binary PATH        Path to nilchaind binary (default: nilchaind)
  --poll-status              Poll /gateway/upload-status for each upload
  --help                     Show this help

Environment:
  GATEWAY_MODE2_BENCH_SIZES
  GATEWAY_MODE2_BENCH_ITERATIONS
  GATEWAY_MODE2_BENCH_OUTPUT_DIR
  GATEWAY_MODE2_BENCH_PREFIX
  GATEWAY_MODE2_BENCH_DURATION
  GATEWAY_MODE2_BENCH_ESCROW
  GATEWAY_MODE2_BENCH_MAX_MONTHLY_SPEND
  GATEWAY_MODE2_BENCH_UPLOAD_TIMEOUT_SECONDS
  GATEWAY_MODE2_BENCH_SERVICE_HINT
  GATEWAY_MODE2_BENCH_CHAIN_WAIT_SECONDS
  GATEWAY_MODE2_BENCH_STATUS_POLL_SECONDS
  NILCHAIN_BIN
  NILCHAIND_BIN
  NIL_GATEWAY_URL
  GATEWAY_URL
  CHAIN_ID
  CHAIN_HOME
  NILCHAIN_HOME
  NILCHAIN_NODE
EOF
}

require_cmd() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "ERROR: required command not found: $cmd" >&2
    exit 1
  fi
}

require_cmd curl
require_cmd jq
require_cmd dd
require_cmd awk
require_cmd tr

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RUN_ID="$(date +%s)-$$"
RUN_STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

sizes_csv="${GATEWAY_MODE2_BENCH_SIZES:-64,128,256}"
iterations="${GATEWAY_MODE2_BENCH_ITERATIONS:-1}"
gateway_url="${NIL_GATEWAY_URL:-${GATEWAY_URL:-http://localhost:8080}}"
chain_id="${CHAIN_ID:-test-1}"
chain_home="${NILCHAIN_HOME:-${CHAIN_HOME:-../_artifacts/nilchain_data}}"
chain_node="${NILCHAIN_NODE:-tcp://127.0.0.1:26657}"
chain_bin="${NILCHAIND_BIN:-${NILCHAIN_BIN:-nilchaind}}"
service_hint="${GATEWAY_MODE2_BENCH_SERVICE_HINT:-General:rs=8+4}"
chain_duration="${GATEWAY_MODE2_BENCH_DURATION:-1000}"
chain_escrow="${GATEWAY_MODE2_BENCH_ESCROW:-1000000}"
chain_max_monthly="${GATEWAY_MODE2_BENCH_MAX_MONTHLY_SPEND:-1000000}"
upload_timeout="${GATEWAY_MODE2_BENCH_UPLOAD_TIMEOUT_SECONDS:-1800}"
iterations_out="${GATEWAY_MODE2_BENCH_OUTPUT_DIR:-$REPO_ROOT/.artifacts/gateway_mode2_benchmark}"
output_prefix="${GATEWAY_MODE2_BENCH_PREFIX:-mode2-bench}"
creator="${DEAL_CREATOR:-}"
chain_wait_seconds="${GATEWAY_MODE2_BENCH_CHAIN_WAIT_SECONDS:-2}"
status_poll_interval="${GATEWAY_MODE2_BENCH_STATUS_POLL_SECONDS:-1}"
poll_status="0"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --sizes)
      sizes_csv="$2"
      shift 2
      ;;
    --iterations)
      iterations="$2"
      shift 2
      ;;
    --gateway)
      gateway_url="$2"
      shift 2
      ;;
    --chain-id)
      chain_id="$2"
      shift 2
      ;;
    --chain-home)
      chain_home="$2"
      shift 2
      ;;
    --chain-node)
      chain_node="$2"
      shift 2
      ;;
    --creator)
      creator="$2"
      shift 2
      ;;
    --service-hint)
      service_hint="$2"
      shift 2
      ;;
    --iterations-out)
      iterations_out="$2"
      shift 2
      ;;
    --output-prefix)
      output_prefix="$2"
      shift 2
      ;;
    --upload-timeout-seconds)
      upload_timeout="$2"
      shift 2
      ;;
    --chain-binary)
      chain_bin="$2"
      shift 2
      ;;
    --poll-status)
      poll_status=1
      shift
      ;;
    --help)
      usage
      exit 0
      ;;
    *)
      echo "ERROR: unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
done

if ! [[ "$iterations" =~ ^[0-9]+$ ]] || [[ "$iterations" -le 0 ]]; then
  echo "ERROR: --iterations must be a positive integer" >&2
  exit 1
fi

if ! [[ "$chain_duration" =~ ^[0-9]+$ ]] || [[ "$chain_duration" -le 0 ]]; then
  echo "ERROR: GATEWAY_MODE2_BENCH_DURATION must be a positive integer" >&2
  exit 1
fi

if ! [[ "$chain_wait_seconds" =~ ^[0-9]+$ ]] || [[ "$chain_wait_seconds" -le 0 ]]; then
  echo "ERROR: GATEWAY_MODE2_BENCH_CHAIN_WAIT_SECONDS must be a positive integer" >&2
  exit 1
fi

IFS=',' read -r -a sizes <<< "$(echo "$sizes_csv" | tr -d ' ')"
if [[ "${#sizes[@]}" -eq 0 ]]; then
  echo "ERROR: no benchmark sizes configured" >&2
  exit 1
fi

for size in "${sizes[@]}"; do
  if ! [[ "$size" =~ ^[0-9]+$ ]] || [[ "$size" -le 0 ]]; then
    echo "ERROR: invalid size '${size}' in --sizes" >&2
    exit 1
  fi
done

require_cmd "$chain_bin"

mkdir -p "$iterations_out"
work_dir="$(mktemp -d "$iterations_out/.tmp.$output_prefix.$RUN_ID.XXXX")"
trap 'rm -rf "$work_dir"' EXIT

csv_path="$iterations_out/${output_prefix}-${RUN_ID}.csv"
jsonl_path="$iterations_out/${output_prefix}-${RUN_ID}.jsonl"
summary_path="$iterations_out/${output_prefix}-${RUN_ID}.summary.json"

cat > "$csv_path" <<CSV
run_id,run_started_at,size_mb,iteration,deal_id,upload_id,cid,wire_bytes,logical_bytes,total_ms,mode2_encode_user_mdus_ms,mode2_build_witness_mdus_ms,mode2_build_manifest_ms,mode2_finalize_dir_ms,mode2_resolve_slots_ms,mode2_resolve_provider_endpoints_ms,mode2_build_upload_tasks_ms,mode2_upload_requests_ms,mode2_upload_parallelism,mode2_upload_retries,mode2_upload_tasks_total,mode2_upload_tasks_metadata,mode2_upload_tasks_shards,mode2_upload_target_count,mode2_user_mdus,mode2_witness_mdus,mode2_remote_providers_targeted,mode2_slots_targeted,throughput_mib_s
CSV

total_runs=0
sum_ms=0
sum_throughput=0

get_metric_or_zero() {
  local raw_json="$1"
  local expr="$2"
  local v
  v="$(jq -r "$expr // 0" <<<"$raw_json")"
  if [[ -z "$v" || "$v" == "null" ]]; then
    echo "0"
  else
    echo "$v"
  fi
}

create_mode2_deal() {
  local payload
  if [[ -n "$creator" ]]; then
    payload="$(jq -nc --arg duration "$chain_duration" \
      --arg hint "$service_hint" \
      --arg escrow "$chain_escrow" \
      --arg max "$chain_max_monthly" \
      --arg creator "$creator" \
      '{
        "duration_blocks": ($duration|tonumber),
        "service_hint": $hint,
        "initial_escrow": $escrow,
        "max_monthly_spend": $max,
        "creator": $creator
      }')"
  else
    payload="$(jq -nc --arg duration "$chain_duration" \
      --arg hint "$service_hint" \
      --arg escrow "$chain_escrow" \
      --arg max "$chain_max_monthly" \
      '{
        "duration_blocks": ($duration|tonumber),
        "service_hint": $hint,
        "initial_escrow": $escrow,
        "max_monthly_spend": $max
      }')"
  fi

  local response
  if ! response="$(curl -sS --max-time 120 -H 'Content-Type: application/json' -X POST "$gateway_url/gateway/create-deal" -d "$payload")"; then
    return 1
  fi

  local tx_hash
  tx_hash="$(jq -r '.tx_hash // empty' <<<"$response")"
  if [[ -z "$tx_hash" || "$tx_hash" == "null" ]]; then
    echo "ERROR: create-deal failed: $response" >&2
    return 1
  fi
  echo "$tx_hash"
}

list_last_deal_id() {
  local out
  if ! out="$("$chain_bin" --home "$chain_home" query nilchain list-deals --chain-id "$chain_id" --node "$chain_node" --output json 2>/dev/null)"; then
    return 1
  fi
  jq -r '.deals[-1].id // .deals[-1].deal_id // empty' <<<"$out"
}

wait_for_new_deal_id() {
  local previous_id="$1"
  local attempts=30
  local current_id

  for _ in $(seq 1 "$attempts"); do
    current_id="$(list_last_deal_id || true)"
    if [[ -n "$current_id" && "$current_id" != "null" ]]; then
      if [[ -z "$previous_id" ]]; then
        echo "$current_id"
        return 0
      fi
      if [[ "$current_id" =~ ^[0-9]+$ && "$previous_id" =~ ^[0-9]+$ && "$current_id" -gt "$previous_id" ]]; then
        echo "$current_id"
        return 0
      fi
    fi
    sleep "$chain_wait_seconds"
  done
  return 1
}

upload_payload() {
  local deal_id="$1"
  local file_path="$2"
  local upload_id="$3"
  local file_name
  file_name="$(basename "$file_path")"

  local url="$gateway_url/gateway/upload?deal_id=$deal_id&upload_id=$upload_id"
  local response
  if ! response="$(curl -sS --max-time "$upload_timeout" \
    -X POST \
    -F "deal_id=$deal_id" \
    -F "upload_id=$upload_id" \
    -F "file=@${file_path};filename=$file_name" \
    "$url")"; then
    return 1
  fi
  echo "$response"
}

poll_upload_status() {
  local deal_id="$1"
  local upload_id="$2"
  local attempts=120
  for _ in $(seq 1 "$attempts"); do
    local status_resp
    if status_resp="$(curl -sS --max-time 30 "$gateway_url/gateway/upload-status?deal_id=$deal_id&upload_id=$upload_id" 2>/dev/null)"; then
      local status
      status="$(jq -r '.status // empty' <<<"$status_resp")"
      if [[ "$status" == "success" || "$status" == "error" ]]; then
        return 0
      fi
    fi
    sleep "$status_poll_interval"
  done
  return 1
}

count_dynamic_upload_targets() {
  local raw_json="$1"
  jq -r '[.profile_ms // {} | keys[] | select(startswith("mode2_upload_target_") and endswith("_ms"))] | length // 0' <<<"$raw_json"
}

total_runs=0
for size in "${sizes[@]}"; do
  payload_file="$work_dir/payload_${size}MiB.bin"
  dd if=/dev/urandom of="$payload_file" bs=1M count="$size" status=none

  for iteration in $(seq 1 "$iterations"); do
    echo "[$RUN_ID] size=${size}MiB iteration=${iteration}"
    total_runs=$((total_runs + 1))

    before_deal_id="$(list_last_deal_id || true)"
    if ! tx_hash="$(create_mode2_deal)"; then
      echo "ERROR: create-deal request failed" >&2
      exit 1
    fi
    if ! deal_id="$(wait_for_new_deal_id "$before_deal_id")"; then
      echo "ERROR: could not resolve deal id after tx $tx_hash" >&2
      exit 1
    fi

    upload_id="${RUN_ID}-${size}-${iteration}"
    if ! response="$(upload_payload "$deal_id" "$payload_file" "$upload_id")"; then
      echo "ERROR: upload failed for size=${size}MiB iteration=${iteration}" >&2
      exit 1
    fi

    if [[ "$poll_status" == "1" ]]; then
      poll_upload_status "$deal_id" "$upload_id" || true
    fi

    if ! jq -e '.profile_ms // empty' <<<"$response" >/dev/null; then
      echo "ERROR: upload response is missing profile_ms for validation" >&2
      exit 1
    fi

    file_label="${size}MiB#${iteration}"

    cid="$(jq -r '.manifest_root // .cid // empty' <<<"$response")"
    wire_bytes="$(get_metric_or_zero "$response" '.file_size_bytes')"
    logical_bytes="$(get_metric_or_zero "$response" '.logical_size_bytes')"
    total_ms="$(get_metric_or_zero "$response" '.profile_ms.gateway_total_ms')"
    encode_ms="$(get_metric_or_zero "$response" '.profile_ms.mode2_encode_user_mdus_ms')"
    witness_ms="$(get_metric_or_zero "$response" '.profile_ms.mode2_build_witness_mdus_ms')"
    manifest_ms="$(get_metric_or_zero "$response" '.profile_ms.mode2_build_manifest_ms')"
    finalize_ms="$(get_metric_or_zero "$response" '.profile_ms.mode2_finalize_dir_ms')"
    resolve_slots_ms="$(get_metric_or_zero "$response" '.profile_ms.mode2_resolve_slots_ms')"
    resolve_provider_ms="$(get_metric_or_zero "$response" '.profile_ms.mode2_resolve_provider_endpoints_ms')"
    build_upload_tasks_ms="$(get_metric_or_zero "$response" '.profile_ms.mode2_build_upload_tasks_ms')"
    upload_requests_ms="$(get_metric_or_zero "$response" '.profile_ms.mode2_upload_requests_ms')"
    upload_parallelism="$(get_metric_or_zero "$response" '.profile_counts.mode2_upload_parallelism')"
    upload_retries="$(get_metric_or_zero "$response" '.profile_counts.mode2_upload_retries')"
    upload_tasks_total="$(get_metric_or_zero "$response" '.profile_counts.mode2_upload_tasks_total')"
    upload_tasks_metadata="$(get_metric_or_zero "$response" '.profile_counts.mode2_upload_tasks_metadata')"
    upload_tasks_shards="$(get_metric_or_zero "$response" '.profile_counts.mode2_upload_tasks_shards')"
    user_mdus="$(get_metric_or_zero "$response" '.profile_counts.mode2_user_mdus')"
    witness_mdus="$(get_metric_or_zero "$response" '.profile_counts.mode2_witness_mdus')"
    remote_providers="$(get_metric_or_zero "$response" '.profile_counts.mode2_remote_providers_targeted')"
    slots_targeted="$(get_metric_or_zero "$response" '.profile_counts.mode2_slots_targeted')"
    target_count="$(count_dynamic_upload_targets "$response")"

    throughput_mib_s="$(awk -v bytes="$wire_bytes" -v ms="$total_ms" 'BEGIN { if (ms <= 0) { print "0" } else { printf "%.6f", bytes / (1024*1024) / (ms / 1000) } }')"

    sum_ms=$((sum_ms + total_ms))
    sum_throughput="$(awk -v a="$sum_throughput" -v b="$throughput_mib_s" 'BEGIN { printf "%.6f", a + b }')"

    printf '%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s\n' \
      "$RUN_ID" \
      "$RUN_STARTED_AT" \
      "$size" \
      "$iteration" \
      "$deal_id" \
      "$upload_id" \
      "$cid" \
      "$wire_bytes" \
      "$logical_bytes" \
      "$total_ms" \
      "$encode_ms" \
      "$witness_ms" \
      "$manifest_ms" \
      "$finalize_ms" \
      "$resolve_slots_ms" \
      "$resolve_provider_ms" \
      "$build_upload_tasks_ms" \
      "$upload_requests_ms" \
      "$upload_parallelism" \
      "$upload_retries" \
      "$upload_tasks_total" \
      "$upload_tasks_metadata" \
      "$upload_tasks_shards" \
      "$target_count" \
      "$user_mdus" \
      "$witness_mdus" \
      "$remote_providers" \
      "$slots_targeted" \
      "$throughput_mib_s" \
      >> "$csv_path"

    {
      jq -c \
        --arg run_id "$RUN_ID" \
        --arg run_started_at "$RUN_STARTED_AT" \
        --arg size_mb "$size" \
        --arg iteration "$iteration" \
        --arg deal_id "$deal_id" \
        --arg upload_id "$upload_id" \
        --arg label "$file_label" \
        --arg wire_bytes "$wire_bytes" \
        --arg logical_bytes "$logical_bytes" \
        --arg total_ms "$total_ms" \
        --arg throughput "$throughput_mib_s" \
        '. + {
          run_id: $run_id,
          run_started_at: $run_started_at,
          size_mb: ($size_mb|tonumber),
          iteration: ($iteration|tonumber),
          deal_id: $deal_id,
          upload_id: $upload_id,
          label: $label,
          wire_bytes: ($wire_bytes|tonumber),
          logical_bytes: ($logical_bytes|tonumber),
          total_ms: ($total_ms|tonumber),
          throughput_mib_s: ($throughput|tonumber)
        }' <<< "$response"
    } >> "$jsonl_path"

    echo "  deal=$deal_id cid=${cid:-none} wire=${wire_bytes}B total=${total_ms}ms throughput=${throughput_mib_s}MiB/s retries=${upload_retries}"
  done
done

avg_ms=0
if [[ "$total_runs" -gt 0 ]]; then
  avg_ms="$(awk -v sum="$sum_ms" -v n="$total_runs" 'BEGIN { printf "%.2f", sum / n }')"
fi

cat > "$summary_path" <<SUMMARY
{
  "run_id": "$RUN_ID",
  "run_started_at": "$RUN_STARTED_AT",
  "sizes_mib": [$(printf '"%s",' "${sizes[@]}" | sed 's/,$//')],
  "iterations_per_size": $iterations,
  "total_runs": $total_runs,
  "gateway_url": "$gateway_url",
  "service_hint": "$service_hint",
  "chain_id": "$chain_id",
  "output_csv": "$(basename "$csv_path")",
  "output_jsonl": "$(basename "$jsonl_path")",
  "sum_ms": $sum_ms,
  "avg_ms": $avg_ms,
  "sum_throughput_mib_s": $sum_throughput
}
SUMMARY

echo "Gateway Mode 2 benchmark complete."
echo "Runs: $total_runs"
echo "CSV:  $csv_path"
echo "JSONL: $jsonl_path"
echo "Summary: $summary_path"
