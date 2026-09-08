"""Offline tests of Commit-step evidence; no validator or HTTP listener is run."""
from decimal import Decimal
from fractions import Fraction
import io
import json
import tempfile
from pathlib import Path
from unittest import TestCase, main
from unittest.mock import patch

import retrieval_commit_metrics as metrics


def exposition(count="2", total="0.4", chain="bench", step="Commit"):
    return (f'{metrics.METRIC}_count{{step="{step}",chain_id="{chain}"}} {count}\n'
            f'{metrics.METRIC}_sum{{chain_id="{chain}",step="{step}"}} {total}\n')


def sample(count, total, tick, chain="bench"):
    return {"chain_id": chain, "count": count, "sum_seconds": total,
            "wall_time_ns": 1000 + tick, "monotonic_start_ns": tick,
            "monotonic_end_ns": tick + 1}


def summary(samples, blocks, **kwargs):
    return metrics.summarize_commit_metrics(samples, start_committed_height=10,
                                            end_committed_height=10 + blocks, **kwargs)


class CommitMetricsTest(TestCase):
    def test_stream_retains_raw_samples_and_refuses_overwrite(self):
        with tempfile.TemporaryDirectory() as directory:
            output = str(Path(directory) / "metrics.jsonl")
            values = [sample(10, "0.4", 1), sample(12, "0.6", 3)]
            with patch.object(metrics.time, "clock_gettime_ns", side_effect=[0, 0, 200000000, 400000000, 1000000000, 1000000000]), patch.object(
                    metrics.time, "sleep"), patch.object(metrics, "capture_commit_metrics", side_effect=values):
                result = metrics.stream_commit_metrics("http://localhost:9000/metrics", "bench", output, 1)
            self.assertEqual(result["samples"], 2)
            self.assertFalse(result["qualification"])
            self.assertEqual([json.loads(line) for line in Path(output).read_text().splitlines()], values)
            with self.assertRaises(FileExistsError):
                metrics.stream_commit_metrics("http://localhost:9000/metrics", "bench", output, 1)
            for seconds in (0, 1101, True, 1.5):
                with self.assertRaises(ValueError):
                    metrics.stream_commit_metrics("http://localhost:9000/metrics", "bench", output, seconds)

    def test_fenced_capture_requires_complete_stable_owned_boundary(self):
        node = "ab" * 20
        def status(height, network="bench", identity=node):
            return json.dumps({"result": {"node_info": {"id": identity, "network": network},
                                         "sync_info": {"latest_block_height": str(height)}}})

        def capture(heights, counts, initial=0):
            with patch.object(metrics, "_read_owned_endpoint", side_effect=heights), patch.object(
                    metrics, "capture_commit_metrics", side_effect=[sample(c, "0.4", i * 2) for i, c in enumerate(counts)]):
                return metrics.capture_fenced_commit_metrics("http://127.0.0.1:9001/metrics", "bench",
                    "http://127.0.0.1:9000/status", node, initial)

        observed = capture([status(2)] * 3, [2, 2])
        self.assertEqual(observed["committed_height"], 2)
        self.assertTrue(observed["boundary_fence"]["fully_observed"])
        self.assertEqual(observed["boundary_fence"]["status_heights"], [2, 2, 2])
        # RPC height publication can precede its Commit timer. Stable RPC alone
        # must not accept even an otherwise valid, stable prior metric pair.
        for heights, counts, initial in [([status(2)] * 3, [1, 1], 0),
                ([status(2)] * 3, [1, 2], 0), ([status(2), status(2), status(3)], [2, 2], 0),
                ([status(2)] * 3, [2, 2], 1), ([status(2, network="other")] * 3, [2, 2], 0),
                ([status(2, identity="cd" * 20)] * 3, [2, 2], 0)]:
            with self.subTest(heights=heights, counts=counts, initial=initial), self.assertRaises(ValueError):
                capture(heights, counts, initial)
        # Restart series uses its separately known persisted starting height.
        self.assertEqual(capture([status(12)] * 3, [2, 2], 10)["count"], 2)

    def test_parse_exact_labels_and_ignore_unrelated_nan(self):
        text = ('# TYPE ignored summary\nother_metric{quantile="0.5"} NaN\n'
                + exposition(step="NewHeight") + exposition())
        self.assertEqual(metrics.parse_commit_metrics(text, "bench"),
                         {"chain_id": "bench", "count": 2, "sum_seconds": "0.4"})
        escaped = exposition(chain=r'bench\\name\"quote\nline')
        self.assertEqual(metrics.parse_commit_metrics(escaped, 'bench\\name"quote\nline')["count"], 2)

    def test_parser_rejects_invalid_or_ambiguous_evidence(self):
        good = exposition()
        cases = [good + good, exposition(chain="other"),
                 good.replace('step="Commit"', 'step="Commit",step="Commit"'),
                 good.replace('step="Commit"', 'step="Commit",node="extra"'),
                 good.replace('step="Commit"', r'step="Com\qmit"'),
                 good.replace('step="Commit",', ''),
                 good.splitlines()[0], good.replace("} 2", "} 2 999"),
                 exposition(count="NaN"), exposition(count="-1"), exposition(count="1.5"),
                 exposition(count=str(1 << 53)), exposition(total="NaN"),
                 exposition(total="+Inf"), exposition(total="1e999"), exposition(total="1e-999"),
                 exposition(total="-0.1"), exposition(count="0", total="1")]
        for text in cases:
            with self.subTest(text=text), self.assertRaises(ValueError):
                metrics.parse_commit_metrics(text, "bench")

    def test_individual_and_grouped_intervals_are_upper_bounds(self):
        singles = [sample(0, "0", 0), sample(1, "0.2", 2), sample(2, "0.5", 4)]
        result = summary(singles, 2, boundaries_reconciled=True)
        self.assertTrue(result["qualified"])
        self.assertTrue(result["within_700ms_budget"])
        self.assertGreaterEqual(Decimal(result["p95_upper_bound_seconds"]), Decimal("0.3"))
        grouped = summary([singles[0], singles[-1]], 2, boundaries_reconciled=True)
        self.assertEqual(grouped["intervals"][0]["count"], 2)
        self.assertGreaterEqual(Decimal(grouped["p95_upper_bound_seconds"]), Decimal("0.5"))
        self.assertLess(Decimal(grouped["p95_upper_bound_seconds"]), Decimal("0.50000001"))
        # The grouped sum is copied as an upper bound for EACH block, not divided
        # into an invented distribution or mistaken for a per-block mean.
        too_coarse = summary([sample(0, "0", 0), sample(20, "1", 2)], 20,
                             boundaries_reconciled=True)
        self.assertTrue(too_coarse["qualified"])
        self.assertFalse(too_coarse["within_700ms_budget"])

    def test_weighted_nearest_rank(self):
        # 19 low-bound blocks and one high-bound block: nearest-rank p95 is low.
        result = summary([sample(0, "0", 0), sample(19, "0.1", 2), sample(20, "2.1", 4)],
                         20, boundaries_reconciled=True)
        self.assertLess(Decimal(result["p95_upper_bound_seconds"]), Decimal("0.11"))
        self.assertTrue(result["within_700ms_budget"])

    def test_float_roundoff_never_understates_interval_difference(self):
        # Real repeated float addition loses low bits in a large cumulative sum.
        count = 1000000
        before = 1000000.0
        after = before
        for _ in range(3):
            after += 0.1
        self.assertLess(Decimal.from_float(after) - Decimal.from_float(before), Decimal("0.3"))
        result = summary([sample(count, repr(before), 0), sample(count + 3, repr(after), 2)],
                         3, boundaries_reconciled=True)
        self.assertGreaterEqual(Decimal(result["p95_upper_bound_seconds"]), Decimal("0.3"))
        # Compare the directed Decimal envelope against exact rational arithmetic.
        for n, value in [(1, 0.7), (1000000, 1000000.3), (10**12, 1e14)]:
            low, high = metrics._sum_bounds(n, Decimal.from_float(value))
            factor = 1 - Fraction(n + 4, 1 << 53)
            self.assertLessEqual(Fraction(low), Fraction(value) * factor)
            self.assertGreaterEqual(Fraction(high), Fraction(value) / factor)
        exact_budget = summary([sample(0, "0", 0), sample(1, "0.7", 2)], 1,
                               boundaries_reconciled=True)
        self.assertFalse(exact_budget["within_700ms_budget"], "roundoff uncertainty cannot certify exact threshold")

    def test_coverage_gaps_and_boundaries_never_qualify(self):
        samples = [sample(0, "0", 0), sample(1, "0.1", 2)]
        for result in [summary(samples, 1), summary(samples, 2, boundaries_reconciled=True),
                       summary(samples, 0, boundaries_reconciled=True),
                       summary([samples[0], sample(0, "0", 2)], 0, boundaries_reconciled=True)]:
            self.assertFalse(result["qualified"])
            self.assertFalse(result["within_700ms_budget"])
            self.assertTrue(result["qualification_reasons"])
        self.assertEqual(summary(samples, 1)["boundary"], "commit-step execution upper bound")
        self.assertIn("scheduling", summary(samples, 1)["excluded"])

    def test_reset_malformed_and_cross_chain_captures_rejected(self):
        baseline = sample(10, "1", 0)
        cases = [sample(9, "1", 2), sample(11, "0.9", 2), sample(10, "1.1", 2),
                 sample(11, "1.1", 2, "other"), sample(11, "NaN", 2),
                 sample(11, "1.1", 0), sample(True, "1.1", 2),
                 dict(sample(11, "1.1", 2), monotonic_end_ns=1)]
        for bad in cases:
            with self.subTest(sample=bad), self.assertRaises(ValueError):
                summary([baseline, bad], 1)
        # Empty intervals are valid captures and contribute no phantom blocks.
        result = summary([baseline, sample(10, "1", 2), sample(11, "1.1", 4)], 1,
                         boundaries_reconciled=True)
        self.assertEqual(len(result["intervals"]), 1)

    def test_capture_brackets_endpoint_and_does_not_enable_proxy_or_redirect(self):
        class Response(io.BytesIO):
            status = 200
        class Opener:
            def open(self, url, timeout):
                self.url, self.timeout = url, timeout
                return Response(exposition().encode())
        opener = Opener()
        with patch.object(metrics.urllib.request, "build_opener", return_value=opener) as build, \
                patch.object(metrics.time, "time_ns", return_value=123), \
                patch.object(metrics.time, "clock_gettime_ns", side_effect=[10, 20]):
            result = metrics.capture_commit_metrics("http://127.0.0.1:29001/metrics", "bench")
        self.assertEqual((result["wall_time_ns"], result["monotonic_start_ns"], result["monotonic_end_ns"]),
                         (123, 10, 20))
        self.assertEqual(opener.url, "http://127.0.0.1:29001/metrics")
        handlers = build.call_args.args
        self.assertEqual(handlers[0].proxies, {})
        self.assertIsNone(handlers[1].redirect_request(None, None, 302, "", {}, "http://elsewhere"))

    def test_capture_rejects_nonlocal_or_unbounded_inputs_without_network(self):
        with patch.object(metrics.urllib.request, "build_opener") as build:
            for url in ["https://localhost:29001/metrics", "http://example.com:29001/metrics",
                        "http://localhost/metrics", "http://user@localhost:29001/metrics",
                        "http://localhost:29001/other", "http://localhost:29001/metrics?redirect=1"]:
                with self.subTest(url=url), self.assertRaises(ValueError):
                    metrics.capture_commit_metrics(url, "bench")
            for timeout in [0, -1, float("inf"), float("nan"), 11, True]:
                with self.subTest(timeout=timeout), self.assertRaises(ValueError):
                    metrics.capture_commit_metrics("http://localhost:29001/metrics", "bench", timeout)
            build.assert_not_called()
        with self.assertRaises(ValueError):
            metrics.parse_commit_metrics("x" * (metrics.MAX_BYTES + 1), "bench")


if __name__ == "__main__":
    main()
