"""Existing CometBFT Commit-step measurements; stdlib only.

This timer covers validation, blockstore/WAL fsync, FinalizeBlock, application
Commit, mempool update, and state persistence. It excludes the subsequent state
transition tail, private-validator key refresh, and next-round scheduling. It may
include waiting for the committed block. It is not an entire-finalizeCommit timer.

Capture CLI must run through the harness's existing bounded command adapter for
an absolute deadline: urllib's socket timeout alone does not bound trickled HTTP
headers. No redirects or proxies are followed; only explicit loopback endpoints
are accepted. Endpoint/process ownership remains the driver's responsibility.
"""
import argparse
from decimal import Decimal, ROUND_CEILING, ROUND_FLOOR, localcontext
import json
import math
import os
import re
import time
import urllib.parse
import urllib.request


METRIC = "cometbft_consensus_step_duration_seconds"
FINALIZE_BLOCK_METRIC = "cometbft_abci_connection_method_timing_seconds"
BOUNDARY = "commit-step execution upper bound"
MAX_BYTES = 4 * 1024 * 1024
_MAX_COUNT = (1 << 53) - 5
_NUMBER = re.compile(r"[+]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?\Z")
_LABEL = re.compile(r'([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*"((?:[^"\\\n]|\\[\\"n])*)"')


def _integer(value, name):
    if type(value) is not int or value < 0:
        raise ValueError(f"{name} must be a nonnegative integer")
    return value


def _labels(text):
    labels = {}
    remaining = text.strip()
    while remaining:
        match = _LABEL.match(remaining)
        if not match or match[1] in labels:
            raise ValueError("malformed or duplicate metric labels")
        labels[match[1]] = re.sub(r'\\([\\"n])', lambda m: "\n" if m[1] == "n" else m[1], match[2])
        remaining = remaining[match.end():].strip()
        if remaining:
            if not remaining.startswith(","):
                raise ValueError("malformed metric labels")
            remaining = remaining[1:].strip()
    return labels


def _total(value):
    if not isinstance(value, str) or len(value) > 128 or not _NUMBER.fullmatch(value):
        raise ValueError("sum must be a finite nonnegative numeric token")
    number = float(value)
    if not math.isfinite(number) or (number == 0 and Decimal(value) != 0):
        raise ValueError("sum must be a finite representable float64")
    return Decimal.from_float(number)


def parse_commit_metrics(text, chain_id):
    """Read exactly one count/sum pair for the requested chain and Commit label.

    Unrelated metrics, including NaN summary quantiles, are intentionally ignored.
    Metric labels are parsed rather than matched as substrings. No pooling across
    nodes, chains, steps, or extra label sets is permitted.
    """
    if not isinstance(chain_id, str) or not chain_id:
        raise ValueError("chain_id is required")
    if not isinstance(text, str) or len(text.encode("utf-8")) > MAX_BYTES:
        raise ValueError("metrics response exceeds limit or is not text")
    found = {}
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        name = re.match(r"[a-zA-Z_:][a-zA-Z0-9_:]*", line)
        if not name or name[0] not in (METRIC + "_count", METRIC + "_sum"):
            continue
        match = re.fullmatch(r"([^{}\s]+)\{(.*)\}\s+(\S+)", line)
        if not match:
            raise ValueError("malformed Commit metric sample")
        labels = _labels(match[2])
        if "step" not in labels:
            raise ValueError("metric step is missing")
        if labels["step"] != "Commit":
            continue
        if labels != {"step": "Commit", "chain_id": chain_id}:
            raise ValueError("Commit metric chain or labels mismatch")
        field = "count" if match[1].endswith("_count") else "sum_seconds"
        if field in found:
            raise ValueError("duplicate Commit metric sample")
        token = match[3]
        if field == "count":
            if len(token) > 32 or not _NUMBER.fullmatch(token):
                raise ValueError("count must be a nonnegative integer")
            count = Decimal(token)
            if count != count.to_integral_value() or count > _MAX_COUNT:
                raise ValueError("count must be an integer within the roundoff bound")
            found[field] = int(count)
        else:
            _total(token)
            found[field] = token
    if set(found) != {"count", "sum_seconds"}:
        raise ValueError("Commit count/sum pair is missing")
    if found["count"] == 0 and _total(found["sum_seconds"]) != 0:
        raise ValueError("zero count has nonzero sum")
    return {"chain_id": chain_id, **found}


