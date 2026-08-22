#!/usr/bin/env bash
# bench_retrieval_sessions.sh — deterministic single-node retrieval-session
# throughput/load driver (issue #245).
# Measurement boundary: START_NS/END_NS covers the paced load loop, while each
# transaction latency starts before CLI submission and ends after wait_for_tx
# confirms the committed transaction is queryable.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHAIN_DIR="$ROOT_DIR/polystorechain"
CORE_DIR="$ROOT_DIR/polystore_core"
BIN="$CHAIN_DIR/polystorechaind"
MODULE_CLI="${POLYSTORE_CHAIN_MODULE_CLI_NAME:-nilchain}"

SESSIONS="${POLYSTORE_BENCH_SESSIONS:-5}"
TARGET_SESSIONS_PER_SEC="${POLYSTORE_BENCH_RATE:-5}"
PROOFS_PER_SESSION="${POLYSTORE_BENCH_PROOFS_PER_SESSION:-0}"
PROOFS_DIR="${POLYSTORE_BENCH_PROOFS_DIR:-}"
PROOFS_DIR_WAS_SET=0
[ -n "$PROOFS_DIR" ] && PROOFS_DIR_WAS_SET=1
PROOF_MANIFEST_ROOT="${POLYSTORE_BENCH_MANIFEST_ROOT:-}"
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
[[ "$TARGET_SESSIONS_PER_SEC" =~ ^[0-9]+$ && "$TARGET_SESSIONS_PER_SEC" -gt 0 ]] || fail "POLYSTORE_BENCH_RATE (target_sessions_per_sec) must be a positive integer"
[[ "$PROOFS_PER_SESSION" =~ ^[0-9]+$ ]] || fail "POLYSTORE_BENCH_PROOFS_PER_SESSION must be a non-negative integer"
if [ "$PROOFS_PER_SESSION" -gt 0 ] && [ "$PROOFS_PER_SESSION" -gt 32 ]; then
  fail "POLYSTORE_BENCH_PROOFS_PER_SESSION must be 1..32 for the explicit General:rs=2+1 fixture (or 0 to skip proofs)"
fi
if [ "$PROOFS_PER_SESSION" -gt 0 ]; then
  DEFAULT_GAS=$((250000 + PROOFS_PER_SESSION * 50000))
else
  DEFAULT_GAS=auto
fi
GAS_LIMIT="${POLYSTORE_BENCH_GAS:-$DEFAULT_GAS}"

CORE_LIB="$CORE_LIB_DIR/libpolystore_core.so"
log "building polystore_core"
(cd "$CORE_DIR" && cargo build --release) || fail "cargo build --release failed"
export LD_LIBRARY_PATH="$CORE_LIB_DIR${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
export CGO_LDFLAGS="-L$CORE_LIB_DIR -lpolystore_core${CGO_LDFLAGS:+ $CGO_LDFLAGS}"

log "building polystorechaind"
(cd "$CHAIN_DIR" && go build -o "$BIN" ./cmd/polystorechaind) || fail "chain build failed"

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

