"""Check report derivation and rejection using one retained successful run."""
import copy
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile


def main():
    harness, evidence, blocks = map(Path, sys.argv[1:4])
    original = json.loads(evidence.read_text())
    command = [sys.executable, str(Path(__file__).with_name("summarize.py")), str(harness)]
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
    ]
    with tempfile.TemporaryDirectory() as temporary:
        source = Path(temporary) / "evidence.json"
        def run(document, block_source=blocks):
            source.write_text(json.dumps(document))
            return subprocess.run(command + [str(source), str(block_source), "--run-scope", "landed-retained-diagnostic"],
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
        bad_blocks = Path(temporary) / "blocks.jsonl"
        bad_blocks.write_bytes(blocks.read_bytes() + b"\n")
        result = run(original, bad_blocks)
        assert result.returncode == 2 and not result.stdout, result.stderr
        changed = [json.loads(line) for line in blocks.read_text().splitlines()]
        changed[0]["gas_wanted"] += 1
        bad_blocks.write_text("".join(json.dumps(row) + "\n" for row in changed))
        document = copy.deepcopy(original)
        document["committed_block_reconciliation"]["sha256"] = hashlib.sha256(bad_blocks.read_bytes()).hexdigest()
        result = run(document, bad_blocks)
        assert result.returncode == 2 and not result.stdout, result.stderr
        bad_harness = Path(temporary) / "harness.py"
        marker = Path(temporary) / "executed"
        bad_harness.write_text(f"from pathlib import Path\nPath({str(marker)!r}).touch()\n")
        command[-1] = str(bad_harness)
        result = run(original)
        assert result.returncode == 2 and not result.stdout and not marker.exists(), result.stderr
    print(f"Report accepted retained success and rejected {len(mutations) + 3} altered inputs.")


if __name__ == "__main__":
    main()