def parse_finalize_block_histogram(text, chain_id):
    """Read one native CometBFT sync FinalizeBlock histogram."""
    if not isinstance(chain_id, str) or not chain_id:
        raise ValueError("chain_id is required")
    if not isinstance(text, str) or len(text.encode("utf-8")) > MAX_BYTES:
        raise ValueError("metrics response exceeds limit or is not text")
    buckets, count = {}, None
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        name = re.match(r"[a-zA-Z_:][a-zA-Z0-9_:]*", line)
        if not name or name[0] not in (
                FINALIZE_BLOCK_METRIC + "_bucket", FINALIZE_BLOCK_METRIC + "_count"):
            continue
        match = re.fullmatch(r"([^{}\s]+)\{(.*)\}\s+(\S+)", line)
        if not match:
            raise ValueError("malformed FinalizeBlock histogram sample")
        labels = _labels(match[2])
        if labels.get("method") != "finalize_block" or labels.get("type") != "sync":
            continue
        base = {"method": "finalize_block", "type": "sync", "chain_id": chain_id}
        if match[1].endswith("_bucket"):
            if set(labels) != set(base) | {"le"} or any(labels[key] != value for key, value in base.items()):
                raise ValueError("FinalizeBlock histogram chain or labels mismatch")
            bound = labels["le"]
            if bound != "+Inf":
                if not _NUMBER.fullmatch(bound) or Decimal(bound) <= 0:
                    raise ValueError("FinalizeBlock histogram has an invalid bucket")
            if bound in buckets:
                raise ValueError("duplicate FinalizeBlock histogram bucket")
            value = Decimal(match[3]) if _NUMBER.fullmatch(match[3]) else None
            if value is None or value != value.to_integral_value() or not 0 <= value <= _MAX_COUNT:
                raise ValueError("FinalizeBlock bucket count must be a bounded integer")
            buckets[bound] = int(value)
        else:
            if labels != base or count is not None:
                raise ValueError("FinalizeBlock histogram chain or labels mismatch")
            value = Decimal(match[3]) if _NUMBER.fullmatch(match[3]) else None
            if value is None or value != value.to_integral_value() or not 0 <= value <= _MAX_COUNT:
                raise ValueError("FinalizeBlock count must be a bounded integer")
            count = int(value)
    if count is None or "+Inf" not in buckets or buckets["+Inf"] != count:
        raise ValueError("FinalizeBlock histogram count/buckets are missing or inconsistent")
    ordered = sorted(((Decimal(key), key, value) for key, value in buckets.items() if key != "+Inf"))
    if any(current[0] <= previous[0] for previous, current in zip(ordered, ordered[1:])):
        raise ValueError("FinalizeBlock histogram bucket bounds are not strictly increasing")
    ordered.append((Decimal("Infinity"), "+Inf", buckets["+Inf"]))
    if any(current[2] < previous[2] for previous, current in zip(ordered, ordered[1:])):
        raise ValueError("FinalizeBlock histogram buckets are not cumulative")
    return {"chain_id": chain_id, "count": count,
            "buckets": [{"le": key, "count": value} for _, key, value in ordered]}


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _read_owned_endpoint(url, path, timeout):
    if not isinstance(url, str) or any(char in url for char in "\r\n\t"):
        raise ValueError("invalid metrics URL")
    parsed = urllib.parse.urlsplit(url)
    if (parsed.scheme != "http" or parsed.hostname not in ("127.0.0.1", "::1", "localhost")
            or parsed.username is not None or parsed.password is not None
            or parsed.fragment or parsed.query or parsed.path != path
            or parsed.port is None or not 1 <= parsed.port <= 65535):
        raise ValueError(f"an owned explicit localhost HTTP {path} endpoint is required")
    if isinstance(timeout, bool) or not math.isfinite(timeout) or not 0 < timeout <= 10:
        raise ValueError("socket timeout must be in (0, 10] seconds")
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect())
    with opener.open(url, timeout=timeout) as response:
        if response.status != 200:
            raise ValueError("metrics endpoint did not return 200")
        body = response.read(MAX_BYTES + 1)
    if len(body) > MAX_BYTES:
        raise ValueError("metrics response exceeds limit")
    return body.decode("utf-8")


