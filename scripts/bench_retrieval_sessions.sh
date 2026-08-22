#!/usr/bin/env bash
# bench_retrieval_sessions.sh — deterministic single-node retrieval-session
# throughput/load driver (issue #245).
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHAIN_DIR="$ROOT_DIR/polystorechain"
CORE_DIR="$ROOT_DIR/polystore_core"
BIN="$CHAIN_DIR/polystorechaind"
MODULE_CLI="${POLYSTORE_CHAIN_MODULE_CLI_NAME:-nilchain}"

SESSIONS="${POLYSTORE_BENCH_SESSIONS:-5}"
RATE="${POLYSTORE_BENCH_RATE:-5}"
PROOFS_PER_SESSION="${POLYSTORE_BENCH_PROOFS_PER_SESSION:-0}"
PROOFS_DIR="${POLYSTORE_BENCH_PROOFS_DIR:-}"
OUTPUT="${POLYSTORE_BENCH_OUTPUT:-$ROOT_DIR/bench_results_retrieval_sessions.json}"
CHAIN_HOME="${POLYSTORE_BENCH_HOME:-$ROOT_DIR/_artifacts/bench_retrieval_sessions_data}"
CHAIN_ID="${CHAIN_ID:-31337}"
RPC_ADDR="${RPC_ADDR:-tcp://127.0.0.1:26658}"
P2P_ADDR="${P2P_ADDR:-tcp://127.0.0.1:26659}"
RPC_HOST_PORT="${RPC_ADDR#*://}"
LCD="http://$RPC_HOST_PORT"
DENOM="${POLYSTORE_DENOM:-stake}"
GAS_PRICE="${POLYSTORE_GAS_PRICES:-0.001aatom}"
CORE_LIB_DIR="${POLYSTORE_CORE_LIB_DIR:-$CORE_DIR/target/release}"
KEEP_HOME=0
[ "${1:-}" = "--keep-home" ] && KEEP_HOME=1

log()  { printf '[bench-sessions] %s\n' "$*"; }
fail() { printf '[bench-sessions] ERROR: %s\n' "$*" >&2; exit 1; }
require_cmd() { command -v "$1" >/dev/null 2>&1 || fail "missing '$1'; install it and rerun"; }

require_cmd cargo
require_cmd go
require_cmd curl
require_cmd python3
[[ "$SESSIONS" =~ ^[0-9]+$ && "$SESSIONS" -gt 0 ]] || fail "POLYSTORE_BENCH_SESSIONS must be a positive integer"
[[ "$RATE" =~ ^[0-9]+$ && "$RATE" -gt 0 ]] || fail "POLYSTORE_BENCH_RATE must be a positive integer"
[[ "$PROOFS_PER_SESSION" =~ ^[0-9]+$ ]] || fail "POLYSTORE_BENCH_PROOFS_PER_SESSION must be a non-negative integer"
if [ "$PROOFS_PER_SESSION" -gt 0 ] && [ -z "$PROOFS_DIR" ]; then
  fail "POLYSTORE_BENCH_PROOFS_PER_SESSION=$PROOFS_PER_SESSION requires POLYSTORE_BENCH_PROOFS_DIR with <session-index>.json payloads"
fi

CORE_LIB="$CORE_LIB_DIR/libpolystore_core.so"
if [ ! -f "$CORE_LIB" ]; then
  log "libpolystore_core.so missing; building polystore_core"
  (cd "$CORE_DIR" && cargo build --release) || fail "cargo build --release failed; build $CORE_LIB manually and rerun"
fi
[ -f "$CORE_LIB" ] || fail "missing $CORE_LIB after cargo build --release; run (cd $CORE_DIR && cargo build --release)"
export LD_LIBRARY_PATH="$CORE_LIB_DIR${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
export CGO_LDFLAGS="-L$CORE_LIB_DIR -lpolystore_core${CGO_LDFLAGS:+ $CGO_LDFLAGS}"

if [ ! -x "$BIN" ]; then
  log "building polystorechaind"
  (cd "$CHAIN_DIR" && go build -o "$BIN" ./cmd/polystorechaind) || fail "chain build failed; run (cd $CHAIN_DIR && go build -o $BIN ./cmd/polystorechaind)"
fi