prepare_proof_fixtures() {
  [ "$PROOFS_PER_SESSION" -gt 0 ] || return 0
  if [ "$PROOFS_DIR_WAS_SET" -eq 0 ]; then
    PROOFS_DIR="$CHAIN_HOME/proof-fixtures"
    mkdir -p "$PROOFS_DIR"
    log "generating deterministic proof fixtures in $PROOFS_DIR"
    (
      cd "$CHAIN_DIR"
      POLYSTORE_BENCH_FIXTURE_DIR="$PROOFS_DIR" \
      POLYSTORE_BENCH_FIXTURE_SESSIONS="$SESSIONS" \
      POLYSTORE_BENCH_FIXTURE_COUNT="$PROOFS_PER_SESSION" \
      POLYSTORE_BENCH_FIXTURE_SERVICE_HINT="General:rs=2+1" \
        go test ./x/polystorechain/keeper -run '^TestWriteRetrievalSessionProofFixture$' -count=1
    ) || fail "proof fixture generation failed"
  else
    [ -d "$PROOFS_DIR" ] || fail "proof fixture directory does not exist: $PROOFS_DIR"
  fi
  if [ -z "$PROOF_MANIFEST_ROOT" ]; then
    [ -f "$PROOFS_DIR/manifest_root.txt" ] || \
      fail "proof mode requires $PROOFS_DIR/manifest_root.txt or POLYSTORE_BENCH_MANIFEST_ROOT"
    PROOF_MANIFEST_ROOT="$(tr -d '[:space:]' < "$PROOFS_DIR/manifest_root.txt")"
  fi
  PROOF_MANIFEST_ROOT="$(python3 - "$PROOF_MANIFEST_ROOT" <<'PY'
import sys
value = sys.argv[1].strip()
hex_value = value[2:] if value.lower().startswith("0x") else value
if len(hex_value) != 64:
    raise SystemExit("manifest root must contain exactly 32 bytes")
try:
    bytes.fromhex(hex_value)
except ValueError as exc:
    raise SystemExit(f"manifest root is not hexadecimal: {exc}")
print("0x" + hex_value.lower())
PY
  )" || fail "invalid POLYSTORE_BENCH_MANIFEST_ROOT"
  for i in $(seq 1 "$SESSIONS"); do
    [ -f "$PROOFS_DIR/$i.json" ] || fail "missing proof payload $PROOFS_DIR/$i.json"
  done
}

mkdir -p "$(dirname "$OUTPUT")"

log "initializing chain home $CHAIN_HOME (chain-id $CHAIN_ID, module $MODULE_CLI)"
"$BIN" init bench-sessions --chain-id "$CHAIN_ID" --home "$CHAIN_HOME" >/dev/null 2>&1
KEYRING_ARGS=(--keyring-backend test --home "$CHAIN_HOME")
TXARGS=(--keyring-backend test --home "$CHAIN_HOME" --chain-id "$CHAIN_ID"
  --gas "$GAS_LIMIT" --gas-adjustment 1.5 --gas-prices "$GAS_PRICE" --node "$RPC_ADDR" --output json -y)
prepare_proof_fixtures

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
  local height
  height=$(curl -sf "$LCD/status" | python3 -c 'import json,sys; print(int(json.load(sys.stdin)["result"]["sync_info"]["latest_block_height"]))') \
    || fail "block height sample failed at $LCD/status"
  [[ "$height" =~ ^[1-9][0-9]*$ ]] || fail "invalid block height sample: $height"
  python3 - "$OUTPUT" "$height" <<'PY'
import json, sys, time
doc = json.load(open(sys.argv[1]))
doc["blocks"].append({"height": int(sys.argv[2]), "unix_ns": time.time_ns()})
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
  hash=$(parse_json_record <<<"$out" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("txhash", ""))' 2>/dev/null || true)
  LAST_TXHASH="$hash"
  txjson=""
  if [ -n "$hash" ]; then txjson=$(wait_for_tx "$hash" || true); fi
  LAST_TXJSON="$txjson"
  finished=$(date +%s%N)

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