def capture_commit_metrics(url, chain_id, timeout=2.0, include_finalize_block=False):
    """One size/socket-time-bounded scrape; use the command adapter for hard time.

    The monotonic timestamps bracket the HTTP operation, not block execution.
    A metric is observed near the end of Commit and has no per-height label.
    """
    wall_time_ns = time.time_ns()
    started = time.clock_gettime_ns(time.CLOCK_MONOTONIC)
    body = _read_owned_endpoint(url, "/metrics", timeout)
    ended = time.clock_gettime_ns(time.CLOCK_MONOTONIC)
    result = {**parse_commit_metrics(body, chain_id),
            "wall_time_ns": wall_time_ns, "monotonic_start_ns": started,
            "monotonic_end_ns": ended}
    if include_finalize_block:
        result["finalize_block_histogram"] = parse_finalize_block_histogram(body, chain_id)
    return result


def capture_fenced_commit_metrics(url, chain_id, rpc_url, node_id, initial_height, timeout=2.0,
                                  include_finalize_block=False):
    """Attest a fully observed Commit boundary for one owned process lifetime.

    initial_height is the persisted app height BEFORE this process starts, not
    the first height later observed over RPC. Fresh genesis starts at zero.
    Restart needs a separately established persisted height and separate series.
    A moving or lagging boundary fails rather than assigning timers to guessed
    heights. The driver may retry within its existing absolute command deadline.
    """
    initial_height = _integer(initial_height, "process initial height")
    if not isinstance(node_id, str) or not re.fullmatch(r"[0-9a-f]{40}", node_id):
        raise ValueError("expected node identity is required")
    heights = []
    captures = []
    for index in range(3):
        status = json.loads(_read_owned_endpoint(rpc_url, "/status", timeout))
        if not isinstance(status, dict) or status.get("error"):
            raise ValueError("invalid RPC status")
        status = status["result"]
        if status["node_info"]["id"] != node_id or status["node_info"]["network"] != chain_id:
            raise ValueError("status endpoint belongs to a different node or chain")
        height = status["sync_info"]["latest_block_height"]
        if not isinstance(height, str) or not re.fullmatch(r"0|[1-9][0-9]{0,18}", height):
            raise ValueError("invalid committed status height")
        heights.append(int(height))
        if index < 2:
            captures.append(capture_commit_metrics(url, chain_id, timeout, include_finalize_block))
    first, last = captures
    finalize_count = (last.get("finalize_block_histogram") or {}).get("count")
    if (len(set(heights)) != 1 or heights[0] < initial_height
            or first["count"] != last["count"] or first["sum_seconds"] != last["sum_seconds"]
            or first.get("finalize_block_histogram") != last.get("finalize_block_histogram")
            or last["count"] != heights[0] - initial_height
            or (include_finalize_block and finalize_count != heights[0] - initial_height)):
        raise ValueError("Commit observation boundary is moving or not fully observed")
    return {**last, "committed_height": heights[0], "boundary_fence": {
        "node_id": node_id, "process_initial_height": initial_height,
        "status_heights": heights, "captures": captures,
        "fully_observed": True}}


