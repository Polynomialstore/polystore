#!/usr/bin/env python3
"""Reproduce the retained summary and exercise a small semantic failure set."""
import argparse, hashlib, json, runpy, subprocess, sys, tempfile
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
    parser.add_argument("--report", type=Path, help="Later retained report using the same semantic checker")
    args = parser.parse_args()
    scripts = Path(__file__).resolve().parent
    here = args.report.resolve() if args.report else scripts
    base = [sys.executable, str(scripts / "summarize.py"), str(args.harness), str(args.evidence),
            str(args.blocks), str(args.transactions), *(str(path) for path in args.commit_streams),
            "--decoder", str(args.decoder), "--decoder-library", str(args.decoder_library)]
    if args.report:
        base.extend(["--pins", str(here / "pins.json")])
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
    if args.report:
        changed = json.loads(json.dumps(original))
        success = next(row for row in changed["v3_http_phases"]["cross-audit-measured"] if row.get("status") == "success")
        success.pop("timing")
        mutations.append((changed, "provider phase timing differs or lacks authoritative qualification"))
        changed = json.loads(json.dumps(original))
        success = next(row for row in changed["v3_http_phases"]["cross-audit-measured"] if row.get("status") == "success")
        success["timing"]["submission_attempts"][0]["pre_broadcast_ns"] = True
        mutations.append((changed, "provider phase timing differs or lacks authoritative qualification"))
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

    # Include the interval before the first proof, retaining all nine fractional digits.
    helpers = runpy.run_path(str(scripts / "summarize.py"))
    blocks = [{"height": height, "time": f"2026-09-10T12:00:0{height}.123456789Z"} for height in range(3)]
    result = helpers["header_summary"](blocks, [{"height": 1}, {"height": 2}])
    require(result["elapsed_ns"] == 2_000_000_000 and result["inter_block_intervals"]["count"] == 2 and
            helpers["header_time_ns"](blocks[0]["time"]) % 1_000_000_000 == 123456789,
            "header interval or nanosecond precision differs")
    for malformed in (blocks[1:], [blocks[0], blocks[2]], [blocks[1], dict(blocks[0], height=2), blocks[0]]):
        try:
            helpers["header_summary"](malformed, [{"height": 1}, {"height": 2}])
        except ValueError:
            pass
        else:
            raise ValueError("missing preceding/gapped/reversed headers accepted")

    manifest = json.loads((here / "manifest.json").read_text())
    require(manifest["qualification"] is False, "manifest changed qualification")
    for name, expected in manifest["published_files"].items():
        data = (here / name).read_bytes()
        require(len(data) == expected["bytes"] and hashlib.sha256(data).hexdigest() == expected["sha256"],
                f"published file hash differs: {name}")
    print(json.dumps({"status": "passed", "summary_equal": True,
                      "semantic_negative_checks": len(mutations) + 5,
                      "published_hashes": len(manifest["published_files"])}, sort_keys=True))

if __name__ == "__main__": main()
