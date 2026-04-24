#!/usr/bin/env python3
"""Deterministic enforcement-policy simulator for PolyStore Mode 2 devnets.

This is intentionally a policy harness, not a process-level devnet launcher.
It models the same conceptual surfaces the chain/gateway enforce today:
providers, Mode 2 slots, retrieval sessions, organic credits, synthetic quota
fill, deputy-served misses, hard faults, make-before-break repair, and basic
market accounting.
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

try:
    from .parallel import map_parallel
except ImportError:  # Allows direct execution as a script.
    from parallel import map_parallel


BLOB_SIZE_BYTES = 128 * 1024
BLOBS_PER_MDU = 64
SLOT_ACTIVE = "ACTIVE"
SLOT_REPAIRING = "REPAIRING"
HEALTH_HEALTHY = "HEALTHY"
HEALTH_SUSPECT = "SUSPECT"
HEALTH_DELINQUENT = "DELINQUENT"
CAPABILITY_ACTIVE = "ACTIVE"
CAPABILITY_HIGH_BANDWIDTH = "HIGH_BANDWIDTH"
PROVIDER_ACTIVE = "ACTIVE"
PROVIDER_RESERVE = "RESERVE"
PROVIDER_PROBATION = "PROBATION"
SERVICE_COLD = "Cold"
SERVICE_GENERAL = "General"
SERVICE_HOT = "Hot"
PERFORMANCE_PLATINUM = "Platinum"
PERFORMANCE_GOLD = "Gold"
PERFORMANCE_SILVER = "Silver"
PERFORMANCE_FAIL = "Fail"
PERFORMANCE_TIERS = {
    PERFORMANCE_PLATINUM,
    PERFORMANCE_GOLD,
    PERFORMANCE_SILVER,
    PERFORMANCE_FAIL,
}
SERVICE_CLASSES = {SERVICE_COLD, SERVICE_GENERAL, SERVICE_HOT}

ENFORCEMENT_ORDER = {
    "MEASURE_ONLY": 0,
    "REPAIR_ONLY": 1,
    "REWARD_EXCLUSION": 2,
    "JAIL_SIMULATED": 3,
    "SLASH_SIMULATED": 4,
}

BUILTIN_NOOP_SCENARIOS = {
    "ideal",
    "setup-failure",
    "underpriced-storage",
    "wash-retrieval",
    "viral-public-retrieval",
    "elasticity-cap-hit",
    "elasticity-overlay-scaleup",
    "large-scale-regional-stress",
    "flapping-provider",
    "sustained-non-response",
    "audit-budget-exhaustion",
    "deputy-evidence-spam",
    "overpriced-storage",
    "demand-elasticity-recovery",
    "provider-cost-shock",
    "provider-economic-churn",
    "provider-supply-entry",
    "provider-bond-headroom",
    "retrieval-demand-shock",
    "price-controller-bounds",
    "subsidy-farming",
    "storage-escrow-close-refund",
    "coordinated-regional-outage",
    "repair-candidate-exhaustion",
    "replacement-grinding",
    "invalid-synthetic-proof",
    "staged-upload-grief",
    "high-bandwidth-promotion",
    "high-bandwidth-regression",
    "performance-market-latency",
    "operator-concentration-cap",
}

CLI_SCENARIOS = sorted(
    BUILTIN_NOOP_SCENARIOS
    | {
        "single-outage",
        "malicious-corrupt",
        "corrupt-provider",
        "withholding",
        "lazy-provider",
    }
)


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
    repair_attempt_cap_per_slot: int = 0
    repair_backoff_epochs: int = 0
    repair_pending_timeout_epochs: int = 0
    route_attempt_limit: int = 12
    enforcement_mode: str = "REWARD_EXCLUSION"
    dynamic_pricing: bool = False
    storage_price: float = 1.0
    storage_lockin_enabled: bool = False
    deal_duration_epochs: int = 0
    deal_close_epoch: int = 0
    deal_close_count: int = 0
    deal_close_bps: int = 0
    storage_price_min: float = 0.1
    storage_price_max: float = 20.0
    storage_target_utilization_bps: int = 7000
    retrieval_price_per_slot: float = 0.01
    retrieval_price_min: float = 0.001
    retrieval_price_max: float = 1.0
    retrieval_target_per_epoch: int = 80
    new_deal_requests_per_epoch: int = 0
    storage_demand_price_ceiling: float = 0.0
    storage_demand_reference_price: float = 0.0
    storage_demand_elasticity_bps: int = 0
    storage_demand_min_bps: int = 0
    storage_demand_max_bps: int = 10_000
    retrieval_demand_shocks: tuple[dict[str, Any], ...] = ()
    retrieval_base_fee: float = 0.001
    retrieval_burn_bps: int = 500
    sponsored_retrieval_bps: int = 0
    owner_retrieval_debit_bps: int = 0
    dynamic_pricing_max_step_bps: int = 500
    base_reward_per_slot: float = 0.02
    audit_budget_per_epoch: float = 1.0
    audit_cost_per_miss: float = 0.005
    evidence_spam_claims_per_epoch: int = 0
    evidence_spam_bond: float = 0.0
    evidence_spam_bounty: float = 0.0
    evidence_spam_conviction_bps: int = 0
    provider_slot_capacity: int = 16
    provider_capacity_min: int = 0
    provider_capacity_max: int = 0
    provider_bandwidth_capacity_per_epoch: int = 0
    provider_bandwidth_capacity_min: int = 0
    provider_bandwidth_capacity_max: int = 0
    service_class: str = SERVICE_GENERAL
    performance_market_enabled: bool = False
    provider_latency_ms_min: float = 0.0
    provider_latency_ms_max: float = 0.0
    provider_latency_jitter_bps: int = 0
    platinum_latency_ms: float = 100.0
    gold_latency_ms: float = 250.0
    silver_latency_ms: float = 500.0
    performance_reward_per_serve: float = 0.0
    platinum_reward_multiplier_bps: int = 15_000
    gold_reward_multiplier_bps: int = 10_000
    silver_reward_multiplier_bps: int = 5_000
    fail_reward_multiplier_bps: int = 0
    high_bandwidth_promotion_enabled: bool = False
    high_bandwidth_capacity_threshold: int = 0
    high_bandwidth_min_retrievals: int = 0
    high_bandwidth_min_success_rate_bps: int = 9900
    high_bandwidth_max_saturation_bps: int = 500
    high_bandwidth_demotion_saturation_bps: int = 0
    high_bandwidth_routing_enabled: bool = False
    hot_retrieval_bps: int = 0
    operator_count: int = 0
    dominant_operator_provider_bps: int = 0
    operator_assignment_cap_per_deal: int = 0
    provider_online_probability_min: float = 1.0
    provider_online_probability_max: float = 1.0
    provider_repair_probability_min: float = 1.0
    provider_repair_probability_max: float = 1.0
    provider_storage_cost_jitter_bps: int = 0
    provider_bandwidth_cost_jitter_bps: int = 0
    provider_cost_shocks: tuple[dict[str, Any], ...] = ()
    provider_churn_enabled: bool = False
    provider_churn_pnl_threshold: float = 0.0
    provider_churn_after_epochs: int = 1
    provider_churn_max_providers_per_epoch: int = 0
    provider_churn_min_remaining_providers: int = 0
    provider_entry_enabled: bool = False
    provider_entry_reserve_count: int = 0
    provider_entry_start_epoch: int = 1
    provider_entry_end_epoch: int = 0
    provider_entry_max_per_epoch: int = 1
    provider_entry_trigger_utilization_bps: int = 0
    provider_entry_trigger_storage_price: float = 0.0
    provider_entry_probation_epochs: int = 1
    provider_regions: tuple[str, ...] = ("global",)
    regional_outages: tuple[dict[str, Any], ...] = ()
    max_repairs_started_per_epoch: int = 0
    provider_storage_cost_per_slot_epoch: float = 0.01
    provider_bandwidth_cost_per_retrieval: float = 0.001
    provider_fixed_cost_per_epoch: float = 0.05
    provider_initial_bond: float = 100.0
    provider_min_bond: float = 0.0
    provider_bond_per_slot: float = 0.0
    slash_hard_fault: float = 1.0
    jail_epochs: int = 3
    elasticity_trigger_retrievals_per_epoch: int = 0
    elasticity_base_cost: float = 1.0
    elasticity_max_spend: float = 0.0
    elasticity_overlay_enabled: bool = False
    elasticity_overlay_providers_per_epoch: int = 0
    elasticity_overlay_max_providers_per_deal: int = 0
    elasticity_overlay_ready_delay_epochs: int = 1
    elasticity_overlay_ttl_epochs: int = 0
    staged_upload_attempts_per_epoch: int = 0
    staged_upload_mdu_per_attempt: int = 1
    staged_upload_commit_rate_bps: int = 10_000
    staged_upload_retention_epochs: int = 0
    staged_upload_max_pending_generations: int = 0

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
        if self.enforcement_mode not in ENFORCEMENT_ORDER:
            raise ValueError(f"unknown enforcement_mode {self.enforcement_mode!r}")
        if self.retrieval_burn_bps < 0 or self.retrieval_burn_bps > 10_000:
            raise ValueError("retrieval_burn_bps must be in [0, 10000]")
        if self.sponsored_retrieval_bps < 0 or self.sponsored_retrieval_bps > 10_000:
            raise ValueError("sponsored_retrieval_bps must be in [0, 10000]")
        if self.owner_retrieval_debit_bps < 0 or self.owner_retrieval_debit_bps > 10_000:
            raise ValueError("owner_retrieval_debit_bps must be in [0, 10000]")
        if self.new_deal_requests_per_epoch < 0:
            raise ValueError("new_deal_requests_per_epoch must be non-negative")
        if self.storage_demand_price_ceiling < 0:
            raise ValueError("storage_demand_price_ceiling must be non-negative")
        if self.storage_demand_reference_price < 0:
            raise ValueError("storage_demand_reference_price must be non-negative")
        if self.storage_demand_elasticity_bps < 0:
            raise ValueError("storage_demand_elasticity_bps must be non-negative")
        if self.storage_demand_min_bps < 0 or self.storage_demand_max_bps < 0:
            raise ValueError("storage demand bps bounds must be non-negative")
        if self.storage_demand_min_bps > self.storage_demand_max_bps:
            raise ValueError("storage_demand_min_bps must be <= storage_demand_max_bps")
        if self.deal_duration_epochs < 0:
            raise ValueError("deal_duration_epochs must be non-negative")
        if self.deal_close_epoch < 0:
            raise ValueError("deal_close_epoch must be non-negative")
        if self.deal_close_count < 0:
            raise ValueError("deal_close_count must be non-negative")
        if self.deal_close_bps < 0 or self.deal_close_bps > 10_000:
            raise ValueError("deal_close_bps must be in [0, 10000]")
        if not isinstance(self.retrieval_demand_shocks, (list, tuple)):
            raise ValueError("retrieval_demand_shocks must be a list")
        for shock in self.retrieval_demand_shocks:
            if not isinstance(shock, dict):
                raise ValueError("retrieval demand shock entries must be objects")
            start_epoch = int(shock.get("start_epoch", shock.get("epoch", 0)))
            if start_epoch <= 0:
                raise ValueError("retrieval demand shocks require positive start_epoch")
            end_epoch = int(shock.get("end_epoch", self.epochs))
            if end_epoch < start_epoch:
                raise ValueError("retrieval demand shock end_epoch must be >= start_epoch")
            if int(shock.get("multiplier_bps", 10_000)) < 0:
                raise ValueError("retrieval demand shock multiplier_bps must be non-negative")
        if self.provider_capacity_min < 0 or self.provider_capacity_max < 0:
            raise ValueError("provider capacity bounds must be non-negative")
        if self.provider_capacity_min and self.provider_capacity_max and self.provider_capacity_min > self.provider_capacity_max:
            raise ValueError("provider_capacity_min must be <= provider_capacity_max")
        if self.provider_bandwidth_capacity_min < 0 or self.provider_bandwidth_capacity_max < 0:
            raise ValueError("provider bandwidth capacity bounds must be non-negative")
        if (
            self.provider_bandwidth_capacity_min
            and self.provider_bandwidth_capacity_max
            and self.provider_bandwidth_capacity_min > self.provider_bandwidth_capacity_max
        ):
            raise ValueError("provider_bandwidth_capacity_min must be <= provider_bandwidth_capacity_max")
        if self.service_class not in SERVICE_CLASSES:
            raise ValueError(f"service_class must be one of {sorted(SERVICE_CLASSES)}")
        if self.provider_latency_ms_min < 0 or self.provider_latency_ms_max < 0:
            raise ValueError("provider latency bounds must be non-negative")
        if self.provider_latency_ms_min and self.provider_latency_ms_max and self.provider_latency_ms_min > self.provider_latency_ms_max:
            raise ValueError("provider_latency_ms_min must be <= provider_latency_ms_max")
        if self.provider_latency_jitter_bps < 0:
            raise ValueError("provider_latency_jitter_bps must be non-negative")
        if not (self.platinum_latency_ms <= self.gold_latency_ms <= self.silver_latency_ms):
            raise ValueError("latency tier thresholds must satisfy platinum <= gold <= silver")
        if self.performance_reward_per_serve < 0:
            raise ValueError("performance_reward_per_serve must be non-negative")
        if self.evidence_spam_claims_per_epoch < 0:
            raise ValueError("evidence_spam_claims_per_epoch must be non-negative")
        if self.evidence_spam_bond < 0 or self.evidence_spam_bounty < 0:
            raise ValueError("evidence spam bond and bounty must be non-negative")
        if not 0 <= self.evidence_spam_conviction_bps <= 10_000:
            raise ValueError("evidence_spam_conviction_bps must be in [0, 10000]")
        for key, value in {
            "platinum_reward_multiplier_bps": self.platinum_reward_multiplier_bps,
            "gold_reward_multiplier_bps": self.gold_reward_multiplier_bps,
            "silver_reward_multiplier_bps": self.silver_reward_multiplier_bps,
            "fail_reward_multiplier_bps": self.fail_reward_multiplier_bps,
        }.items():
            if value < 0:
                raise ValueError(f"{key} must be non-negative")
        if not 0 <= self.provider_online_probability_min <= self.provider_online_probability_max <= 1:
            raise ValueError("provider online probability bounds must be in [0, 1]")
        if not 0 <= self.provider_repair_probability_min <= self.provider_repair_probability_max <= 1:
            raise ValueError("provider repair probability bounds must be in [0, 1]")
        if not self.provider_regions:
            raise ValueError("provider_regions must not be empty")
        if self.repair_attempt_cap_per_slot < 0:
            raise ValueError("repair_attempt_cap_per_slot must be non-negative")
        if self.repair_backoff_epochs < 0:
            raise ValueError("repair_backoff_epochs must be non-negative")
        if self.repair_pending_timeout_epochs < 0:
            raise ValueError("repair_pending_timeout_epochs must be non-negative")
        if self.high_bandwidth_capacity_threshold < 0:
            raise ValueError("high_bandwidth_capacity_threshold must be non-negative")
        if self.high_bandwidth_min_retrievals < 0:
            raise ValueError("high_bandwidth_min_retrievals must be non-negative")
        for key, value in {
            "high_bandwidth_min_success_rate_bps": self.high_bandwidth_min_success_rate_bps,
            "high_bandwidth_max_saturation_bps": self.high_bandwidth_max_saturation_bps,
            "high_bandwidth_demotion_saturation_bps": self.high_bandwidth_demotion_saturation_bps,
            "hot_retrieval_bps": self.hot_retrieval_bps,
            "dominant_operator_provider_bps": self.dominant_operator_provider_bps,
        }.items():
            if value < 0 or value > 10_000:
                raise ValueError(f"{key} must be in [0, 10000]")
        if self.operator_count < 0:
            raise ValueError("operator_count must be non-negative")
        if self.operator_count > self.providers:
            raise ValueError("operator_count must be <= providers")
        if self.operator_assignment_cap_per_deal < 0:
            raise ValueError("operator_assignment_cap_per_deal must be non-negative")
        if not isinstance(self.provider_cost_shocks, (list, tuple)):
            raise ValueError("provider_cost_shocks must be a list")
        for shock in self.provider_cost_shocks:
            if not isinstance(shock, dict):
                raise ValueError("provider cost shock entries must be objects")
            start_epoch = int(shock.get("start_epoch", shock.get("epoch", 0)))
            if start_epoch <= 0:
                raise ValueError("provider cost shocks require positive start_epoch")
            end_epoch = int(shock.get("end_epoch", self.epochs))
            if end_epoch < start_epoch:
                raise ValueError("provider cost shock end_epoch must be >= start_epoch")
            for key in {
                "fixed_cost_multiplier_bps",
                "storage_cost_multiplier_bps",
                "bandwidth_cost_multiplier_bps",
            }:
                if int(shock.get(key, 10_000)) < 0:
                    raise ValueError(f"{key} must be non-negative")
        if self.provider_churn_after_epochs <= 0:
            raise ValueError("provider_churn_after_epochs must be positive")
        if self.provider_churn_max_providers_per_epoch < 0:
            raise ValueError("provider_churn_max_providers_per_epoch must be non-negative")
        if self.provider_churn_min_remaining_providers < 0:
            raise ValueError("provider_churn_min_remaining_providers must be non-negative")
        if self.provider_churn_min_remaining_providers > self.providers:
            raise ValueError("provider_churn_min_remaining_providers must be <= providers")
        if self.provider_initial_bond < 0:
            raise ValueError("provider_initial_bond must be non-negative")
        if self.provider_min_bond < 0:
            raise ValueError("provider_min_bond must be non-negative")
        if self.provider_bond_per_slot < 0:
            raise ValueError("provider_bond_per_slot must be non-negative")
        if self.provider_entry_reserve_count < 0:
            raise ValueError("provider_entry_reserve_count must be non-negative")
        if self.provider_entry_reserve_count > self.providers:
            raise ValueError("provider_entry_reserve_count must be <= providers")
        if self.providers - self.provider_entry_reserve_count < self.n:
            raise ValueError("active providers after reserve allocation must be >= K+M")
        if self.provider_entry_start_epoch <= 0:
            raise ValueError("provider_entry_start_epoch must be positive")
        if self.provider_entry_end_epoch < 0:
            raise ValueError("provider_entry_end_epoch must be non-negative")
        if (
            self.provider_entry_end_epoch
            and self.provider_entry_end_epoch < self.provider_entry_start_epoch
        ):
            raise ValueError("provider_entry_end_epoch must be 0 or >= provider_entry_start_epoch")
        if self.provider_entry_max_per_epoch < 0:
            raise ValueError("provider_entry_max_per_epoch must be non-negative")
        if not 0 <= self.provider_entry_trigger_utilization_bps <= 100_000:
            raise ValueError("provider_entry_trigger_utilization_bps must be in [0, 100000]")
        if self.provider_entry_trigger_storage_price < 0:
            raise ValueError("provider_entry_trigger_storage_price must be non-negative")
        if self.provider_entry_probation_epochs < 0:
            raise ValueError("provider_entry_probation_epochs must be non-negative")
        if self.elasticity_base_cost < 0:
            raise ValueError("elasticity_base_cost must be non-negative")
        if self.elasticity_max_spend < 0:
            raise ValueError("elasticity_max_spend must be non-negative")
        if self.elasticity_overlay_providers_per_epoch < 0:
            raise ValueError("elasticity_overlay_providers_per_epoch must be non-negative")
        if self.elasticity_overlay_max_providers_per_deal < 0:
            raise ValueError("elasticity_overlay_max_providers_per_deal must be non-negative")
        if self.elasticity_overlay_ready_delay_epochs < 0:
            raise ValueError("elasticity_overlay_ready_delay_epochs must be non-negative")
        if self.elasticity_overlay_ttl_epochs < 0:
            raise ValueError("elasticity_overlay_ttl_epochs must be non-negative")
        if self.staged_upload_attempts_per_epoch < 0:
            raise ValueError("staged_upload_attempts_per_epoch must be non-negative")
        if self.staged_upload_mdu_per_attempt <= 0:
            raise ValueError("staged_upload_mdu_per_attempt must be positive")
        if not 0 <= self.staged_upload_commit_rate_bps <= 10_000:
            raise ValueError("staged_upload_commit_rate_bps must be in [0, 10000]")
        if self.staged_upload_retention_epochs < 0:
            raise ValueError("staged_upload_retention_epochs must be non-negative")
        if self.staged_upload_max_pending_generations < 0:
            raise ValueError("staged_upload_max_pending_generations must be non-negative")


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
    initial_bond: float
    operator_id: str
    region: str = "global"
    capacity_slots: int = 16
    bandwidth_capacity_per_epoch: int = 0
    latency_ms: float = 0.0
    repair_success_probability: float = 1.0
    capability_tier: str = CAPABILITY_ACTIVE
    capability_reason: str = ""
    lifecycle_state: str = PROVIDER_ACTIVE
    entered_epoch: int = 0
    probation_until_epoch: int = 0
    supply_promoted_epoch: int = 0
    high_bandwidth_promoted_epoch: int = 0
    high_bandwidth_demoted_epoch: int = 0
    storage_cost_multiplier: float = 1.0
    bandwidth_cost_multiplier: float = 1.0
    behavior: ProviderBehavior = field(default_factory=ProviderBehavior)
    hard_faults: int = 0
    retrieval_attempts: int = 0
    retrieval_latent_attempts: int = 0
    retrieval_demand_shock_active: int = 0
    retrieval_demand_multiplier_bps: int = 10_000
    retrieval_successes: int = 0
    corrupt_responses: int = 0
    withheld_responses: int = 0
    offline_responses: int = 0
    saturated_responses: int = 0
    platinum_serves: int = 0
    gold_serves: int = 0
    silver_serves: int = 0
    fail_serves: int = 0
    latency_sample_count: int = 0
    total_latency_ms: float = 0.0
    rewards_earned_slots: int = 0
    reward_revenue: float = 0.0
    storage_fee_revenue: float = 0.0
    retrieval_revenue: float = 0.0
    performance_reward_revenue: float = 0.0
    total_cost: float = 0.0
    slashed: float = 0.0
    bond: float = 0.0
    jailed_until_epoch: int = 0
    churn_pressure_epochs: int = 0
    churned_epoch: int = 0

    def __post_init__(self) -> None:
        self.bond = self.initial_bond

    @property
    def revenue(self) -> float:
        return (
            self.reward_revenue
            + self.storage_fee_revenue
            + self.retrieval_revenue
            + self.performance_reward_revenue
        )

    @property
    def pnl(self) -> float:
        return self.revenue - self.total_cost - self.slashed


@dataclass
class SlotState:
    deal_id: int
    slot: int
    provider_id: str
    status: str = SLOT_ACTIVE
    pending_provider_id: str | None = None
    repair_remaining_epochs: int = 0
    repair_ready: bool = False
    repair_attempts: int = 0
    repair_backoff_until_epoch: int = 0
    repair_started_epoch: int = 0
    last_repair_attempt_epoch: int = 0
    missed_epochs: int = 0
    deputy_missed_epochs: int = 0
    current_gen: int = 1
    credits_raw: int = 0
    credits_applied: int = 0
    synthetic: int = 0
    direct_served: int = 0
    deputy_served: int = 0
    hard_faulted_this_epoch: bool = False
    durability_suspect: bool = False
    health_state: str = HEALTH_HEALTHY
    health_reason: str = ""
    compliant_this_epoch: bool = False
    reward_eligible_this_epoch: bool = False
    last_reason: str = ""

    def reset_epoch(self) -> None:
        self.credits_raw = 0
        self.credits_applied = 0
        self.synthetic = 0
        self.direct_served = 0
        self.deputy_served = 0
        self.hard_faulted_this_epoch = False
        self.compliant_this_epoch = False
        self.reward_eligible_this_epoch = False
        self.last_reason = ""


@dataclass
class DealState:
    deal_id: int
    k: int
    m: int
    user_mdus: int
    witness_mdus: int
    slots: list[SlotState]
    opened_epoch: int = 1
    closed_epoch: int = 0
    storage_escrow_locked: float = 0.0
    storage_fee_per_epoch: float = 0.0
    storage_fee_earned: float = 0.0
    storage_escrow_refunded: float = 0.0

    @property
    def n(self) -> int:
        return self.k + self.m

    @property
    def rows(self) -> int:
        return BLOBS_PER_MDU // self.k


@dataclass
class ElasticityOverlay:
    deal_id: int
    provider_id: str
    activated_epoch: int
    ready_epoch: int
    expire_epoch: int


@dataclass
class EpochMetrics:
    epoch: int
    retrieval_attempts: int = 0
    retrieval_successes: int = 0
    unavailable_reads: int = 0
    data_loss_events: int = 0
    direct_served: int = 0
    deputy_served: int = 0
    corrupt_responses: int = 0
    withheld_responses: int = 0
    offline_responses: int = 0
    saturated_responses: int = 0
    invalid_proofs: int = 0
    quota_misses: int = 0
    deputy_misses: int = 0
    compliant_slots: int = 0
    reward_eligible_slots: int = 0
    active_slots: int = 0
    repairing_slots: int = 0
    suspect_slots: int = 0
    delinquent_slots: int = 0
    repairs_started: int = 0
    repairs_ready: int = 0
    repairs_completed: int = 0
    repair_attempts: int = 0
    repair_backoffs: int = 0
    repair_cooldowns: int = 0
    repair_attempt_caps: int = 0
    repair_timeouts: int = 0
    high_bandwidth_promotions: int = 0
    high_bandwidth_demotions: int = 0
    high_bandwidth_providers: int = 0
    high_bandwidth_serves: int = 0
    hot_retrieval_attempts: int = 0
    hot_high_bandwidth_serves: int = 0
    max_operator_assignment_share_bps: int = 0
    max_operator_deal_slots: int = 0
    operator_deal_cap_violations: int = 0
    platinum_serves: int = 0
    gold_serves: int = 0
    silver_serves: int = 0
    fail_serves: int = 0
    latency_sample_count: int = 0
    total_latency_ms: float = 0.0
    performance_reward_paid: float = 0.0
    new_deal_latent_requests: int = 0
    new_deal_requests: int = 0
    new_deals_accepted: int = 0
    new_deals_suppressed_price: int = 0
    new_deals_rejected_price: int = 0
    new_deals_rejected_capacity: int = 0
    paid_corrupt_bytes: int = 0
    retrieval_base_burned: float = 0.0
    retrieval_variable_burned: float = 0.0
    retrieval_provider_payouts: float = 0.0
    storage_escrow_locked: float = 0.0
    storage_escrow_earned: float = 0.0
    storage_escrow_refunded: float = 0.0
    storage_escrow_outstanding: float = 0.0
    storage_fee_provider_payouts: float = 0.0
    storage_fee_burned: float = 0.0
    open_deals: int = 0
    deals_closed: int = 0
    sponsored_retrieval_attempts: int = 0
    owner_funded_retrieval_attempts: int = 0
    sponsored_retrieval_base_spent: float = 0.0
    sponsored_retrieval_variable_spent: float = 0.0
    owner_retrieval_escrow_debited: float = 0.0
    reward_pool_minted: float = 0.0
    reward_paid: float = 0.0
    reward_burned: float = 0.0
    audit_budget_minted: float = 0.0
    audit_budget_demand: float = 0.0
    audit_budget_spent: float = 0.0
    audit_budget_carryover: float = 0.0
    audit_budget_backlog: float = 0.0
    audit_budget_exhausted: int = 0
    evidence_spam_claims: int = 0
    evidence_spam_convictions: int = 0
    evidence_spam_bond_burned: float = 0.0
    evidence_spam_bounty_paid: float = 0.0
    evidence_spam_net_gain: float = 0.0
    provider_cost: float = 0.0
    provider_revenue: float = 0.0
    provider_pnl: float = 0.0
    provider_cost_shock_active: int = 0
    provider_cost_shocked_providers: int = 0
    provider_cost_shock_fixed_multiplier_bps: int = 10_000
    provider_cost_shock_storage_multiplier_bps: int = 10_000
    provider_cost_shock_bandwidth_multiplier_bps: int = 10_000
    churn_pressure_providers: int = 0
    provider_churn_events: int = 0
    churned_providers: int = 0
    provider_entries: int = 0
    provider_probation_promotions: int = 0
    provider_underbonded_repairs: int = 0
    underbonded_providers: int = 0
    underbonded_assigned_slots: int = 0
    provider_bond_required: float = 0.0
    provider_bond_available: float = 0.0
    provider_bond_deficit: float = 0.0
    reserve_providers: int = 0
    probationary_providers: int = 0
    entered_active_providers: int = 0
    active_provider_capacity: int = 0
    exited_provider_capacity: int = 0
    reserve_provider_capacity: int = 0
    probationary_provider_capacity: int = 0
    churned_assigned_slots: int = 0
    storage_price: float = 0.0
    retrieval_price_per_slot: float = 0.0
    storage_utilization_bps: int = 0
    elasticity_spent: float = 0.0
    elasticity_rejections: int = 0
    elasticity_overlay_activations: int = 0
    elasticity_overlay_ready: int = 0
    elasticity_overlay_active: int = 0
    elasticity_overlay_expired: int = 0
    elasticity_overlay_serves: int = 0
    elasticity_overlay_rejections: int = 0
    staged_upload_attempts: int = 0
    staged_upload_accepted: int = 0
    staged_upload_committed: int = 0
    staged_upload_rejections: int = 0
    staged_upload_cleaned: int = 0
    staged_upload_pending_generations: int = 0
    staged_upload_pending_mdus: int = 0


@dataclass
class AssertionResult:
    name: str
    passed: bool
    detail: str


@dataclass
class ScenarioSpec:
    name: str
    description: str = ""
    config: dict[str, Any] = field(default_factory=dict)
    faults: list[str] = field(default_factory=list)
    assertions: dict[str, Any] = field(default_factory=dict)


@dataclass
class SimResult:
    config: dict[str, Any]
    totals: dict[str, Any]
    epochs: list[dict[str, Any]]
    final_slots: dict[str, int]
    assertions: list[AssertionResult] = field(default_factory=list)
    providers: list[dict[str, Any]] = field(default_factory=list)
    slots: list[dict[str, Any]] = field(default_factory=list)
    evidence: list[dict[str, Any]] = field(default_factory=list)
    repairs: list[dict[str, Any]] = field(default_factory=list)
    economy: list[dict[str, Any]] = field(default_factory=list)
    operators: list[dict[str, Any]] = field(default_factory=list)

    def to_jsonable(self) -> dict[str, Any]:
        return {
            "config": self.config,
            "totals": self.totals,
            "epochs": self.epochs,
            "final_slots": self.final_slots,
            "assertions": [asdict(item) for item in self.assertions],
            "providers": self.providers,
            "slots": self.slots,
            "evidence": self.evidence,
            "repairs": self.repairs,
            "economy": self.economy,
            "operators": self.operators,
        }


class PolicySimulator:
    def __init__(self, config: SimConfig, extra_faults: Iterable[str] = ()):
        config.validate()
        self.config = config
        self.extra_faults = list(extra_faults)
        self.rng = random.Random(config.seed)
        self.providers = self._build_providers()
        self.deals = self._build_deals()
        self.metrics: list[EpochMetrics] = []
        self.evidence_rows: list[dict[str, Any]] = []
        self.repair_rows: list[dict[str, Any]] = []
        self.slot_rows: list[dict[str, Any]] = []
        self.economy_rows: list[dict[str, Any]] = []
        self.staged_uploads: list[dict[str, int]] = []
        self.elasticity_overlays: list[ElasticityOverlay] = []
        self.provider_epoch_serves: dict[str, int] = {}
        self.deal_epoch_retrievals: dict[int, int] = {}
        self.audit_budget_carryover = 0.0
        self.audit_budget_backlog = 0.0
        self.elasticity_spent_total = 0.0
        self.storage_price = config.storage_price
        self.retrieval_price_per_slot = config.retrieval_price_per_slot
        self.repairs_started_this_epoch = 0
        self.provider_slashed_total_last_epoch = 0.0
        self.next_deal_id = max((deal.deal_id for deal in self.deals), default=0) + 1
        self._apply_builtin_scenario(config.scenario)
        for fault in self.extra_faults:
            self.apply_fault(fault)

    @staticmethod
    def provider_id(index: int) -> str:
        return f"sp-{index:03d}"

    @staticmethod
    def operator_id(index: int) -> str:
        return f"op-{index:03d}"

    def mode_at_least(self, mode: str) -> bool:
        return ENFORCEMENT_ORDER[self.config.enforcement_mode] >= ENFORCEMENT_ORDER[mode]

    def _build_providers(self) -> dict[str, Provider]:
        rng = random.Random(f"{self.config.seed}:provider-profile")
        regions = tuple(self.config.provider_regions)
        providers: dict[str, Provider] = {}
        capacity_min = self.config.provider_capacity_min or self.config.provider_slot_capacity
        capacity_max = self.config.provider_capacity_max or self.config.provider_slot_capacity
        bandwidth_min = self.config.provider_bandwidth_capacity_min or self.config.provider_bandwidth_capacity_per_epoch
        bandwidth_max = self.config.provider_bandwidth_capacity_max or self.config.provider_bandwidth_capacity_per_epoch
        latency_min = self.config.provider_latency_ms_min
        latency_max = self.config.provider_latency_ms_max
        operator_count = self.config.operator_count or self.config.providers
        reserve_start = self.config.providers - self.config.provider_entry_reserve_count
        for index in range(self.config.providers):
            provider_id = self.provider_id(index)
            provider = Provider(
                provider_id,
                self.config.provider_initial_bond,
                self._operator_id_for_provider(index, operator_count),
                region=regions[index % len(regions)],
                capacity_slots=rng.randint(capacity_min, capacity_max) if capacity_max else self.config.provider_slot_capacity,
                bandwidth_capacity_per_epoch=rng.randint(bandwidth_min, bandwidth_max) if bandwidth_max else 0,
                latency_ms=rng.uniform(latency_min, latency_max) if latency_max else 0.0,
                repair_success_probability=rng.uniform(
                    self.config.provider_repair_probability_min,
                    self.config.provider_repair_probability_max,
                ),
                storage_cost_multiplier=jitter_multiplier(rng, self.config.provider_storage_cost_jitter_bps),
                bandwidth_cost_multiplier=jitter_multiplier(rng, self.config.provider_bandwidth_cost_jitter_bps),
            )
            provider.behavior.online_probability = rng.uniform(
                self.config.provider_online_probability_min,
                self.config.provider_online_probability_max,
            )
            if index >= reserve_start:
                provider.lifecycle_state = PROVIDER_RESERVE
            providers[provider_id] = provider
        return providers

    def _operator_id_for_provider(self, provider_index: int, operator_count: int) -> str:
        if self.config.dominant_operator_provider_bps > 0 and operator_count > 1:
            dominant_count = ceil_div(self.config.providers * self.config.dominant_operator_provider_bps, 10_000)
            dominant_count = max(1, min(self.config.providers, dominant_count))
            if provider_index < dominant_count:
                return self.operator_id(0)
            return self.operator_id(1 + ((provider_index - dominant_count) % (operator_count - 1)))
        return self.operator_id(provider_index % operator_count)

    def _build_deals(self) -> list[DealState]:
        deals: list[DealState] = []
        assigned_counts = {pid: 0 for pid in self.providers}
        for deal_idx in range(self.config.deals):
            deal_id = deal_idx + 1
            start = (deal_idx * self.config.n) % self.config.providers
            slots = []
            deal_provider_ids: set[str] = set()
            deal_operator_counts: dict[str, int] = {}
            for slot_idx in range(self.config.n):
                pid = self._select_initial_provider(
                    start,
                    slot_idx,
                    assigned_counts,
                    deal_provider_ids,
                    deal_operator_counts,
                )
                slots.append(SlotState(deal_id=deal_id, slot=slot_idx, provider_id=pid))
                assigned_counts[pid] += 1
                deal_provider_ids.add(pid)
                operator_id = self.providers[pid].operator_id
                deal_operator_counts[operator_id] = deal_operator_counts.get(operator_id, 0) + 1
            deals.append(
                DealState(
                    deal_id=deal_id,
                    k=self.config.k,
                    m=self.config.m,
                    user_mdus=self.config.user_mdus_per_deal,
                    witness_mdus=self.config.witness_mdus,
                    slots=slots,
                )
            )
        return deals

    def _select_initial_provider(
        self,
        start: int,
        slot_idx: int,
        assigned_counts: dict[str, int],
        deal_provider_ids: set[str],
        deal_operator_counts: dict[str, int],
    ) -> str:
        ordered_provider_ids = [
            self.provider_id((start + slot_idx + offset) % self.config.providers)
            for offset in range(self.config.providers)
        ]
        for enforce_operator_cap, enforce_capacity in ((True, True), (False, True), (False, False)):
            for provider_id in ordered_provider_ids:
                if provider_id in deal_provider_ids:
                    continue
                provider = self.providers[provider_id]
                if not self._provider_lifecycle_assignable(provider):
                    continue
                if not self._provider_has_bond_headroom(provider, assigned_counts.get(provider_id, 0), additional_slots=1):
                    continue
                if enforce_capacity and assigned_counts.get(provider_id, 0) >= provider.capacity_slots:
                    continue
                if (
                    enforce_operator_cap
                    and self.config.operator_assignment_cap_per_deal > 0
                    and deal_operator_counts.get(provider.operator_id, 0) >= self.config.operator_assignment_cap_per_deal
                ):
                    continue
                return provider_id
        raise RuntimeError("no provider candidate available for initial placement")

    def _apply_builtin_scenario(self, scenario: str) -> None:
        if scenario in BUILTIN_NOOP_SCENARIOS:
            return
        if scenario == "single-outage":
            self.providers["sp-000"].behavior.offline_epochs.update(range(2, 6))
            return
        if scenario in {"malicious-corrupt", "corrupt-provider"}:
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
            providers=self._provider_rows(),
            slots=self.slot_rows,
            evidence=self.evidence_rows,
            repairs=self.repair_rows,
            economy=self.economy_rows,
            operators=self._operator_rows(),
        )

    def _run_epoch(self, epoch: int) -> EpochMetrics:
        for deal in self._open_deals():
            for slot in deal.slots:
                slot.reset_epoch()

        metrics = EpochMetrics(epoch=epoch)
        metrics.open_deals = len(self._open_deals())
        metrics.storage_price = self.storage_price
        metrics.retrieval_price_per_slot = self.retrieval_price_per_slot
        self.provider_epoch_serves = {pid: 0 for pid in self.providers}
        self.deal_epoch_retrievals = {deal.deal_id: 0 for deal in self._open_deals()}
        self.repairs_started_this_epoch = 0
        self._expire_elasticity_overlays(epoch, metrics)
        self._promote_probationary_providers(epoch, metrics)
        online = self._epoch_online_map(epoch)
        self._simulate_new_deal_demand(epoch, metrics)
        self._simulate_staged_uploads(epoch, metrics)

        for _ in range(self._retrieval_attempts_for_epoch(epoch, metrics)):
            self._simulate_retrieval(epoch, online, metrics)

        for deal in self._open_deals():
            for slot in deal.slots:
                if slot.status == SLOT_REPAIRING:
                    metrics.repairing_slots += 1
                    self._advance_repair(epoch, online, deal, slot, metrics)
                    self._count_slot_health(slot, metrics)
                    self._record_slot_row(epoch, slot)
                    continue
                metrics.active_slots += 1
                self._settle_slot_epoch(epoch, online, deal, slot, metrics)
                self._count_slot_health(slot, metrics)
                self._record_slot_row(epoch, slot)

        self._simulate_evidence_spam(epoch, metrics)
        self._repair_underbonded_assignments(epoch, metrics)
        self._record_data_loss_events(metrics)
        self._settle_epoch_economy(epoch, metrics)
        self._update_provider_capabilities(epoch, metrics)
        self._record_concentration_metrics(metrics)
        self._maybe_update_prices(metrics)
        return metrics

    def _retrieval_attempts_for_epoch(self, epoch: int, metrics: EpochMetrics) -> int:
        latent_attempts = self.config.users * self.config.retrievals_per_user_per_epoch
        multiplier_bps = self._retrieval_demand_multiplier_bps(epoch)
        metrics.retrieval_latent_attempts = latent_attempts
        metrics.retrieval_demand_multiplier_bps = multiplier_bps
        metrics.retrieval_demand_shock_active = self._active_retrieval_demand_shocks(epoch)
        return int(latent_attempts * multiplier_bps / 10_000)

    def _open_deals(self) -> list[DealState]:
        return [deal for deal in self.deals if deal.closed_epoch == 0]

    def _retrieval_demand_multiplier_bps(self, epoch: int) -> int:
        multiplier_bps = 10_000
        for shock in self.config.retrieval_demand_shocks:
            if not self._demand_shock_epoch_applies(shock, epoch):
                continue
            multiplier_bps = multiplier_bps * int(shock.get("multiplier_bps", 10_000)) // 10_000
        return multiplier_bps

    def _active_retrieval_demand_shocks(self, epoch: int) -> int:
        return sum(1 for shock in self.config.retrieval_demand_shocks if self._demand_shock_epoch_applies(shock, epoch))

    def _demand_shock_epoch_applies(self, shock: dict[str, Any], epoch: int) -> bool:
        start_epoch = int(shock.get("start_epoch", shock.get("epoch", 1)))
        end_epoch = int(shock.get("end_epoch", self.config.epochs))
        return start_epoch <= epoch <= end_epoch

    def _simulate_new_deal_demand(self, epoch: int, metrics: EpochMetrics) -> None:
        latent_requests = self.config.new_deal_requests_per_epoch
        if latent_requests <= 0:
            return

        requests = self._effective_new_deal_requests(latent_requests)
        metrics.new_deal_latent_requests = latent_requests
        metrics.new_deal_requests = requests
        metrics.new_deals_suppressed_price = latent_requests - requests
        for _ in range(requests):
            if (
                self.config.storage_demand_price_ceiling > 0
                and self.storage_price > self.config.storage_demand_price_ceiling
            ):
                metrics.new_deals_rejected_price += 1
                continue
            deal = self._try_create_dynamic_deal(epoch)
            if not deal:
                metrics.new_deals_rejected_capacity += 1
                continue
            self.deals.append(deal)
            self.next_deal_id += 1
            metrics.new_deals_accepted += 1

    def _simulate_staged_uploads(self, epoch: int, metrics: EpochMetrics) -> None:
        if self.config.staged_upload_attempts_per_epoch <= 0 and not self.staged_uploads:
            return

        self._cleanup_staged_uploads(epoch, metrics)
        max_pending = self.config.staged_upload_max_pending_generations
        for _ in range(self.config.staged_upload_attempts_per_epoch):
            metrics.staged_upload_attempts += 1
            if max_pending > 0 and len(self.staged_uploads) >= max_pending:
                metrics.staged_upload_rejections += 1
                continue

            metrics.staged_upload_accepted += 1
            if self.rng.randrange(10_000) < self.config.staged_upload_commit_rate_bps:
                metrics.staged_upload_committed += 1
                continue

            open_deals = self._open_deals()
            if not open_deals:
                metrics.staged_upload_rejections += 1
                continue
            deal = self.rng.choice(open_deals)
            self.staged_uploads.append(
                {
                    "created_epoch": epoch,
                    "deal_id": deal.deal_id,
                    "mdus": self.config.staged_upload_mdu_per_attempt,
                }
            )

        self._record_staged_upload_snapshot(epoch, metrics)

    def _cleanup_staged_uploads(self, epoch: int, metrics: EpochMetrics) -> None:
        retention = self.config.staged_upload_retention_epochs
        if retention <= 0 or not self.staged_uploads:
            return

        kept: list[dict[str, int]] = []
        cleaned = 0
        for item in self.staged_uploads:
            if epoch - item["created_epoch"] >= retention:
                cleaned += 1
            else:
                kept.append(item)
        self.staged_uploads = kept
        metrics.staged_upload_cleaned = cleaned

    def _record_staged_upload_snapshot(self, epoch: int, metrics: EpochMetrics) -> None:
        metrics.staged_upload_pending_generations = len(self.staged_uploads)
        metrics.staged_upload_pending_mdus = sum(item["mdus"] for item in self.staged_uploads)
        if metrics.staged_upload_rejections:
            self.evidence_rows.append(
                {
                    "epoch": epoch,
                    "deal_id": "",
                    "slot": "",
                    "provider_id": "user-gateway",
                    "evidence_class": "operational",
                    "reason": "staged_upload_preflight_rejected",
                    "consequence": "retention_limit",
                }
            )
        if metrics.staged_upload_cleaned:
            self.evidence_rows.append(
                {
                    "epoch": epoch,
                    "deal_id": "",
                    "slot": "",
                    "provider_id": "provider-daemon",
                    "evidence_class": "operational",
                    "reason": "staged_upload_retention_cleanup",
                    "consequence": "local_gc",
                }
            )

    def _effective_new_deal_requests(self, latent_requests: int) -> int:
        multiplier_bps = self._storage_demand_multiplier_bps()
        return int(latent_requests * multiplier_bps / 10_000)

    def _storage_demand_multiplier_bps(self) -> int:
        if (
            self.config.storage_demand_reference_price <= 0
            or self.config.storage_demand_elasticity_bps <= 0
        ):
            return 10_000

        price_delta = (self.config.storage_demand_reference_price - self.storage_price) / self.config.storage_demand_reference_price
        raw_bps = 10_000 + int(round(price_delta * self.config.storage_demand_elasticity_bps))
        return max(self.config.storage_demand_min_bps, min(self.config.storage_demand_max_bps, raw_bps))

    def _try_create_dynamic_deal(self, epoch: int) -> DealState | None:
        deal_id = self.next_deal_id
        start = (deal_id * self.config.n) % self.config.providers
        assigned_counts = self._assigned_counts(include_pending=True)
        slots = []
        deal_provider_ids: set[str] = set()
        deal_operator_counts: dict[str, int] = {}
        for slot_idx in range(self.config.n):
            provider_id = self._select_dynamic_provider(
                epoch,
                start,
                slot_idx,
                assigned_counts,
                deal_provider_ids,
                deal_operator_counts,
            )
            if not provider_id:
                return None
            slots.append(SlotState(deal_id=deal_id, slot=slot_idx, provider_id=provider_id))
            assigned_counts[provider_id] += 1
            deal_provider_ids.add(provider_id)
            operator_id = self.providers[provider_id].operator_id
            deal_operator_counts[operator_id] = deal_operator_counts.get(operator_id, 0) + 1
        return DealState(
            deal_id=deal_id,
            k=self.config.k,
            m=self.config.m,
            user_mdus=self.config.user_mdus_per_deal,
            witness_mdus=self.config.witness_mdus,
            slots=slots,
            opened_epoch=epoch,
        )

    def _select_dynamic_provider(
        self,
        epoch: int,
        start: int,
        slot_idx: int,
        assigned_counts: dict[str, int],
        deal_provider_ids: set[str],
        deal_operator_counts: dict[str, int],
    ) -> str | None:
        ordered_provider_ids = [
            self.provider_id((start + slot_idx + offset) % self.config.providers)
            for offset in range(self.config.providers)
        ]
        for enforce_operator_cap in (True, False):
            for provider_id in ordered_provider_ids:
                if provider_id in deal_provider_ids:
                    continue
                provider = self.providers[provider_id]
                if not self._provider_lifecycle_assignable(provider):
                    continue
                if not self._provider_has_bond_headroom(provider, assigned_counts.get(provider_id, 0), additional_slots=1):
                    continue
                if provider.behavior.draining or self._is_jailed(provider, epoch):
                    continue
                if assigned_counts.get(provider_id, 0) >= provider.capacity_slots:
                    continue
                if (
                    enforce_operator_cap
                    and self.config.operator_assignment_cap_per_deal > 0
                    and deal_operator_counts.get(provider.operator_id, 0) >= self.config.operator_assignment_cap_per_deal
                ):
                    continue
                return provider_id
        return None

    def _expire_elasticity_overlays(self, epoch: int, metrics: EpochMetrics) -> None:
        if not self.elasticity_overlays:
            return
        kept: list[ElasticityOverlay] = []
        expired = 0
        closed_deal_ids = {deal.deal_id for deal in self.deals if deal.closed_epoch}
        for overlay in self.elasticity_overlays:
            if overlay.deal_id in closed_deal_ids:
                expired += 1
            elif overlay.expire_epoch > 0 and epoch >= overlay.expire_epoch:
                expired += 1
            else:
                kept.append(overlay)
        self.elasticity_overlays = kept
        metrics.elasticity_overlay_expired = expired

    def _maybe_scale_elasticity_overlays(self, epoch: int, metrics: EpochMetrics) -> None:
        if not self.config.elasticity_overlay_enabled:
            return
        if self.config.elasticity_trigger_retrievals_per_epoch <= 0:
            return
        if metrics.retrieval_attempts < self.config.elasticity_trigger_retrievals_per_epoch:
            return
        if self.config.elasticity_overlay_providers_per_epoch <= 0:
            return

        target_deals = sorted(
            self._open_deals(),
            key=lambda deal: (-self.deal_epoch_retrievals.get(deal.deal_id, 0), deal.deal_id),
        )
        activations = 0
        while activations < self.config.elasticity_overlay_providers_per_epoch:
            progressed = False
            for deal in target_deals:
                if activations >= self.config.elasticity_overlay_providers_per_epoch:
                    break
                if self.deal_epoch_retrievals.get(deal.deal_id, 0) <= 0:
                    continue
                max_per_deal = self.config.elasticity_overlay_max_providers_per_deal
                if max_per_deal > 0 and self._elasticity_overlay_count(deal.deal_id) >= max_per_deal:
                    continue

                cost = self.config.elasticity_base_cost
                if cost > 0 and self.elasticity_spent_total + cost > self.config.elasticity_max_spend:
                    metrics.elasticity_rejections += 1
                    metrics.elasticity_overlay_rejections += 1
                    self._record_elasticity_overlay_rejection(epoch, deal.deal_id, "spend_cap")
                    return

                provider_id = self._select_elasticity_overlay_provider(epoch, deal)
                if not provider_id:
                    metrics.elasticity_rejections += 1
                    metrics.elasticity_overlay_rejections += 1
                    self._record_elasticity_overlay_rejection(epoch, deal.deal_id, "no_candidate")
                    continue

                ready_epoch = epoch + self.config.elasticity_overlay_ready_delay_epochs
                ttl = self.config.elasticity_overlay_ttl_epochs
                expire_epoch = 0 if ttl <= 0 else epoch + ttl
                self.elasticity_overlays.append(
                    ElasticityOverlay(
                        deal_id=deal.deal_id,
                        provider_id=provider_id,
                        activated_epoch=epoch,
                        ready_epoch=ready_epoch,
                        expire_epoch=expire_epoch,
                    )
                )
                self.elasticity_spent_total += cost
                metrics.elasticity_spent += cost
                metrics.elasticity_overlay_activations += 1
                activations += 1
                progressed = True
                self._record_overlay_evidence(
                    epoch,
                    deal.deal_id,
                    provider_id,
                    "market",
                    "elasticity_overlay_activated",
                    "overflow_route",
                )
            if not progressed:
                break

    def _elasticity_overlay_count(self, deal_id: int) -> int:
        return sum(1 for overlay in self.elasticity_overlays if overlay.deal_id == deal_id)

    def _select_elasticity_overlay_provider(self, epoch: int, deal: DealState) -> str | None:
        excluded = {self._slot_route_provider_id(slot) for slot in deal.slots}
        excluded.update(
            overlay.provider_id
            for overlay in self.elasticity_overlays
            if overlay.deal_id == deal.deal_id
        )
        operator_counts = self._deal_operator_counts(deal)
        for overlay in self.elasticity_overlays:
            if overlay.deal_id != deal.deal_id:
                continue
            operator_id = self.providers[overlay.provider_id].operator_id
            operator_counts[operator_id] = operator_counts.get(operator_id, 0) + 1

        candidates = []
        for provider_id, provider in self.providers.items():
            if provider_id in excluded:
                continue
            if not self._provider_lifecycle_assignable(provider):
                continue
            if not self._provider_has_bond_headroom(provider, self._assigned_counts().get(provider_id, 0)):
                continue
            if provider.behavior.draining or self._is_jailed(provider, epoch):
                continue
            if (
                self.config.operator_assignment_cap_per_deal > 0
                and operator_counts.get(provider.operator_id, 0) >= self.config.operator_assignment_cap_per_deal
            ):
                continue
            candidates.append(provider_id)

        if not candidates:
            return None
        seed = f"{self.config.seed}:overlay:{epoch}:{deal.deal_id}:{self._elasticity_overlay_count(deal.deal_id)}"
        return min(
            candidates,
            key=lambda provider_id: (
                0 if self.providers[provider_id].capability_tier == CAPABILITY_HIGH_BANDWIDTH else 1,
                -self.providers[provider_id].bandwidth_capacity_per_epoch,
                stable_digest(seed, provider_id),
            ),
        )

    def _record_elasticity_overlay_rejection(self, epoch: int, deal_id: int, reason: str) -> None:
        self._record_overlay_evidence(
            epoch,
            deal_id,
            "user-gateway",
            "market",
            "elasticity_overlay_rejected",
            reason,
        )

    def _record_elasticity_overlay_snapshot(self, epoch: int, metrics: EpochMetrics) -> None:
        metrics.elasticity_overlay_active = len(self.elasticity_overlays)
        metrics.elasticity_overlay_ready = sum(
            1 for overlay in self.elasticity_overlays if overlay.ready_epoch <= epoch
        )

    def _simulate_evidence_spam(self, epoch: int, metrics: EpochMetrics) -> None:
        claims = self.config.evidence_spam_claims_per_epoch
        if claims <= 0:
            return

        convictions = claims * self.config.evidence_spam_conviction_bps // 10_000
        burned_claims = claims - convictions
        bond_burned = burned_claims * self.config.evidence_spam_bond
        bounty_paid = convictions * self.config.evidence_spam_bounty
        metrics.evidence_spam_claims = claims
        metrics.evidence_spam_convictions = convictions
        metrics.evidence_spam_bond_burned = bond_burned
        metrics.evidence_spam_bounty_paid = bounty_paid
        metrics.evidence_spam_net_gain = bounty_paid - bond_burned

        for claim_index in range(claims):
            convicted = claim_index < convictions
            self.evidence_rows.append(
                {
                    "epoch": epoch,
                    "deal_id": "",
                    "slot": "",
                    "provider_id": "deputy-spammer",
                    "evidence_class": "threshold" if convicted else "spam",
                    "reason": "deputy_evidence_spam",
                    "consequence": "bounty_paid" if convicted else "bond_burned",
                }
            )

    @staticmethod
    def _count_slot_health(slot: SlotState, metrics: EpochMetrics) -> None:
        if slot.health_state == HEALTH_SUSPECT:
            metrics.suspect_slots += 1
        elif slot.health_state == HEALTH_DELINQUENT:
            metrics.delinquent_slots += 1

    def _epoch_online_map(self, epoch: int) -> dict[str, bool]:
        out: dict[str, bool] = {}
        for provider_id, provider in self.providers.items():
            behavior = provider.behavior
            if not self._provider_lifecycle_assignable(provider):
                out[provider_id] = False
            elif self._is_jailed(provider, epoch):
                out[provider_id] = False
            elif self._region_offline(provider.region, epoch):
                out[provider_id] = False
            elif epoch in behavior.offline_epochs:
                out[provider_id] = False
            else:
                out[provider_id] = self.rng.random() <= behavior.online_probability
        return out

    def _region_offline(self, region: str, epoch: int) -> bool:
        for outage in self.config.regional_outages:
            if str(outage.get("region")) != region:
                continue
            epochs = outage.get("epochs", "")
            if isinstance(epochs, str) and epoch in parse_epoch_range(epochs):
                return True
            if isinstance(epochs, list) and epoch in {int(item) for item in epochs}:
                return True
        return False

    def _simulate_retrieval(
        self,
        epoch: int,
        online: dict[str, bool],
        metrics: EpochMetrics,
    ) -> None:
        metrics.retrieval_attempts += 1
        metrics.retrieval_base_burned += self.config.retrieval_base_fee
        sponsored = self._retrieval_is_sponsored()
        if sponsored:
            metrics.sponsored_retrieval_attempts += 1
            metrics.sponsored_retrieval_base_spent += self.config.retrieval_base_fee
        else:
            metrics.owner_funded_retrieval_attempts += 1
            metrics.owner_retrieval_escrow_debited += (
                self.config.retrieval_base_fee * self.config.owner_retrieval_debit_bps / 10_000
            )
        open_deals = self._open_deals()
        if not open_deals:
            metrics.unavailable_reads += 1
            return
        deal = self.rng.choice(open_deals)
        self.deal_epoch_retrievals[deal.deal_id] = self.deal_epoch_retrievals.get(deal.deal_id, 0) + 1
        order = list(range(deal.n))
        self.rng.shuffle(order)
        is_hot = self.config.hot_retrieval_bps > 0 and self.rng.randrange(10_000) < self.config.hot_retrieval_bps
        if is_hot:
            metrics.hot_retrieval_attempts += 1
        if is_hot and self.config.high_bandwidth_routing_enabled:
            order.sort(
                key=lambda idx: (
                    0
                    if self.providers[self._slot_route_provider_id(deal.slots[idx])].capability_tier
                    == CAPABILITY_HIGH_BANDWIDTH
                    else 1
                )
            )
        routes: list[tuple[SlotState | None, str, str]] = [
            (deal.slots[slot_idx], self._slot_route_provider_id(deal.slots[slot_idx]), "base")
            for slot_idx in order
        ]
        routes.extend(
            (None, provider_id, "elasticity_overlay")
            for provider_id in self._ready_elasticity_overlay_provider_ids(deal.deal_id, epoch)
        )
        max_attempts = min(len(routes), self.config.route_attempt_limit)
        successes = 0
        failed_slots: list[SlotState] = []
        served_providers: list[tuple[str, str]] = []

        for slot, provider_id, route_kind in routes[:max_attempts]:
            outcome, latency_ms, performance_tier = self._serve_from_provider(provider_id, online)
            if outcome == "ok":
                successes += 1
                served_providers.append((provider_id, performance_tier))
                self._record_performance_serve(provider_id, latency_ms, performance_tier, metrics)
                if self.providers[provider_id].capability_tier == CAPABILITY_HIGH_BANDWIDTH:
                    metrics.high_bandwidth_serves += 1
                    if is_hot:
                        metrics.hot_high_bandwidth_serves += 1
                self.provider_epoch_serves[provider_id] += 1
                if route_kind == "elasticity_overlay":
                    metrics.elasticity_overlay_serves += 1
                elif slot is not None:
                    slot.credits_raw += 1
                    slot.direct_served += 1
                    metrics.direct_served += 1
                if successes >= deal.k:
                    break
                continue

            if slot is not None:
                failed_slots.append(slot)
            self._record_performance_fail(provider_id, metrics)
            if outcome == "corrupt":
                metrics.corrupt_responses += 1
                metrics.invalid_proofs += 1
                self.providers[provider_id].hard_faults += 1
                if slot is None:
                    self._record_overlay_evidence(epoch, deal.deal_id, provider_id, "hard", "overlay_corrupt_retrieval", "slash_candidate")
                else:
                    self._record_evidence(epoch, deal, slot, provider_id, "hard", "corrupt_retrieval")
                self._hard_fault_consequence(epoch, provider_id, "corrupt_retrieval")
                if slot is not None:
                    self._start_repair(epoch, deal, slot, "corrupt_retrieval", metrics)
            elif outcome == "withheld":
                metrics.withheld_responses += 1
            elif outcome == "saturated":
                metrics.saturated_responses += 1
            else:
                metrics.offline_responses += 1

        if successes >= deal.k:
            metrics.retrieval_successes += 1
            self._settle_retrieval_payment(served_providers[: deal.k], metrics, sponsored=sponsored)
            for slot in failed_slots:
                if slot.direct_served == 0:
                    slot.deputy_served += 1
                    metrics.deputy_served += 1
            return

        metrics.unavailable_reads += 1

    @staticmethod
    def _slot_route_provider_id(slot: SlotState) -> str:
        if slot.status == SLOT_REPAIRING and slot.pending_provider_id:
            return slot.pending_provider_id
        return slot.provider_id

    def _ready_elasticity_overlay_provider_ids(self, deal_id: int, epoch: int) -> list[str]:
        provider_ids = {
            overlay.provider_id
            for overlay in self.elasticity_overlays
            if overlay.deal_id == deal_id and overlay.ready_epoch <= epoch
        }
        return sorted(
            provider_ids,
            key=lambda provider_id: (
                0 if self.providers[provider_id].capability_tier == CAPABILITY_HIGH_BANDWIDTH else 1,
                -self.providers[provider_id].bandwidth_capacity_per_epoch,
                provider_id,
            ),
        )

    def _retrieval_is_sponsored(self) -> bool:
        if self.config.sponsored_retrieval_bps <= 0:
            return False
        if self.config.sponsored_retrieval_bps >= 10_000:
            return True
        return self.rng.randrange(10_000) < self.config.sponsored_retrieval_bps

    def _serve_from_provider(self, provider_id: str, online: dict[str, bool]) -> tuple[str, float, str]:
        provider = self.providers[provider_id]
        provider.retrieval_attempts += 1
        if not online.get(provider_id, False):
            provider.offline_responses += 1
            return "offline", 0.0, PERFORMANCE_FAIL
        if (
            provider.bandwidth_capacity_per_epoch > 0
            and self.provider_epoch_serves.get(provider_id, 0) >= provider.bandwidth_capacity_per_epoch
        ):
            provider.saturated_responses += 1
            return "saturated", 0.0, PERFORMANCE_FAIL

        behavior = provider.behavior
        roll = self.rng.random()
        if roll < behavior.corrupt_rate:
            provider.corrupt_responses += 1
            return "corrupt", 0.0, PERFORMANCE_FAIL

        roll = self.rng.random()
        if roll < behavior.withhold_rate:
            provider.withheld_responses += 1
            return "withheld", 0.0, PERFORMANCE_FAIL

        provider.retrieval_successes += 1
        latency_ms = self._sample_latency_ms(provider)
        return "ok", latency_ms, self._performance_tier(latency_ms)

    def _sample_latency_ms(self, provider: Provider) -> float:
        latency = provider.latency_ms
        if latency <= 0:
            return 0.0
        return latency * jitter_multiplier(self.rng, self.config.provider_latency_jitter_bps)

    def _performance_tier(self, latency_ms: float) -> str:
        if not self.config.performance_market_enabled:
            return ""
        if latency_ms <= self.config.platinum_latency_ms:
            return PERFORMANCE_PLATINUM
        if latency_ms <= self.config.gold_latency_ms:
            return PERFORMANCE_GOLD
        if latency_ms <= self.config.silver_latency_ms:
            return PERFORMANCE_SILVER
        return PERFORMANCE_FAIL

    def _record_performance_serve(
        self,
        provider_id: str,
        latency_ms: float,
        tier: str,
        metrics: EpochMetrics,
    ) -> None:
        if not self.config.performance_market_enabled:
            return
        provider = self.providers[provider_id]
        provider.latency_sample_count += 1
        provider.total_latency_ms += latency_ms
        metrics.latency_sample_count += 1
        metrics.total_latency_ms += latency_ms
        if tier == PERFORMANCE_PLATINUM:
            provider.platinum_serves += 1
            metrics.platinum_serves += 1
        elif tier == PERFORMANCE_GOLD:
            provider.gold_serves += 1
            metrics.gold_serves += 1
        elif tier == PERFORMANCE_SILVER:
            provider.silver_serves += 1
            metrics.silver_serves += 1
        else:
            provider.fail_serves += 1
            metrics.fail_serves += 1

        reward = self.config.performance_reward_per_serve * self._performance_reward_multiplier_bps(tier) / 10_000
        provider.performance_reward_revenue += reward
        metrics.performance_reward_paid += reward

    def _record_performance_fail(self, provider_id: str, metrics: EpochMetrics) -> None:
        if not self.config.performance_market_enabled:
            return
        provider = self.providers[provider_id]
        provider.fail_serves += 1
        metrics.fail_serves += 1

    def _performance_reward_multiplier_bps(self, tier: str) -> int:
        if tier == PERFORMANCE_PLATINUM:
            return self.config.platinum_reward_multiplier_bps
        if tier == PERFORMANCE_GOLD:
            return self.config.gold_reward_multiplier_bps
        if tier == PERFORMANCE_SILVER:
            return self.config.silver_reward_multiplier_bps
        return self.config.fail_reward_multiplier_bps

    def _settle_retrieval_payment(
        self,
        provider_ids: list[tuple[str, str]],
        metrics: EpochMetrics,
        sponsored: bool = False,
    ) -> None:
        if not provider_ids:
            return
        variable = self.retrieval_price_per_slot * len(provider_ids)
        burn = variable * self.config.retrieval_burn_bps / 10_000
        payout = variable - burn
        per_provider = payout / len(provider_ids)
        metrics.retrieval_variable_burned += burn
        metrics.retrieval_provider_payouts += payout
        if sponsored:
            metrics.sponsored_retrieval_variable_spent += variable
        else:
            metrics.owner_retrieval_escrow_debited += variable * self.config.owner_retrieval_debit_bps / 10_000
        for provider_id, _tier in provider_ids:
            self.providers[provider_id].retrieval_revenue += per_provider

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
                self._record_evidence(epoch, deal, slot, slot.provider_id, "hard", "invalid_synthetic_proof")
                self._hard_fault_consequence(epoch, slot.provider_id, "invalid_synthetic_proof")
                self._start_repair(epoch, deal, slot, "invalid_synthetic_proof", metrics)
            else:
                slot.synthetic = needed_synthetic

        total = slot.credits_applied + slot.synthetic

        if slot.deputy_served > 0 and slot.direct_served == 0:
            slot.deputy_missed_epochs += 1
            metrics.deputy_misses += 1
            self._mark_suspect(slot, "deputy_served_zero_direct")
            self._record_evidence(epoch, deal, slot, slot.provider_id, "soft", "deputy_served_zero_direct")
            if slot.deputy_missed_epochs >= self.config.deputy_evict_after_missed_epochs:
                self._start_repair(epoch, deal, slot, "deputy_served_zero_direct", metrics)
        elif slot.direct_served > 0:
            slot.deputy_missed_epochs = 0

        if total < quota:
            slot.missed_epochs += 1
            metrics.quota_misses += 1
            slot.last_reason = "quota_shortfall"
            self._mark_suspect(slot, "quota_shortfall")
            self._record_evidence(epoch, deal, slot, slot.provider_id, "soft", "quota_shortfall")
            if slot.missed_epochs >= self.config.evict_after_missed_epochs:
                self._start_repair(epoch, deal, slot, "quota_shortfall", metrics)
            if not self.mode_at_least("REWARD_EXCLUSION"):
                slot.reward_eligible_this_epoch = True
                metrics.reward_eligible_slots += 1
                provider.rewards_earned_slots += 1
            return

        slot.missed_epochs = 0
        if slot.status == SLOT_ACTIVE and not slot.durability_suspect:
            self._mark_healthy(slot)
        slot.compliant_this_epoch = True
        metrics.compliant_slots += 1
        if not slot.hard_faulted_this_epoch and slot.status == SLOT_ACTIVE:
            slot.reward_eligible_this_epoch = True
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
        provider = self.providers[pending]
        can_coordinate_repair = (
            online.get(pending, False)
            and self.rng.random() <= provider.repair_success_probability
        )
        if not can_coordinate_repair:
            if self._repair_pending_timed_out(epoch, slot):
                self._timeout_repair(epoch, deal, slot, metrics)
            return

        if slot.repair_remaining_epochs > 0:
            slot.repair_remaining_epochs -= 1
        if slot.repair_remaining_epochs > 0:
            if self._repair_pending_timed_out(epoch, slot):
                self._timeout_repair(epoch, deal, slot, metrics)
            return

        if not slot.repair_ready:
            slot.repair_ready = True
            metrics.repairs_ready += 1
            self.repair_rows.append(
                {
                    "epoch": epoch,
                    "event": "repair_ready",
                    "deal_id": deal.deal_id,
                    "slot": slot.slot,
                    "old_provider": slot.provider_id,
                    "new_provider": pending,
                    "reason": "catchup_ready",
                    "generation": slot.current_gen,
                    "attempt": slot.repair_attempts,
                    "cooldown_until_epoch": slot.repair_backoff_until_epoch,
                }
            )

        old_provider = slot.provider_id
        completed_attempts = slot.repair_attempts
        slot.provider_id = pending
        slot.pending_provider_id = None
        slot.status = SLOT_ACTIVE
        slot.repair_remaining_epochs = 0
        slot.repair_ready = False
        slot.missed_epochs = 0
        slot.deputy_missed_epochs = 0
        slot.durability_suspect = False
        slot.current_gen += 1
        metrics.repairs_completed += 1
        self.repair_rows.append(
            {
                "epoch": epoch,
                "event": "repair_completed",
                "deal_id": deal.deal_id,
                "slot": slot.slot,
                "old_provider": old_provider,
                "new_provider": slot.provider_id,
                "reason": "catchup_complete",
                "generation": slot.current_gen,
                "attempt": completed_attempts,
                "cooldown_until_epoch": slot.repair_backoff_until_epoch,
            }
        )
        slot.repair_attempts = 0
        slot.repair_backoff_until_epoch = 0
        slot.repair_started_epoch = 0
        slot.last_repair_attempt_epoch = 0
        self._mark_healthy(slot)

    def _repair_pending_timed_out(self, epoch: int, slot: SlotState) -> bool:
        timeout = self.config.repair_pending_timeout_epochs
        if timeout <= 0 or slot.repair_started_epoch <= 0:
            return False
        return epoch - slot.repair_started_epoch >= timeout

    def _timeout_repair(self, epoch: int, deal: DealState, slot: SlotState, metrics: EpochMetrics) -> None:
        pending = slot.pending_provider_id or ""
        metrics.repair_timeouts += 1
        if self.config.repair_backoff_epochs > 0:
            slot.repair_backoff_until_epoch = max(
                slot.repair_backoff_until_epoch,
                epoch + self.config.repair_backoff_epochs,
            )
        self.repair_rows.append(
            {
                "epoch": epoch,
                "event": "repair_timeout",
                "deal_id": deal.deal_id,
                "slot": slot.slot,
                "old_provider": slot.provider_id,
                "new_provider": pending,
                "reason": "readiness_timeout",
                "generation": slot.current_gen,
                "attempt": slot.repair_attempts,
                "cooldown_until_epoch": slot.repair_backoff_until_epoch,
            }
        )
        slot.status = SLOT_ACTIVE
        slot.pending_provider_id = None
        slot.repair_remaining_epochs = 0
        slot.repair_ready = False
        slot.repair_started_epoch = 0
        slot.last_reason = "readiness_timeout"
        self._mark_delinquent(slot, "readiness_timeout")

    @staticmethod
    def _mark_suspect(slot: SlotState, reason: str) -> None:
        if slot.health_state != HEALTH_DELINQUENT:
            slot.health_state = HEALTH_SUSPECT
            slot.health_reason = reason

    @staticmethod
    def _mark_delinquent(slot: SlotState, reason: str) -> None:
        slot.health_state = HEALTH_DELINQUENT
        slot.health_reason = reason

    @staticmethod
    def _mark_healthy(slot: SlotState) -> None:
        slot.health_state = HEALTH_HEALTHY
        slot.health_reason = ""
        slot.repair_attempts = 0
        slot.repair_backoff_until_epoch = 0
        slot.repair_started_epoch = 0
        slot.last_repair_attempt_epoch = 0

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
        is_hard_fault = reason in {"corrupt_retrieval", "invalid_synthetic_proof"}
        slot.hard_faulted_this_epoch = slot.hard_faulted_this_epoch or is_hard_fault
        slot.durability_suspect = slot.durability_suspect or is_hard_fault
        self._mark_delinquent(slot, reason)
        if not self.mode_at_least("REPAIR_ONLY"):
            self.repair_rows.append(
                {
                    "epoch": epoch,
                    "event": "repair_would_start",
                    "deal_id": deal.deal_id,
                    "slot": slot.slot,
                    "old_provider": slot.provider_id,
                    "new_provider": "",
                    "reason": reason,
                    "generation": slot.current_gen,
                    "attempt": slot.repair_attempts,
                    "cooldown_until_epoch": slot.repair_backoff_until_epoch,
                }
            )
            return
        if slot.last_repair_attempt_epoch == epoch:
            return
        if slot.repair_backoff_until_epoch > epoch:
            slot.last_repair_attempt_epoch = epoch
            self._record_repair_backoff(epoch, deal, slot, "repair_cooldown", metrics)
            return
        if (
            self.config.repair_attempt_cap_per_slot > 0
            and slot.repair_attempts >= self.config.repair_attempt_cap_per_slot
        ):
            slot.last_repair_attempt_epoch = epoch
            self._record_repair_backoff(epoch, deal, slot, "repair_attempt_cap", metrics)
            return

        slot.repair_attempts += 1
        slot.last_repair_attempt_epoch = epoch
        metrics.repair_attempts += 1
        if (
            self.config.max_repairs_started_per_epoch > 0
            and self.repairs_started_this_epoch >= self.config.max_repairs_started_per_epoch
        ):
            self._record_repair_backoff(epoch, deal, slot, "repair_coordination_limit", metrics)
            return
        pending, candidate_diagnostics = self._select_replacement(epoch, deal, slot)
        if not pending:
            self._record_repair_backoff(epoch, deal, slot, "no_candidate", metrics, candidate_diagnostics)
            return
        old_provider = slot.provider_id
        slot.status = SLOT_REPAIRING
        slot.pending_provider_id = pending
        slot.repair_remaining_epochs = self.config.repair_epochs
        slot.repair_ready = False
        slot.repair_started_epoch = epoch
        slot.repair_backoff_until_epoch = 0
        slot.last_reason = reason
        metrics.repairs_started += 1
        self.repairs_started_this_epoch += 1
        self.repair_rows.append(
            {
                "epoch": epoch,
                "event": "repair_started",
                "deal_id": deal.deal_id,
                "slot": slot.slot,
                "old_provider": old_provider,
                "new_provider": pending,
                "reason": reason,
                "generation": slot.current_gen,
                "attempt": slot.repair_attempts,
                "cooldown_until_epoch": slot.repair_backoff_until_epoch,
                **candidate_diagnostics,
            }
        )

    def _repair_underbonded_assignments(self, epoch: int, metrics: EpochMetrics) -> None:
        if self.config.provider_min_bond <= 0 and self.config.provider_bond_per_slot <= 0:
            return

        assigned_counts = self._assigned_counts()
        for deal in self._open_deals():
            for slot in deal.slots:
                if slot.status == SLOT_REPAIRING:
                    continue
                provider = self.providers[slot.provider_id]
                if not self._provider_underbonded(provider, assigned_counts.get(slot.provider_id, 0)):
                    continue
                self._mark_suspect(slot, "provider_underbonded")
                self._record_evidence(epoch, deal, slot, slot.provider_id, "economic", "provider_underbonded")
                repairs_before = metrics.repairs_started
                self._start_repair(epoch, deal, slot, "provider_underbonded", metrics)
                if metrics.repairs_started > repairs_before:
                    metrics.provider_underbonded_repairs += 1

    def _record_repair_backoff(
        self,
        epoch: int,
        deal: DealState,
        slot: SlotState,
        reason: str,
        metrics: EpochMetrics,
        candidate_diagnostics: dict[str, Any] | None = None,
    ) -> None:
        metrics.repair_backoffs += 1
        if reason == "repair_cooldown":
            metrics.repair_cooldowns += 1
        if reason == "repair_attempt_cap":
            metrics.repair_attempt_caps += 1
        if reason != "repair_cooldown" and self.config.repair_backoff_epochs > 0:
            slot.repair_backoff_until_epoch = max(
                slot.repair_backoff_until_epoch,
                epoch + self.config.repair_backoff_epochs,
            )
        slot.last_reason = reason
        self.repair_rows.append(
            {
                "epoch": epoch,
                "event": "repair_backoff",
                "deal_id": deal.deal_id,
                "slot": slot.slot,
                "old_provider": slot.provider_id,
                "new_provider": "",
                "reason": reason,
                "generation": slot.current_gen,
                "attempt": slot.repair_attempts,
                "cooldown_until_epoch": slot.repair_backoff_until_epoch,
                **(candidate_diagnostics or empty_candidate_diagnostics()),
            }
        )

    def _select_replacement(self, epoch: int, deal: DealState, slot: SlotState) -> tuple[str | None, dict[str, Any]]:
        excluded = {s.provider_id for s in deal.slots}
        excluded.update(s.pending_provider_id for s in deal.slots if s.pending_provider_id)
        assigned_counts = self._assigned_counts(include_pending=True)
        deal_operator_counts = self._deal_operator_counts(deal, excluded_slot=slot)
        candidates, diagnostics = self._replacement_candidates(
            epoch,
            assigned_counts,
            excluded,
            deal_operator_counts,
            slot.provider_id,
            allow_same_deal=False,
            enforce_operator_cap=True,
        )
        if not candidates:
            candidates, diagnostics = self._replacement_candidates(
                epoch,
                assigned_counts,
                excluded,
                deal_operator_counts,
                slot.provider_id,
                allow_same_deal=True,
                enforce_operator_cap=True,
            )
        if not candidates and self.config.operator_assignment_cap_per_deal > 0:
            candidates, diagnostics = self._replacement_candidates(
                epoch,
                assigned_counts,
                excluded,
                deal_operator_counts,
                slot.provider_id,
                allow_same_deal=False,
                enforce_operator_cap=False,
            )
        if not candidates:
            return None, diagnostics

        seed = f"{self.config.seed}:{epoch}:{deal.deal_id}:{slot.slot}:{slot.current_gen}"
        return min(candidates, key=lambda pid: stable_digest(seed, pid)), diagnostics

    def _deal_operator_counts(self, deal: DealState, excluded_slot: SlotState | None = None) -> dict[str, int]:
        counts: dict[str, int] = {}
        for slot in deal.slots:
            if excluded_slot is slot:
                continue
            provider_id = slot.pending_provider_id if slot.status == SLOT_REPAIRING and slot.pending_provider_id else slot.provider_id
            operator_id = self.providers[provider_id].operator_id
            counts[operator_id] = counts.get(operator_id, 0) + 1
        return counts

    def _replacement_candidates(
        self,
        epoch: int,
        assigned_counts: dict[str, int],
        current_deal_providers: set[str | None],
        current_deal_operator_counts: dict[str, int],
        current_provider_id: str,
        allow_same_deal: bool,
        enforce_operator_cap: bool,
    ) -> tuple[list[str], dict[str, Any]]:
        candidates = []
        diagnostics = empty_candidate_diagnostics()
        diagnostics["candidate_mode"] = "fallback" if allow_same_deal else "primary"
        if not enforce_operator_cap:
            diagnostics["candidate_mode"] = "operator_cap_fallback"
        for pid, provider in self.providers.items():
            if pid == current_provider_id:
                diagnostics["excluded_current_provider"] += 1
                continue
            if not allow_same_deal and pid in current_deal_providers:
                diagnostics["excluded_current_deal"] += 1
                continue
            if not self._provider_lifecycle_assignable(provider):
                diagnostics["excluded_ineligible_lifecycle"] = diagnostics.get("excluded_ineligible_lifecycle", 0) + 1
                continue
            if not self._provider_has_bond_headroom(provider, assigned_counts.get(pid, 0), additional_slots=1):
                diagnostics["excluded_bond_headroom"] += 1
                continue
            if provider.behavior.draining:
                diagnostics["excluded_draining"] += 1
                continue
            if self._is_jailed(provider, epoch):
                diagnostics["excluded_jailed"] += 1
                continue
            if assigned_counts.get(pid, 0) >= provider.capacity_slots:
                diagnostics["excluded_capacity"] += 1
                continue
            if (
                enforce_operator_cap
                and self.config.operator_assignment_cap_per_deal > 0
                and current_deal_operator_counts.get(provider.operator_id, 0) >= self.config.operator_assignment_cap_per_deal
            ):
                diagnostics["excluded_operator_cap"] += 1
                continue
            candidates.append(pid)
        diagnostics["eligible_candidates"] = len(candidates)
        return candidates, diagnostics

    @staticmethod
    def _is_jailed(provider: Provider, epoch: int) -> bool:
        return epoch < provider.jailed_until_epoch

    @staticmethod
    def _provider_lifecycle_assignable(provider: Provider) -> bool:
        return provider.lifecycle_state == PROVIDER_ACTIVE and not provider.churned_epoch

    def _provider_required_bond(self, assigned_slots: int) -> float:
        return self.config.provider_min_bond + assigned_slots * self.config.provider_bond_per_slot

    def _provider_has_bond_headroom(
        self,
        provider: Provider,
        assigned_slots: int,
        additional_slots: int = 0,
    ) -> bool:
        required = self._provider_required_bond(assigned_slots + additional_slots)
        return provider.bond + 1e-12 >= required

    def _provider_underbonded(self, provider: Provider, assigned_slots: int) -> bool:
        return not self._provider_has_bond_headroom(provider, assigned_slots)

    def _assigned_counts(self, include_pending: bool = False) -> dict[str, int]:
        assigned_counts = {pid: 0 for pid in self.providers}
        for deal in self._open_deals():
            for slot in deal.slots:
                assigned_counts[slot.provider_id] += 1
                if include_pending and slot.pending_provider_id:
                    assigned_counts[slot.pending_provider_id] += 1
        return assigned_counts

    def _operator_assignment_counts(self, include_pending: bool = False) -> dict[str, int]:
        counts = {provider.operator_id: 0 for provider in self.providers.values()}
        for provider_id, assigned in self._assigned_counts(include_pending=include_pending).items():
            operator_id = self.providers[provider_id].operator_id
            counts[operator_id] = counts.get(operator_id, 0) + assigned
        return counts

    def _record_concentration_metrics(self, metrics: EpochMetrics) -> None:
        operator_counts = self._operator_assignment_counts(include_pending=True)
        total_assignments = sum(operator_counts.values())
        top_assignment_count = max(operator_counts.values(), default=0)
        metrics.max_operator_assignment_share_bps = int(top_assignment_count * 10_000 / max(1, total_assignments))

        max_deal_slots = 0
        cap_violations = 0
        for deal in self._open_deals():
            deal_counts = self._deal_operator_counts(deal)
            if deal_counts:
                max_deal_slots = max(max_deal_slots, max(deal_counts.values()))
            if self.config.operator_assignment_cap_per_deal > 0:
                cap_violations += sum(
                    1 for count in deal_counts.values() if count > self.config.operator_assignment_cap_per_deal
                )
        metrics.max_operator_deal_slots = max_deal_slots
        metrics.operator_deal_cap_violations = cap_violations

    def _required_blobs(self, deal: DealState) -> int:
        slot_bytes = deal.user_mdus * deal.rows * BLOB_SIZE_BYTES
        target_bytes = ceil_div(slot_bytes * self.config.quota_bps_per_epoch, 10_000)
        target_blobs = max(1, ceil_div(target_bytes, BLOB_SIZE_BYTES))
        return max(self.config.quota_min_blobs, min(target_blobs, self.config.quota_max_blobs))

    def _hard_fault_consequence(self, epoch: int, provider_id: str, reason: str) -> None:
        provider = self.providers[provider_id]
        if self.mode_at_least("JAIL_SIMULATED"):
            provider.jailed_until_epoch = max(provider.jailed_until_epoch, epoch + self.config.jail_epochs)
        if self.mode_at_least("SLASH_SIMULATED"):
            slash = min(provider.bond, self.config.slash_hard_fault)
            provider.bond -= slash
            provider.slashed += slash
            self.evidence_rows.append(
                {
                    "epoch": epoch,
                    "deal_id": "",
                    "slot": "",
                    "provider_id": provider_id,
                    "evidence_class": "economic",
                    "reason": f"slash:{reason}",
                    "consequence": "slash_simulated",
                }
            )

    def _record_evidence(
        self,
        epoch: int,
        deal: DealState,
        slot: SlotState,
        provider_id: str,
        evidence_class: str,
        reason: str,
    ) -> None:
        consequence = "measure"
        if reason in {"corrupt_retrieval", "invalid_synthetic_proof"} and self.mode_at_least("SLASH_SIMULATED"):
            consequence = "slash_simulated"
        elif reason in {"corrupt_retrieval", "invalid_synthetic_proof"} and self.mode_at_least("JAIL_SIMULATED"):
            consequence = "jail_simulated"
        elif self.mode_at_least("REPAIR_ONLY"):
            consequence = "repair_candidate"
        self.evidence_rows.append(
            {
                "epoch": epoch,
                "deal_id": deal.deal_id,
                "slot": slot.slot,
                "provider_id": provider_id,
                "evidence_class": evidence_class,
                "reason": reason,
                "consequence": consequence,
            }
        )

    def _record_overlay_evidence(
        self,
        epoch: int,
        deal_id: int | str,
        provider_id: str,
        evidence_class: str,
        reason: str,
        consequence: str,
    ) -> None:
        self.evidence_rows.append(
            {
                "epoch": epoch,
                "deal_id": deal_id,
                "slot": "overlay",
                "provider_id": provider_id,
                "evidence_class": evidence_class,
                "reason": reason,
                "consequence": consequence,
            }
        )

    def _record_slot_row(self, epoch: int, slot: SlotState) -> None:
        self.slot_rows.append(
            {
                "epoch": epoch,
                "deal_id": slot.deal_id,
                "slot": slot.slot,
                "provider_id": slot.provider_id,
                "status": slot.status,
                "health_state": slot.health_state,
                "health_reason": slot.health_reason,
                "pending_provider_id": slot.pending_provider_id or "",
                "generation": slot.current_gen,
                "repair_ready": int(slot.repair_ready),
                "repair_attempts": slot.repair_attempts,
                "repair_backoff_until_epoch": slot.repair_backoff_until_epoch,
                "repair_started_epoch": slot.repair_started_epoch,
                "missed_epochs": slot.missed_epochs,
                "deputy_missed_epochs": slot.deputy_missed_epochs,
                "credits_raw": slot.credits_raw,
                "credits_applied": slot.credits_applied,
                "synthetic": slot.synthetic,
                "direct_served": slot.direct_served,
                "deputy_served": slot.deputy_served,
                "durability_suspect": int(slot.durability_suspect),
                "compliant": int(slot.compliant_this_epoch),
                "reward_eligible": int(slot.reward_eligible_this_epoch),
                "reason": slot.last_reason,
            }
        )

    def _record_data_loss_events(self, metrics: EpochMetrics) -> None:
        for deal in self._open_deals():
            trusted_slots = sum(1 for slot in deal.slots if not slot.durability_suspect)
            if trusted_slots < deal.k:
                metrics.data_loss_events += 1

    def _settle_storage_escrow(self, epoch: int, metrics: EpochMetrics) -> None:
        if self.config.storage_lockin_enabled and self.config.deal_duration_epochs > 0:
            for deal in self._open_deals():
                self._ensure_deal_storage_lock(deal, metrics)
                self._earn_deal_storage_fee(deal, metrics)

        self._close_configured_deals(epoch, metrics)
        metrics.open_deals = len(self._open_deals())
        metrics.storage_escrow_outstanding = self._storage_escrow_outstanding()

    def _ensure_deal_storage_lock(self, deal: DealState, metrics: EpochMetrics) -> None:
        if deal.storage_escrow_locked > 0:
            return
        deal.storage_fee_per_epoch = self.storage_price * deal.user_mdus * deal.n
        deal.storage_escrow_locked = deal.storage_fee_per_epoch * self.config.deal_duration_epochs
        metrics.storage_escrow_locked += deal.storage_escrow_locked
        self.evidence_rows.append(
            {
                "epoch": deal.opened_epoch,
                "deal_id": deal.deal_id,
                "slot": "",
                "provider_id": "user-gateway",
                "evidence_class": "market",
                "reason": "storage_escrow_locked",
                "consequence": "storage_lockin",
            }
        )

    def _earn_deal_storage_fee(self, deal: DealState, metrics: EpochMetrics) -> None:
        remaining = max(0.0, deal.storage_escrow_locked - deal.storage_fee_earned)
        earned = min(deal.storage_fee_per_epoch, remaining)
        if earned <= 0:
            return
        deal.storage_fee_earned += earned
        metrics.storage_escrow_earned += earned

        eligible_slots = [slot for slot in deal.slots if slot.reward_eligible_this_epoch]
        payout = earned * len(eligible_slots) / max(1, deal.n)
        burned = max(0.0, earned - payout)
        metrics.storage_fee_provider_payouts += payout
        metrics.storage_fee_burned += burned
        if not eligible_slots:
            return
        per_provider = payout / len(eligible_slots)
        for slot in eligible_slots:
            self.providers[slot.provider_id].storage_fee_revenue += per_provider

    def _close_configured_deals(self, epoch: int, metrics: EpochMetrics) -> None:
        if self.config.deal_close_epoch <= 0 or epoch != self.config.deal_close_epoch:
            return
        candidates = sorted(self._open_deals(), key=lambda deal: deal.deal_id)
        close_count = self.config.deal_close_count
        if close_count <= 0 and self.config.deal_close_bps > 0:
            close_count = int(len(candidates) * self.config.deal_close_bps / 10_000)
        if close_count <= 0:
            return
        for deal in candidates[:close_count]:
            if self.config.storage_lockin_enabled and self.config.deal_duration_epochs > 0:
                self._ensure_deal_storage_lock(deal, metrics)
            refundable = max(0.0, deal.storage_escrow_locked - deal.storage_fee_earned - deal.storage_escrow_refunded)
            deal.storage_escrow_refunded += refundable
            deal.closed_epoch = epoch
            metrics.storage_escrow_refunded += refundable
            metrics.deals_closed += 1
            self.evidence_rows.append(
                {
                    "epoch": epoch,
                    "deal_id": deal.deal_id,
                    "slot": "",
                    "provider_id": "chain",
                    "evidence_class": "market",
                    "reason": "deal_storage_escrow_closed",
                    "consequence": "refund_unearned",
                }
            )

    def _storage_escrow_outstanding(self) -> float:
        return sum(
            max(0.0, deal.storage_escrow_locked - deal.storage_fee_earned - deal.storage_escrow_refunded)
            for deal in self.deals
        )

    def _settle_epoch_economy(self, epoch: int, metrics: EpochMetrics) -> None:
        assigned_counts = self._assigned_counts()

        reward_pool = metrics.active_slots * self.config.base_reward_per_slot
        reward_paid = metrics.reward_eligible_slots * self.config.base_reward_per_slot
        reward_burned = max(0.0, reward_pool - reward_paid)
        metrics.reward_pool_minted = reward_pool
        metrics.reward_paid = reward_paid
        metrics.reward_burned = reward_burned

        if metrics.reward_eligible_slots:
            for deal in self._open_deals():
                for slot in deal.slots:
                    if slot.reward_eligible_this_epoch:
                        self.providers[slot.provider_id].reward_revenue += self.config.base_reward_per_slot

        self._settle_storage_escrow(epoch, metrics)

        audit_minted = self.config.audit_budget_per_epoch
        current_audit_demand = (metrics.quota_misses + metrics.deputy_misses) * self.config.audit_cost_per_miss
        audit_demand = self.audit_budget_backlog + current_audit_demand
        audit_available = self.audit_budget_carryover + audit_minted
        audit_spent = min(audit_available, audit_demand)
        self.audit_budget_backlog = max(0.0, audit_demand - audit_spent)
        self.audit_budget_carryover = max(0.0, audit_available - audit_spent)
        metrics.audit_budget_minted = audit_minted
        metrics.audit_budget_demand = audit_demand
        metrics.audit_budget_spent = audit_spent
        metrics.audit_budget_carryover = self.audit_budget_carryover
        metrics.audit_budget_backlog = self.audit_budget_backlog
        metrics.audit_budget_exhausted = int(self.audit_budget_backlog > 0)

        if (
            self.config.elasticity_trigger_retrievals_per_epoch > 0
            and metrics.retrieval_attempts >= self.config.elasticity_trigger_retrievals_per_epoch
        ):
            if self.config.elasticity_overlay_enabled:
                self._maybe_scale_elasticity_overlays(epoch, metrics)
            elif self.elasticity_spent_total + self.config.elasticity_base_cost > self.config.elasticity_max_spend:
                metrics.elasticity_rejections += 1
            else:
                self.elasticity_spent_total += self.config.elasticity_base_cost
                metrics.elasticity_spent += self.config.elasticity_base_cost
        self._record_elasticity_overlay_snapshot(epoch, metrics)

        shock_stats = self._provider_cost_shock_stats(epoch)
        metrics.provider_cost_shock_active = shock_stats["active"]
        metrics.provider_cost_shocked_providers = shock_stats["shocked_providers"]
        metrics.provider_cost_shock_fixed_multiplier_bps = shock_stats["fixed_multiplier_bps"]
        metrics.provider_cost_shock_storage_multiplier_bps = shock_stats["storage_multiplier_bps"]
        metrics.provider_cost_shock_bandwidth_multiplier_bps = shock_stats["bandwidth_multiplier_bps"]

        provider_cost = 0.0
        for provider_id, provider in self.providers.items():
            if not self._provider_lifecycle_assignable(provider):
                continue
            fixed_multiplier, storage_multiplier, bandwidth_multiplier = self._provider_cost_multipliers(provider, epoch)
            cost = (
                self.config.provider_fixed_cost_per_epoch
                * fixed_multiplier
                + assigned_counts[provider_id]
                * self.config.provider_storage_cost_per_slot_epoch
                * provider.storage_cost_multiplier
                * storage_multiplier
                + self.provider_epoch_serves[provider_id]
                * self.config.provider_bandwidth_cost_per_retrieval
                * provider.bandwidth_cost_multiplier
                * bandwidth_multiplier
            )
            provider.total_cost += cost
            provider_cost += cost

        self._apply_provider_economic_churn(epoch, metrics, assigned_counts)
        self._apply_provider_supply_entry(epoch, metrics)
        self._record_provider_bond_snapshot(metrics, assigned_counts)
        self._record_provider_capacity_snapshot(metrics, assigned_counts)

        provider_slashed_total = sum(p.slashed for p in self.providers.values())
        provider_slashed_delta = provider_slashed_total - self.provider_slashed_total_last_epoch
        self.provider_slashed_total_last_epoch = provider_slashed_total

        metrics.provider_cost = provider_cost
        metrics.provider_revenue = (
            metrics.retrieval_provider_payouts
            + metrics.storage_fee_provider_payouts
            + metrics.reward_paid
            + metrics.performance_reward_paid
        )
        metrics.provider_pnl = metrics.provider_revenue - metrics.provider_cost - provider_slashed_delta
        total_capacity = max(1, metrics.active_provider_capacity)
        metrics.storage_utilization_bps = int(metrics.active_slots * 10_000 / total_capacity)
        self.economy_rows.append(
            {
                "epoch": epoch,
                "storage_price": metrics.storage_price,
                "retrieval_price_per_slot": metrics.retrieval_price_per_slot,
                "storage_utilization_bps": metrics.storage_utilization_bps,
                "retrieval_base_burned": metrics.retrieval_base_burned,
                "retrieval_variable_burned": metrics.retrieval_variable_burned,
                "retrieval_provider_payouts": metrics.retrieval_provider_payouts,
                "storage_escrow_locked": metrics.storage_escrow_locked,
                "storage_escrow_earned": metrics.storage_escrow_earned,
                "storage_escrow_refunded": metrics.storage_escrow_refunded,
                "storage_escrow_outstanding": metrics.storage_escrow_outstanding,
                "storage_fee_provider_payouts": metrics.storage_fee_provider_payouts,
                "storage_fee_burned": metrics.storage_fee_burned,
                "open_deals": metrics.open_deals,
                "deals_closed": metrics.deals_closed,
                "sponsored_retrieval_attempts": metrics.sponsored_retrieval_attempts,
                "owner_funded_retrieval_attempts": metrics.owner_funded_retrieval_attempts,
                "sponsored_retrieval_base_spent": metrics.sponsored_retrieval_base_spent,
                "sponsored_retrieval_variable_spent": metrics.sponsored_retrieval_variable_spent,
                "owner_retrieval_escrow_debited": metrics.owner_retrieval_escrow_debited,
                "reward_pool_minted": metrics.reward_pool_minted,
                "reward_paid": metrics.reward_paid,
                "reward_burned": metrics.reward_burned,
                "audit_budget_minted": metrics.audit_budget_minted,
                "audit_budget_demand": metrics.audit_budget_demand,
                "audit_budget_spent": metrics.audit_budget_spent,
                "audit_budget_carryover": metrics.audit_budget_carryover,
                "audit_budget_backlog": metrics.audit_budget_backlog,
                "audit_budget_exhausted": metrics.audit_budget_exhausted,
                "new_deal_latent_requests": metrics.new_deal_latent_requests,
                "new_deal_requests": metrics.new_deal_requests,
                "new_deals_accepted": metrics.new_deals_accepted,
                "new_deals_suppressed_price": metrics.new_deals_suppressed_price,
                "new_deals_rejected_price": metrics.new_deals_rejected_price,
                "new_deals_rejected_capacity": metrics.new_deals_rejected_capacity,
                "evidence_spam_claims": metrics.evidence_spam_claims,
                "evidence_spam_convictions": metrics.evidence_spam_convictions,
                "evidence_spam_bond_burned": metrics.evidence_spam_bond_burned,
                "evidence_spam_bounty_paid": metrics.evidence_spam_bounty_paid,
                "evidence_spam_net_gain": metrics.evidence_spam_net_gain,
                "provider_cost": metrics.provider_cost,
                "provider_revenue": metrics.provider_revenue,
                "provider_pnl": metrics.provider_pnl,
                "provider_cost_shock_active": metrics.provider_cost_shock_active,
                "provider_cost_shocked_providers": metrics.provider_cost_shocked_providers,
                "provider_cost_shock_fixed_multiplier_bps": metrics.provider_cost_shock_fixed_multiplier_bps,
                "provider_cost_shock_storage_multiplier_bps": metrics.provider_cost_shock_storage_multiplier_bps,
                "provider_cost_shock_bandwidth_multiplier_bps": metrics.provider_cost_shock_bandwidth_multiplier_bps,
                "churn_pressure_providers": metrics.churn_pressure_providers,
                "provider_churn_events": metrics.provider_churn_events,
                "churned_providers": metrics.churned_providers,
                "provider_entries": metrics.provider_entries,
                "provider_probation_promotions": metrics.provider_probation_promotions,
                "provider_underbonded_repairs": metrics.provider_underbonded_repairs,
                "underbonded_providers": metrics.underbonded_providers,
                "underbonded_assigned_slots": metrics.underbonded_assigned_slots,
                "provider_bond_required": metrics.provider_bond_required,
                "provider_bond_available": metrics.provider_bond_available,
                "provider_bond_deficit": metrics.provider_bond_deficit,
                "reserve_providers": metrics.reserve_providers,
                "probationary_providers": metrics.probationary_providers,
                "entered_active_providers": metrics.entered_active_providers,
                "active_provider_capacity": metrics.active_provider_capacity,
                "exited_provider_capacity": metrics.exited_provider_capacity,
                "reserve_provider_capacity": metrics.reserve_provider_capacity,
                "probationary_provider_capacity": metrics.probationary_provider_capacity,
                "churned_assigned_slots": metrics.churned_assigned_slots,
                "performance_reward_paid": metrics.performance_reward_paid,
                "latency_sample_count": metrics.latency_sample_count,
                "average_latency_ms": metrics.total_latency_ms / metrics.latency_sample_count if metrics.latency_sample_count else 0.0,
                "elasticity_spent": metrics.elasticity_spent,
                "elasticity_rejections": metrics.elasticity_rejections,
                "elasticity_overlay_activations": metrics.elasticity_overlay_activations,
                "elasticity_overlay_ready": metrics.elasticity_overlay_ready,
                "elasticity_overlay_active": metrics.elasticity_overlay_active,
                "elasticity_overlay_expired": metrics.elasticity_overlay_expired,
                "elasticity_overlay_serves": metrics.elasticity_overlay_serves,
                "elasticity_overlay_rejections": metrics.elasticity_overlay_rejections,
                "staged_upload_attempts": metrics.staged_upload_attempts,
                "staged_upload_accepted": metrics.staged_upload_accepted,
                "staged_upload_committed": metrics.staged_upload_committed,
                "staged_upload_rejections": metrics.staged_upload_rejections,
                "staged_upload_cleaned": metrics.staged_upload_cleaned,
                "staged_upload_pending_generations": metrics.staged_upload_pending_generations,
                "staged_upload_pending_mdus": metrics.staged_upload_pending_mdus,
            }
        )

    def _apply_provider_economic_churn(
        self,
        epoch: int,
        metrics: EpochMetrics,
        assigned_counts: dict[str, int],
    ) -> None:
        threshold = self.config.provider_churn_pnl_threshold
        for provider in self.providers.values():
            if not self._provider_lifecycle_assignable(provider):
                continue
            if provider.pnl < threshold:
                provider.churn_pressure_epochs += 1
            else:
                provider.churn_pressure_epochs = 0

        pressure_candidates = [
            provider
            for provider in self.providers.values()
            if self._provider_lifecycle_assignable(provider)
            and provider.churn_pressure_epochs >= self.config.provider_churn_after_epochs
        ]
        metrics.churn_pressure_providers = len(pressure_candidates)

        if self.config.provider_churn_enabled and pressure_candidates:
            active_providers = sum(
                1 for provider in self.providers.values() if self._provider_lifecycle_assignable(provider)
            )
            max_exits_by_floor = max(0, active_providers - self.config.provider_churn_min_remaining_providers)
            max_exits_by_config = self.config.provider_churn_max_providers_per_epoch or len(pressure_candidates)
            exit_limit = min(len(pressure_candidates), max_exits_by_floor, max_exits_by_config)
            pressure_candidates.sort(key=lambda provider: (provider.pnl, provider.provider_id))
            for provider in pressure_candidates[:exit_limit]:
                provider.churned_epoch = epoch
                provider.behavior.draining = True
                provider.behavior.offline_epochs.update(range(epoch + 1, self.config.epochs + 1))
                metrics.provider_churn_events += 1
                self.evidence_rows.append(
                    {
                        "epoch": epoch,
                        "deal_id": "",
                        "slot": "",
                        "provider_id": provider.provider_id,
                        "evidence_class": "market",
                        "reason": "provider_economic_churn",
                        "consequence": "draining_exit",
                    }
                )

    def _promote_probationary_providers(self, epoch: int, metrics: EpochMetrics) -> None:
        for provider in self.providers.values():
            if provider.lifecycle_state != PROVIDER_PROBATION:
                continue
            if provider.probation_until_epoch and epoch < provider.probation_until_epoch:
                continue
            provider.lifecycle_state = PROVIDER_ACTIVE
            provider.supply_promoted_epoch = epoch
            metrics.provider_probation_promotions += 1
            self.evidence_rows.append(
                {
                    "epoch": epoch,
                    "deal_id": "",
                    "slot": "",
                    "provider_id": provider.provider_id,
                    "evidence_class": "market",
                    "reason": "provider_probation_promoted",
                    "consequence": "active_supply",
                }
            )

    def _apply_provider_supply_entry(
        self,
        epoch: int,
        metrics: EpochMetrics,
    ) -> None:
        if not self.config.provider_entry_enabled:
            return
        if self.config.provider_entry_max_per_epoch <= 0:
            return
        if epoch < self.config.provider_entry_start_epoch:
            return
        if self.config.provider_entry_end_epoch and epoch > self.config.provider_entry_end_epoch:
            return
        if not self._provider_entry_triggered(metrics):
            return

        reserve = sorted(
            (
                provider
                for provider in self.providers.values()
                if provider.lifecycle_state == PROVIDER_RESERVE and not provider.churned_epoch
            ),
            key=lambda provider: provider.provider_id,
        )
        for provider in reserve[: self.config.provider_entry_max_per_epoch]:
            provider.lifecycle_state = PROVIDER_PROBATION
            provider.entered_epoch = epoch
            provider.probation_until_epoch = epoch + self.config.provider_entry_probation_epochs
            metrics.provider_entries += 1
            self.evidence_rows.append(
                {
                    "epoch": epoch,
                    "deal_id": "",
                    "slot": "",
                    "provider_id": provider.provider_id,
                    "evidence_class": "market",
                    "reason": "provider_supply_entry",
                    "consequence": "probation",
                }
            )
            if self.config.provider_entry_probation_epochs == 0:
                provider.lifecycle_state = PROVIDER_ACTIVE
                provider.supply_promoted_epoch = epoch
                metrics.provider_probation_promotions += 1

    def _provider_entry_triggered(self, metrics: EpochMetrics) -> bool:
        utilization_threshold = self.config.provider_entry_trigger_utilization_bps
        price_threshold = self.config.provider_entry_trigger_storage_price
        if utilization_threshold <= 0 and price_threshold <= 0:
            return True

        active_capacity = sum(
            provider.capacity_slots
            for provider in self.providers.values()
            if self._provider_lifecycle_assignable(provider)
        )
        utilization_bps = int(metrics.active_slots * 10_000 / max(1, active_capacity))
        if utilization_threshold > 0 and utilization_bps >= utilization_threshold:
            return True
        if price_threshold > 0 and self.storage_price >= price_threshold:
            return True
        return False

    def _record_provider_bond_snapshot(
        self,
        metrics: EpochMetrics,
        assigned_counts: dict[str, int],
    ) -> None:
        for provider in self.providers.values():
            if provider.churned_epoch:
                continue
            if provider.lifecycle_state not in {PROVIDER_ACTIVE, PROVIDER_PROBATION}:
                continue
            assigned = assigned_counts.get(provider.provider_id, 0)
            required = self._provider_required_bond(assigned)
            metrics.provider_bond_required += required
            metrics.provider_bond_available += provider.bond
            if provider.bond + 1e-12 >= required:
                continue
            metrics.underbonded_providers += 1
            metrics.underbonded_assigned_slots += assigned
            metrics.provider_bond_deficit += required - provider.bond

    def _record_provider_capacity_snapshot(
        self,
        metrics: EpochMetrics,
        assigned_counts: dict[str, int],
    ) -> None:
        churned = [provider for provider in self.providers.values() if provider.churned_epoch]
        active = [
            provider
            for provider in self.providers.values()
            if provider.lifecycle_state == PROVIDER_ACTIVE and not provider.churned_epoch
        ]
        reserve = [
            provider
            for provider in self.providers.values()
            if provider.lifecycle_state == PROVIDER_RESERVE and not provider.churned_epoch
        ]
        probationary = [
            provider
            for provider in self.providers.values()
            if provider.lifecycle_state == PROVIDER_PROBATION and not provider.churned_epoch
        ]
        metrics.churned_providers = len(churned)
        metrics.reserve_providers = len(reserve)
        metrics.probationary_providers = len(probationary)
        metrics.entered_active_providers = sum(
            1 for provider in active if provider.entered_epoch > 0
        )
        metrics.active_provider_capacity = sum(provider.capacity_slots for provider in active)
        metrics.exited_provider_capacity = sum(provider.capacity_slots for provider in churned)
        metrics.reserve_provider_capacity = sum(provider.capacity_slots for provider in reserve)
        metrics.probationary_provider_capacity = sum(provider.capacity_slots for provider in probationary)
        metrics.churned_assigned_slots = sum(assigned_counts[provider.provider_id] for provider in churned)

    def _provider_cost_multipliers(self, provider: Provider, epoch: int) -> tuple[float, float, float]:
        fixed_bps = 10_000
        storage_bps = 10_000
        bandwidth_bps = 10_000
        for shock in self.config.provider_cost_shocks:
            if not self._provider_cost_shock_applies(shock, provider, epoch):
                continue
            fixed_bps = fixed_bps * int(shock.get("fixed_cost_multiplier_bps", 10_000)) // 10_000
            storage_bps = storage_bps * int(shock.get("storage_cost_multiplier_bps", 10_000)) // 10_000
            bandwidth_bps = bandwidth_bps * int(shock.get("bandwidth_cost_multiplier_bps", 10_000)) // 10_000
        return fixed_bps / 10_000, storage_bps / 10_000, bandwidth_bps / 10_000

    def _provider_cost_shock_stats(self, epoch: int) -> dict[str, int]:
        active_shocks = 0
        shocked_providers: set[str] = set()
        max_fixed_bps = 10_000
        max_storage_bps = 10_000
        max_bandwidth_bps = 10_000
        for shock in self.config.provider_cost_shocks:
            if not self._cost_shock_epoch_applies(shock, epoch):
                continue
            active_shocks += 1
            for provider in self.providers.values():
                if not self._provider_lifecycle_assignable(provider):
                    continue
                if not self._provider_cost_shock_applies(shock, provider, epoch):
                    continue
                shocked_providers.add(provider.provider_id)
                fixed_multiplier, storage_multiplier, bandwidth_multiplier = self._provider_cost_multipliers(provider, epoch)
                max_fixed_bps = max(max_fixed_bps, int(round(fixed_multiplier * 10_000)))
                max_storage_bps = max(max_storage_bps, int(round(storage_multiplier * 10_000)))
                max_bandwidth_bps = max(max_bandwidth_bps, int(round(bandwidth_multiplier * 10_000)))
        return {
            "active": active_shocks,
            "shocked_providers": len(shocked_providers),
            "fixed_multiplier_bps": max_fixed_bps,
            "storage_multiplier_bps": max_storage_bps,
            "bandwidth_multiplier_bps": max_bandwidth_bps,
        }

    def _provider_cost_shock_applies(self, shock: dict[str, Any], provider: Provider, epoch: int) -> bool:
        if not self._cost_shock_epoch_applies(shock, epoch):
            return False
        provider_id = shock.get("provider_id")
        if provider_id and str(provider_id) != provider.provider_id:
            return False
        provider_ids = {str(item) for item in shock.get("provider_ids", [])}
        if provider_ids and provider.provider_id not in provider_ids:
            return False
        operator_id = shock.get("operator_id")
        if operator_id and str(operator_id) != provider.operator_id:
            return False
        region = shock.get("region")
        if region and str(region) != provider.region:
            return False
        return True

    def _cost_shock_epoch_applies(self, shock: dict[str, Any], epoch: int) -> bool:
        start_epoch = int(shock.get("start_epoch", shock.get("epoch", 1)))
        end_epoch = int(shock.get("end_epoch", self.config.epochs))
        return start_epoch <= epoch <= end_epoch

    def _update_provider_capabilities(self, epoch: int, metrics: EpochMetrics) -> None:
        if not self.config.high_bandwidth_promotion_enabled:
            metrics.high_bandwidth_providers = sum(
                1 for provider in self.providers.values() if provider.capability_tier == CAPABILITY_HIGH_BANDWIDTH
            )
            return

        for provider in self.providers.values():
            attempts = provider.retrieval_attempts
            success_rate_bps = int(provider.retrieval_successes * 10_000 / attempts) if attempts else 0
            saturation_bps = int(provider.saturated_responses * 10_000 / attempts) if attempts else 0
            if provider.capability_tier == CAPABILITY_HIGH_BANDWIDTH:
                if (
                    self.config.high_bandwidth_demotion_saturation_bps > 0
                    and attempts >= self.config.high_bandwidth_min_retrievals
                    and saturation_bps > self.config.high_bandwidth_demotion_saturation_bps
                ):
                    provider.capability_tier = CAPABILITY_ACTIVE
                    provider.capability_reason = "demoted:saturation_regression"
                    provider.high_bandwidth_demoted_epoch = epoch
                    metrics.high_bandwidth_demotions += 1
                continue

            if provider.bandwidth_capacity_per_epoch < self.config.high_bandwidth_capacity_threshold:
                continue
            if attempts < self.config.high_bandwidth_min_retrievals:
                continue
            if success_rate_bps < self.config.high_bandwidth_min_success_rate_bps:
                continue
            if saturation_bps > self.config.high_bandwidth_max_saturation_bps:
                continue
            if provider.hard_faults > 0:
                continue

            provider.capability_tier = CAPABILITY_HIGH_BANDWIDTH
            provider.capability_reason = "promoted:capacity_success_saturation"
            provider.high_bandwidth_promoted_epoch = epoch
            metrics.high_bandwidth_promotions += 1

        metrics.high_bandwidth_providers = sum(
            1 for provider in self.providers.values() if provider.capability_tier == CAPABILITY_HIGH_BANDWIDTH
        )

    def _maybe_update_prices(self, metrics: EpochMetrics) -> None:
        if not self.config.dynamic_pricing:
            return
        self.storage_price = bounded_step(
            current=self.storage_price,
            direction=1 if metrics.storage_utilization_bps > self.config.storage_target_utilization_bps else -1,
            step_bps=self.config.dynamic_pricing_max_step_bps,
            min_value=self.config.storage_price_min,
            max_value=self.config.storage_price_max,
        )
        self.retrieval_price_per_slot = bounded_step(
            current=self.retrieval_price_per_slot,
            direction=1 if metrics.retrieval_attempts > self.config.retrieval_target_per_epoch else -1,
            step_bps=self.config.dynamic_pricing_max_step_bps,
            min_value=self.config.retrieval_price_min,
            max_value=self.config.retrieval_price_max,
        )

    def _totals(self) -> dict[str, Any]:
        fields = [
            "retrieval_attempts",
            "retrieval_latent_attempts",
            "retrieval_demand_shock_active",
            "retrieval_successes",
            "unavailable_reads",
            "data_loss_events",
            "direct_served",
            "deputy_served",
            "corrupt_responses",
            "withheld_responses",
            "offline_responses",
            "saturated_responses",
            "invalid_proofs",
            "quota_misses",
            "deputy_misses",
            "compliant_slots",
            "reward_eligible_slots",
            "active_slots",
            "repairing_slots",
            "suspect_slots",
            "delinquent_slots",
            "repairs_started",
            "repairs_ready",
            "repairs_completed",
            "repair_attempts",
            "repair_backoffs",
            "repair_cooldowns",
            "repair_attempt_caps",
            "repair_timeouts",
            "high_bandwidth_promotions",
            "high_bandwidth_demotions",
            "high_bandwidth_serves",
            "hot_retrieval_attempts",
            "hot_high_bandwidth_serves",
            "platinum_serves",
            "gold_serves",
            "silver_serves",
            "fail_serves",
            "latency_sample_count",
            "total_latency_ms",
            "performance_reward_paid",
            "new_deal_latent_requests",
            "new_deal_requests",
            "new_deals_accepted",
            "new_deals_suppressed_price",
            "new_deals_rejected_price",
            "new_deals_rejected_capacity",
            "paid_corrupt_bytes",
            "retrieval_base_burned",
            "retrieval_variable_burned",
            "retrieval_provider_payouts",
            "storage_escrow_locked",
            "storage_escrow_earned",
            "storage_escrow_refunded",
            "storage_fee_provider_payouts",
            "storage_fee_burned",
            "deals_closed",
            "sponsored_retrieval_attempts",
            "owner_funded_retrieval_attempts",
            "sponsored_retrieval_base_spent",
            "sponsored_retrieval_variable_spent",
            "owner_retrieval_escrow_debited",
            "reward_pool_minted",
            "reward_paid",
            "reward_burned",
            "audit_budget_minted",
            "audit_budget_demand",
            "audit_budget_spent",
            "audit_budget_exhausted",
            "evidence_spam_claims",
            "evidence_spam_convictions",
            "evidence_spam_bond_burned",
            "evidence_spam_bounty_paid",
            "evidence_spam_net_gain",
            "provider_cost",
            "provider_cost_shock_active",
            "provider_churn_events",
            "provider_entries",
            "provider_probation_promotions",
            "provider_underbonded_repairs",
            "elasticity_spent",
            "elasticity_rejections",
            "elasticity_overlay_activations",
            "elasticity_overlay_expired",
            "elasticity_overlay_serves",
            "elasticity_overlay_rejections",
            "staged_upload_attempts",
            "staged_upload_accepted",
            "staged_upload_committed",
            "staged_upload_rejections",
            "staged_upload_cleaned",
        ]
        totals = {name: sum(getattr(m, name) for m in self.metrics) for name in fields}
        attempts = totals["retrieval_attempts"]
        successes = totals["retrieval_successes"]
        active_slots = totals["active_slots"]
        totals["success_rate"] = successes / attempts if attempts else 0.0
        totals["reward_coverage"] = (
            totals["reward_eligible_slots"] / active_slots if active_slots else 0.0
        )
        totals["new_deal_acceptance_rate"] = (
            totals["new_deals_accepted"] / totals["new_deal_requests"]
            if totals["new_deal_requests"]
            else 0.0
        )
        totals["new_deal_latent_acceptance_rate"] = (
            totals["new_deals_accepted"] / totals["new_deal_latent_requests"]
            if totals["new_deal_latent_requests"]
            else 0.0
        )
        totals["final_deals"] = len(self.deals)
        totals["final_open_deals"] = len(self._open_deals())
        totals["final_closed_deals"] = sum(1 for deal in self.deals if deal.closed_epoch)
        totals["storage_escrow_outstanding"] = self._storage_escrow_outstanding()
        totals["max_storage_escrow_outstanding"] = max(
            (m.storage_escrow_outstanding for m in self.metrics),
            default=0.0,
        )
        totals["provider_hard_faults"] = sum(p.hard_faults for p in self.providers.values())
        totals["provider_revenue"] = sum(p.revenue for p in self.providers.values())
        totals["provider_pnl"] = sum(p.pnl for p in self.providers.values())
        totals["provider_slashed"] = sum(p.slashed for p in self.providers.values())
        totals["providers_negative_pnl"] = sum(1 for p in self.providers.values() if p.pnl < 0)
        totals["high_bandwidth_providers"] = sum(
            1 for p in self.providers.values() if p.capability_tier == CAPABILITY_HIGH_BANDWIDTH
        )
        totals["average_latency_ms"] = (
            totals["total_latency_ms"] / totals["latency_sample_count"] if totals["latency_sample_count"] else 0.0
        )
        totals["max_retrieval_demand_multiplier_bps"] = max(
            (m.retrieval_demand_multiplier_bps for m in self.metrics),
            default=10_000,
        )
        tiered_serves = (
            totals["platinum_serves"]
            + totals["gold_serves"]
            + totals["silver_serves"]
            + totals["fail_serves"]
        )
        totals["platinum_share"] = totals["platinum_serves"] / tiered_serves if tiered_serves else 0.0
        totals["performance_fail_rate"] = totals["fail_serves"] / tiered_serves if tiered_serves else 0.0
        totals["sponsored_retrieval_spent"] = (
            totals["sponsored_retrieval_base_spent"] + totals["sponsored_retrieval_variable_spent"]
        )
        totals["min_provider_pnl"] = min((p.pnl for p in self.providers.values()), default=0.0)
        totals["max_provider_pnl"] = max((p.pnl for p in self.providers.values()), default=0.0)
        totals["max_provider_cost_shocked_providers"] = max(
            (m.provider_cost_shocked_providers for m in self.metrics),
            default=0,
        )
        totals["max_provider_cost_shock_fixed_multiplier_bps"] = max(
            (m.provider_cost_shock_fixed_multiplier_bps for m in self.metrics),
            default=10_000,
        )
        totals["max_provider_cost_shock_storage_multiplier_bps"] = max(
            (m.provider_cost_shock_storage_multiplier_bps for m in self.metrics),
            default=10_000,
        )
        totals["max_provider_cost_shock_bandwidth_multiplier_bps"] = max(
            (m.provider_cost_shock_bandwidth_multiplier_bps for m in self.metrics),
            default=10_000,
        )
        totals["churn_pressure_provider_epochs"] = sum(m.churn_pressure_providers for m in self.metrics)
        totals["max_churn_pressure_providers"] = max(
            (m.churn_pressure_providers for m in self.metrics),
            default=0,
        )
        totals["churned_providers"] = sum(1 for p in self.providers.values() if p.churned_epoch)
        totals["max_churned_providers"] = max((m.churned_providers for m in self.metrics), default=0)
        totals["final_underbonded_providers"] = self.metrics[-1].underbonded_providers if self.metrics else 0
        totals["max_underbonded_providers"] = max((m.underbonded_providers for m in self.metrics), default=0)
        totals["final_underbonded_assigned_slots"] = (
            self.metrics[-1].underbonded_assigned_slots if self.metrics else 0
        )
        totals["max_underbonded_assigned_slots"] = max(
            (m.underbonded_assigned_slots for m in self.metrics),
            default=0,
        )
        totals["final_provider_bond_required"] = self.metrics[-1].provider_bond_required if self.metrics else 0.0
        totals["final_provider_bond_available"] = self.metrics[-1].provider_bond_available if self.metrics else 0.0
        totals["final_provider_bond_deficit"] = self.metrics[-1].provider_bond_deficit if self.metrics else 0.0
        totals["max_provider_bond_deficit"] = max((m.provider_bond_deficit for m in self.metrics), default=0.0)
        totals["final_elasticity_overlay_active"] = self.metrics[-1].elasticity_overlay_active if self.metrics else 0
        totals["max_elasticity_overlay_active"] = max((m.elasticity_overlay_active for m in self.metrics), default=0)
        totals["final_elasticity_overlay_ready"] = self.metrics[-1].elasticity_overlay_ready if self.metrics else 0
        totals["max_elasticity_overlay_ready"] = max((m.elasticity_overlay_ready for m in self.metrics), default=0)
        totals["final_staged_upload_pending_generations"] = (
            self.metrics[-1].staged_upload_pending_generations if self.metrics else 0
        )
        totals["max_staged_upload_pending_generations"] = max(
            (m.staged_upload_pending_generations for m in self.metrics),
            default=0,
        )
        totals["final_staged_upload_pending_mdus"] = (
            self.metrics[-1].staged_upload_pending_mdus if self.metrics else 0
        )
        totals["max_staged_upload_pending_mdus"] = max(
            (m.staged_upload_pending_mdus for m in self.metrics),
            default=0,
        )
        totals["reserve_providers"] = sum(
            1 for p in self.providers.values() if p.lifecycle_state == PROVIDER_RESERVE and not p.churned_epoch
        )
        totals["probationary_providers"] = sum(
            1 for p in self.providers.values() if p.lifecycle_state == PROVIDER_PROBATION and not p.churned_epoch
        )
        totals["entered_active_providers"] = sum(
            1
            for p in self.providers.values()
            if p.lifecycle_state == PROVIDER_ACTIVE and p.entered_epoch > 0 and not p.churned_epoch
        )
        totals["max_probationary_providers"] = max((m.probationary_providers for m in self.metrics), default=0)
        totals["max_reserve_providers"] = max((m.reserve_providers for m in self.metrics), default=0)
        totals["final_active_provider_capacity"] = sum(
            p.capacity_slots
            for p in self.providers.values()
            if p.lifecycle_state == PROVIDER_ACTIVE and not p.churned_epoch
        )
        totals["final_exited_provider_capacity"] = sum(
            p.capacity_slots for p in self.providers.values() if p.churned_epoch
        )
        totals["final_reserve_provider_capacity"] = sum(
            p.capacity_slots
            for p in self.providers.values()
            if p.lifecycle_state == PROVIDER_RESERVE and not p.churned_epoch
        )
        totals["final_probationary_provider_capacity"] = sum(
            p.capacity_slots
            for p in self.providers.values()
            if p.lifecycle_state == PROVIDER_PROBATION and not p.churned_epoch
        )
        totals["max_churned_assigned_slots"] = max((m.churned_assigned_slots for m in self.metrics), default=0)
        assigned_counts = self._assigned_counts()
        totals["providers_over_capacity"] = sum(
            1 for pid, provider in self.providers.items() if assigned_counts.get(pid, 0) > provider.capacity_slots
        )
        operator_provider_counts: dict[str, int] = {}
        for provider in self.providers.values():
            operator_provider_counts[provider.operator_id] = operator_provider_counts.get(provider.operator_id, 0) + 1
        operator_assignment_counts = self._operator_assignment_counts(include_pending=True)
        total_operator_assignments = sum(operator_assignment_counts.values())
        totals["operator_count"] = len(operator_provider_counts)
        totals["top_operator_provider_count"] = max(operator_provider_counts.values(), default=0)
        totals["top_operator_provider_share_bps"] = int(
            totals["top_operator_provider_count"] * 10_000 / max(1, len(self.providers))
        )
        totals["top_operator_assigned_slots"] = max(operator_assignment_counts.values(), default=0)
        totals["max_operator_assignment_share_bps"] = max(
            (m.max_operator_assignment_share_bps for m in self.metrics),
            default=0,
        )
        totals["max_operator_deal_slots"] = max((m.max_operator_deal_slots for m in self.metrics), default=0)
        totals["operator_deal_cap_violations"] = max(
            (m.operator_deal_cap_violations for m in self.metrics),
            default=0,
        )
        totals["top_operator_assignment_share_bps"] = int(
            totals["top_operator_assigned_slots"] * 10_000 / max(1, total_operator_assignments)
        )
        total_capacity = totals["final_active_provider_capacity"] or sum(p.capacity_slots for p in self.providers.values())
        final_active_slots = self._final_slots()["active"]
        totals["final_storage_utilization_bps"] = int(final_active_slots * 10_000 / max(1, total_capacity))
        totals["min_provider_capacity"] = min((p.capacity_slots for p in self.providers.values()), default=0)
        totals["max_provider_capacity"] = max((p.capacity_slots for p in self.providers.values()), default=0)
        totals["min_provider_bandwidth_capacity"] = min((p.bandwidth_capacity_per_epoch for p in self.providers.values()), default=0)
        totals["max_provider_bandwidth_capacity"] = max((p.bandwidth_capacity_per_epoch for p in self.providers.values()), default=0)
        totals["audit_budget_carryover"] = self.audit_budget_carryover
        totals["audit_budget_backlog"] = self.audit_budget_backlog
        if self.economy_rows:
            storage_prices = [row["storage_price"] for row in self.economy_rows]
            retrieval_prices = [row["retrieval_price_per_slot"] for row in self.economy_rows]
            totals["final_storage_price"] = storage_prices[-1]
            totals["min_storage_price"] = min(storage_prices)
            totals["max_storage_price"] = max(storage_prices)
            totals["final_retrieval_price"] = retrieval_prices[-1]
            totals["min_retrieval_price"] = min(retrieval_prices)
            totals["max_retrieval_price"] = max(retrieval_prices)
            totals["storage_price_direction_changes"] = direction_change_count(storage_prices)
            totals["retrieval_price_direction_changes"] = direction_change_count(retrieval_prices)
        return totals

    def _provider_rows(self) -> list[dict[str, Any]]:
        assigned_counts = self._assigned_counts()
        rows = []
        for provider_id, provider in sorted(self.providers.items()):
            assigned = assigned_counts[provider_id]
            bond_required = self._provider_required_bond(assigned)
            rows.append(
                {
                    "provider_id": provider_id,
                    "operator_id": provider.operator_id,
                    "region": provider.region,
                    "lifecycle_state": provider.lifecycle_state,
                    "entered_epoch": provider.entered_epoch,
                    "probation_until_epoch": provider.probation_until_epoch,
                    "supply_promoted_epoch": provider.supply_promoted_epoch,
                    "capability_tier": provider.capability_tier,
                    "capability_reason": provider.capability_reason,
                    "high_bandwidth_promoted_epoch": provider.high_bandwidth_promoted_epoch,
                    "high_bandwidth_demoted_epoch": provider.high_bandwidth_demoted_epoch,
                    "assigned_slots": assigned,
                    "capacity_slots": provider.capacity_slots,
                    "capacity_utilization_bps": int(assigned * 10_000 / max(1, provider.capacity_slots)),
                    "bandwidth_capacity_per_epoch": provider.bandwidth_capacity_per_epoch,
                    "latency_ms": provider.latency_ms,
                    "average_latency_ms": provider.total_latency_ms / provider.latency_sample_count if provider.latency_sample_count else 0.0,
                    "repair_success_probability": provider.repair_success_probability,
                    "online_probability": provider.behavior.online_probability,
                    "storage_cost_multiplier": provider.storage_cost_multiplier,
                    "bandwidth_cost_multiplier": provider.bandwidth_cost_multiplier,
                    "hard_faults": provider.hard_faults,
                    "retrieval_attempts": provider.retrieval_attempts,
                    "retrieval_successes": provider.retrieval_successes,
                    "corrupt_responses": provider.corrupt_responses,
                    "withheld_responses": provider.withheld_responses,
                    "offline_responses": provider.offline_responses,
                    "saturated_responses": provider.saturated_responses,
                    "platinum_serves": provider.platinum_serves,
                    "gold_serves": provider.gold_serves,
                    "silver_serves": provider.silver_serves,
                    "fail_serves": provider.fail_serves,
                    "latency_sample_count": provider.latency_sample_count,
                    "rewards_earned_slots": provider.rewards_earned_slots,
                    "reward_revenue": provider.reward_revenue,
                    "storage_fee_revenue": provider.storage_fee_revenue,
                    "retrieval_revenue": provider.retrieval_revenue,
                    "performance_reward_revenue": provider.performance_reward_revenue,
                    "total_cost": provider.total_cost,
                    "slashed": provider.slashed,
                    "bond": provider.bond,
                    "bond_required": bond_required,
                    "bond_headroom": provider.bond - bond_required,
                    "underbonded": int(provider.bond + 1e-12 < bond_required),
                    "pnl": provider.pnl,
                    "jailed_until_epoch": provider.jailed_until_epoch,
                    "draining": int(provider.behavior.draining),
                    "churn_pressure_epochs": provider.churn_pressure_epochs,
                    "churned_epoch": provider.churned_epoch,
                    "churned": int(provider.churned_epoch > 0),
                    "churn_risk": int(provider.pnl < 0),
                }
            )
        return rows

    def _operator_rows(self) -> list[dict[str, Any]]:
        assigned_counts = self._assigned_counts()
        by_operator: dict[str, dict[str, Any]] = {}
        for provider_id, provider in sorted(self.providers.items()):
            row = by_operator.setdefault(
                provider.operator_id,
                {
                    "operator_id": provider.operator_id,
                    "provider_count": 0,
                    "assigned_slots": 0,
                    "high_bandwidth_providers": 0,
                    "retrieval_attempts": 0,
                    "retrieval_successes": 0,
                    "revenue": 0.0,
                    "pnl": 0.0,
                },
            )
            row["provider_count"] += 1
            row["assigned_slots"] += assigned_counts[provider_id]
            row["high_bandwidth_providers"] += int(provider.capability_tier == CAPABILITY_HIGH_BANDWIDTH)
            row["retrieval_attempts"] += provider.retrieval_attempts
            row["retrieval_successes"] += provider.retrieval_successes
            row["revenue"] += provider.revenue
            row["pnl"] += provider.pnl

        total_providers = max(1, len(self.providers))
        total_assignments = max(1, sum(row["assigned_slots"] for row in by_operator.values()))
        for row in by_operator.values():
            row["provider_share_bps"] = int(row["provider_count"] * 10_000 / total_providers)
            row["assignment_share_bps"] = int(row["assigned_slots"] * 10_000 / total_assignments)
            attempts = row["retrieval_attempts"]
            row["success_rate"] = row["retrieval_successes"] / attempts if attempts else 0.0
        return sorted(by_operator.values(), key=lambda row: (-row["assigned_slots"], row["operator_id"]))

    def _final_slots(self) -> dict[str, int]:
        active = 0
        repairing = 0
        for deal in self._open_deals():
            for slot in deal.slots:
                if slot.status == SLOT_REPAIRING:
                    repairing += 1
                else:
                    active += 1
        return {"active": active, "repairing": repairing}


def evaluate_assertions(
    result: SimResult,
    min_success_rate: float | None = None,
    assertion_specs: dict[str, Any] | None = None,
) -> list[AssertionResult]:
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

    if assertion_specs:
        for name, expected in assertion_specs.items():
            add_generic_assertion(add, totals, name, expected)
        result.assertions = checks
        return checks

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
        add("outage_marks_repair_ready", totals["repairs_ready"] >= 1, str(totals["repairs_ready"]))
        add("outage_completes_repair", totals["repairs_completed"] >= 1, str(totals["repairs_completed"]))
        add("outage_no_corrupt_payment", totals["paid_corrupt_bytes"] == 0, str(totals["paid_corrupt_bytes"]))
    elif scenario in {"malicious-corrupt", "corrupt-provider"}:
        add("malicious_detected", totals["invalid_proofs"] >= 1, str(totals["invalid_proofs"]))
        add("malicious_triggers_repair", totals["repairs_started"] >= 1, str(totals["repairs_started"]))
        add("malicious_marks_repair_ready", totals["repairs_ready"] >= 1, str(totals["repairs_ready"]))
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
        add("withholding_marks_repair_ready", totals["repairs_ready"] >= 1, str(totals["repairs_ready"]))
        add(
            "withholding_route_around",
            totals["success_rate"] >= 0.95,
            f"success_rate={totals['success_rate']:.4f}",
        )
    elif scenario == "lazy-provider":
        add("lazy_quota_miss_detected", totals["quota_misses"] >= 1, str(totals["quota_misses"]))
        add("lazy_triggers_repair", totals["repairs_started"] >= 1, str(totals["repairs_started"]))
        add("lazy_marks_repair_ready", totals["repairs_ready"] >= 1, str(totals["repairs_ready"]))

    result.assertions = checks
    return checks


def add_generic_assertion(add, totals: dict[str, Any], name: str, expected: Any) -> None:
    if name.startswith("min_"):
        metric = name[4:]
        actual = totals.get(metric)
        add(
            name,
            actual is not None and actual >= expected,
            f"{metric}={format_assert_value(actual)}, required>={format_assert_value(expected)}",
        )
        return
    if name.startswith("max_"):
        metric = name[4:]
        actual = totals.get(metric)
        add(
            name,
            actual is not None and actual <= expected,
            f"{metric}={format_assert_value(actual)}, required<={format_assert_value(expected)}",
        )
        return
    if name.startswith("exact_"):
        metric = name[6:]
        actual = totals.get(metric)
        add(
            name,
            actual == expected,
            f"{metric}={format_assert_value(actual)}, required={format_assert_value(expected)}",
        )
        return
    actual = totals.get(name)
    add(
        name,
        actual == expected,
        f"{name}={format_assert_value(actual)}, required={format_assert_value(expected)}",
    )


def format_assert_value(value: Any) -> str:
    if isinstance(value, float):
        return f"{value:.9g}"
    return str(value)


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


def bounded_step(current: float, direction: int, step_bps: int, min_value: float, max_value: float) -> float:
    if direction == 0 or step_bps <= 0:
        return current
    factor = step_bps / 10_000
    next_value = current * (1 + factor if direction > 0 else 1 - factor)
    return max(min_value, min(max_value, next_value))


def direction_change_count(values: list[float]) -> int:
    changes = 0
    previous_sign = 0
    for before, after in zip(values, values[1:]):
        delta = after - before
        if abs(delta) < 1e-12:
            continue
        sign = 1 if delta > 0 else -1
        if previous_sign and sign != previous_sign:
            changes += 1
        previous_sign = sign
    return changes


def empty_candidate_diagnostics() -> dict[str, Any]:
    return {
        "candidate_mode": "",
        "eligible_candidates": 0,
        "excluded_current_deal": 0,
        "excluded_current_provider": 0,
        "excluded_ineligible_lifecycle": 0,
        "excluded_bond_headroom": 0,
        "excluded_draining": 0,
        "excluded_jailed": 0,
        "excluded_capacity": 0,
        "excluded_operator_cap": 0,
    }


def jitter_multiplier(rng: random.Random, jitter_bps: int) -> float:
    if jitter_bps <= 0:
        return 1.0
    spread = jitter_bps / 10_000
    return max(0.0, 1.0 + rng.uniform(-spread, spread))


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


def load_scenario_spec(path: Path) -> ScenarioSpec:
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ValueError(
            "scenario fixtures must be strict JSON, even when using the .yaml "
            f"extension because JSON is a YAML subset: {path}: "
            f"{exc.msg} at line {exc.lineno}, column {exc.colno}"
        ) from exc
    if not isinstance(raw, dict):
        raise ValueError(f"scenario fixture must be an object: {path}")
    name = raw.get("name") or path.stem
    return ScenarioSpec(
        name=str(name),
        description=str(raw.get("description", "")),
        config=dict(raw.get("config", {})),
        faults=list(raw.get("faults", [])),
        assertions=dict(raw.get("assertions", {})),
    )


def config_from_args(args: argparse.Namespace, spec: ScenarioSpec | None = None) -> tuple[SimConfig, list[str], dict[str, Any]]:
    data: dict[str, Any] = {}
    faults: list[str] = []
    assertions: dict[str, Any] = {}
    if spec:
        data.update(spec.config)
        data.setdefault("scenario", spec.name)
        faults.extend(spec.faults)
        assertions.update(spec.assertions)
    else:
        data["scenario"] = args.scenario

    cli_values = {
        "seed": args.seed,
        "providers": args.providers,
        "users": args.users,
        "deals": args.deals,
        "epochs": args.epochs,
        "k": args.k,
        "m": args.m,
        "user_mdus_per_deal": args.user_mdus_per_deal,
        "retrievals_per_user_per_epoch": args.retrievals_per_user_per_epoch,
        "quota_min_blobs": args.quota_min_blobs,
        "quota_max_blobs": args.quota_max_blobs,
        "credit_cap_bps": args.credit_cap_bps,
        "evict_after_missed_epochs": args.evict_after_missed_epochs,
        "repair_epochs": args.repair_epochs,
        "repair_attempt_cap_per_slot": args.repair_attempt_cap_per_slot,
        "repair_backoff_epochs": args.repair_backoff_epochs,
        "repair_pending_timeout_epochs": args.repair_pending_timeout_epochs,
        "enforcement_mode": args.enforcement_mode,
        "deal_duration_epochs": args.deal_duration_epochs,
        "deal_close_epoch": args.deal_close_epoch,
        "deal_close_count": args.deal_close_count,
        "deal_close_bps": args.deal_close_bps,
        "sponsored_retrieval_bps": args.sponsored_retrieval_bps,
        "owner_retrieval_debit_bps": args.owner_retrieval_debit_bps,
        "elasticity_overlay_providers_per_epoch": args.elasticity_overlay_providers_per_epoch,
        "elasticity_overlay_max_providers_per_deal": args.elasticity_overlay_max_providers_per_deal,
        "elasticity_overlay_ready_delay_epochs": args.elasticity_overlay_ready_delay_epochs,
        "elasticity_overlay_ttl_epochs": args.elasticity_overlay_ttl_epochs,
        "staged_upload_attempts_per_epoch": args.staged_upload_attempts_per_epoch,
        "staged_upload_mdu_per_attempt": args.staged_upload_mdu_per_attempt,
        "staged_upload_commit_rate_bps": args.staged_upload_commit_rate_bps,
        "staged_upload_retention_epochs": args.staged_upload_retention_epochs,
        "staged_upload_max_pending_generations": args.staged_upload_max_pending_generations,
    }
    for key, value in cli_values.items():
        if value is not None:
            data[key] = value
    if args.dynamic_pricing:
        data["dynamic_pricing"] = True
    if args.storage_lockin:
        data["storage_lockin_enabled"] = True
    if args.elasticity_overlay:
        data["elasticity_overlay_enabled"] = True
    faults.extend(args.fault or [])
    return SimConfig(**data), faults, assertions


def write_json(path: Path, result: SimResult) -> None:
    path.write_text(
        json.dumps(stable_json_value(result.to_jsonable()), indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def stable_json_value(value: Any) -> Any:
    if isinstance(value, float):
        return round(value, 9)
    if isinstance(value, dict):
        return {key: stable_json_value(item) for key, item in value.items()}
    if isinstance(value, list):
        return [stable_json_value(item) for item in value]
    return value


def write_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    if not rows:
        path.write_text("", encoding="utf-8")
        return
    fieldnames: list[str] = []
    for row in rows:
        for key in row.keys():
            if key not in fieldnames:
                fieldnames.append(key)
    with path.open("w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def write_output_dir(path: Path, result: SimResult) -> None:
    path.mkdir(parents=True, exist_ok=True)
    summary = {
        "config": result.config,
        "totals": result.totals,
        "final_slots": result.final_slots,
        "assertions": [asdict(item) for item in result.assertions],
    }
    (path / "summary.json").write_text(
        json.dumps(stable_json_value(summary), indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    (path / "assertions.json").write_text(
        json.dumps(
            stable_json_value([asdict(item) for item in result.assertions]),
            indent=2,
            sort_keys=True,
        )
        + "\n",
        encoding="utf-8",
    )
    write_csv(path / "epochs.csv", result.epochs)
    write_csv(path / "providers.csv", result.providers)
    write_csv(path / "operators.csv", result.operators)
    write_csv(path / "slots.csv", result.slots)
    write_csv(path / "evidence.csv", result.evidence)
    write_csv(path / "repairs.csv", result.repairs)
    write_csv(path / "economy.csv", result.economy)


def print_summary(result: SimResult) -> None:
    totals = result.totals
    print("PolyStore policy simulation")
    print(f"scenario={result.config['scenario']} seed={result.config['seed']}")
    print(
        "providers={providers} users={users} deals={deals} epochs={epochs} rs={k}+{m} mode={enforcement_mode}".format(
            **result.config
        )
    )
    print(
        "success_rate={success_rate:.4f} reward_coverage={reward_coverage:.4f} "
        "repairs_started={repairs_started} repairs_ready={repairs_ready} "
        "repairs_completed={repairs_completed} repair_attempts={repair_attempts} "
        "repair_backoffs={repair_backoffs} repair_timeouts={repair_timeouts}".format(**totals)
    )
    print(
        "quota_misses={quota_misses} deputy_misses={deputy_misses} "
        "invalid_proofs={invalid_proofs} unavailable_reads={unavailable_reads} "
        "data_loss_events={data_loss_events} saturated_responses={saturated_responses} "
        "suspect_slots={suspect_slots} delinquent_slots={delinquent_slots}".format(**totals)
    )
    print(
        "provider_pnl={provider_pnl:.4f} negative_pnl={providers_negative_pnl} "
        "reward_burned={reward_burned:.4f} high_bandwidth_providers={high_bandwidth_providers}".format(**totals)
    )
    if totals.get("staged_upload_attempts", 0):
        print(
            "staged_uploads attempts={staged_upload_attempts} accepted={staged_upload_accepted} "
            "rejected={staged_upload_rejections} cleaned={staged_upload_cleaned} "
            "final_pending={final_staged_upload_pending_generations}".format(**totals)
        )
    if totals.get("elasticity_overlay_activations", 0) or totals.get("elasticity_overlay_rejections", 0):
        print(
            "elasticity_overlays activations={elasticity_overlay_activations} "
            "serves={elasticity_overlay_serves} rejections={elasticity_overlay_rejections} "
            "final_active={final_elasticity_overlay_active}".format(**totals)
        )
    if totals.get("sponsored_retrieval_attempts", 0) or totals.get("owner_retrieval_escrow_debited", 0):
        print(
            "sponsored_retrievals attempts={sponsored_retrieval_attempts} "
            "spent={sponsored_retrieval_spent:.4f} owner_escrow_debited={owner_retrieval_escrow_debited:.4f}".format(**totals)
        )
    if totals.get("storage_escrow_locked", 0) or totals.get("storage_escrow_refunded", 0):
        print(
            "storage_escrow locked={storage_escrow_locked:.4f} earned={storage_escrow_earned:.4f} "
            "refunded={storage_escrow_refunded:.4f} outstanding={storage_escrow_outstanding:.4f} "
            "closed_deals={final_closed_deals}".format(**totals)
        )
    if result.assertions:
        failed = [item for item in result.assertions if not item.passed]
        status = "failed" if failed else "passed"
        print(f"assertions={status} ({len(result.assertions) - len(failed)}/{len(result.assertions)})")
        for item in result.assertions:
            prefix = "PASS" if item.passed else "FAIL"
            print(f"  {prefix} {item.name}: {item.detail}")


def run_one(config: SimConfig, faults: list[str], assertion_specs: dict[str, Any], min_success_rate: float | None) -> SimResult:
    sim = PolicySimulator(config, extra_faults=faults)
    result = sim.run()
    if assertion_specs or min_success_rate is not None:
        evaluate_assertions(result, min_success_rate, assertion_specs)
    return result


def run_scenario_dir_task(task: tuple[SimConfig, list[str], dict[str, Any], float | None, bool, Path | None]) -> SimResult:
    config, faults, assertion_specs, min_success_rate, force_assertions, out_dir = task
    result = run_one(config, faults, assertion_specs, min_success_rate)
    if force_assertions and not result.assertions:
        evaluate_assertions(result, min_success_rate)
    if out_dir:
        write_output_dir(out_dir, result)
    return result


def fixture_paths(directory: Path) -> list[Path]:
    return sorted([*directory.glob("*.yaml"), *directory.glob("*.json")])


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--scenario",
        default="ideal",
        choices=CLI_SCENARIOS,
    )
    parser.add_argument("--scenario-file", type=Path)
    parser.add_argument("--scenario-dir", type=Path)
    parser.add_argument("--seed", type=int)
    parser.add_argument("--providers", type=int)
    parser.add_argument("--users", type=int)
    parser.add_argument("--deals", type=int)
    parser.add_argument("--epochs", type=int)
    parser.add_argument("--k", type=int)
    parser.add_argument("--m", type=int)
    parser.add_argument("--user-mdus-per-deal", type=int)
    parser.add_argument("--retrievals-per-user-per-epoch", type=int)
    parser.add_argument("--quota-min-blobs", type=int)
    parser.add_argument("--quota-max-blobs", type=int)
    parser.add_argument("--credit-cap-bps", type=int)
    parser.add_argument("--evict-after-missed-epochs", type=int)
    parser.add_argument("--repair-epochs", type=int)
    parser.add_argument("--repair-attempt-cap-per-slot", type=int)
    parser.add_argument("--repair-backoff-epochs", type=int)
    parser.add_argument("--repair-pending-timeout-epochs", type=int)
    parser.add_argument("--enforcement-mode", choices=sorted(ENFORCEMENT_ORDER))
    parser.add_argument("--storage-lockin", action="store_true")
    parser.add_argument("--deal-duration-epochs", type=int)
    parser.add_argument("--deal-close-epoch", type=int)
    parser.add_argument("--deal-close-count", type=int)
    parser.add_argument("--deal-close-bps", type=int)
    parser.add_argument("--sponsored-retrieval-bps", type=int)
    parser.add_argument("--owner-retrieval-debit-bps", type=int)
    parser.add_argument("--elasticity-overlay", action="store_true")
    parser.add_argument("--elasticity-overlay-providers-per-epoch", type=int)
    parser.add_argument("--elasticity-overlay-max-providers-per-deal", type=int)
    parser.add_argument("--elasticity-overlay-ready-delay-epochs", type=int)
    parser.add_argument("--elasticity-overlay-ttl-epochs", type=int)
    parser.add_argument("--staged-upload-attempts-per-epoch", type=int)
    parser.add_argument("--staged-upload-mdu-per-attempt", type=int)
    parser.add_argument("--staged-upload-commit-rate-bps", type=int)
    parser.add_argument("--staged-upload-retention-epochs", type=int)
    parser.add_argument("--staged-upload-max-pending-generations", type=int)
    parser.add_argument("--dynamic-pricing", action="store_true")
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
    parser.add_argument("--jobs", type=int, default=0, help="parallel workers for --scenario-dir; 0 auto-detects CPU count capped at 8")
    parser.add_argument("--json-out", type=Path)
    parser.add_argument("--csv-out", type=Path)
    parser.add_argument("--out-dir", type=Path)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.scenario_dir:
        paths = fixture_paths(args.scenario_dir)
        if not paths:
            raise SystemExit(f"no scenario fixtures found in {args.scenario_dir}")
        tasks = []
        for path in paths:
            spec = load_scenario_spec(path)
            config, faults, assertion_specs = config_from_args(args, spec)
            out_dir = args.out_dir / spec.name if args.out_dir else None
            tasks.append((config, faults, assertion_specs, args.min_success_rate, args.assertions, out_dir))
        results = map_parallel(run_scenario_dir_task, tasks, args.jobs)

        failures = 0
        for result in results:
            print_summary(result)
            if result.assertions and any(not item.passed for item in result.assertions):
                failures += 1
        return 1 if failures else 0

    spec = load_scenario_spec(args.scenario_file) if args.scenario_file else None
    config, faults, assertion_specs = config_from_args(args, spec)
    result = run_one(config, faults, assertion_specs, args.min_success_rate)
    if args.assertions and not result.assertions:
        evaluate_assertions(result, args.min_success_rate)
    if args.json_out:
        write_json(args.json_out, result)
    if args.csv_out:
        write_csv(args.csv_out, result.epochs)
    if args.out_dir:
        write_output_dir(args.out_dir, result)
    print_summary(result)
    if result.assertions and any(not item.passed for item in result.assertions):
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