def summarize_finalize_block_histogram(before, after, expected_blocks):
    """Return nearest-rank quantile bucket upper bounds for one fenced interval."""
    expected = _integer(expected_blocks, "expected FinalizeBlock observations")
    if before.get("chain_id") != after.get("chain_id") or not before.get("chain_id"):
        raise ValueError("FinalizeBlock histogram chain changed")
    old = {row["le"]: _integer(row["count"], "FinalizeBlock bucket count")
           for row in before.get("buckets", [])}
    new = {row["le"]: _integer(row["count"], "FinalizeBlock bucket count")
           for row in after.get("buckets", [])}
    if set(old) != set(new) or "+Inf" not in old:
        raise ValueError("FinalizeBlock histogram bucket layout changed")
    count = _integer(after.get("count"), "FinalizeBlock count") - _integer(
        before.get("count"), "FinalizeBlock count")
    deltas = {key: new[key] - old[key] for key in old}
    ordered = sorted(((Decimal(key), key, value) for key, value in deltas.items() if key != "+Inf"))
    ordered.append((Decimal("Infinity"), "+Inf", deltas["+Inf"]))
    if count < 0 or count != expected or deltas["+Inf"] != count or any(
            value < 0 for value in deltas.values()) or any(
                current[2] < previous[2] for previous, current in zip(ordered, ordered[1:])):
        raise ValueError("FinalizeBlock histogram delta does not match the fenced block range")
    if count == 0:
        raise ValueError("FinalizeBlock histogram interval is empty")
    quantiles = {}
    for percentile in (50, 95, 99):
        rank = (percentile * count + 99) // 100
        _, bucket, _ = next(row for row in ordered if row[2] >= rank)
        quantiles[f"p{percentile}"] = {
            "bucket": bucket, "upper_bound_seconds": None if bucket == "+Inf" else bucket,
            "known": bucket != "+Inf"}
    return {"boundary": "native CometBFT sync FinalizeBlock histogram bucket upper bounds",
            "chain_id": before["chain_id"], "observed_blocks": count,
            "quantiles": quantiles, "buckets": [{"le": key, "count": value}
                                                  for _, key, value in ordered],
            "p95_within_650ms": quantiles["p95"]["known"] and
                Decimal(quantiles["p95"]["upper_bound_seconds"]) <= Decimal("0.65")}


def _sum_bounds(count, total):
    """Outward bounds for Go's float64 duration conversion and cumulative sum.

    Unit roundoff is 2^-53. At most count additions plus three rounding operations
    in Duration.Seconds are conservatively covered by k=count+4. Products of k
    (1 +/- u) factors lie between 1-k*u and 1/(1-k*u). Decimal.from_float recovers
    the actual Prometheus float from its round-trip text; directed 100-digit
    arithmetic also rounds this error envelope outward. Nonzero Go durations are
    nanoseconds, so subnormal underflow is not a possible observation.
    """
    if count == 0:
        return Decimal(0), Decimal(0)
    with localcontext() as ctx:
        ctx.prec = 100
        ctx.rounding = ROUND_FLOOR
        factor = Decimal(1) - Decimal(count + 4) / Decimal(1 << 53)
        lower = total * factor
        ctx.rounding = ROUND_CEILING
        upper = total / factor
    return lower, upper


def summarize_commit_metrics(samples, *, start_committed_height, end_committed_height,
                             boundaries_reconciled=False):
    """Weighted nearest-rank p95 upper bound, separately qualified for coverage.

    Driver must reconcile the baseline and final scrape with the declared block
    range after metric observation. Committed-height publication precedes the
    Commit histogram update, so a single concurrent height/metrics read is not a
    boundary fence. Missing trailing observations remain unqualified. Do not pass
    boundaries_reconciled=True without evidence for both phase boundaries.
    """
    start = _integer(start_committed_height, "start committed height")
    end = _integer(end_committed_height, "end committed height")
    if end < start or type(boundaries_reconciled) is not bool:
        raise ValueError("invalid committed range or boundary flag")
    if len(samples) < 2:
        raise ValueError("at least two captures are required")
    intervals = []
    previous = None
    for sample in samples:
        count = _integer(sample["count"], "count")
        if count > _MAX_COUNT:
            raise ValueError("count exceeds roundoff bound")
        total = _total(sample["sum_seconds"])
        if count == 0 and total != 0:
            raise ValueError("zero count has nonzero sum")
        chain = sample["chain_id"]
        if not isinstance(chain, str) or not chain:
            raise ValueError("chain_id is required")
        _integer(sample["wall_time_ns"], "wall time")
        began = _integer(sample["monotonic_start_ns"], "capture start")
        ended = _integer(sample["monotonic_end_ns"], "capture end")
        if ended < began:
            raise ValueError("capture timestamps are reversed")
        lower, upper = _sum_bounds(count, total)
        if previous is not None:
            old, old_total, old_lower = previous
            if chain != old["chain_id"]:
                raise ValueError("chain mismatch between captures")
            if began < old["monotonic_end_ns"]:
                raise ValueError("captures overlap or monotonic clock reset")
            delta = count - old["count"]
            if delta < 0 or total < old_total:
                raise ValueError("Commit metric counter reset")
            if delta == 0 and total != old_total:
                raise ValueError("sum changed without observations")
            if delta:
                with localcontext() as ctx:
                    ctx.prec = 100
                    ctx.rounding = ROUND_CEILING
                    bound = upper - old_lower
                intervals.append({"count": delta, "upper_bound_seconds": str(bound),
                                  "from_monotonic_start_ns": old["monotonic_start_ns"],
                                  "to_monotonic_end_ns": ended})
        previous = sample, total, lower
    observed = sum(interval["count"] for interval in intervals)
    reasons = []
    if not boundaries_reconciled:
        reasons.append("phase boundaries are not reconciled with completed Commit observations")
    if observed != end - start:
        reasons.append("observation count differs from committed block range; trailing or extra blocks are unresolved")
    if observed == 0:
        reasons.append("no completed Commit observations")
    def quantile(percent):
        if not observed:
            return None
        rank = (percent * observed + 99) // 100
        seen = 0
        for interval in sorted(intervals, key=lambda item: Decimal(item["upper_bound_seconds"])):
            seen += interval["count"]
            if seen >= rank:
                return interval["upper_bound_seconds"]
        raise ValueError("Commit interval counts do not cover the requested quantile")
    quantiles = {f"p{percent}_upper_bound_seconds": quantile(percent)
                 for percent in (50, 95, 99, 100)}
    p95 = quantiles["p95_upper_bound_seconds"]
    return {"boundary": BOUNDARY, "chain_id": samples[0]["chain_id"],
            "start_committed_height": start, "end_committed_height": end,
            "observed_blocks": observed, "qualified": not reasons,
            "qualification_reasons": reasons, "intervals": intervals,
            **quantiles, "max_upper_bound_seconds": quantiles["p100_upper_bound_seconds"],
            "within_700ms_budget": not reasons and p95 is not None and Decimal(p95) <= Decimal("0.7"),
            "excluded": "post-persistence state-transition tail, validator-key refresh, next-round scheduling"}


