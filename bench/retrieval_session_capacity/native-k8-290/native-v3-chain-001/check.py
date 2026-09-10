"""Check report derivation and rejection using one retained successful run."""
import copy
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile


def main():
    harness, evidence, blocks, refunds = map(Path, sys.argv[1:5])
    original = json.loads(evidence.read_text())
    command = [sys.executable, str(Path(__file__).with_name("summarize.py")), str(harness)]
    def unrelated_receipt(document):
        receipt = document["native_v3_chain"]["sessions"][0]["refund_transaction"]
        receipt["txhash"] = "AB" * 32
        for row in receipt["validators"]:
            row["txhash"] = receipt["txhash"]
    def another_session_refund(document):
        first, second = document["native_v3_chain"]["sessions"][:2]
        first["refund_transaction"] = copy.deepcopy(second["refund_transaction"])
        first["after_refund"]["session"]["updated_height"] = str(second["refund_transaction"]["height"])
    mutations = [
        lambda d: d.update(status="failed"),
        lambda d: d["provenance"].update(source_checkout="8d7522588d2eb9b8e5b8eb6f98e11bca09e14f86"),
        lambda d: d["provenance"].update(driver_sha256="0" * 64),
        lambda d: d["profile"]["consensus"]["block"].update(max_gas="128000000"),
        lambda d: d.pop("audit_coverage_verified"),
        lambda d: d["native_v3_chain"]["scheduler"]["transactions"][0].update(queue_latency_ns=-1),
        lambda d: d["native_v3_chain"]["scheduler"]["transactions"][0].pop("validators"),
        lambda d: d["native_v3_chain"]["scheduler"]["transactions"][0]["validators"].pop(),
        lambda d: d["native_v3_chain"]["sessions"][0]["accepted_sample_ordinals"].pop(),
        lambda d: d["native_v3_chain"]["gas_preflight"].pop(),
        lambda d: d["native_v3_chain"]["measured_window"]["validator_cpu_delta"]["validators"][0].update(user_cpu_seconds=-1),
        lambda d: d["native_v3_chain"]["measured_window"]["validator_cpu_after"]["validators"][0].update(pid=1),
        lambda d: d["native_v3_chain"]["scheduler"]["transactions"][0].update(signer="nil1wrong"),
        lambda d: d["native_v3_chain"]["scheduler"]["transactions"][0].update(kind="ack"),
        lambda d: d["validator_resources"][0].update(peak_rss_bytes=-1),
        lambda d: d["commit_step_metrics"]["phases"]["native_v3_chain_before"]["nodes"][0].update(node_id="wrong"),
        lambda d: d["native_v3_chain"]["sessions"][0].pop("expired_before_refund"),
        lambda d: d["native_v3_chain"]["sessions"][0].pop("refund_transaction"),
        lambda d: d["native_v3_chain"]["sessions"][0].pop("after_refund"),
        lambda d: d["native_v3_chain"]["sessions"][0]["after_refund"]["session"].update(refunded_slots_mask=0),
        lambda d: d["native_v3_chain"]["sessions"][0]["after_refund"]["session"].update(locked_fee="133"),
        lambda d: d["native_v3_chain"]["sessions"][0]["refund_transaction"].update(code=1),
        lambda d: d["native_v3_chain"]["sessions"][0]["refund_transaction"]["validators"].pop(),
        lambda d: d["native_v3_chain"]["sessions"][0]["refund_transaction"]["validators"][0].update(height=1),
        lambda d: d["native_v3_chain"]["sessions"][0]["after_refund"]["session"].update(updated_height="384"),
        lambda d: d["native_v3_chain"]["sessions"][0].update(after_refund=d["native_v3_chain"]["sessions"][1]["after_refund"]),
        lambda d: d["native_v3_chain"]["sessions"][0]["expired_before_refund"]["session"].update(locked_fee="1"),
        lambda d: d["native_v3_chain"]["sessions"][0]["expired_before_refund"]["session"].update(accepted_sample_bitmap=""),
        unrelated_receipt,
        another_session_refund,
    ]
    with tempfile.TemporaryDirectory() as temporary:
        source = Path(temporary) / "evidence.json"
        def run(document, block_source=blocks, refund_source=refunds):
            source.write_bytes(evidence.read_bytes() if document is original else json.dumps(document).encode())
            return subprocess.run(command + [str(source), str(block_source), str(refund_source), "--run-scope", "landed-retained-diagnostic"],
                                  capture_output=True, text=True, timeout=10)
        result = run(original)
        assert result.returncode == 0, result.stderr
        summary = json.loads(result.stdout)
        assert summary["counts"] == dict(total=64, measured=56, total_ordinals=1056, measured_ordinals=924)
        for index, mutate in enumerate(mutations):
            document = copy.deepcopy(original)
            mutate(document)
            result = run(document)
            assert result.returncode == 2 and not result.stdout, (index, result.returncode, result.stdout, result.stderr)
            assert "retained input" not in result.stderr, (index, result.stderr)
        # A plausible altered measurement passes structural timing checks but
        # must not be accepted as the original retained run.
        document = copy.deepcopy(original)
        for row in document["native_v3_chain"]["scheduler"]["transactions"]:
            row["checktx_latency_ns"] = 0
        result = run(document)
        assert result.returncode == 2 and not result.stdout and "retained input evidence bytes" in result.stderr, result.stderr
        bad_blocks = Path(temporary) / "blocks.jsonl"
        bad_blocks.write_bytes(blocks.read_bytes() + b"\n")
        result = run(original, bad_blocks)
        assert result.returncode == 2 and not result.stdout, result.stderr
        document = copy.deepcopy(original)
        document["committed_block_reconciliation"]["sha256"] = hashlib.sha256(bad_blocks.read_bytes()).hexdigest()
        result = run(document, bad_blocks)
        assert result.returncode == 2 and not result.stdout and "retained input block bytes" in result.stderr, result.stderr
        changed = [json.loads(line) for line in blocks.read_text().splitlines()]
        changed[0]["gas_wanted"] += 1
        bad_blocks.write_text("".join(json.dumps(row) + "\n" for row in changed))
        document = copy.deepcopy(original)
        document["committed_block_reconciliation"]["sha256"] = hashlib.sha256(bad_blocks.read_bytes()).hexdigest()
        result = run(document, bad_blocks)
        assert result.returncode == 2 and not result.stdout, result.stderr
        bad_refunds = Path(temporary) / "refunds.json"
        bad_refunds.write_bytes(refunds.read_bytes() + b"\n")
        result = run(original, refund_source=bad_refunds)
        assert result.returncode == 2 and not result.stdout, result.stderr
        bad_harness = Path(temporary) / "harness.py"
        marker = Path(temporary) / "executed"
        bad_harness.write_text(f"from pathlib import Path\nPath({str(marker)!r}).touch()\n")
        command[-1] = str(bad_harness)
        result = run(original)
        assert result.returncode == 2 and not result.stdout and not marker.exists(), result.stderr
        document = copy.deepcopy(original)
        document["provenance"]["driver_sha256"] = hashlib.sha256(bad_harness.read_bytes()).hexdigest()
        result = run(document)
        assert result.returncode == 2 and not result.stdout and not marker.exists(), result.stderr
        bad_harness.write_bytes(harness.read_bytes())
        siblings = ("retrieval_bench_artifact", "retrieval_commit_metrics", "retrieval_fresh_proof")
        for name in siblings:
            (bad_harness.parent / (name + ".py")).write_bytes(harness.with_name(name + ".py").read_bytes())
        for name in siblings:
            altered = bad_harness.with_name(name + ".py")
            correct = altered.read_bytes()
            altered.write_text(f"from pathlib import Path\nPath({str(marker)!r}).touch()\n")
            result = run(original)
            assert result.returncode == 2 and not result.stdout and not marker.exists(), result.stderr
            altered.write_bytes(correct)
        # An unrelated sibling must not shadow a standard-library import.
        bad_harness.with_name("sqlite3.py").write_text(f"from pathlib import Path\nPath({str(marker)!r}).touch()\n")
        result = run(original)
        assert result.returncode == 0 and not marker.exists(), result.stderr
    print(f"Report accepted retained success and rejected {len(mutations) + 10} altered inputs; import shadowing blocked.")


if __name__ == "__main__":
    main()
