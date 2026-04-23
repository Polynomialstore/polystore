#!/usr/bin/env python3
"""Deterministic enforcement-policy simulator for PolyStore Mode 2 devnets.

This is intentionally a policy harness, not a process-level devnet launcher. It
models the same surfaces the chain/gateway enforce today: providers, Mode 2
slots, retrieval sessions, organic credits, synthetic quota fill, deputy-served
misses, hard faults, and make-before-break repair.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import random
import sys
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Iterable


BLOB_SIZE_BYTES = 128 * 1024
BLOBS_PER_MDU = 64
SLOT_ACTIVE = "ACTIVE"
SLOT_REPAIRING = "REPAIRING"


@dataclass(frozen=True)
class SimConfig:
    scenario: str = "ideal"
    seed: int = 7
    providers: int = 48
    users: int = 80
    deals: int = 24
    epochs: int = 12
    k: int = 8
    m: int = 4
    user_mdus_per_deal: int = 16
    witness_mdus: int = 1
    retrievals_per_user_per_epoch: int = 1
    quota_bps_per_epoch: int = 50
    quota_min_blobs: int = 2
    quota_max_blobs: int = 8
    credit_cap_bps: int = 0
    evict_after_missed_epochs: int = 2
    deputy_evict_after_missed_epochs: int = 1
    repair_epochs: int = 2
    route_attempt_limit: int = 12

    @property
    def n(self) -> int:
        return self.k + self.m

    @property
    def rows(self) -> int:
        if self.k <= 0:
            return 0
        return BLOBS_PER_MDU // self.k

    def validate(self) -> None:
        if self.providers <= 0:
            raise ValueError("providers must be positive")
        if self.users <= 0:
            raise ValueError("users must be positive")
        if self.deals <= 0:
            raise ValueError("deals must be positive")
        if self.epochs <= 0:
            raise ValueError("epochs must be positive")
        if self.k <= 0 or self.m < 0:
            raise ValueError("k must be positive and m must be non-negative")
        if BLOBS_PER_MDU % self.k != 0:
            raise ValueError("k must divide 64 so Mode 2 slot rows are integral")
        if self.providers < self.n:
            raise ValueError("providers must be >= k+m")
        if self.route_attempt_limit < self.k:
            raise ValueError("route_attempt_limit must be >= k")


@dataclass
class ProviderBehavior:
    offline_epochs: set[int] = field(default_factory=set)
    online_probability: float = 1.0
    corrupt_rate: float = 0.0
    withhold_rate: float = 0.0
    invalid_proof_rate: float = 0.0
    synthetic_participation: float = 1.0
    draining: bool = False


@dataclass
class Provider:
    provider_id: str
    behavior: ProviderBehavior = field(default_factory=ProviderBehavior)
    hard_faults: int = 0
    retrieval_attempts: int = 0
    retrieval_successes: int = 0
    corrupt_responses: int = 0
    withheld_responses: int = 0
    offline_responses: int = 0
    rewards_earned_slots: int = 0


@dataclass
class SlotState:
    slot: int
    provider_id: str
    status: str = SLOT_ACTIVE
    pending_provider_id: str | None = None
    repair_remaining_epochs: int = 0
    missed_epochs: int = 0
    deputy_missed_epochs: int = 0
    current_gen: int = 1
    credits_raw: int = 0
    credits_applied: int = 0
    synthetic: int = 0
    direct_served: int = 0
    deputy_served: int = 0
    hard_faulted_this_epoch: bool = False

    def reset_epoch(self) -> None:
        self.credits_raw = 0
        self.credits_applied = 0
        self.synthetic = 0
        self.direct_served = 0
        self.deputy_served = 0
        self.hard_faulted_this_epoch = False


@dataclass
class DealState:
    deal_id: int
    k: int
    m: int
    user_mdus: int
    witness_mdus: int
    slots: list[SlotState]

    @property
    def n(self) -> int:
        return self.k + self.m

    @property
    def rows(self) -> int:
        return BLOBS_PER_MDU // self.k


@dataclass
class EpochMetrics:
    epoch: int
    retrieval_attempts: int = 0
    retrieval_successes: int = 0
    unavailable_reads: int = 0
    direct_served: int = 0
    deputy_served: int = 0
    corrupt_responses: int = 0
    withheld_responses: int = 0
    offline_responses: int = 0
    invalid_proofs: int = 0
    quota_misses: int = 0
    deputy_misses: int = 0
    compliant_slots: int = 0
    reward_eligible_slots: int = 0
    active_slots: int = 0
    repairing_slots: int = 0
    repairs_started: int = 0
    repairs_completed: int = 0
    paid_corrupt_bytes: int = 0


@dataclass
class AssertionResult:
    name: str
    passed: bool
    detail: str


@dataclass
class SimResult:
    config: dict[str, Any]
    totals: dict[str, Any]
    epochs: list[dict[str, Any]]
    final_slots: dict[str, int]
    assertions: list[AssertionResult] = field(default_factory=list)

    def to_jsonable(self) -> dict[str, Any]:
        return {
            "config": self.config,
            "totals": self.totals,
            "epochs": self.epochs,
            "final_slots": self.final_slots,
            "assertions": [asdict(item) for item in self.assertions],
        }


class PolicySimulator:
    def __init__(self, config: SimConfig, extra_faults: Iterable[str] = ()):
        config.validate()
        self.config = config
        self.extra_faults = list(extra_faults)
        self.rng = random.Random(config.seed)
        self.providers: dict[str, Provider] = {
            self.provider_id(i): Provider(self.provider_id(i)) for i in range(config.providers)
        }
        self.deals = self._build_deals()
        self.metrics: list[EpochMetrics] = []
        self._apply_builtin_scenario(config.scenario)
        for fault in self.extra_faults:
            self.apply_fault(fault)

    @staticmethod
    def provider_id(index: int) -> str:
        return f"sp-{index:03d}"

    def _build_deals(self) -> list[DealState]:
        deals: list[DealState] = []
        for deal_idx in range(self.config.deals):
            start = (deal_idx * self.config.n) % self.config.providers
            slots = []
            for slot_idx in range(self.config.n):
                pid = self.provider_id((start + slot_idx) % self.config.providers)
                slots.append(SlotState(slot=slot_idx, provider_id=pid))
            deals.append(
                DealState(
                    deal_id=deal_idx + 1,
                    k=self.config.k,
                    m=self.config.m,
                    user_mdus=self.config.user_mdus_per_deal,
                    witness_mdus=self.config.witness_mdus,
                    slots=slots,
                )
            )
        return deals

    def _apply_builtin_scenario(self, scenario: str) -> None:
        if scenario == "ideal":
            return
        if scenario == "single-outage":
            self.providers["sp-000"].behavior.offline_epochs.update(range(2, 6))
            return
        if scenario == "malicious-corrupt":
            behavior = self.providers["sp-000"].behavior
            behavior.corrupt_rate = 1.0
            behavior.invalid_proof_rate = 1.0
            return
        if scenario == "withholding":
            behavior = self.providers["sp-000"].behavior
            behavior.withhold_rate = 1.0
            behavior.synthetic_participation = 0.0
            return
        if scenario == "lazy-provider":
            self.providers["sp-000"].behavior.synthetic_participation = 0.0
            return
        raise ValueError(f"unknown scenario {scenario!r}")

    def apply_fault(self, raw: str) -> None:
        parts = raw.split(":")
        if len(parts) < 2:
            raise ValueError(f"invalid fault {raw!r}")
        kind, provider_id = parts[0], parts[1]
        if provider_id not in self.providers:
            raise ValueError(f"unknown provider in fault {raw!r}")
        behavior = self.providers[provider_id].behavior

        if kind == "offline":
            if len(parts) != 3:
                raise ValueError("offline fault format: offline:sp-000:2-5")
            behavior.offline_epochs.update(parse_epoch_range(parts[2]))
            return
        if kind == "corrupt":
            behavior.corrupt_rate = parse_probability(parts, raw)
            return
        if kind == "withhold":
            behavior.withhold_rate = parse_probability(parts, raw)
            return
        if kind == "invalid-proof":
            behavior.invalid_proof_rate = parse_probability(parts, raw)
            return
        if kind == "lazy":
            behavior.synthetic_participation = 0.0
            return
        if kind == "draining":
            behavior.draining = True
            return
        raise ValueError(f"unknown fault kind in {raw!r}")

    def run(self) -> SimResult:
        for epoch in range(1, self.config.epochs + 1):
            self.metrics.append(self._run_epoch(epoch))
        totals = self._totals()
        result_config = asdict(self.config)
        result_config["faults"] = list(self.extra_faults)
        return SimResult(
            config=result_config,
            totals=totals,
            epochs=[asdict(m) for m in self.metrics],
            final_slots=self._final_slots(),
        )

    def _run_epoch(self, epoch: int) -> EpochMetrics:
        for deal in self.deals:
            for slot in deal.slots:
                slot.reset_epoch()

        metrics = EpochMetrics(epoch=epoch)
        online = self._epoch_online_map(epoch)

        for _ in range(self.config.users * self.config.retrievals_per_user_per_epoch):
            self._simulate_retrieval(epoch, online, metrics)

        for deal in self.deals:
            for slot in deal.slots:
                if slot.status == SLOT_REPAIRING:
                    metrics.repairing_slots += 1
                    self._advance_repair(epoch, online, deal, slot, metrics)
                    continue
                metrics.active_slots += 1
                self._settle_slot_epoch(epoch, online, deal, slot, metrics)

        return metrics

    def _epoch_online_map(self, epoch: int) -> dict[str, bool]:
        out: dict[str, bool] = {}
        for provider_id, provider in self.providers.items():
            behavior = provider.behavior
            if epoch in behavior.offline_epochs:
                out[provider_id] = False
            else:
                out[provider_id] = self.rng.random() <= behavior.online_probability
        return out

    def _simulate_retrieval(
        self,
        epoch: int,
        online: dict[str, bool],
        metrics: EpochMetrics,
    ) -> None:
        metrics.retrieval_attempts += 1
        deal = self.rng.choice(self.deals)
        order = list(range(deal.n))
        self.rng.shuffle(order)
        max_attempts = min(len(order), self.config.route_attempt_limit)
        successes = 0
        failed_slots: list[SlotState] = []

        for slot_idx in order[:max_attempts]:
            slot = deal.slots[slot_idx]
            if slot.status == SLOT_REPAIRING and slot.pending_provider_id:
                provider_id = slot.pending_provider_id
            else:
                provider_id = slot.provider_id

            outcome = self._serve_from_provider(provider_id, online)
            if outcome == "ok":
                successes += 1
                slot.credits_raw += 1
                slot.direct_served += 1
                metrics.direct_served += 1
                if successes >= deal.k:
                    break
                continue

            failed_slots.append(slot)
            if outcome == "corrupt":
                metrics.corrupt_responses += 1
                metrics.invalid_proofs += 1
                self.providers[provider_id].hard_faults += 1
                self._start_repair(epoch, deal, slot, "corrupt_retrieval", metrics)
            elif outcome == "withheld":
                metrics.withheld_responses += 1
            else:
                metrics.offline_responses += 1

        if successes >= deal.k:
            metrics.retrieval_successes += 1
            for slot in failed_slots:
                if slot.direct_served == 0:
                    slot.deputy_served += 1
                    metrics.deputy_served += 1
            return

        metrics.unavailable_reads += 1

    def _serve_from_provider(self, provider_id: str, online: dict[str, bool]) -> str:
        provider = self.providers[provider_id]
        provider.retrieval_attempts += 1
        if not online.get(provider_id, False):
            provider.offline_responses += 1
            return "offline"

        behavior = provider.behavior
        roll = self.rng.random()
        if roll < behavior.corrupt_rate:
            provider.corrupt_responses += 1
            return "corrupt"

        roll = self.rng.random()
        if roll < behavior.withhold_rate:
            provider.withheld_responses += 1
            return "withheld"

        provider.retrieval_successes += 1
        return "ok"

    def _settle_slot_epoch(
        self,
        epoch: int,
        online: dict[str, bool],
        deal: DealState,
        slot: SlotState,
        metrics: EpochMetrics,
    ) -> None:
        quota = self._required_blobs(deal)
        credit_cap = ceil_div(quota * self.config.credit_cap_bps, 10_000)
        slot.credits_applied = min(slot.credits_raw, credit_cap)
        needed_synthetic = max(0, quota - slot.credits_applied)
        provider = self.providers[slot.provider_id]
        behavior = provider.behavior

        if (
            needed_synthetic > 0
            and online.get(slot.provider_id, False)
            and self.rng.random() <= behavior.synthetic_participation
        ):
            if self.rng.random() < behavior.invalid_proof_rate:
                metrics.invalid_proofs += 1
                provider.hard_faults += 1
                slot.hard_faulted_this_epoch = True
                self._start_repair(epoch, deal, slot, "invalid_synthetic_proof", metrics)
            else:
                slot.synthetic = needed_synthetic

        total = slot.credits_applied + slot.synthetic

        if slot.deputy_served > 0 and slot.direct_served == 0:
            slot.deputy_missed_epochs += 1
            metrics.deputy_misses += 1
            if slot.deputy_missed_epochs >= self.config.deputy_evict_after_missed_epochs:
                self._start_repair(epoch, deal, slot, "deputy_served_zero_direct", metrics)
        elif slot.direct_served > 0:
            slot.deputy_missed_epochs = 0

        if total < quota:
            slot.missed_epochs += 1
            metrics.quota_misses += 1
            if slot.missed_epochs >= self.config.evict_after_missed_epochs:
                self._start_repair(epoch, deal, slot, "quota_shortfall", metrics)
            return

        slot.missed_epochs = 0
        metrics.compliant_slots += 1
        if not slot.hard_faulted_this_epoch and slot.status == SLOT_ACTIVE:
            metrics.reward_eligible_slots += 1
            provider.rewards_earned_slots += 1

    def _advance_repair(
        self,
        epoch: int,
        online: dict[str, bool],
        deal: DealState,
        slot: SlotState,
        metrics: EpochMetrics,
    ) -> None:
        pending = slot.pending_provider_id
        if not pending:
            return
        if online.get(pending, False) and slot.repair_remaining_epochs > 0:
            slot.repair_remaining_epochs -= 1
        if slot.repair_remaining_epochs > 0:
            return

        old_provider = slot.provider_id
        slot.provider_id = pending
        slot.pending_provider_id = None
        slot.status = SLOT_ACTIVE
        slot.repair_remaining_epochs = 0
        slot.missed_epochs = 0
        slot.deputy_missed_epochs = 0
        slot.current_gen += 1
        metrics.repairs_completed += 1
        _ = old_provider

    def _start_repair(
        self,
        epoch: int,
        deal: DealState,
        slot: SlotState,
        reason: str,
        metrics: EpochMetrics,
    ) -> None:
        if slot.status == SLOT_REPAIRING:
            return
        pending = self._select_replacement(epoch, deal, slot)
        if not pending:
            return
        slot.status = SLOT_REPAIRING
        slot.pending_provider_id = pending
        slot.repair_remaining_epochs = self.config.repair_epochs
        slot.hard_faulted_this_epoch = slot.hard_faulted_this_epoch or reason in {
            "corrupt_retrieval",
            "invalid_synthetic_proof",
        }
        metrics.repairs_started += 1

    def _select_replacement(self, epoch: int, deal: DealState, slot: SlotState) -> str | None:
        excluded = {s.provider_id for s in deal.slots}
        excluded.update(s.pending_provider_id for s in deal.slots if s.pending_provider_id)
        candidates = [
            pid
            for pid, p in self.providers.items()
            if pid not in excluded and not p.behavior.draining
        ]

        if not candidates:
            candidates = [
                pid
                for pid, p in self.providers.items()
                if pid != slot.provider_id and not p.behavior.draining
            ]
        if not candidates:
            return None

        seed = f"{self.config.seed}:{epoch}:{deal.deal_id}:{slot.slot}:{slot.current_gen}"
        return min(candidates, key=lambda pid: stable_digest(seed, pid))

    def _required_blobs(self, deal: DealState) -> int:
        slot_bytes = deal.user_mdus * deal.rows * BLOB_SIZE_BYTES
        target_bytes = ceil_div(slot_bytes * self.config.quota_bps_per_epoch, 10_000)
        target_blobs = max(1, ceil_div(target_bytes, BLOB_SIZE_BYTES))
        return max(self.config.quota_min_blobs, min(target_blobs, self.config.quota_max_blobs))

    def _totals(self) -> dict[str, Any]:
        fields = [
            "retrieval_attempts",
            "retrieval_successes",
            "unavailable_reads",
            "direct_served",
            "deputy_served",
            "corrupt_responses",
            "withheld_responses",
            "offline_responses",
            "invalid_proofs",
            "quota_misses",
            "deputy_misses",
            "compliant_slots",
            "reward_eligible_slots",
            "active_slots",
            "repairing_slots",
            "repairs_started",
            "repairs_completed",
            "paid_corrupt_bytes",
        ]
        totals = {name: sum(getattr(m, name) for m in self.metrics) for name in fields}
        attempts = totals["retrieval_attempts"]
        successes = totals["retrieval_successes"]
        active_slots = totals["active_slots"]
        totals["success_rate"] = successes / attempts if attempts else 0.0
        totals["reward_coverage"] = (
            totals["reward_eligible_slots"] / active_slots if active_slots else 0.0
        )
        totals["provider_hard_faults"] = sum(p.hard_faults for p in self.providers.values())
        return totals

    def _final_slots(self) -> dict[str, int]:
        active = 0
        repairing = 0
        for deal in self.deals:
            for slot in deal.slots:
                if slot.status == SLOT_REPAIRING:
                    repairing += 1
                else:
                    active += 1
        return {"active": active, "repairing": repairing}


def evaluate_assertions(result: SimResult, min_success_rate: float | None = None) -> list[AssertionResult]:
    scenario = result.config["scenario"]
    has_custom_faults = bool(result.config.get("faults"))
    totals = result.totals
    checks: list[AssertionResult] = []

    def add(name: str, passed: bool, detail: str) -> None:
        checks.append(AssertionResult(name=name, passed=passed, detail=detail))

    if min_success_rate is not None:
        add(
            "min_success_rate",
            totals["success_rate"] >= min_success_rate,
            f"success_rate={totals['success_rate']:.4f}, required={min_success_rate:.4f}",
        )

    if has_custom_faults:
        result.assertions = checks
        return checks

    if scenario == "ideal":
        add("ideal_no_unavailable_reads", totals["unavailable_reads"] == 0, str(totals["unavailable_reads"]))
        add("ideal_no_repairs", totals["repairs_started"] == 0, str(totals["repairs_started"]))
        add("ideal_no_invalid_proofs", totals["invalid_proofs"] == 0, str(totals["invalid_proofs"]))
        add("ideal_no_quota_misses", totals["quota_misses"] == 0, str(totals["quota_misses"]))
        add(
            "ideal_full_reward_coverage",
            totals["reward_coverage"] == 1.0,
            f"reward_coverage={totals['reward_coverage']:.4f}",
        )
    elif scenario == "single-outage":
        add(
            "outage_retrievals_remain_available",
            totals["success_rate"] >= 0.99,
            f"success_rate={totals['success_rate']:.4f}",
        )
        add("outage_triggers_repair", totals["repairs_started"] >= 1, str(totals["repairs_started"]))
        add("outage_completes_repair", totals["repairs_completed"] >= 1, str(totals["repairs_completed"]))
        add("outage_no_corrupt_payment", totals["paid_corrupt_bytes"] == 0, str(totals["paid_corrupt_bytes"]))
    elif scenario == "malicious-corrupt":
        add("malicious_detected", totals["invalid_proofs"] >= 1, str(totals["invalid_proofs"]))
        add("malicious_triggers_repair", totals["repairs_started"] >= 1, str(totals["repairs_started"]))
        add(
            "malicious_corrupt_bytes_not_paid",
            totals["paid_corrupt_bytes"] == 0,
            str(totals["paid_corrupt_bytes"]),
        )
        add(
            "malicious_route_around",
            totals["success_rate"] >= 0.95,
            f"success_rate={totals['success_rate']:.4f}",
        )
    elif scenario == "withholding":
        add("withholding_detected", totals["withheld_responses"] >= 1, str(totals["withheld_responses"]))
        add("withholding_triggers_repair", totals["repairs_started"] >= 1, str(totals["repairs_started"]))
        add(
            "withholding_route_around",
            totals["success_rate"] >= 0.95,
            f"success_rate={totals['success_rate']:.4f}",
        )
    elif scenario == "lazy-provider":
        add("lazy_quota_miss_detected", totals["quota_misses"] >= 1, str(totals["quota_misses"]))
        add("lazy_triggers_repair", totals["repairs_started"] >= 1, str(totals["repairs_started"]))

    result.assertions = checks
    return checks


def stable_digest(*parts: str) -> str:
    h = hashlib.sha256()
    for part in parts:
        h.update(part.encode("utf-8"))
        h.update(b"\0")
    return h.hexdigest()


def ceil_div(num: int, denom: int) -> int:
    if denom <= 0:
        raise ValueError("denom must be positive")
    return (num + denom - 1) // denom


def parse_epoch_range(raw: str) -> set[int]:
    out: set[int] = set()
    for chunk in raw.split(","):
        chunk = chunk.strip()
        if not chunk:
            continue
        if "-" in chunk:
            start_s, end_s = chunk.split("-", 1)
            start = int(start_s)
            end = int(end_s)
            if end < start:
                raise ValueError(f"invalid epoch range {raw!r}")
            out.update(range(start, end + 1))
        else:
            out.add(int(chunk))
    return out


def parse_probability(parts: list[str], raw: str) -> float:
    if len(parts) != 3:
        raise ValueError(f"fault requires probability: {raw!r}")
    value = float(parts[2])
    if value < 0 or value > 1:
        raise ValueError(f"probability must be in [0,1]: {raw!r}")
    return value


def write_json(path: Path, result: SimResult) -> None:
    path.write_text(json.dumps(result.to_jsonable(), indent=2, sort_keys=True) + "\n", encoding="utf-8")


def write_csv(path: Path, result: SimResult) -> None:
    epochs = result.epochs
    if not epochs:
        path.write_text("", encoding="utf-8")
        return
    with path.open("w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=list(epochs[0].keys()))
        writer.writeheader()
        writer.writerows(epochs)


def print_summary(result: SimResult) -> None:
    totals = result.totals
    print("PolyStore policy simulation")
    print(f"scenario={result.config['scenario']} seed={result.config['seed']}")
    print(
        "providers={providers} users={users} deals={deals} epochs={epochs} rs={k}+{m}".format(
            **result.config
        )
    )
    print(
        "success_rate={success_rate:.4f} reward_coverage={reward_coverage:.4f} "
        "repairs_started={repairs_started} repairs_completed={repairs_completed}".format(**totals)
    )
    print(
        "quota_misses={quota_misses} deputy_misses={deputy_misses} "
        "invalid_proofs={invalid_proofs} unavailable_reads={unavailable_reads}".format(**totals)
    )
    if result.assertions:
        failed = [item for item in result.assertions if not item.passed]
        status = "failed" if failed else "passed"
        print(f"assertions={status} ({len(result.assertions) - len(failed)}/{len(result.assertions)})")
        for item in result.assertions:
            prefix = "PASS" if item.passed else "FAIL"
            print(f"  {prefix} {item.name}: {item.detail}")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--scenario",
        default="ideal",
        choices=["ideal", "single-outage", "malicious-corrupt", "withholding", "lazy-provider"],
    )
    parser.add_argument("--seed", type=int, default=7)
    parser.add_argument("--providers", type=int, default=48)
    parser.add_argument("--users", type=int, default=80)
    parser.add_argument("--deals", type=int, default=24)
    parser.add_argument("--epochs", type=int, default=12)
    parser.add_argument("--k", type=int, default=8)
    parser.add_argument("--m", type=int, default=4)
    parser.add_argument("--user-mdus-per-deal", type=int, default=16)
    parser.add_argument("--retrievals-per-user-per-epoch", type=int, default=1)
    parser.add_argument("--quota-min-blobs", type=int, default=2)
    parser.add_argument("--quota-max-blobs", type=int, default=8)
    parser.add_argument("--credit-cap-bps", type=int, default=0)
    parser.add_argument("--evict-after-missed-epochs", type=int, default=2)
    parser.add_argument("--repair-epochs", type=int, default=2)
    parser.add_argument(
        "--fault",
        action="append",
        default=[],
        help=(
            "fault injection, repeatable. Examples: offline:sp-000:2-5, "
            "corrupt:sp-001:0.25, withhold:sp-002:1, invalid-proof:sp-003:1, lazy:sp-004"
        ),
    )
    parser.add_argument("--assert", dest="assertions", action="store_true")
    parser.add_argument("--min-success-rate", type=float)
    parser.add_argument("--json-out", type=Path)
    parser.add_argument("--csv-out", type=Path)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    config = SimConfig(
        scenario=args.scenario,
        seed=args.seed,
        providers=args.providers,
        users=args.users,
        deals=args.deals,
        epochs=args.epochs,
        k=args.k,
        m=args.m,
        user_mdus_per_deal=args.user_mdus_per_deal,
        retrievals_per_user_per_epoch=args.retrievals_per_user_per_epoch,
        quota_min_blobs=args.quota_min_blobs,
        quota_max_blobs=args.quota_max_blobs,
        credit_cap_bps=args.credit_cap_bps,
        evict_after_missed_epochs=args.evict_after_missed_epochs,
        repair_epochs=args.repair_epochs,
    )
    sim = PolicySimulator(config, extra_faults=args.fault)
    result = sim.run()
    if args.assertions or args.min_success_rate is not None:
        evaluate_assertions(result, args.min_success_rate)
    if args.json_out:
        write_json(args.json_out, result)
    if args.csv_out:
        write_csv(args.csv_out, result)
    print_summary(result)
    if result.assertions and any(not item.passed for item in result.assertions):
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