def stream_commit_metrics(url, chain_id, output, seconds, timeout=2.0):
    """Retain frequent raw samples; the driver still owns hard timeout/fences.

    No per-block timing is inferred here. Missed observations remain grouped
    upper bounds in summarize_commit_metrics rather than invented samples.
    """
    if type(seconds) is not int or not 1 <= seconds <= 1100 or not os.path.isabs(output):
        raise ValueError("stream requires absolute new output and 1..1100 seconds")
    end = time.clock_gettime_ns(time.CLOCK_MONOTONIC) + seconds * 10**9
    count = 0
    with open(output, "x", opener=lambda path, flags: os.open(path, flags, 0o600)) as target:
        while time.clock_gettime_ns(time.CLOCK_MONOTONIC) < end:
            value = capture_commit_metrics(url, chain_id, timeout)
            target.write(json.dumps(value, sort_keys=True) + "\n")
            target.flush()
            count += 1
            remaining = (end - time.clock_gettime_ns(time.CLOCK_MONOTONIC)) / 1e9
            if remaining > 0:
                time.sleep(min(0.2, remaining))
    return dict(path=output, samples=count, qualification=False)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("url")
    parser.add_argument("chain_id")
    parser.add_argument("--timeout", type=float, default=2.0)
    parser.add_argument("--rpc-url")
    parser.add_argument("--node-id")
    parser.add_argument("--process-initial-height", type=int)
    parser.add_argument("--stream-output")
    parser.add_argument("--stream-seconds", type=int)
    parser.add_argument("--finalize-block-histogram", action="store_true")
    args = parser.parse_args()
    fenced = (args.rpc_url, args.node_id, args.process_initial_height)
    if args.stream_output is not None or args.stream_seconds is not None:
        if args.stream_output is None or args.stream_seconds is None or any(value is not None for value in fenced):
            parser.error("stream requires output/seconds and excludes per-scrape fences")
        result = stream_commit_metrics(args.url, args.chain_id, args.stream_output, args.stream_seconds, args.timeout)
    elif any(value is not None for value in fenced):
        if any(value is None for value in fenced):
            parser.error("fenced capture requires RPC URL, node ID and process initial height")
        result = capture_fenced_commit_metrics(args.url, args.chain_id, *fenced, args.timeout,
                                               args.finalize_block_histogram)
    else:
        result = capture_commit_metrics(args.url, args.chain_id, args.timeout,
                                        args.finalize_block_histogram)
    print(json.dumps(result, sort_keys=True))