NODE_PID=""
cleanup() {
  if [ -n "$NODE_PID" ] && kill -0 "$NODE_PID" 2>/dev/null; then
    log "stopping node pid $NODE_PID"
    kill "$NODE_PID" 2>/dev/null || true
    for _ in $(seq 1 10); do
      kill -0 "$NODE_PID" 2>/dev/null || break
      sleep 0.2
    done
    kill -9 "$NODE_PID" 2>/dev/null || true
  fi
  if [ "$KEEP_HOME" != "1" ] && [ -d "$CHAIN_HOME" ]; then rm -rf "$CHAIN_HOME"; fi
}
trap cleanup EXIT

rm -rf "$CHAIN_HOME"
mkdir -p "$(dirname "$OUTPUT")"

log "initializing chain home $CHAIN_HOME (chain-id $CHAIN_ID, module $MODULE_CLI)"
"$BIN" init bench-sessions --chain-id "$CHAIN_ID" --home "$CHAIN_HOME" >/dev/null 2>&1
KEYRING_ARGS=(--keyring-backend test --home "$CHAIN_HOME")
TXARGS=(--keyring-backend test --home "$CHAIN_HOME" --chain-id "$CHAIN_ID"
  --gas-adjustment 1.5 --gas-prices "$GAS_PRICE" --node "$RPC_ADDR" --output json -y)

add_key() {
  set +o pipefail
  yes | "$BIN" keys add "$1" "${KEYRING_ARGS[@]}" --output json >/dev/null 2>&1
  local rc=$?
  set -o pipefail
  return "$rc"
}
USER_NAME=bench-user
PROVIDER_NAMES=(bench-provider1 bench-provider2 bench-provider3)
add_key "$USER_NAME"
USER_ADDR=$("$BIN" keys show "$USER_NAME" -a "${KEYRING_ARGS[@]}")
PROVIDER_ADDRS=()
for name in "${PROVIDER_NAMES[@]}"; do
  add_key "$name"
  addr=$("$BIN" keys show "$name" -a "${KEYRING_ARGS[@]}")
  PROVIDER_ADDRS+=("$addr")
done

# Fund the fee token as well as stake: EVM-enabled ante handling requires aatom.
FUNDING="100000000000$DENOM,1000000000000000000aatom"
"$BIN" genesis add-genesis-account "$USER_ADDR" "$FUNDING" "${KEYRING_ARGS[@]}" >/dev/null
for addr in "${PROVIDER_ADDRS[@]}"; do
  "$BIN" genesis add-genesis-account "$addr" "$FUNDING" "${KEYRING_ARGS[@]}" >/dev/null
done
"$BIN" genesis gentx "$USER_NAME" "50000000000$DENOM" --chain-id "$CHAIN_ID" "${KEYRING_ARGS[@]}" >/dev/null
"$BIN" genesis collect-gentxs --home "$CHAIN_HOME" >/dev/null
python3 - "$CHAIN_HOME/config/genesis.json" <<'PY'
import json, sys
path = sys.argv[1]
data = json.load(open(path))
bank = data["app_state"]["bank"]
metadata = bank.get("denom_metadata", [])
if not any(item.get("base") == "aatom" for item in metadata):
    metadata.append({
        "description": "EVM fee token metadata",
        "denom_units": [
            {"denom": "aatom", "exponent": 0, "aliases": ["uatom"]},
            {"denom": "atom", "exponent": 18, "aliases": []},
        ],
        "base": "aatom", "display": "atom", "name": "Atom", "symbol": "ATOM",
        "uri": "", "uri_hash": "",
    })
bank["denom_metadata"] = metadata
json.dump(data, open(path, "w"), indent=1)
PY
"$BIN" genesis validate --home "$CHAIN_HOME" >/dev/null || fail "invalid genesis after provider fixture setup"

# Keep blocks short so each recorded transaction becomes queryable promptly.
sed -i.bak 's/timeout_commit = "5s"/timeout_commit = "1s"/' "$CHAIN_HOME/config/config.toml"
log "starting node (rpc $RPC_ADDR, p2p $P2P_ADDR)"
"$BIN" start --home "$CHAIN_HOME" --rpc.laddr "$RPC_ADDR" --p2p.laddr "$P2P_ADDR" \
  --minimum-gas-prices "$GAS_PRICE" >"$CHAIN_HOME/node.log" 2>&1 &
