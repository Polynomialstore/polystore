"""Read retained completed proof-only evidence; never modifies the run home."""
import collections
import gzip
from decimal import Decimal
import json
from pathlib import Path
import sqlite3
import sys


def conservative_p95(intervals, start, end):
    # Boundary-crossing observations may fall in either step. Treat all as
    # infinite rather than dilute the target step with outside observations.
    inside, uncertain = [], 0
    for row in intervals:
        left, right = row['from_monotonic_start_ns'], row['to_monotonic_end_ns']
        if right <= start or left >= end:
            continue
        if left >= start and right <= end:
            inside.append((Decimal(row['upper_bound_seconds']), row['count']))
        else:
            uncertain += row['count']
    known = sum(count for _, count in inside)
    rank = (95 * (known + uncertain) + 99) // 100
    seen, bound = 0, None
    for value, count in sorted(inside):
        seen += count
        if seen >= rank:
            bound = str(value)
            break
    return dict(definite_observations=known, boundary_uncertain_observations=uncertain,
                p95_upper_bound_seconds=bound,
                budget_700ms_established=bound is not None and Decimal(bound) <= Decimal('0.7'))


def summarize(home):
    source = home / 'measurement.json' if (home / 'measurement.json').exists() else home / 'evidence.json'
    doc = json.loads(source.read_text())
    assert doc['status'] in ('sustained_retrieval_diagnostic_finished', 'failed')
    assert doc['offered_window_ns'] == doc['sustained_profile']['measurement_seconds'] * 10**9
    assert len(doc['commit_streams']) == len({s['node_id'] for s in doc['commit_streams']}) == 4
    assert all(s['summary']['qualified'] for s in doc['commit_streams'])
    assert doc['warmup']['all_committed']
    assert doc['committed_block_reconciliation']['all_four_results_agree']
    scheduler = doc['scheduler']
    start = scheduler['started_ns']
    seconds = doc['sustained_profile']['step_seconds']
    assert len(doc['sustained_profile']['rates']) * seconds == doc['sustained_profile']['measurement_seconds']
    if (home / 'sustained-transactions.jsonl.gz').exists():
        with gzip.open(home / 'sustained-transactions.jsonl.gz', 'rt') as source:
            rows = [json.loads(line) for line in source]
    else:
        with sqlite3.connect(f'file:{home / "sustained.sqlite"}?mode=ro', uri=True) as db:
            rows = [json.loads(row[0]) for row in db.execute('SELECT result FROM transactions')]
    assert len({r['id'] for r in rows}) == len(rows) == doc['sustained_profile']['measured_sessions']
    assert all(r['phase'] == 'measurement' for r in rows)
    unverified = [r for r in rows if r['outcome'] == 'committed_success' and not r.get('proof_state_verified')]
    assert not unverified, f'Committed proofs lack verified pinned state: {[r["id"] for r in unverified]}'
    steps = []
    for index, rate in enumerate(doc['sustained_profile']['rates']):
        left, right = start + index * seconds * 10**9, start + (index + 1) * seconds * 10**9
        offered = [r for r in rows if left <= r['offered_ns'] < right]
        observed = [r for r in rows if r['outcome'] == 'committed_success' and left <= r['finished_ns'] < right]
        queue = sorted(r['queue_latency_ns'] for r in offered if r.get('queue_latency_ns') is not None)
        offer_delay = sorted(r['started_ns'] - r['offered_ns'] for r in offered if r.get('started_ns') is not None)
        metrics = {stream['node_id']: conservative_p95(stream['summary']['intervals'], left, right)
                   for stream in doc['commit_streams']}
        steps.append(dict(offered_rate=rate, seconds=seconds, offered=len(offered),
            eventual_outcomes=dict(collections.Counter(r['outcome'] for r in offered)),
            committed_success_observed_in_step=len(observed),
            observed_committed_sessions_per_second=len(observed) / seconds,
            cohort_outcomes_recorded_at_or_after_step_end=sum(r['finished_ns'] >= right for r in offered),
            all_cohorts_pending_at_step_end=sum(r['offered_ns'] < right <= r['finished_ns'] for r in rows),
            unknown_recorded_by_step_end=sum(r['offered_ns'] < right and r['finished_ns'] < right and r['outcome'] == 'unknown' for r in rows),
            offered_to_started_p95_ms=offer_delay[(95 * len(offer_delay) + 99) // 100 - 1] / 10**6 if offer_delay else None,
            admitted_queue_p95_ms=queue[(95 * len(queue) + 99) // 100 - 1] / 10**6 if queue else None,
            commit_metrics=metrics))
    assert sum(step['offered'] for step in steps) == len(rows)
    end = start + len(steps) * seconds * 10**9
    return dict(qualification=False, run_status=doc['status'], run_error=doc.get('error'), measurement_seconds=len(steps) * seconds, steps=steps,
        total_outcomes=dict(collections.Counter(r['outcome'] for r in rows)),
        committed_success_observed_during_drain=sum(r['outcome'] == 'committed_success' and r['finished_ns'] >= end for r in rows),
        scheduler_elapsed_ns=scheduler['finished_ns'] - scheduler['started_ns'],
        outer_scheduler_and_drain_elapsed_ns=doc['scheduler_and_drain_elapsed_ns'],
        peak_queued=scheduler['peak_queued'], peak_in_flight=scheduler['peak_in_flight'],
        quarantined_signers=scheduler['quarantined_signers'],
        validator_peak_rss_bytes=[r['peak_rss_bytes'] for r in doc['validator_resources']],
        timing_scope='Completion observation includes committed transaction and pinned proof-state query; it is not the exact commit instant. Per-step metric bounds conservatively include boundary uncertainty. No delivery or settlement throughput.')


if __name__ == '__main__':
    if sys.argv[1:] == ['--self-test']:
        rows = [dict(from_monotonic_start_ns=1, to_monotonic_end_ns=9, count=100, upper_bound_seconds='0.6'),
                dict(from_monotonic_start_ns=9, to_monotonic_end_ns=11, count=1, upper_bound_seconds='0.1')]
        assert conservative_p95(rows, 0, 10)['budget_700ms_established']
        rows[1]['count'] = 6
        assert not conservative_p95(rows, 0, 10)['budget_700ms_established']
        assert conservative_p95([], 0, 10)['p95_upper_bound_seconds'] is None
        print('PASS: edge observations cannot dilute a step latency bound')
    else:
        print(json.dumps(summarize(Path(sys.argv[1])), indent=2))