python3 - "$OUTPUT" "$SESSIONS" "$TARGET_SESSIONS_PER_SEC" "$PROOFS_PER_SESSION" "$CHAIN_ID" "$RPC_ADDR" "$MODULE_CLI" "$GAS_LIMIT" <<'PY'
import json, sys, time
json.dump({"config": {
  "sessions": int(sys.argv[2]), "target_sessions_per_sec": int(sys.argv[3]),
  "proofs_per_session": int(sys.argv[4]), "chain_id": sys.argv[5],
  "rpc": sys.argv[6], "module_cli": sys.argv[7], "gas_limit": sys.argv[8],
  "serial_driver": True,
  "saturation": False,
  "driver_note": "single-client paced path; sessions/block ceiling comes from gas/time arithmetic and in-process benchmarks, not arbitrary parallel saturation",
  "started_unix_ns": time.time_ns()}, "blocks": [], "txs": []},
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
PROVIDER_NAME=""
for i in "${!PROVIDER_ADDRS[@]}"; do
  if [ "${PROVIDER_ADDRS[$i]}" = "$PROVIDER_ADDR" ]; then
    PROVIDER_NAME="${PROVIDER_NAMES[$i]}"
    break
  fi
done
[ -n "$PROVIDER_NAME" ] || fail "assigned provider $PROVIDER_ADDR has no matching key"

log "deal $DEAL_ID assigned $ASSIGNED_COUNT providers"

if [ "$PROOFS_PER_SESSION" -gt 0 ]; then
  MANIFEST_HEX="$PROOF_MANIFEST_ROOT"
else
  MANIFEST_HEX="0x$(python3 -c 'print("ab" * 32)')"
fi
send_tx update-deal-content 0 "$USER_NAME" update-deal-content --deal-id "$DEAL_ID" --cid "$MANIFEST_HEX" \
  --size 131072 --total-mdus 3 --witness-mdus 1 || fail "update-deal-content setup transaction failed"
BLOB_COUNT=1
if [ "$PROOFS_PER_SESSION" -gt 0 ]; then
  BLOB_COUNT="$PROOFS_PER_SESSION"
fi

INTERVAL_NS=$((1000000000 / TARGET_SESSIONS_PER_SEC))
START_NS=$(date +%s%N)
for i in $(seq 1 "$SESSIONS"); do
  target=$((START_NS + (i - 1) * INTERVAL_NS))
  now=$(date +%s%N)
  if [ "$now" -lt "$target" ]; then
    sleep "$(( (target - now) / 1000000000 )).$(( ((target - now) % 1000000000) / 1000000 ))"
  fi
  sample_block
  NONCE="$i"
  if send_tx open-session "$i" "$USER_NAME" open-retrieval-session --deal-id "$DEAL_ID" --provider "$PROVIDER_ADDR" \
      --manifest-root "$MANIFEST_HEX" --start-mdu-index 2 --start-blob-index 0 --blob-count "$BLOB_COUNT" --nonce "$NONCE"; then
    # LAST_TXJSON is the exact open transaction; never search sender history.
    SESSION_ID=$(python3 -c 'import json,sys
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
      proof_ok=0
      record_skip submit-proof "$i" "POLYSTORE_BENCH_PROOFS_PER_SESSION=0 (proof stage skipped)"
    else
      PROOF_FILE="$PROOFS_DIR/$i.json"
      [ -f "$PROOF_FILE" ] || fail "missing proof payload $PROOF_FILE"
      # Never mutate a caller-owned fixture; inject this run's session ID into
      # a per-session copy because owner/provider addresses are regenerated.
      RUNTIME_PROOF_FILE="$CHAIN_HOME/proof-$i.json"
      cp "$PROOF_FILE" "$RUNTIME_PROOF_FILE"
      python3 - "$RUNTIME_PROOF_FILE" "$SESSION_ID" "$PROOFS_PER_SESSION" <<'PY'
import base64, binascii, json, sys
def decode_session_id(value, label):
    text = str(value).strip()
    try:
        decoded = base64.b64decode(text, validate=True)
        if base64.b64encode(decoded).decode("ascii") == text and len(decoded) == 32:
            return decoded
    except (ValueError, binascii.Error):
        pass
    hex_id = text[2:] if text.lower().startswith("0x") else text
    try:
        decoded = bytes.fromhex(hex_id)
    except ValueError as exc:
        raise SystemExit(f"{label} is not strict base64 or hex: {exc}")
    if len(decoded) != 32:
        raise SystemExit(f"{label} must be exactly 32 bytes")
    return decoded

proof_path = sys.argv[1]
obj = json.load(open(proof_path))
if "session_id" in obj:
    decode_session_id(obj["session_id"], "proof payload session_id")
runtime_bytes = decode_session_id(sys.argv[2], "open tx session_id")
proofs = obj.get("proofs")
if not isinstance(proofs, list) or len(proofs) != int(sys.argv[3]):
    raise SystemExit(f"proof payload must contain exactly {sys.argv[3]} proofs")
obj["session_id"] = base64.b64encode(runtime_bytes).decode("ascii")
with open(proof_path, "w") as stream:
    json.dump(obj, stream, indent=1)
PY
      if send_tx submit-proof "$i" "$PROVIDER_NAME" submit-retrieval-proof "$RUNTIME_PROOF_FILE"; then
        proof_ok=1
      else
        proof_ok=0
        log "session $i proof transaction failed (recorded)"
      fi
    fi

    if [ "$PROOFS_PER_SESSION" -eq 0 ] || [ "$proof_ok" -eq 1 ]; then
      send_tx confirm-session "$i" "$USER_NAME" confirm-retrieval-session --session-id "$SESSION_ID" \
        || log "session $i confirm transaction failed (recorded)"
    else
      record_skip confirm-session "$i" "proof transaction failed; confirmation skipped"
    fi
  else
    log "session $i open transaction failed (recorded)"
  fi
done
sample_block
END_NS=$(date +%s%N)

python3 - "$OUTPUT" "$START_NS" "$END_NS" <<'PY'
import json, sys
doc = json.load(open(sys.argv[1]))
wall = (int(sys.argv[3]) - int(sys.argv[2])) / 1e9
txs = doc["txs"]
load_kinds = {"open-session", "submit-proof", "confirm-session"}
load_txs = [t for t in txs if t.get("kind") in load_kinds]
total_ok = sum(1 for t in txs if t.get("code") == 0 and not t.get("error"))
total_failed = sum(1 for t in txs if not t.get("skipped") and (t.get("code") not in (0, None) or t.get("error")))
total_skipped = sum(1 for t in txs if t.get("skipped"))
total_sent = sum(1 for t in txs if not t.get("skipped"))
load_ok = sum(1 for t in load_txs if t.get("code") == 0 and not t.get("error"))
load_failed = sum(1 for t in load_txs if not t.get("skipped") and (t.get("code") not in (0, None) or t.get("error")))
load_skipped = sum(1 for t in load_txs if t.get("skipped"))
load_sent = sum(1 for t in load_txs if not t.get("skipped"))
load_rate = round(load_sent / wall, 3) if wall > 0 else None
session_indices = range(1, int(doc["config"]["sessions"]) + 1)
successful = {(t.get("index"), t.get("kind"))
              for t in load_txs if t.get("code") == 0 and not t.get("error")}
sessions_confirmed = sum(
    1 for i in session_indices
    if (i, "open-session") in successful and (i, "confirm-session") in successful
)
proofs_enabled = int(doc["config"]["proofs_per_session"]) > 0
sessions_completed = sum(
    1 for i in session_indices
    if (i, "open-session") in successful
    and (i, "submit-proof") in successful
    and (i, "confirm-session") in successful
) if proofs_enabled else 0
confirmed_rate = round(sessions_confirmed / wall, 3) if wall > 0 else None
completed_rate = round(sessions_completed / wall, 3) if proofs_enabled and wall > 0 else None
summary = {
  "total_records": len(txs), "total_ok": total_ok, "total_failed": total_failed,
  "total_skipped": total_skipped, "total_txs_sent": total_sent,
  "load_records": len(load_txs), "load_ok": load_ok, "load_failed": load_failed,
  "load_skipped": load_skipped, "load_txs_sent": load_sent,
  "load_txs_per_sec": load_rate, "txs_per_sec": load_rate,
  "sessions_attempted": int(doc["config"]["sessions"]),
  "sessions_confirmed": sessions_confirmed,
  "sessions_confirmed_per_sec": confirmed_rate,
  "sessions_completed": sessions_completed,
  "sessions_per_sec": completed_rate,
  "completion_basis": "open+proof+confirm" if proofs_enabled else "not measured (proof stage skipped)",
  "target_sessions_per_sec": int(doc["config"]["target_sessions_per_sec"]),
  "serial_driver": True, "saturation": False,
  "wall_seconds": round(wall, 3),
}
if doc["blocks"]:
    heights = [b["height"] for b in doc["blocks"]]
    summary.update({"block_height_start": min(heights), "block_height_end": max(heights),
      "blocks_produced": max(heights) - min(heights)})
doc["summary"] = summary
json.dump(doc, open(sys.argv[1], "w"), indent=1)
print(json.dumps(summary, indent=1))
PY
log "results written to $OUTPUT"