NODE_PID=$!
for _ in $(seq 1 60); do
  height=$(curl -sf "$LCD/status" | python3 -c 'import json,sys; print(int(json.load(sys.stdin)["result"]["sync_info"]["latest_block_height"]))' 2>/dev/null || echo 0)
  if [ "$height" -ge 1 ]; then break; fi
  kill -0 "$NODE_PID" 2>/dev/null || { tail -40 "$CHAIN_HOME/node.log" >&2; fail "node exited during startup"; }
  sleep 1
done
height=$(curl -sf "$LCD/status" | python3 -c 'import json,sys; print(int(json.load(sys.stdin)["result"]["sync_info"]["latest_block_height"]))' 2>/dev/null || echo 0)
[ "$height" -ge 1 ] || { tail -40 "$CHAIN_HOME/node.log" >&2; fail "node did not produce first block at $RPC_ADDR"; }

wait_for_tx() {
  local hash="$1" out
  for _ in $(seq 1 60); do
    out=$("$BIN" query tx "$hash" --home "$CHAIN_HOME" --node "$RPC_ADDR" --output json 2>/dev/null || true)
    if [ -n "$out" ] && python3 -c 'import json,sys; d=json.load(sys.stdin); raise SystemExit(0 if d.get("txhash") else 1)' <<<"$out" 2>/dev/null; then
      printf '%s' "$out"
      return 0
    fi
    sleep 0.25
done
return 1
}

TX_SEQ=0
record_tx() {
  TX_SEQ=$((TX_SEQ + 1))
  TX_KIND="$1" TX_INDEX="$2" TX_FROM="$3" TX_HASH="$4" TX_CODE="$5" \
    TX_LATENCY_MS="$6" TX_HEIGHT_BEFORE="$7" TX_HEIGHT_AFTER="$8" TX_ERROR="$9" \
    python3 - "$OUTPUT" "$TX_SEQ" <<'PY'
import json, os, sys
doc = json.load(open(sys.argv[1]))
def val(name, default=""):
    return os.environ.get(name, default)
def integer(name, default=None):
    raw = val(name)
    return default if raw == "" else int(raw)
rec = {
    "seq": int(sys.argv[2]), "kind": val("TX_KIND"), "index": int(val("TX_INDEX", "0")),
    "from": val("TX_FROM"), "txhash": val("TX_HASH"), "code": integer("TX_CODE", None),
    "latency_ms": integer("TX_LATENCY_MS", None), "height_before": integer("TX_HEIGHT_BEFORE", None),
    "height_after": integer("TX_HEIGHT_AFTER", None), "error": val("TX_ERROR"),
}
doc["txs"].append(rec)
json.dump(doc, open(sys.argv[1], "w"), indent=1)
PY
}

record_skip() {
  TX_SEQ=$((TX_SEQ + 1))
  TX_KIND="$1" TX_INDEX="$2" TX_ERROR="$3" python3 - "$OUTPUT" "$TX_SEQ" <<'PY'
import json, os, sys
doc = json.load(open(sys.argv[1]))
doc["txs"].append({"seq": int(sys.argv[2]), "kind": os.environ["TX_KIND"],
  "index": int(os.environ["TX_INDEX"]), "txhash": "", "code": None,
  "latency_ms": None, "height_before": None, "height_after": None,
  "error": os.environ["TX_ERROR"], "skipped": True})
json.dump(doc, open(sys.argv[1], "w"), indent=1)
PY
}

sample_block() {
  python3 - "$OUTPUT" "$LCD/status" <<'PY'
import json, sys, time, urllib.request
try:
    body = json.load(urllib.request.urlopen(sys.argv[2], timeout=5))
    height = int(body["result"]["sync_info"]["latest_block_height"])
except Exception:
    height = 0
doc = json.load(open(sys.argv[1]))
doc["blocks"].append({"height": height, "unix_ns": time.time_ns()})
json.dump(doc, open(sys.argv[1], "w"), indent=1)
PY
}

parse_json_record() {
  python3 -c 'import json,sys
for line in reversed(sys.stdin.read().splitlines()):
  try:
    obj=json.loads(line)
    if isinstance(obj, dict):
      print(json.dumps(obj)); raise SystemExit
  except json.JSONDecodeError:
    pass
raise SystemExit(1)'
}

