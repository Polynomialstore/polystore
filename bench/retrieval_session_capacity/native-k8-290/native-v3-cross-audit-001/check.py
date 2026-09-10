#!/usr/bin/env python3
"""Reproduce the retained summary and exercise a small semantic failure set."""
import argparse, hashlib, json, subprocess, sys, tempfile
from pathlib import Path

def require(value, message):
    if not value: raise ValueError(message)

def run(command, expected=None):
    result = subprocess.run(command, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if expected is None:
        require(result.returncode == 0, result.stderr[-4000:])
        return json.loads(result.stdout)
    require(result.returncode != 0 and expected in result.stderr,
            f"mutation did not fail at {expected!r}: {result.stderr[-2000:]}")

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("harness", type=Path)
    parser.add_argument("evidence", type=Path)
    parser.add_argument("blocks", type=Path)
    parser.add_argument("transactions", type=Path)
    parser.add_argument("commit_streams", nargs=4, type=Path)
    parser.add_argument("--decoder", required=True, type=Path)
    parser.add_argument("--decoder-library", required=True, type=Path)
    args = parser.parse_args()
    here = Path(__file__).resolve().parent
    base = [sys.executable, str(here / "summarize.py"), str(args.harness), str(args.evidence),
            str(args.blocks), str(args.transactions), *(str(path) for path in args.commit_streams),
            "--decoder", str(args.decoder), "--decoder-library", str(args.decoder_library)]
    require(run(base) == json.loads((here / "summary.json").read_text()),
            "checked-in summary differs from reconstruction")

    original = json.loads(args.evidence.read_text())
    mutations = []
    changed = json.loads(json.dumps(original)); changed["qualification"] = True
    mutations.append((changed, "top-level diagnostic status/scope differs"))
    changed = json.loads(json.dumps(original)); changed["native_v3_cross_audit"]["measured_proof_transactions"].pop()
    mutations.append((changed, "retained transaction counts differ"))
    changed = json.loads(json.dumps(original)); changed["native_v3_cross_audit"]["schedule_bins"][0]["terminal"] -= 1
    mutations.append((changed, "30-second schedule bins differ"))
    changed = json.loads(json.dumps(original)); changed["native_v3_cross_audit"]["crossed_audits"]["4"]["0"]["audit"]["accepted_count"] = "0"
    mutations.append((changed, "two normal audit epochs did not cover"))
    changed = json.loads(json.dumps(original)); changed["native_v3_cross_audit"]["measured_proof_transactions"][0]["validators"][0]["txhash"] = "A" * 64
    mutations.append((changed, "validator receipt differs"))
    changed = json.loads(json.dumps(original)); changed["native_v3_cross_audit"]["sessions"][0]["after_proofs"]["session"]["context_hash"] = "A" * 44
    mutations.append((changed, "session immutable authority/economic/height fields changed"))
    changed = json.loads(json.dumps(original))
    retry = next(row for row in changed["v3_http_phases"]["cross-audit-measured"] if row.get("http_status") == 429)
    retry["provider"] = "invalid-provider"
    mutations.append((changed, "provider HTTP terminal success inventory differs"))
    changed = json.loads(json.dumps(original))
    success = next(row for row in changed["v3_http_phases"]["cross-audit-measured"] if row.get("status") == "success")
    success["tx_hash"] = "A" * 64
    mutations.append((changed, "HTTP success identity differs from measured proof receipt"))
    changed = json.loads(json.dumps(original))
    success = next(row for row in changed["v3_http_phases"]["cross-audit-measured"] if row.get("status") == "success")
    success["session_id"] = "0x" + "00" * 32
    mutations.append((changed, "HTTP success identity differs from measured proof receipt"))
    with tempfile.TemporaryDirectory() as directory:
        for index, (doc, expected) in enumerate(mutations):
            path = Path(directory) / f"evidence-{index}.json"
            path.write_text(json.dumps(doc))
            command = base.copy(); command[3] = str(path)
            run(command, expected)
        transactions = json.loads(args.transactions.read_text())
        transactions["transactions"][0]["raw_tx_base64"] = "d3Jvbmc="
        path = Path(directory) / "transactions-corrupt.json"
        path.write_text(json.dumps(transactions))
        command = base.copy(); command[5] = str(path)
        run(command, "recovered raw transaction hash/size differs")
        transactions = json.loads(args.transactions.read_text())
        transactions["transactions"][0]["decoded"]["body"]["messages"][0]["creator"] = "invalid-creator"
        path = Path(directory) / "transactions-decoded-stale.json"
        path.write_text(json.dumps(transactions))
        command = base.copy(); command[5] = str(path)
        run(command, "native transaction decode differs from recovered representation")

    manifest = json.loads((here / "manifest.json").read_text())
    require(manifest["qualification"] is False, "manifest changed qualification")
    for name, expected in manifest["published_files"].items():
        data = (here / name).read_bytes()
        require(len(data) == expected["bytes"] and hashlib.sha256(data).hexdigest() == expected["sha256"],
                f"published file hash differs: {name}")
    print(json.dumps({"status": "passed", "summary_equal": True,
                      "semantic_negative_checks": len(mutations) + 2,
                      "published_hashes": len(manifest["published_files"])}, sort_keys=True))

if __name__ == "__main__": main()