send_tx() { # send_tx <kind> <index> <from> <module-cli-args...>
  local kind="$1" index="$2" from="$3"; shift 3
  local before after started finished out rc hash txjson code error
  before=$(curl -sf "$LCD/status" | python3 -c 'import json,sys; print(json.load(sys.stdin)["result"]["sync_info"]["latest_block_height"])' 2>/dev/null || echo 0)
  started=$(date +%s%N)
  out=$("$BIN" tx "$MODULE_CLI" "$@" --from "$from" "${TXARGS[@]}" 2>&1) && rc=0 || rc=$?
  finished=$(date +%s%N)
  hash=$(parse_json_record <<<"$out" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("txhash", ""))' 2>/dev/null || true)
  LAST_TXHASH="$hash"
  txjson=""
  if [ -n "$hash" ]; then txjson=$(wait_for_tx "$hash" || true); fi
  LAST_TXJSON="$txjson"
  after=$(curl -sf "$LCD/status" | python3 -c 'import json,sys; print(json.load(sys.stdin)["result"]["sync_info"]["latest_block_height"])' 2>/dev/null || echo 0)
  code=1
  error="$out"
  if [ -n "$txjson" ]; then
    code=$(python3 -c 'import json,sys; print(json.load(sys.stdin).get("code",0))' <<<"$txjson")
    error=$(python3 -c 'import json,sys; print(json.load(sys.stdin).get("raw_log", ""))' <<<"$txjson")
  elif [ -z "$hash" ]; then
    error="transaction did not return txhash: $out"
  fi
  [ "${#error}" -le 300 ] || error="${error:0:300}"
  record_tx "$kind" "$index" "$from" "$hash" "$code" "$(( (finished - started) / 1000000 ))" "$before" "$after" "$error"
  [ "$rc" -eq 0 ] && [ -n "$txjson" ] && [ "$code" -eq 0 ]
}

python3 - "$OUTPUT" "$SESSIONS" "$RATE" "$PROOFS_PER_SESSION" "$CHAIN_ID" "$RPC_ADDR" "$MODULE_CLI" <<'PY'
import json, sys, time
json.dump({"config": {"sessions": int(sys.argv[2]), "rate_tps": int(sys.argv[3]),
  "proofs_per_session": int(sys.argv[4]), "chain_id": sys.argv[5], "rpc": sys.argv[6],
  "module_cli": sys.argv[7], "started_unix_ns": time.time_ns()}, "blocks": [], "txs": []},
  open(sys.argv[1], "w"), indent=1)
PY

log "registering three funded providers"
for i in "${!PROVIDER_ADDRS[@]}"; do
  send_tx register-provider "$((i + 1))" "${PROVIDER_NAMES[$i]}" register-provider General 100000000000 \
    --endpoint "/ip4/127.0.0.1/tcp/$((8080 + i))/http" || fail "provider registration failed for ${PROVIDER_NAMES[$i]}"
done

log "creating Mode 2 deal"
send_tx create-deal 0 "$USER_NAME" create-deal 100000 100000000 10000000 --service-hint "General:rs=2+1" \
  || fail "create-deal setup transaction failed"
DEALS_JSON=$("$BIN" query "$MODULE_CLI" list-deals --home "$CHAIN_HOME" --node "$RPC_ADDR" --output json 2>/dev/null) \
  || fail "query $MODULE_CLI list-deals failed"
DEAL_ID=$(python3 -c 'import json,sys; d=json.load(sys.stdin); xs=d.get("deals",[]); print(xs[-1].get("id",xs[-1].get("deal_id",0)) if xs else "")' <<<"$DEALS_JSON")
[ -n "$DEAL_ID" ] || fail "query $MODULE_CLI list-deals returned no deal"
ASSIGNED_COUNT=$(python3 -c 'import json,sys; d=json.load(sys.stdin); xs=d.get("deals",[]); print(len(xs[-1].get("providers",[])) if xs else 0)' <<<"$DEALS_JSON")
[ "$ASSIGNED_COUNT" -ge 3 ] || fail "Mode 2 deal has $ASSIGNED_COUNT eligible providers; expected at least 3"
PROVIDER_ADDR=$(python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["deals"][-1]["providers"][0])' <<<"$DEALS_JSON")
log "deal $DEAL_ID assigned $ASSIGNED_COUNT providers"

MANIFEST_HEX="0x$(python3 -c 'print("ab" * 32)')"
send_tx update-deal-content 0 "$USER_NAME" update-deal-content --deal-id "$DEAL_ID" --cid "$MANIFEST_HEX" \
  --size 131072 --total-mdus 3 --witness-mdus 1 || fail "update-deal-content setup transaction failed"

INTERVAL_NS=$((1000000000 / RATE))
START_NS=$(date +%s%N)
for i in $(seq 1 "$SESSIONS"); do
  sample_block
  NONCE="$i"
  if send_tx open-session "$i" "$USER_NAME" open-retrieval-session --deal-id "$DEAL_ID" --provider "$PROVIDER_ADDR" \
      --manifest-root "$MANIFEST_HEX" --start-mdu-index 2 --start-blob-index 0 --blob-count 1 --nonce "$NONCE"; then
    # LAST_TXJSON is the exact open transaction; never search sender history.
    SESSION_ID=$(python3 -c 'import binascii,json,sys
d=json.load(sys.stdin)
events=list(d.get("events",[]))
for log in d.get("logs",[]):
  events.extend(log.get("events",[]))
for event in events:
  if event.get("type","").split(".")[-1] == "open_retrieval_session":
    for attr in event.get("attributes",[]):
      if attr.get("key") == "session_id":
        print(attr.get("value","")); raise SystemExit
# Current keeper response has no custom event; decode the response bytes from this exact tx.
raw=bytes.fromhex(d.get("data",""))
if len(raw) >= 32:
  print(raw[-32:].hex()); raise SystemExit
print("")' <<<"$LAST_TXJSON")
    [ -n "$SESSION_ID" ] || fail "open tx $LAST_TXHASH has no open_retrieval_session session_id"
    if [ "$PROOFS_PER_SESSION" -eq 0 ]; then
      record_skip submit-proof "$i" "POLYSTORE_BENCH_PROOFS_PER_SESSION=0 (proof stage skipped)"
    else
      PROOF_FILE="$PROOFS_DIR/$i.json"
      [ -f "$PROOF_FILE" ] || fail "missing proof payload $PROOF_FILE"
      python3 - "$PROOF_FILE" "$SESSION_ID" <<'PY'
import json, sys
obj = json.load(open(sys.argv[1]))
if obj.get("session_id") != sys.argv[2]:
    raise SystemExit("proof payload session_id does not match exact open tx session_id")
PY
      send_tx submit-proof "$i" "${PROVIDER_NAMES[0]}" submit-retrieval-proof "$PROOF_FILE" \
        || log "session $i proof transaction failed (recorded)"
    fi
    send_tx confirm-session "$i" "$USER_NAME" confirm-retrieval-session --session-id "$SESSION_ID" \
      || log "session $i confirm transaction failed (recorded)"
  else
    log "session $i open transaction failed (recorded)"
  fi
  now=$(date +%s%N)
  target=$((START_NS + i * INTERVAL_NS))
  if [ "$now" -lt "$target" ]; then
    sleep "$(( (target - now) / 1000000000 )).$(( ((target - now) % 1000000000) / 1000000 ))"
  fi
done
END_NS=$(date +%s%N)

python3 - "$OUTPUT" "$START_NS" "$END_NS" <<'PY'
import json, sys
doc = json.load(open(sys.argv[1]))
wall = (int(sys.argv[3]) - int(sys.argv[2])) / 1e9
txs = doc["txs"]
ok = sum(1 for t in txs if t.get("code") == 0 and not t.get("error"))
failed = sum(1 for t in txs if not t.get("skipped") and (t.get("code") not in (0, None) or t.get("error")))
skipped = sum(1 for t in txs if t.get("skipped"))
sent = sum(1 for t in txs if not t.get("skipped"))
summary = {"total_records": len(txs), "ok": ok, "failed": failed, "skipped": skipped,
  "txs_sent": sent, "wall_seconds": round(wall, 3),
  "txs_per_sec": round(sent / wall, 3) if wall > 0 else None}
if doc["blocks"]:
    heights = [b["height"] for b in doc["blocks"]]
    summary.update({"block_height_start": min(heights), "block_height_end": max(heights),
      "blocks_produced": max(heights) - min(heights)})
doc["summary"] = summary
json.dump(doc, open(sys.argv[1], "w"), indent=1)
print(json.dumps(summary, indent=1))
PY
log "results written to $OUTPUT"
