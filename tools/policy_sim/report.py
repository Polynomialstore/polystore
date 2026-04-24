#!/usr/bin/env python3
"""Generate human-readable reports from policy simulator outputs.

The simulator owns deterministic raw artifacts. This tool consumes those
artifacts and writes Markdown plus small SVG charts without rerunning the
simulation.
"""

from __future__ import annotations

import argparse
import csv
import json
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any


SCENARIO_GUIDES = {
    "ideal": {
        "title": "Cooperative Baseline",
        "intent": (
            "Prove the simulator can represent a healthy network before any policing policy is trusted. "
            "All providers behave correctly, no repair should be needed, rewards should cover all eligible slots, "
            "and the economic ledger should not invent distress."
        ),
        "expected": "No evidence, no repairs, no invalid proofs, full retrieval success, and full reward coverage.",
        "review": "Use this as the control case for policy deltas. If this report shows churn or missing rewards, the harness is overfitting enforcement noise.",
    },
    "single-outage": {
        "title": "Single Provider Outage",
        "intent": (
            "Model an honest provider that becomes unavailable for several epochs. The policy question is whether "
            "the network can preserve user-facing availability while detecting the failing slot and performing make-before-break repair."
        ),
        "expected": "Retrievals remain available, soft evidence accumulates, affected slots are repaired, and the offline provider is not paid for missed work.",
        "review": "Check whether repair starts soon enough without overreacting to a short outage.",
    },
    "flapping-provider": {
        "title": "Flapping Provider",
        "intent": (
            "Model a provider with intermittent outages that recover before the delinquency threshold. "
            "This is the anti-thrash fixture: normal infrastructure jitter should create evidence and operator visibility without needless slot churn."
        ),
        "expected": "Offline responses are visible, retrieval success stays high, no data loss occurs, and repair stays below the configured threshold.",
        "review": "Use this case to tune missed-epoch windows before treating sustained non-response as delinquency.",
    },
    "sustained-non-response": {
        "title": "Sustained Non-Response",
        "intent": (
            "Model a provider that remains unavailable long enough to cross soft-fault thresholds. "
            "This validates that repeated non-response becomes repairable delinquency without requiring hard cryptographic fraud evidence."
        ),
        "expected": "Soft evidence accumulates, repair starts, replacement completes, corrupt bytes remain unpaid, and data-loss events stay at zero.",
        "review": "Inspect this case before implementing per-slot delinquency, reward exclusion, and deterministic replacement selection in keeper tests.",
    },
    "withholding": {
        "title": "Withholding Provider",
        "intent": (
            "Model a provider that stays nominally online but withholds retrieval responses and skips synthetic proof participation. "
            "This is a griefing case because the provider may try to appear present while forcing deputies or peers to absorb load."
        ),
        "expected": "The run should record withheld responses or deputy misses, exclude bad slots from rewards, and schedule repair without paying corrupt bytes.",
        "review": "Confirm that withholding is distinguishable from ordinary jitter before any real slashing policy is considered.",
    },
    "corrupt-provider": {
        "title": "Corrupt Provider",
        "intent": (
            "Model a provider returning bad data or invalid synthetic proofs. This is the hard-fault path where repair, reward exclusion, "
            "and simulated slashing should be visible."
        ),
        "expected": "Invalid proofs appear, corrupt bytes are not paid, repairs start, and simulated slash accounting is non-zero in slash mode.",
        "review": "Review this before keeper slashing work. This is the clearest fixture for evidence quality and punishment severity.",
    },
    "invalid-synthetic-proof": {
        "title": "Invalid Synthetic Proof",
        "intent": (
            "Model a provider submitting invalid liveness proofs without corrupting retrieval bytes. The policy question is whether "
            "chain-verifiable hard proof evidence alone triggers repair and simulated slash accounting."
        ),
        "expected": "Invalid proofs are recorded, repair starts and completes, the provider is simulated-slashed, corrupt retrieval payment remains zero, and durability remains intact.",
        "review": "Use this fixture to isolate keeper proof-validation behavior from gateway byte-verification behavior before punitive hard-fault rollout.",
    },
    "malicious-corrupt": {
        "title": "Corrupt Provider",
        "intent": (
            "Model a provider returning bad data or invalid synthetic proofs. This is the hard-fault path where repair, reward exclusion, "
            "and simulated slashing should be visible."
        ),
        "expected": "Invalid proofs appear, corrupt bytes are not paid, repairs start, and simulated slash accounting is non-zero in slash mode.",
        "review": "Review this before keeper slashing work. This is the clearest fixture for evidence quality and punishment severity.",
    },
    "lazy-provider": {
        "title": "Lazy Provider",
        "intent": (
            "Model a provider that does not satisfy liveness quota even when user-facing reads may still succeed. "
            "This tests whether the network detects free-riding on redundancy instead of only detecting outright retrieval failures."
        ),
        "expected": "Quota misses accumulate, rewards are withheld for non-compliant slots, and repair starts if laziness persists.",
        "review": "Check whether the quota threshold is calibrated or too punitive for normal low-traffic periods.",
    },
    "setup-failure": {
        "title": "Setup Phase Failure",
        "intent": (
            "Model a provider failing during early placement/upload setup. The policy concern is avoiding a bad initial assignment "
            "that leaves the deal under-replicated before steady-state liveness has much evidence."
        ),
        "expected": "Early evidence should trigger repair while preserving availability and not expanding on-chain enforcement beyond simulated mode.",
        "review": "Use this to design provider admission and initial-deal health checks.",
    },
    "staged-upload-grief": {
        "title": "Staged Upload Grief",
        "intent": (
            "Model a client or user-gateway repeatedly uploading provisional generations and never committing them. "
            "This is an operational/accounting grief case: local provider-daemon storage pressure must be bounded by retention cleanup and preflight caps, not by repair or punitive provider enforcement."
        ),
        "expected": "Preflight rejections and retention cleanup are visible, pending provisional generations stay under the configured cap, no repair starts, and committed retrieval availability remains intact.",
        "review": "Use this before implementing provider-daemon staged-generation GC, gateway preflight checks, and operator alerts for abandoned provisional data.",
    },
    "underpriced-storage": {
        "title": "Underpriced Storage Market",
        "intent": (
            "Model a technically healthy network whose prices do not cover provider costs. This is not an availability failure; "
            "it is a market-equilibrium warning that rational providers would churn even though the protocol appears healthy."
        ),
        "expected": "Retrieval success remains high, but provider P&L turns negative and churn risk appears.",
        "review": "This fixture should force discussion of price floors, reward calibration, and dynamic pricing before production economics.",
    },
    "overpriced-storage": {
        "title": "Overpriced Storage Demand Collapse",
        "intent": (
            "Model a technically healthy network whose storage quote exceeds modeled user willingness to pay. "
            "This is a demand-side market warning: existing reads can stay perfect while new storage demand collapses."
        ),
        "expected": "Existing retrievals remain healthy, new deal requests are rejected by price rather than capacity, and the demand acceptance rate falls to zero.",
        "review": "Use this fixture to discuss quote UX, price ceilings, affordability bounds, and whether dynamic pricing should move before demand disappears.",
    },
    "demand-elasticity-recovery": {
        "title": "Storage Demand Elasticity Recovery",
        "intent": (
            "Model latent storage demand that initially pauses because storage price is above a reference willingness-to-pay level, "
            "then recovers as the utilization-based controller steps price down."
        ),
        "expected": "Some latent demand is suppressed early, effective requests recover later, accepted deals become non-zero, and capacity rejections stay zero.",
        "review": "Use this fixture to calibrate demand elasticity, quote telemetry, and price-step timing before encoding market defaults.",
    },
    "provider-cost-shock": {
        "title": "Provider Cost Shock",
        "intent": (
            "Model a technically healthy network where provider operating costs jump after launch. "
            "The policy question is whether the simulator exposes churn pressure and pricing mismatch before availability fails."
        ),
        "expected": "Retrieval success remains high, the cost-shock window is visible, provider P&L falls, and negative-P&L churn risk appears.",
        "review": "Use this fixture to calibrate cost assumptions, price floors, reward buffers, and whether pricing should react to provider cost telemetry.",
    },
    "provider-economic-churn": {
        "title": "Provider Economic Churn",
        "intent": (
            "Model rational provider exit after sustained negative P&L. The policy question is whether bounded churn converts "
            "economic distress into visible capacity exit and repair pressure without causing durability loss."
        ),
        "expected": "Cost-shocked providers become churn candidates, exits are capped per epoch, affected slots are repaired, and reads remain available.",
        "review": "Use this fixture to tune churn caps, replacement capacity, price floors, and how much economic distress should remain monitoring-only.",
    },
    "provider-supply-entry": {
        "title": "Provider Supply Entry",
        "intent": (
            "Model reserve providers entering the active set after churn reduces supply. The policy question is whether supply recovery "
            "has explicit admission, probation, and promotion telemetry instead of silently assuming infinite replacement capacity."
        ),
        "expected": "Cost-shocked providers churn, reserve providers enter probation, probationary providers promote to active supply, repair completes, and durability remains intact.",
        "review": "Use this fixture to tune onboarding caps, probation length, utilization or price triggers, and whether new SPs should receive normal placement immediately or only after readiness evidence.",
    },
    "provider-bond-headroom": {
        "title": "Provider Bond Headroom",
        "intent": (
            "Model provider assignment collateral as a first-class placement constraint. The policy question is whether a provider that "
            "falls below required bond is visible, excluded from new responsibility, and repaired away without treating every economic fault as slashable fraud."
        ),
        "expected": "A slashed provider becomes underbonded, underbonded slots trigger repair, new assignments exclude insufficient-bond providers, and durability remains intact.",
        "review": "Use this fixture to tune minimum bond, per-slot collateral, slash sizing, and whether underbonding should create repair, throttling, or only placement exclusion.",
    },
    "retrieval-demand-shock": {
        "title": "Retrieval Demand Shock",
        "intent": (
            "Model a temporary retrieval demand spike and verify the retrieval-price controller reacts within configured bounds "
            "without creating repeated oscillation or availability loss."
        ),
        "expected": "Retrieval demand shock epochs are visible, retrieval price rises and settles within bounds, reads stay available, and direction changes remain limited.",
        "review": "Use this fixture to tune retrieval-demand targets, step size, price floors/ceilings, and shock dampening before keeper defaults.",
    },
    "wash-retrieval": {
        "title": "Wash Retrieval Demand",
        "intent": (
            "Model artificial retrieval demand. The policy question is whether fake activity can farm rewards for free, "
            "or whether requester/session fees and burns make the attack costly."
        ),
        "expected": "Retrievals succeed, but base fees and variable burns are visible and non-zero.",
        "review": "Check whether burn and payout ratios are strong enough to make wash traffic irrational.",
    },
    "viral-public-retrieval": {
        "title": "Viral Public Retrieval Spike",
        "intent": (
            "Model a legitimate public-demand spike. The system should pay providers for real bandwidth, burn the configured fees, "
            "avoid treating popularity as misbehavior, and isolate deal-owner escrow from sponsored public demand."
        ),
        "expected": "High retrieval volume succeeds, provider payouts rise, base burns and sponsored-session spend are visible, owner escrow is not debited, and unnecessary repair stays quiet.",
        "review": "Use this to separate anti-wash controls from legitimate popularity handling and to plan sponsored-session keeper/accounting tests.",
    },
    "high-bandwidth-promotion": {
        "title": "High-Bandwidth Provider Promotion",
        "intent": (
            "Model hot retrieval demand with heterogeneous provider bandwidth. The policy question is whether measured high-capacity, "
            "high-success providers become eligible for hot-path routing without giving every provider the same service posture."
        ),
        "expected": "Providers above the bandwidth and success thresholds are promoted, hot retrievals route through them, no demotion occurs, and availability remains intact.",
        "review": "Use this before implementing provider capability state, hot-deal placement priority, or high-bandwidth reward multipliers in keeper/runtime code.",
    },
    "high-bandwidth-regression": {
        "title": "High-Bandwidth Capability Regression",
        "intent": (
            "Model hot retrieval demand after providers have become high-bandwidth eligible. The policy question is whether "
            "the system can revoke hot-path eligibility when promoted providers begin saturating under concentrated traffic."
        ),
        "expected": "Providers promote first, some promoted providers demote after sustained saturation, hot retrievals continue to succeed, and no data-loss event occurs.",
        "review": "Use this before implementing capability demotion thresholds, hot-route failover behavior, or provider/operator alerting for regressed high-bandwidth service.",
    },
    "performance-market-latency": {
        "title": "Performance Market Latency Tiers",
        "intent": (
            "Model Hot-service retrieval demand across providers with heterogeneous latency. The policy question is whether the simulator can "
            "separate correctness from QoS by recording Platinum/Gold/Silver/Fail service tiers and paying tiered performance rewards without "
            "treating slow-but-correct service as corrupt data."
        ),
        "expected": "Retrievals remain available, all latency tiers appear, Fail-tier serves earn no performance reward, and provider economics expose the tiered reward effect.",
        "review": "Use this before implementing latency-tier keeper params, provider telemetry, service-class reward multipliers, or hot-service placement priority.",
    },
    "operator-concentration-cap": {
        "title": "Operator Concentration Cap",
        "intent": (
            "Model a Sybil-shaped provider set where one operator controls many SP identities. The policy question is whether "
            "placement can preserve per-deal operator diversity even when the dominant operator has enough provider keys and capacity to fill many slots."
        ),
        "expected": "The dominant operator is visible in provider-share signals, no deal exceeds the configured operator slot cap, and availability remains intact.",
        "review": "Use this before implementing operator identity, per-deal assignment caps, Sybil concentration alerts, or replacement-candidate diversity checks.",
    },
    "elasticity-cap-hit": {
        "title": "Elasticity Cap Hit",
        "intent": (
            "Model demand above the user-funded elasticity budget. The desired behavior is fail-closed spending: the simulator should record "
            "rejections instead of silently exceeding the configured cap."
        ),
        "expected": "Elasticity rejections are visible and spend remains at or below the cap.",
        "review": "Confirm this matches product expectations for burst handling and user-funded capacity expansion.",
    },
    "elasticity-overlay-scaleup": {
        "title": "Elasticity Overlay Scale-Up",
        "intent": (
            "Model the positive path for user-funded overflow capacity. Sustained hot retrieval pressure buys temporary overlay routes, "
            "the routes become ready after a delay, serve reads, and expire instead of becoming permanent unpaid responsibility."
        ),
        "expected": "Overlay activations, spend, ready routes, serves, and expirations are visible; spend caps do not reject this fixture; durable slot repair and data-loss paths stay quiet.",
        "review": "Use this before implementing MsgSignalSaturation, overlay readiness, overlay TTL, and gateway routing expansion in the live stack.",
    },
    "audit-budget-exhaustion": {
        "title": "Audit Budget Exhaustion",
        "intent": (
            "Model many soft failures with an intentionally tight audit budget. The policy concern is whether audit spending remains capped "
            "instead of becoming an unbounded protocol subsidy."
        ),
        "expected": "Quota misses create audit demand, audit spend is capped by budget, repair starts where allowed, and data-loss events remain zero.",
        "review": "Use this case to decide whether audit budget exhaustion should degrade into backlog, higher fees, or stronger admission control.",
    },
    "deputy-evidence-spam": {
        "title": "Deputy Evidence Spam",
        "intent": (
            "Model a deputy submitting low-quality failure claims. The policy question is whether evidence bonds and conviction-gated "
            "bounties make spam uneconomic before evidence-market keeper code exists."
        ),
        "expected": "Spam claims burn bond, unconvicted claims earn no bounty, net spam gain is non-positive, and no real provider is repaired or slashed.",
        "review": "Use this before implementing evidence bonds, burn-on-expiry, bounty payout, or deputy reputation state.",
    },
    "price-controller-bounds": {
        "title": "Price Controller Bounds",
        "intent": (
            "Model dynamic storage and retrieval price movement under sustained demand. This is a controller-safety fixture, not a claim that "
            "the current parameters are economically optimal."
        ),
        "expected": "Prices move in the expected direction, remain within configured bounds, preserve availability, and do not hide provider distress.",
        "review": "Inspect the economic assumptions and decide whether the step size, floors, ceilings, and target utilization are credible.",
    },
    "subsidy-farming": {
        "title": "Subsidy Farming",
        "intent": (
            "Model providers attempting to collect base rewards while skipping useful liveness work. "
            "The policy concern is reward leakage, not retrieval correctness alone."
        ),
        "expected": "Quota misses are visible, reward coverage falls for non-compliant responsibility, and corrupt/data-loss safety invariants stay clean.",
        "review": "Use this before implementing base-reward gating and subsidy-farming controls.",
    },
    "storage-escrow-close-refund": {
        "title": "Storage Escrow Close And Refund",
        "intent": (
            "Model the storage lock-in lifecycle for committed content. The policy question is whether storage fees are locked, "
            "earned over time by eligible providers, and refunded on early close without leaving hidden outstanding escrow."
        ),
        "expected": "Storage escrow is locked, earned storage fees pay eligible providers, early deal close refunds unearned funds, closed-content reads are rejected explicitly, and outstanding escrow reaches zero by run end.",
        "review": "Use this before implementing keeper close/refund semantics, quote-to-charge parity, storage-fee payout, and end-of-deal accounting tests.",
    },
    "storage-escrow-noncompliance-burn": {
        "title": "Storage Escrow Noncompliance Burn",
        "intent": (
            "Model earned storage fees under reward-exclusion mode when a provider misses liveness quota. "
            "The policy question is whether non-compliant responsibility loses provider storage-fee payout without hiding availability or durability regressions."
        ),
        "expected": "Storage escrow still locks and earns, compliant slots are paid, non-compliant slot share is burned, repairs start, and outstanding escrow reaches zero by run end.",
        "review": "Use this before implementing keeper storage-fee payout gates, reward-exclusion accounting, and burn-ledger tests for delinquent storage responsibility.",
    },
    "storage-escrow-expiry": {
        "title": "Storage Escrow Expiry",
        "intent": (
            "Model end-of-duration storage accounting. The policy question is whether a fully earned deal auto-expires, "
            "leaves no hidden escrow, and stops contributing active responsibility after its duration."
        ),
        "expected": "Storage escrow locks, earns exactly through the configured duration, every deal expires, no unearned refund is needed, and final open deals reach zero.",
        "review": "Use this before implementing keeper expiry auto-close, deal GC, and final payout/escrow settlement tests.",
    },
    "expired-retrieval-rejection": {
        "title": "Expired Retrieval Rejection",
        "intent": (
            "Model post-expiry retrieval semantics. The policy question is whether requests after a deal has fully expired "
            "are counted as explicit expired-content rejections instead of user-facing availability failures or billable retrievals."
        ),
        "expected": "Deals expire cleanly, later retrieval attempts are rejected as expired, unavailable reads remain zero, and no retrieval escrow is debited after expiry.",
        "review": "Use this before implementing gateway/keeper post-expiry query behavior, expired-deal response codes, and retrieval accounting guards.",
    },
    "closed-retrieval-rejection": {
        "title": "Closed Retrieval Rejection",
        "intent": (
            "Model retrieval semantics after an intentional deal close and storage-escrow refund. The policy question is whether "
            "requests after close are counted as explicit closed-content rejections instead of availability failures or billable retrievals."
        ),
        "expected": "Deals close cleanly, unearned storage escrow is refunded, later retrieval attempts are rejected as closed content, unavailable reads remain zero, and no retrieval escrow is debited after close.",
        "review": "Use this before implementing gateway/keeper post-close query behavior, closed-deal response codes, and retrieval accounting guards.",
    },
    "coordinated-regional-outage": {
        "title": "Coordinated Regional Outage",
        "intent": (
            "Model a smaller correlated regional outage than the expensive scale case. This provides a cheaper fixture for placement diversity, "
            "repair, and regional risk analysis."
        ),
        "expected": "Regional offline responses appear, repair starts, availability remains within contract, and data-loss events remain zero.",
        "review": "Use this case to decide whether regional placement assumptions should become keeper parameters or simulator-only launch analysis.",
    },
    "repair-candidate-exhaustion": {
        "title": "Repair Candidate Exhaustion",
        "intent": (
            "Model a network with no spare replacement capacity. The expected behavior is explicit repair backoff and operator visibility, "
            "not silent over-assignment."
        ),
        "expected": "Repair backoffs are visible, provider capacity is respected, and data-loss events remain zero under the modeled fault.",
        "review": "Use this case to tune assignment headroom, repair attempt caps, and launch-provider minimums.",
    },
    "replacement-grinding": {
        "title": "Replacement Grinding",
        "intent": (
            "Model a repair path where pending replacement providers never prove readiness. The policy question is whether "
            "timeouts, cooldowns, and per-slot attempt caps bound churn instead of letting repairs remain pending forever."
        ),
        "expected": "Repairs start, pending readiness times out, cooldowns and attempt caps are visible, no pending provider is promoted without readiness, and durability remains intact.",
        "review": "Use this case to tune pending-provider readiness proof windows, repair timeout lengths, retry caps, and whether failed catch-up should affect provider reputation.",
    },
    "large-scale-regional-stress": {
        "title": "Large-Scale Regional Stress",
        "intent": (
            "Model a population-scale network with more than one thousand storage providers and thousands of users. "
            "Providers have heterogeneous capacity, bandwidth, reliability, cost, region, and repair coordination probability. "
            "A correlated regional outage and dynamic pricing test whether network state, price, retrieval success, and healing remain stable under scale."
        ),
        "expected": "Availability should stay above the configured floor, price should remain bounded, saturation and repair backoffs should be visible, and no provider should be assigned above modeled capacity.",
        "review": "Use this report to inspect aggregate network state rather than a single bad actor: utilization, price trajectory, bandwidth saturation, repair throughput, and provider P&L distribution.",
    },
}


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def load_csv(path: Path) -> list[dict[str, str]]:
    if not path.exists() or path.stat().st_size == 0:
        return []
    with path.open(newline="", encoding="utf-8") as fh:
        return list(csv.DictReader(fh))


def fnum(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def fint(value: Any) -> int:
    return int(round(fnum(value)))


def fmt_num(value: Any, digits: int = 4) -> str:
    number = fnum(value)
    if abs(number - round(number)) < 0.0000001:
        return str(int(round(number)))
    return f"{number:.{digits}f}"


def fmt_money(value: Any) -> str:
    return f"{fnum(value):.4f}"


def fmt_optional_money_threshold(value: Any) -> str:
    number = fnum(value)
    return fmt_money(number) if number > 0 else "disabled"


def fmt_pct(value: Any) -> str:
    return f"{fnum(value) * 100:.2f}%"


def fmt_bps(value: Any) -> str:
    return fmt_pct(fnum(value) / 10_000)


def performance_summary_sentence(totals: dict[str, Any]) -> str:
    tiered_serves = (
        fnum(totals.get("platinum_serves"))
        + fnum(totals.get("gold_serves"))
        + fnum(totals.get("silver_serves"))
        + fnum(totals.get("fail_serves"))
    )
    if not tiered_serves:
        return ""
    return (
        f" Performance tiers recorded `{fmt_num(totals.get('platinum_serves'))}` Platinum, "
        f"`{fmt_num(totals.get('gold_serves'))}` Gold, `{fmt_num(totals.get('silver_serves'))}` Silver, "
        f"and `{fmt_num(totals.get('fail_serves'))}` Fail serves."
    )


def metric_sum(rows: list[dict[str, str]], key: str) -> float:
    return sum(fnum(row.get(key)) for row in rows)


def percentile(values: list[float], pct: float) -> float:
    if not values:
        return 0.0
    sorted_values = sorted(values)
    idx = min(len(sorted_values) - 1, max(0, round((pct / 100) * (len(sorted_values) - 1))))
    return sorted_values[idx]


def first_epoch(rows: list[dict[str, str]], predicate) -> str:
    for row in rows:
        if predicate(row):
            return str(row.get("epoch", ""))
    return "none"


def scenario_guide(name: str) -> dict[str, str]:
    return SCENARIO_GUIDES.get(
        name,
        {
            "title": name.replace("-", " ").title(),
            "intent": "Custom simulator scenario. Review the configuration, evidence ledger, and assertion contract before drawing policy conclusions.",
            "expected": "Expected behavior is defined by the assertions bundled with this run.",
            "review": "Confirm the scenario is sufficiently specified before using it for keeper or e2e planning.",
        },
    )


def scenario_allows_unavailable_reads(name: str) -> bool:
    return name in {
        "large-scale-regional-stress",
        "coordinated-regional-outage",
        "provider-economic-churn",
        "elasticity-overlay-scaleup",
    }


SWEEP_METRICS = [
    "success_rate",
    "unavailable_reads",
    "expired_retrieval_attempts",
    "closed_retrieval_attempts",
    "data_loss_events",
    "reward_coverage",
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
    "high_bandwidth_providers",
    "high_bandwidth_serves",
    "hot_retrieval_attempts",
    "hot_high_bandwidth_serves",
    "max_operator_assignment_share_bps",
    "top_operator_assignment_share_bps",
    "top_operator_provider_share_bps",
    "max_operator_deal_slots",
    "operator_deal_cap_violations",
    "platinum_serves",
    "gold_serves",
    "silver_serves",
    "fail_serves",
    "average_latency_ms",
    "performance_fail_rate",
    "platinum_share",
    "performance_reward_paid",
    "storage_escrow_locked",
    "storage_escrow_earned",
    "storage_escrow_refunded",
    "storage_escrow_outstanding",
    "storage_fee_provider_payouts",
    "storage_fee_burned",
    "deals_closed",
    "deals_expired",
    "final_expired_deals",
    "final_open_deals",
    "final_closed_deals",
    "retrieval_base_burned",
    "retrieval_variable_burned",
    "retrieval_provider_payouts",
    "sponsored_retrieval_attempts",
    "sponsored_retrieval_spent",
    "owner_retrieval_escrow_debited",
    "retrieval_wash_accounted_spend",
    "retrieval_wash_net_gain",
    "retrieval_attempts",
    "retrieval_latent_attempts",
    "retrieval_demand_shock_active",
    "max_retrieval_demand_multiplier_bps",
    "new_deal_latent_requests",
    "new_deal_requests",
    "new_deals_accepted",
    "new_deals_suppressed_price",
    "new_deals_rejected_price",
    "new_deals_rejected_capacity",
    "new_deal_acceptance_rate",
    "new_deal_latent_acceptance_rate",
    "elasticity_overlay_activations",
    "elasticity_overlay_expired",
    "elasticity_overlay_serves",
    "elasticity_overlay_rejections",
    "final_elasticity_overlay_active",
    "max_elasticity_overlay_active",
    "final_elasticity_overlay_ready",
    "max_elasticity_overlay_ready",
    "staged_upload_attempts",
    "staged_upload_accepted",
    "staged_upload_committed",
    "staged_upload_rejections",
    "staged_upload_cleaned",
    "final_staged_upload_pending_generations",
    "max_staged_upload_pending_generations",
    "final_staged_upload_pending_mdus",
    "max_staged_upload_pending_mdus",
    "suspect_slots",
    "delinquent_slots",
    "quota_misses",
    "invalid_proofs",
    "paid_corrupt_bytes",
    "provider_slashed",
    "audit_budget_demand",
    "audit_budget_spent",
    "audit_budget_backlog",
    "audit_budget_exhausted",
    "evidence_spam_claims",
    "evidence_spam_convictions",
    "evidence_spam_bond_burned",
    "evidence_spam_bounty_paid",
    "evidence_spam_net_gain",
    "provider_cost_shock_active",
    "max_provider_cost_shocked_providers",
    "max_provider_cost_shock_fixed_multiplier_bps",
    "max_provider_cost_shock_storage_multiplier_bps",
    "max_provider_cost_shock_bandwidth_multiplier_bps",
    "provider_churn_events",
    "churned_providers",
    "provider_entries",
    "provider_probation_promotions",
    "provider_underbonded_repairs",
    "final_underbonded_providers",
    "max_underbonded_providers",
    "final_underbonded_assigned_slots",
    "max_underbonded_assigned_slots",
    "final_provider_bond_deficit",
    "max_provider_bond_deficit",
    "reserve_providers",
    "probationary_providers",
    "max_reserve_providers",
    "max_probationary_providers",
    "entered_active_providers",
    "churn_pressure_provider_epochs",
    "max_churn_pressure_providers",
    "final_active_provider_capacity",
    "final_exited_provider_capacity",
    "final_reserve_provider_capacity",
    "final_probationary_provider_capacity",
    "max_churned_assigned_slots",
    "providers_negative_pnl",
    "saturated_responses",
    "providers_over_capacity",
    "final_storage_utilization_bps",
    "min_storage_price",
    "max_storage_price",
    "final_storage_price",
    "min_retrieval_price",
    "max_retrieval_price",
    "final_retrieval_price",
    "storage_price_direction_changes",
    "retrieval_price_direction_changes",
    "provider_pnl",
]

SWEEP_CONFIG_KEYS = [
    "scenario",
    "seed",
    "providers",
    "users",
    "deals",
    "epochs",
    "retrievals_per_user_per_epoch",
    "enforcement_mode",
    "evict_after_missed_epochs",
    "deputy_evict_after_missed_epochs",
    "repair_epochs",
    "repair_attempt_cap_per_slot",
    "repair_backoff_epochs",
    "repair_pending_timeout_epochs",
    "max_repairs_started_per_epoch",
    "route_attempt_limit",
    "dynamic_pricing",
    "dynamic_pricing_max_step_bps",
    "storage_target_utilization_bps",
    "retrieval_target_per_epoch",
    "retrieval_demand_shocks",
    "new_deal_requests_per_epoch",
    "storage_demand_price_ceiling",
    "storage_demand_reference_price",
    "storage_demand_elasticity_bps",
    "storage_demand_min_bps",
    "storage_demand_max_bps",
    "storage_price",
    "storage_lockin_enabled",
    "deal_duration_epochs",
    "deal_expiry_enabled",
    "deal_close_epoch",
    "deal_close_count",
    "deal_close_bps",
    "retrieval_price_per_slot",
    "sponsored_retrieval_bps",
    "owner_retrieval_debit_bps",
    "base_reward_per_slot",
    "audit_budget_per_epoch",
    "audit_cost_per_miss",
    "evidence_spam_claims_per_epoch",
    "evidence_spam_bond",
    "evidence_spam_bounty",
    "evidence_spam_conviction_bps",
    "provider_capacity_min",
    "provider_capacity_max",
    "provider_bandwidth_capacity_min",
    "provider_bandwidth_capacity_max",
    "service_class",
    "performance_market_enabled",
    "provider_latency_ms_min",
    "provider_latency_ms_max",
    "provider_latency_jitter_bps",
    "platinum_latency_ms",
    "gold_latency_ms",
    "silver_latency_ms",
    "performance_reward_per_serve",
    "platinum_reward_multiplier_bps",
    "gold_reward_multiplier_bps",
    "silver_reward_multiplier_bps",
    "fail_reward_multiplier_bps",
    "high_bandwidth_promotion_enabled",
    "high_bandwidth_capacity_threshold",
    "high_bandwidth_min_retrievals",
    "high_bandwidth_min_success_rate_bps",
    "high_bandwidth_max_saturation_bps",
    "high_bandwidth_demotion_saturation_bps",
    "high_bandwidth_routing_enabled",
    "hot_retrieval_bps",
    "operator_count",
    "dominant_operator_provider_bps",
    "operator_assignment_cap_per_deal",
    "provider_online_probability_min",
    "provider_online_probability_max",
    "provider_repair_probability_min",
    "provider_repair_probability_max",
    "provider_storage_cost_per_slot_epoch",
    "provider_bandwidth_cost_per_retrieval",
    "provider_fixed_cost_per_epoch",
    "provider_storage_cost_jitter_bps",
    "provider_bandwidth_cost_jitter_bps",
    "provider_initial_bond",
    "provider_min_bond",
    "provider_bond_per_slot",
    "slash_hard_fault",
    "provider_cost_shocks",
    "provider_churn_enabled",
    "provider_churn_pnl_threshold",
    "provider_churn_after_epochs",
    "provider_churn_max_providers_per_epoch",
    "provider_churn_min_remaining_providers",
    "provider_entry_enabled",
    "provider_entry_reserve_count",
    "provider_entry_start_epoch",
    "provider_entry_end_epoch",
    "provider_entry_max_per_epoch",
    "provider_entry_trigger_utilization_bps",
    "provider_entry_trigger_storage_price",
    "provider_entry_probation_epochs",
    "elasticity_trigger_retrievals_per_epoch",
    "elasticity_base_cost",
    "elasticity_max_spend",
    "elasticity_overlay_enabled",
    "elasticity_overlay_providers_per_epoch",
    "elasticity_overlay_max_providers_per_deal",
    "elasticity_overlay_ready_delay_epochs",
    "elasticity_overlay_ttl_epochs",
    "staged_upload_attempts_per_epoch",
    "staged_upload_mdu_per_attempt",
    "staged_upload_commit_rate_bps",
    "staged_upload_retention_epochs",
    "staged_upload_max_pending_generations",
]


def generate_run_report(run_dir: Path, out_dir: Path) -> None:
    summary = load_json(run_dir / "summary.json")
    epochs = load_csv(run_dir / "epochs.csv")
    providers = load_csv(run_dir / "providers.csv")
    operators = load_csv(run_dir / "operators.csv")
    slots = load_csv(run_dir / "slots.csv")
    evidence = load_csv(run_dir / "evidence.csv")
    repairs = load_csv(run_dir / "repairs.csv")
    economy = load_csv(run_dir / "economy.csv")
    out_dir.mkdir(parents=True, exist_ok=True)
    graphs_dir = out_dir / "graphs"
    graphs_dir.mkdir(exist_ok=True)

    signals = compute_signals(summary, epochs, providers, operators, repairs, economy)
    (out_dir / "signals.json").write_text(
        json.dumps(stable_json_value(signals), indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    write_report_md(out_dir / "report.md", summary, epochs, providers, operators, slots, evidence, repairs, economy)
    write_risk_register(out_dir / "risk_register.md", summary, providers, evidence, repairs, economy)
    write_graduation_report(out_dir / "graduation.md", summary)
    write_graphs(graphs_dir, epochs, economy)


def stable_json_value(value: Any) -> Any:
    if isinstance(value, float):
        return round(value, 9)
    if isinstance(value, dict):
        return {key: stable_json_value(item) for key, item in value.items()}
    if isinstance(value, list):
        return [stable_json_value(item) for item in value]
    return value


def compute_signals(
    summary: dict[str, Any],
    epochs: list[dict[str, str]],
    providers: list[dict[str, str]],
    operators: list[dict[str, str]],
    repairs: list[dict[str, str]],
    economy: list[dict[str, str]],
) -> dict[str, Any]:
    totals = summary["totals"]
    worst_epoch = min(epochs, key=lambda row: safe_rate(row, "retrieval_successes", "retrieval_attempts"), default={})
    peak_saturation_epoch = max(epochs, key=lambda row: fnum(row.get("saturated_responses")), default={})
    peak_repair_backoff_epoch = max(epochs, key=lambda row: fnum(row.get("repair_backoffs")), default={})
    peak_repairing_epoch = max(epochs, key=lambda row: fnum(row.get("repairing_slots")), default={})
    degraded_epochs = [
        row
        for row in epochs
        if safe_rate(row, "retrieval_successes", "retrieval_attempts") < 0.999
        or fnum(row.get("unavailable_reads")) > 0
    ]
    worst_epoch_number = int(fnum(worst_epoch.get("epoch"))) if worst_epoch else 0
    recovery_epoch = 0
    for row in epochs:
        epoch = int(fnum(row.get("epoch")))
        if epoch <= worst_epoch_number:
            continue
        if safe_rate(row, "retrieval_successes", "retrieval_attempts") >= 0.999 and fnum(row.get("unavailable_reads")) == 0:
            recovery_epoch = epoch
            break

    repair_started = fnum(totals.get("repairs_started"))
    repair_ready = fnum(totals.get("repairs_ready"))
    repair_completed = fnum(totals.get("repairs_completed"))
    repair_attempts = fnum(totals.get("repair_attempts"))
    repair_backoffs = fnum(totals.get("repair_backoffs"))
    repair_timeouts = fnum(totals.get("repair_timeouts"))
    retrieval_attempts = max(1.0, fnum(totals.get("retrieval_attempts")))
    storage_prices = [fnum(row.get("storage_price")) for row in economy]
    retrieval_prices = [fnum(row.get("retrieval_price_per_slot")) for row in economy]
    capacity_utils = [fnum(row.get("capacity_utilization_bps")) for row in providers]
    pnls = [fnum(row.get("pnl")) for row in providers]
    high_bandwidth_providers = [row for row in providers if row.get("capability_tier") == "HIGH_BANDWIDTH"]
    reserve_provider_rows = [row for row in providers if row.get("lifecycle_state") == "RESERVE"]
    probation_provider_rows = [row for row in providers if row.get("lifecycle_state") == "PROBATION"]
    entered_active_provider_rows = [
        row
        for row in providers
        if row.get("lifecycle_state") == "ACTIVE" and fnum(row.get("entered_epoch")) > 0
    ]
    bandwidth_caps = [fnum(row.get("bandwidth_capacity_per_epoch")) for row in providers if fnum(row.get("bandwidth_capacity_per_epoch")) > 0]
    provider_latencies = [fnum(row.get("average_latency_ms")) for row in providers if fnum(row.get("latency_sample_count")) > 0]
    online_probs = [fnum(row.get("online_probability")) for row in providers]
    assigned_slots = sum(fnum(row.get("assigned_slots")) for row in providers)
    capacity_slots = sum(fnum(row.get("capacity_slots")) for row in providers)
    top_operator = max(operators, key=lambda row: fnum(row.get("assigned_slots")), default={})
    top_operator_by_providers = max(operators, key=lambda row: fnum(row.get("provider_count")), default={})
    regions = regional_signals(providers)

    return {
        "availability": {
            "success_rate": fnum(totals.get("success_rate")),
            "unavailable_reads": fnum(totals.get("unavailable_reads")),
            "expired_retrieval_attempts": fnum(totals.get("expired_retrieval_attempts")),
            "closed_retrieval_attempts": fnum(totals.get("closed_retrieval_attempts")),
            "data_loss_events": fnum(totals.get("data_loss_events")),
            "worst_epoch": int(fnum(worst_epoch.get("epoch"))),
            "worst_epoch_success_rate": safe_rate(worst_epoch, "retrieval_successes", "retrieval_attempts") if worst_epoch else 0.0,
            "degraded_epochs": len(degraded_epochs),
            "recovery_epoch_after_worst": recovery_epoch,
        },
        "saturation": {
            "saturated_responses": fnum(totals.get("saturated_responses")),
            "saturation_per_retrieval_attempt": fnum(totals.get("saturated_responses")) / retrieval_attempts,
            "peak_saturation_epoch": int(fnum(peak_saturation_epoch.get("epoch"))),
            "peak_saturated_responses": fnum(peak_saturation_epoch.get("saturated_responses")),
        },
        "repair": {
            "started": repair_started,
            "ready": repair_ready,
            "completed": repair_completed,
            "attempts": repair_attempts,
            "readiness_ratio": repair_ready / repair_started if repair_started else 1.0,
            "completion_ratio": repair_completed / repair_started if repair_started else 1.0,
            "backoffs": repair_backoffs,
            "cooldowns": fnum(totals.get("repair_cooldowns")),
            "attempt_caps": fnum(totals.get("repair_attempt_caps")),
            "repair_timeouts": repair_timeouts,
            "backoffs_per_attempt": repair_backoffs / max(1.0, repair_attempts),
            "backoffs_per_started_repair": repair_backoffs / max(1.0, repair_started),
            "peak_backoff_epoch": int(fnum(peak_repair_backoff_epoch.get("epoch"))),
            "peak_repair_backoffs": fnum(peak_repair_backoff_epoch.get("repair_backoffs")),
            "peak_repairing_epoch": int(fnum(peak_repairing_epoch.get("epoch"))),
            "peak_repairing_slots": fnum(peak_repairing_epoch.get("repairing_slots")),
            "final_repair_backlog": max(0.0, repair_started - repair_completed - repair_timeouts),
            "suspect_slot_epochs": fnum(totals.get("suspect_slots")),
            "delinquent_slot_epochs": fnum(totals.get("delinquent_slots")),
        },
        "capacity": {
            "assigned_slots": assigned_slots,
            "capacity_slots": capacity_slots,
            "final_utilization_bps": fnum(totals.get("final_storage_utilization_bps")),
            "providers_over_capacity": fnum(totals.get("providers_over_capacity")),
            "provider_capacity_utilization_p50_bps": percentile(capacity_utils, 50),
            "provider_capacity_utilization_p90_bps": percentile(capacity_utils, 90),
            "provider_capacity_utilization_max_bps": max(capacity_utils, default=0.0),
            "bandwidth_capacity_p10": percentile(bandwidth_caps, 10),
            "bandwidth_capacity_p50": percentile(bandwidth_caps, 50),
            "bandwidth_capacity_p90": percentile(bandwidth_caps, 90),
            "online_probability_p10": percentile(online_probs, 10),
            "online_probability_p50": percentile(online_probs, 50),
            "online_probability_p90": percentile(online_probs, 90),
            "reserve_providers": fnum(totals.get("reserve_providers")),
            "probationary_providers": fnum(totals.get("probationary_providers")),
            "entered_active_providers": fnum(totals.get("entered_active_providers")),
            "reserve_providers_from_rows": len(reserve_provider_rows),
            "probationary_providers_from_rows": len(probation_provider_rows),
            "entered_active_providers_from_rows": len(entered_active_provider_rows),
            "final_reserve_provider_capacity": fnum(totals.get("final_reserve_provider_capacity")),
            "final_probationary_provider_capacity": fnum(totals.get("final_probationary_provider_capacity")),
        },
        "economics": {
            "provider_pnl": fnum(totals.get("provider_pnl")),
            "providers_negative_pnl": fnum(totals.get("providers_negative_pnl")),
            "provider_pnl_p10": percentile(pnls, 10),
            "provider_pnl_p50": percentile(pnls, 50),
            "provider_pnl_p90": percentile(pnls, 90),
            "audit_budget_demand": fnum(totals.get("audit_budget_demand")),
            "audit_budget_spent": fnum(totals.get("audit_budget_spent")),
            "audit_budget_carryover": fnum(totals.get("audit_budget_carryover")),
            "audit_budget_backlog": fnum(totals.get("audit_budget_backlog")),
            "audit_budget_exhausted_epochs": fnum(totals.get("audit_budget_exhausted")),
            "evidence_spam_claims": fnum(totals.get("evidence_spam_claims")),
            "evidence_spam_convictions": fnum(totals.get("evidence_spam_convictions")),
            "evidence_spam_bond_burned": fnum(totals.get("evidence_spam_bond_burned")),
            "evidence_spam_bounty_paid": fnum(totals.get("evidence_spam_bounty_paid")),
            "evidence_spam_net_gain": fnum(totals.get("evidence_spam_net_gain")),
            "provider_cost_shock_epochs": metric_sum(economy, "provider_cost_shock_active"),
            "max_provider_cost_shocked_providers": fnum(totals.get("max_provider_cost_shocked_providers")),
            "max_provider_cost_shock_fixed_multiplier_bps": fnum(totals.get("max_provider_cost_shock_fixed_multiplier_bps")),
            "max_provider_cost_shock_storage_multiplier_bps": fnum(totals.get("max_provider_cost_shock_storage_multiplier_bps")),
            "max_provider_cost_shock_bandwidth_multiplier_bps": fnum(totals.get("max_provider_cost_shock_bandwidth_multiplier_bps")),
            "provider_churn_events": fnum(totals.get("provider_churn_events")),
            "churned_providers": fnum(totals.get("churned_providers")),
            "provider_entries": fnum(totals.get("provider_entries")),
            "provider_probation_promotions": fnum(totals.get("provider_probation_promotions")),
            "max_probationary_providers": fnum(totals.get("max_probationary_providers")),
            "max_reserve_providers": fnum(totals.get("max_reserve_providers")),
            "provider_underbonded_repairs": fnum(totals.get("provider_underbonded_repairs")),
            "final_underbonded_providers": fnum(totals.get("final_underbonded_providers")),
            "max_underbonded_providers": fnum(totals.get("max_underbonded_providers")),
            "final_underbonded_assigned_slots": fnum(totals.get("final_underbonded_assigned_slots")),
            "max_underbonded_assigned_slots": fnum(totals.get("max_underbonded_assigned_slots")),
            "final_provider_bond_deficit": fnum(totals.get("final_provider_bond_deficit")),
            "max_provider_bond_deficit": fnum(totals.get("max_provider_bond_deficit")),
            "churn_pressure_provider_epochs": fnum(totals.get("churn_pressure_provider_epochs")),
            "max_churn_pressure_providers": fnum(totals.get("max_churn_pressure_providers")),
            "final_active_provider_capacity": fnum(totals.get("final_active_provider_capacity")),
            "final_exited_provider_capacity": fnum(totals.get("final_exited_provider_capacity")),
            "max_churned_assigned_slots": fnum(totals.get("max_churned_assigned_slots")),
            "storage_price_start": storage_prices[0] if storage_prices else 0.0,
            "storage_price_end": storage_prices[-1] if storage_prices else 0.0,
            "storage_price_min": min(storage_prices, default=0.0),
            "storage_price_max": max(storage_prices, default=0.0),
            "retrieval_price_start": retrieval_prices[0] if retrieval_prices else 0.0,
            "retrieval_price_end": retrieval_prices[-1] if retrieval_prices else 0.0,
            "retrieval_price_min": min(retrieval_prices, default=0.0),
            "retrieval_price_max": max(retrieval_prices, default=0.0),
            "retrieval_attempts": fnum(totals.get("retrieval_attempts")),
            "retrieval_latent_attempts": fnum(totals.get("retrieval_latent_attempts")),
            "retrieval_demand_shock_epochs": fnum(totals.get("retrieval_demand_shock_active")),
            "max_retrieval_demand_multiplier_bps": fnum(totals.get("max_retrieval_demand_multiplier_bps")),
            "storage_price_direction_changes": fnum(totals.get("storage_price_direction_changes")),
            "retrieval_price_direction_changes": fnum(totals.get("retrieval_price_direction_changes")),
            "storage_escrow_locked": fnum(totals.get("storage_escrow_locked")),
            "storage_escrow_earned": fnum(totals.get("storage_escrow_earned")),
            "storage_escrow_refunded": fnum(totals.get("storage_escrow_refunded")),
            "storage_escrow_outstanding": fnum(totals.get("storage_escrow_outstanding")),
            "max_storage_escrow_outstanding": fnum(totals.get("max_storage_escrow_outstanding")),
            "storage_fee_provider_payouts": fnum(totals.get("storage_fee_provider_payouts")),
            "storage_fee_burned": fnum(totals.get("storage_fee_burned")),
            "deals_closed": fnum(totals.get("deals_closed")),
            "deals_expired": fnum(totals.get("deals_expired")),
            "final_open_deals": fnum(totals.get("final_open_deals")),
            "final_closed_deals": fnum(totals.get("final_closed_deals")),
            "final_expired_deals": fnum(totals.get("final_expired_deals")),
            "sponsored_retrieval_attempts": fnum(totals.get("sponsored_retrieval_attempts")),
            "owner_funded_retrieval_attempts": fnum(totals.get("owner_funded_retrieval_attempts")),
            "sponsored_retrieval_base_spent": fnum(totals.get("sponsored_retrieval_base_spent")),
            "sponsored_retrieval_variable_spent": fnum(totals.get("sponsored_retrieval_variable_spent")),
            "sponsored_retrieval_spent": fnum(totals.get("sponsored_retrieval_spent")),
            "owner_retrieval_escrow_debited": fnum(totals.get("owner_retrieval_escrow_debited")),
            "retrieval_wash_accounted_spend": fnum(totals.get("retrieval_wash_accounted_spend")),
            "retrieval_wash_net_gain": fnum(totals.get("retrieval_wash_net_gain")),
            "elasticity_spent": fnum(totals.get("elasticity_spent")),
            "elasticity_rejections": fnum(totals.get("elasticity_rejections")),
            "elasticity_overlay_activations": fnum(totals.get("elasticity_overlay_activations")),
            "elasticity_overlay_expired": fnum(totals.get("elasticity_overlay_expired")),
            "elasticity_overlay_serves": fnum(totals.get("elasticity_overlay_serves")),
            "elasticity_overlay_rejections": fnum(totals.get("elasticity_overlay_rejections")),
            "final_elasticity_overlay_active": fnum(totals.get("final_elasticity_overlay_active")),
            "max_elasticity_overlay_active": fnum(totals.get("max_elasticity_overlay_active")),
            "final_elasticity_overlay_ready": fnum(totals.get("final_elasticity_overlay_ready")),
            "max_elasticity_overlay_ready": fnum(totals.get("max_elasticity_overlay_ready")),
        },
        "high_bandwidth": {
            "providers": fnum(totals.get("high_bandwidth_providers")),
            "promotions": fnum(totals.get("high_bandwidth_promotions")),
            "demotions": fnum(totals.get("high_bandwidth_demotions")),
            "hot_retrieval_attempts": fnum(totals.get("hot_retrieval_attempts")),
            "high_bandwidth_serves": fnum(totals.get("high_bandwidth_serves")),
            "hot_high_bandwidth_serves": fnum(totals.get("hot_high_bandwidth_serves")),
            "hot_high_bandwidth_serves_per_hot_retrieval": (
                fnum(totals.get("hot_high_bandwidth_serves")) / max(1.0, fnum(totals.get("hot_retrieval_attempts")))
            ),
            "provider_count_from_rows": len(high_bandwidth_providers),
            "bandwidth_capacity_p50": percentile(
                [fnum(row.get("bandwidth_capacity_per_epoch")) for row in high_bandwidth_providers],
                50,
            ),
        },
        "performance": {
            "platinum_serves": fnum(totals.get("platinum_serves")),
            "gold_serves": fnum(totals.get("gold_serves")),
            "silver_serves": fnum(totals.get("silver_serves")),
            "fail_serves": fnum(totals.get("fail_serves")),
            "average_latency_ms": fnum(totals.get("average_latency_ms")),
            "performance_fail_rate": fnum(totals.get("performance_fail_rate")),
            "platinum_share": fnum(totals.get("platinum_share")),
            "performance_reward_paid": fnum(totals.get("performance_reward_paid")),
            "provider_latency_p10_ms": percentile(provider_latencies, 10),
            "provider_latency_p50_ms": percentile(provider_latencies, 50),
            "provider_latency_p90_ms": percentile(provider_latencies, 90),
        },
        "demand": {
            "new_deal_latent_requests": fnum(totals.get("new_deal_latent_requests")),
            "new_deal_requests": fnum(totals.get("new_deal_requests")),
            "new_deals_accepted": fnum(totals.get("new_deals_accepted")),
            "new_deals_suppressed_price": fnum(totals.get("new_deals_suppressed_price")),
            "new_deals_rejected_price": fnum(totals.get("new_deals_rejected_price")),
            "new_deals_rejected_capacity": fnum(totals.get("new_deals_rejected_capacity")),
            "new_deal_acceptance_rate": fnum(totals.get("new_deal_acceptance_rate")),
            "new_deal_latent_acceptance_rate": fnum(totals.get("new_deal_latent_acceptance_rate")),
        },
        "staged_uploads": {
            "attempts": fnum(totals.get("staged_upload_attempts")),
            "accepted": fnum(totals.get("staged_upload_accepted")),
            "committed": fnum(totals.get("staged_upload_committed")),
            "rejections": fnum(totals.get("staged_upload_rejections")),
            "cleaned": fnum(totals.get("staged_upload_cleaned")),
            "final_pending_generations": fnum(totals.get("final_staged_upload_pending_generations")),
            "max_pending_generations": fnum(totals.get("max_staged_upload_pending_generations")),
            "final_pending_mdus": fnum(totals.get("final_staged_upload_pending_mdus")),
            "max_pending_mdus": fnum(totals.get("max_staged_upload_pending_mdus")),
            "rejection_rate": (
                fnum(totals.get("staged_upload_rejections"))
                / max(1.0, fnum(totals.get("staged_upload_attempts")))
            ),
            "cleanup_rate": (
                fnum(totals.get("staged_upload_cleaned"))
                / max(1.0, fnum(totals.get("staged_upload_accepted")))
            ),
        },
        "concentration": {
            "operator_count": fnum(totals.get("operator_count")),
            "top_operator_id": top_operator.get("operator_id", ""),
            "top_operator_assigned_slots": fnum(totals.get("top_operator_assigned_slots")),
            "top_operator_assignment_share_bps": fnum(totals.get("top_operator_assignment_share_bps")),
            "max_operator_assignment_share_bps": fnum(totals.get("max_operator_assignment_share_bps")),
            "max_operator_deal_slots": fnum(totals.get("max_operator_deal_slots")),
            "operator_deal_cap_violations": fnum(totals.get("operator_deal_cap_violations")),
            "top_operator_provider_id": top_operator_by_providers.get("operator_id", ""),
            "top_operator_provider_count": fnum(totals.get("top_operator_provider_count")),
            "top_operator_provider_share_bps": fnum(totals.get("top_operator_provider_share_bps")),
        },
        "regions": regions,
        "top_bottleneck_providers": top_bottleneck_providers(providers),
        "top_operators": top_operators(operators),
    }


def regional_signals(providers: list[dict[str, str]]) -> list[dict[str, Any]]:
    grouped: dict[str, list[dict[str, str]]] = defaultdict(list)
    for row in providers:
        grouped[row.get("region", "unknown")].append(row)
    regions = []
    for region, rows in sorted(grouped.items()):
        assigned = sum(fnum(row.get("assigned_slots")) for row in rows)
        capacity = sum(fnum(row.get("capacity_slots")) for row in rows)
        pnls = [fnum(row.get("pnl")) for row in rows]
        regions.append(
            {
                "region": region,
                "providers": len(rows),
                "assigned_slots": assigned,
                "capacity_slots": capacity,
                "utilization_bps": int(assigned * 10_000 / max(1.0, capacity)),
                "offline_responses": sum(fnum(row.get("offline_responses")) for row in rows),
                "saturated_responses": sum(fnum(row.get("saturated_responses")) for row in rows),
                "negative_pnl_providers": sum(1 for row in rows if fnum(row.get("pnl")) < 0),
                "avg_provider_pnl": sum(pnls) / len(pnls) if pnls else 0.0,
            }
        )
    return regions


def top_operators(operators: list[dict[str, str]]) -> list[dict[str, Any]]:
    ranked = sorted(
        operators,
        key=lambda row: (fnum(row.get("assigned_slots")), fnum(row.get("provider_count"))),
        reverse=True,
    )
    out = []
    for row in ranked[:8]:
        out.append(
            {
                "operator_id": row.get("operator_id", ""),
                "provider_count": fnum(row.get("provider_count")),
                "provider_share_bps": fnum(row.get("provider_share_bps")),
                "assigned_slots": fnum(row.get("assigned_slots")),
                "assignment_share_bps": fnum(row.get("assignment_share_bps")),
                "retrieval_attempts": fnum(row.get("retrieval_attempts")),
                "success_rate": fnum(row.get("success_rate")),
                "pnl": fnum(row.get("pnl")),
            }
        )
    return out


def top_bottleneck_providers(providers: list[dict[str, str]]) -> list[dict[str, Any]]:
    ranked = sorted(
        providers,
        key=lambda row: (
            fnum(row.get("saturated_responses"))
            + fnum(row.get("offline_responses"))
            + max(0.0, fnum(row.get("capacity_utilization_bps")) - 10_000) / 100,
            fnum(row.get("retrieval_attempts")),
        ),
        reverse=True,
    )
    out = []
    for row in ranked[:8]:
        out.append(
            {
                "provider_id": row.get("provider_id", ""),
                "region": row.get("region", ""),
                "assigned_slots": fnum(row.get("assigned_slots")),
                "capacity_slots": fnum(row.get("capacity_slots")),
                "capacity_utilization_bps": fnum(row.get("capacity_utilization_bps")),
                "bandwidth_capacity_per_epoch": fnum(row.get("bandwidth_capacity_per_epoch")),
                "retrieval_attempts": fnum(row.get("retrieval_attempts")),
                "offline_responses": fnum(row.get("offline_responses")),
                "saturated_responses": fnum(row.get("saturated_responses")),
                "pnl": fnum(row.get("pnl")),
            }
        )
    return out


def write_report_md(
    path: Path,
    summary: dict[str, Any],
    epochs: list[dict[str, str]],
    providers: list[dict[str, str]],
    operators: list[dict[str, str]],
    slots: list[dict[str, str]],
    evidence: list[dict[str, str]],
    repairs: list[dict[str, str]],
    economy: list[dict[str, str]],
) -> None:
    config = summary["config"]
    totals = summary["totals"]
    assertions = summary.get("assertions", [])
    failed = [item for item in assertions if not item.get("passed")]
    negative_pnl = [p for p in providers if fnum(p.get("pnl")) < 0]
    churn_risk = [p for p in providers if fnum(p.get("churn_risk")) > 0]
    scenario = str(config["scenario"])
    guide = scenario_guide(scenario)
    evidence_by_reason = Counter(row.get("reason", "unknown") for row in evidence)
    evidence_by_provider = Counter(row.get("provider_id", "unknown") for row in evidence)
    repairs_started = [row for row in repairs if row.get("event") == "repair_started"]
    repairs_ready = [row for row in repairs if row.get("event") == "repair_ready"]
    repairs_completed = [row for row in repairs if row.get("event") == "repair_completed"]
    worst_providers = sorted(providers, key=lambda row: fnum(row.get("pnl")))[:5]
    active_end_slots = [row for row in slots if row.get("epoch") == str(config.get("epochs")) and row.get("status") == "ACTIVE"]
    timeline_rows = build_timeline_rows(epochs)
    verdict = "PASS" if assertions and not failed else "NEEDS REVIEW"
    if not assertions:
        verdict = "UNASSERTED"
    signals = compute_signals(summary, epochs, providers, operators, repairs, economy)

    lines = [
        f"# Policy Simulation Report: {guide['title']}",
        "",
        "## Executive Summary",
        "",
        f"**Verdict:** `{verdict}`. This run simulates `{scenario}` with `{config.get('providers')}` providers, "
        f"`{config.get('users')}` data users, `{config.get('deals')}` deals, and an RS `{config.get('k')}+{config.get('m')}` layout "
        f"for `{config.get('epochs')}` epochs. Enforcement is configured as `{config.get('enforcement_mode')}`.",
        "",
        guide["intent"],
        "",
        f"Expected policy behavior: {guide['expected']}",
        "",
        f"Observed result: retrieval success was `{fmt_pct(totals.get('success_rate'))}`, reward coverage was "
        f"`{fmt_pct(totals.get('reward_coverage'))}`, repairs started/ready/completed were "
        f"`{fmt_num(totals.get('repairs_started'))}` / `{fmt_num(totals.get('repairs_ready'))}` / `{fmt_num(totals.get('repairs_completed'))}`, and "
        f"`{len(negative_pnl)}` providers ended with negative modeled P&L. The run recorded "
        f"`{fmt_num(totals.get('unavailable_reads'))}` unavailable reads, "
        f"`{fmt_num(totals.get('expired_retrieval_attempts'))}` expired retrieval rejections, "
        f"`{fmt_num(totals.get('closed_retrieval_attempts'))}` closed retrieval rejections, "
        f"`{fmt_num(totals.get('data_loss_events'))}` modeled data-loss events, "
        f"`{fmt_num(totals.get('saturated_responses'))}` bandwidth saturation responses and "
        f"`{fmt_num(totals.get('repair_backoffs'))}` repair backoffs across "
        f"`{fmt_num(totals.get('repair_attempts'))}` repair attempts, with "
        f"`{fmt_num(totals.get('repair_timeouts'))}` pending-repair readiness timeouts. Slot health recorded "
        f"`{fmt_num(totals.get('suspect_slots'))}` suspect slot-epochs and "
        f"`{fmt_num(totals.get('delinquent_slots'))}` delinquent slot-epochs. "
        f"High-bandwidth promotions were `{fmt_num(totals.get('high_bandwidth_promotions'))}` and final high-bandwidth providers were "
        f"`{fmt_num(totals.get('high_bandwidth_providers'))}`.{performance_summary_sentence(totals)}",
        "",
        "## Review Focus",
        "",
        guide["review"],
        "",
        "A human reviewer should focus less on the pass/fail label and more on whether the scenario, assertions, and threshold values encode the policy we actually want to enforce on-chain.",
        "",
        "## Run Configuration",
        "",
        "| Field | Value |",
        "|---|---:|",
        f"| Seed | `{config.get('seed')}` |",
        f"| Providers | `{config.get('providers')}` |",
        f"| Data users | `{config.get('users')}` |",
        f"| Deals | `{config.get('deals')}` |",
        f"| Epochs | `{config.get('epochs')}` |",
        f"| Erasure coding | `K={config.get('k')}`, `M={config.get('m')}`, `N={fint(config.get('k')) + fint(config.get('m'))}` |",
        f"| User MDUs per deal | `{config.get('user_mdus_per_deal')}` |",
        f"| Retrievals/user/epoch | `{config.get('retrievals_per_user_per_epoch')}` |",
        f"| Liveness quota | `{config.get('quota_min_blobs')}`-`{config.get('quota_max_blobs')}` blobs/slot/epoch |",
        f"| Repair delay | `{config.get('repair_epochs')}` epochs |",
        f"| Repair attempt cap/slot | `{config.get('repair_attempt_cap_per_slot')}` (`0` means unlimited) |",
        f"| Repair backoff window | `{config.get('repair_backoff_epochs')}` epochs |",
        f"| Repair pending timeout | `{config.get('repair_pending_timeout_epochs')}` epochs (`0` means disabled) |",
        f"| Dynamic pricing | `{str(config.get('dynamic_pricing')).lower()}` |",
        f"| Storage price | `{fmt_money(config.get('storage_price'))}` |",
        f"| Storage lock-in | `{str(config.get('storage_lockin_enabled')).lower()}`; duration `{fmt_num(config.get('deal_duration_epochs'))}` epochs |",
        f"| Deal expiry | `{str(config.get('deal_expiry_enabled')).lower()}` |",
        f"| Deal close policy | epoch `{fmt_num(config.get('deal_close_epoch'))}`; count `{fmt_num(config.get('deal_close_count'))}`; share `{fmt_bps(config.get('deal_close_bps'))}` |",
        f"| New deal requests/epoch | `{fmt_num(config.get('new_deal_requests_per_epoch'))}` |",
        f"| Storage demand price ceiling | `{fmt_money(config.get('storage_demand_price_ceiling'))}` (`0` means disabled) |",
        f"| Storage demand reference price | `{fmt_money(config.get('storage_demand_reference_price'))}` (`0` disables elasticity) |",
        f"| Storage demand elasticity | `{fmt_bps(config.get('storage_demand_elasticity_bps'))}` |",
        f"| Elasticity trigger | `{fmt_num(config.get('elasticity_trigger_retrievals_per_epoch'))}` retrievals/epoch (`0` disables) |",
        f"| Elasticity spend cap | `{fmt_money(config.get('elasticity_max_spend'))}` total |",
        f"| Elasticity overlay | `{str(config.get('elasticity_overlay_enabled')).lower()}`; `{fmt_num(config.get('elasticity_overlay_providers_per_epoch'))}` providers/epoch; max `{fmt_num(config.get('elasticity_overlay_max_providers_per_deal'))}`/deal |",
        f"| Elasticity overlay timing | ready delay `{fmt_num(config.get('elasticity_overlay_ready_delay_epochs'))}` epochs; TTL `{fmt_num(config.get('elasticity_overlay_ttl_epochs'))}` epochs (`0` means no expiry) |",
        f"| Staged uploads/epoch | `{fmt_num(config.get('staged_upload_attempts_per_epoch'))}` provisional attempts |",
        f"| Staged upload retention | `{fmt_num(config.get('staged_upload_retention_epochs'))}` epochs (`0` disables age cleanup) |",
        f"| Staged upload pending cap | `{fmt_num(config.get('staged_upload_max_pending_generations'))}` generations (`0` means unlimited) |",
        f"| Retrieval price/slot | `{fmt_money(config.get('retrieval_price_per_slot'))}` |",
        f"| Sponsored retrieval share | `{fmt_bps(config.get('sponsored_retrieval_bps'))}` |",
        f"| Owner retrieval debit share | `{fmt_bps(config.get('owner_retrieval_debit_bps'))}` |",
        f"| Provider capacity range | `{config.get('provider_capacity_min') or config.get('provider_slot_capacity')}`-`{config.get('provider_capacity_max') or config.get('provider_slot_capacity')}` slots |",
        f"| Provider bandwidth range | `{config.get('provider_bandwidth_capacity_min') or config.get('provider_bandwidth_capacity_per_epoch')}`-`{config.get('provider_bandwidth_capacity_max') or config.get('provider_bandwidth_capacity_per_epoch')}` serves/epoch (`0` means unlimited) |",
        f"| Service class | `{config.get('service_class')}` |",
        f"| Performance market | `{str(config.get('performance_market_enabled')).lower()}` |",
        f"| Provider latency range | `{fmt_num(config.get('provider_latency_ms_min'))}`-`{fmt_num(config.get('provider_latency_ms_max'))}` ms |",
        f"| Latency tier windows | Platinum <= `{fmt_num(config.get('platinum_latency_ms'))}` ms, Gold <= `{fmt_num(config.get('gold_latency_ms'))}` ms, Silver <= `{fmt_num(config.get('silver_latency_ms'))}` ms |",
        f"| High-bandwidth promotion | `{str(config.get('high_bandwidth_promotion_enabled')).lower()}` |",
        f"| High-bandwidth capacity threshold | `{fmt_num(config.get('high_bandwidth_capacity_threshold'))}` serves/epoch |",
        f"| Hot retrieval share | `{fmt_bps(config.get('hot_retrieval_bps'))}` |",
        f"| Operators | `{config.get('operator_count') or config.get('providers')}` |",
        f"| Dominant operator provider share | `{fmt_bps(config.get('dominant_operator_provider_bps'))}` |",
        f"| Operator assignment cap/deal | `{fmt_num(config.get('operator_assignment_cap_per_deal'))}` (`0` means disabled) |",
        f"| Provider regions | `{', '.join(str(item) for item in config.get('provider_regions', []))}` |",
        "",
        "## Economic Assumptions",
        "",
        *economic_assumption_lines(config),
        "",
        "## What Happened",
        "",
        build_behavior_narrative(totals, evidence, repairs, providers, economy),
        "",
        "## Diagnostic Signals",
        "",
        "These are derived from the raw CSV/JSON outputs and are intended to make scale behavior reviewable without manually scanning ledgers.",
        "",
        *diagnostic_signal_lines(signals),
        "",
        "### Regional Signals",
        "",
        *regional_signal_lines(signals),
        "",
        "### Top Bottleneck Providers",
        "",
        *bottleneck_provider_lines(signals),
        "",
        "### Top Operators",
        "",
        *top_operator_lines(signals),
        "",
        "### Timeline",
        "",
        "| Epoch | Retrieval Success | Evidence | Repairs Started | Repairs Ready | Repairs Completed | Reward Burned | Provider P&L | Notes |",
        "|---:|---:|---:|---:|---:|---:|---:|---:|---|",
    ]
    lines.extend(timeline_rows)
    lines.extend(
        [
            "",
            "## Enforcement Interpretation",
            "",
            f"The simulator recorded `{len(evidence)}` evidence events and `{len(repairs)}` repair ledger events. "
            f"The first evidence epoch was `{first_epoch(evidence, lambda row: True)}` and the first repair-start epoch was "
            f"`{first_epoch(repairs, lambda row: row.get('event') == 'repair_started')}`.",
            "",
            "Evidence by reason:",
            "",
            *counter_lines(evidence_by_reason),
            "",
            "Evidence by provider:",
            "",
            *counter_lines(evidence_by_provider),
            "",
            "Repair summary:",
            "",
            f"- Repairs started: `{len(repairs_started)}`",
            f"- Repairs marked ready: `{len(repairs_ready)}`",
            f"- Repairs completed: `{len(repairs_completed)}`",
            f"- Repair attempts: `{fmt_num(totals.get('repair_attempts'))}`",
            f"- Repair backoffs: `{fmt_num(totals.get('repair_backoffs'))}`",
            f"- Repair cooldown backoffs: `{fmt_num(totals.get('repair_cooldowns'))}`",
            f"- Repair attempt-cap backoffs: `{fmt_num(totals.get('repair_attempt_caps'))}`",
            f"- Repair readiness timeouts: `{fmt_num(totals.get('repair_timeouts'))}`",
            f"- Suspect slot-epochs: `{fmt_num(totals.get('suspect_slots'))}`",
            f"- Delinquent slot-epochs: `{fmt_num(totals.get('delinquent_slots'))}`",
            f"- Final active slots in last epoch: `{len(active_end_slots)}`",
            "",
            "Candidate exclusion summary:",
            "",
            *candidate_exclusion_lines(repairs),
            "",
            "### Repair Ledger Excerpt",
            "",
            *repair_excerpt_lines(repairs),
            "",
            "## Economic Interpretation",
            "",
            build_economic_narrative(totals, providers, economy, negative_pnl, churn_risk),
            "",
            "### Provider P&L Extremes",
            "",
            "| Provider | Assigned Slots | Revenue | Cost | Slashed | P&L | Churn Risk |",
            "|---|---:|---:|---:|---:|---:|---:|",
            *provider_lines(worst_providers),
            "",
            "## Assertion Contract",
            "",
            "Assertions are the machine-readable policy contract for this fixture. Passing means this simulator run satisfied the current contract; it does not mean the policy is production-ready.",
            "",
            "| Assertion | Status | Meaning | Detail |",
            "|---|---|---|---|",
            *assertion_lines(assertions),
            "",
            "## Evidence Ledger Excerpt",
            "",
            "These rows are representative raw evidence events. Use `evidence.csv` for the complete ledger.",
            "",
            "| Epoch | Deal | Slot | Provider | Class | Reason | Consequence |",
            "|---:|---:|---:|---|---|---|---|",
            *evidence_excerpt_lines(evidence),
            "",
            "## Generated Graphs",
            "",
            "The following SVG graphs are generated beside this report and embedded here with relative Markdown links so the report is readable as a self-contained artifact in GitHub or a local Markdown viewer.",
            "",
            "### Retrieval Success Rate",
            "",
            "Should stay near 1.0 unless availability is actually lost.",
            "",
            "![Retrieval Success Rate](graphs/retrieval_success_rate.svg)",
            "",
            "### Slot State Transitions",
            "",
            "Shows active slots and repair slots; spikes indicate reassignment churn.",
            "",
            "![Slot State Transitions](graphs/slot_states.svg)",
            "",
            "### Provider P&L",
            "",
            "Shows aggregate provider economics over time.",
            "",
            "![Provider P&L](graphs/provider_pnl.svg)",
            "",
            "### Provider Cost Shock",
            "",
            "Shows modeled provider cost pressure against provider revenue.",
            "",
            "![Provider Cost Shock](graphs/provider_cost_shock.svg)",
            "",
            "### Provider Churn",
            "",
            "Shows modeled provider exits and per-epoch churn events.",
            "",
            "![Provider Churn](graphs/provider_churn.svg)",
            "",
            "### Provider Supply Entry",
            "",
            "Shows reserve provider entry and probationary promotion into active supply.",
            "",
            "![Provider Supply Entry](graphs/provider_supply.svg)",
            "",
            "### Provider Bond Headroom",
            "",
            "Shows underbonded providers and repairs triggered by insufficient assignment collateral.",
            "",
            "![Provider Bond Headroom](graphs/provider_bond_headroom.svg)",
            "",
            "### Burn / Mint Ratio",
            "",
            "Shows whether burns are material relative to minted rewards and audit budget.",
            "",
            "![Burn / Mint Ratio](graphs/burn_mint_ratio.svg)",
            "",
            "### Storage Escrow Lifecycle",
            "",
            "Shows storage escrow locked, earned, refunded, and still outstanding after close/refund semantics.",
            "",
            "![Storage Escrow Lifecycle](graphs/storage_escrow_lifecycle.svg)",
            "",
            "### Price Trajectory",
            "",
            "Shows storage price and retrieval price movement under dynamic pricing.",
            "",
            "![Price Trajectory](graphs/price_trajectory.svg)",
            "",
            "### Retrieval Demand",
            "",
            "Shows effective retrieval attempts against latent baseline demand.",
            "",
            "![Retrieval Demand](graphs/retrieval_demand.svg)",
            "",
            "### Storage Demand",
            "",
            "Shows modeled new deal demand accepted versus rejected by price.",
            "",
            "![Storage Demand](graphs/storage_demand.svg)",
            "",
            "### Capacity Utilization",
            "",
            "Shows active storage responsibility against modeled provider capacity.",
            "",
            "![Capacity Utilization](graphs/capacity_utilization.svg)",
            "",
            "### Saturation And Repair Pressure",
            "",
            "Shows provider bandwidth saturation and repair backoffs, which are scale-specific stress signals.",
            "",
            "![Saturation And Repair Pressure](graphs/saturation_and_repair.svg)",
            "",
            "### Repair Backlog",
            "",
            "Shows whether started repairs are accumulating faster than they complete.",
            "",
            "![Repair Backlog](graphs/repair_backlog.svg)",
            "",
            "### Repair Readiness",
            "",
            "Shows pending-provider readiness timeouts against successful readiness events.",
            "",
            "![Repair Readiness](graphs/repair_readiness.svg)",
            "",
            "### High-Bandwidth Promotion",
            "",
            "Shows capability promotion/demotion state over time for hot-path eligibility.",
            "",
            "![High-Bandwidth Promotion](graphs/high_bandwidth_promotion.svg)",
            "",
            "### Hot Retrieval Routing",
            "",
            "Shows whether hot retrieval attempts are being served by promoted high-bandwidth providers.",
            "",
            "![Hot Retrieval Routing](graphs/hot_retrieval_routing.svg)",
            "",
            "### Performance Tiers",
            "",
            "Shows the fast positive tier and Fail-tier service counts under the performance market.",
            "",
            "![Performance Tiers](graphs/performance_tiers.svg)",
            "",
            "### Operator Concentration",
            "",
            "Shows whether operator assignment share is bounded despite provider identity concentration.",
            "",
            "![Operator Concentration](graphs/operator_concentration.svg)",
            "",
            "### Evidence Pressure",
            "",
            "Shows soft liveness evidence and hard invalid-proof evidence by epoch.",
            "",
            "![Evidence Pressure](graphs/evidence_pressure.svg)",
            "",
            "### Evidence Spam Economics",
            "",
            "Shows bond burn and bounty payout for low-quality deputy evidence claims.",
            "",
            "![Evidence Spam Economics](graphs/evidence_spam.svg)",
            "",
            "### Audit Budget",
            "",
            "Shows whether miss-driven audit demand is spending budget or accumulating carryover.",
            "",
            "![Audit Budget](graphs/audit_budget.svg)",
            "",
            "### Audit Backlog",
            "",
            "Shows unmet audit demand and exhausted-budget epochs when evidence exceeds available enforcement budget.",
            "",
            "![Audit Backlog](graphs/audit_backlog.svg)",
            "",
            "### Sponsored Retrieval Accounting",
            "",
            "Shows sponsor-funded public retrieval spend against any owner deal-escrow debit.",
            "",
            "![Sponsored Retrieval Accounting](graphs/sponsored_retrieval_accounting.svg)",
            "",
            "### Elasticity Spend",
            "",
            "Shows demand-funded elasticity spend and rejected expansion attempts.",
            "",
            "![Elasticity Spend](graphs/elasticity_spend.svg)",
            "",
            "### Elasticity Overlay Routes",
            "",
            "Shows temporary overflow routes that are active or serving reads after user-funded elasticity scale-up.",
            "",
            "![Elasticity Overlay Routes](graphs/elasticity_overlay_routes.svg)",
            "",
            "### Staged Upload Pressure",
            "",
            "Shows provisional-generation preflight rejections and retention cleanup for abandoned staged uploads.",
            "",
            "![Staged Upload Pressure](graphs/staged_upload_pressure.svg)",
            "",
            "## Raw Artifacts",
            "",
            "- `summary.json`: compact machine-readable run summary.",
            "- `epochs.csv`: per-epoch availability, liveness, reward, repair, and economics metrics.",
            "- `providers.csv`: final provider-level economics, fault counters, and capability tier.",
            "- `operators.csv`: final operator-level provider count, assignment share, success, and P&L metrics.",
            "- `slots.csv`: per-slot epoch ledger, including health state and reason.",
            "- `evidence.csv`: policy evidence events.",
            "- `repairs.csv`: repair start, pending-provider readiness, readiness timeout, completion, attempt-count, cooldown, candidate-exclusion, attempt-cap, and backoff events.",
            "- `economy.csv`: per-epoch market, elasticity overlay, staged upload, and accounting ledger.",
            "- `signals.json`: derived availability, saturation, repair, capacity, economic, elasticity overlay, staged upload, regional, concentration, and provider bottleneck signals.",
        ]
    )
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def build_behavior_narrative(
    totals: dict[str, Any],
    evidence: list[dict[str, str]],
    repairs: list[dict[str, str]],
    providers: list[dict[str, str]],
    economy: list[dict[str, str]],
) -> str:
    parts = []
    if fnum(totals.get("data_loss_events")) > 0:
        parts.append(
            f"The run recorded `{fmt_num(totals.get('data_loss_events'))}` modeled data-loss events. "
            "That is a durability failure and should block graduation even if some retrievals still succeeded."
        )
    if fnum(totals.get("success_rate")) >= 1.0:
        if evidence or repairs:
            parts.append(
                "User-facing retrieval availability stayed intact: every modeled retrieval completed successfully. "
                "That does not mean every provider behaved correctly; it means redundancy, routing, or deputy service absorbed the fault."
            )
        else:
            parts.append(
                "User-facing retrieval availability stayed intact and no operational enforcement evidence was recorded. "
                "For this run, the main question is the scenario-specific control or economic result rather than recovery from a provider fault."
            )
    else:
        parts.append(
            f"Availability was degraded: the run succeeded on `{fmt_pct(totals.get('success_rate'))}` of retrievals and recorded "
            f"`{fmt_num(totals.get('unavailable_reads'))}` unavailable reads."
        )
    if fnum(totals.get("expired_retrieval_attempts")) > 0:
        parts.append(
            f"Post-expiry retrieval behavior was exercised: `{fmt_num(totals.get('expired_retrieval_attempts'))}` requests arrived after all active deals had expired. "
            "The simulator counted them as explicit expired-content rejections, not live availability failures or billable retrieval attempts."
        )
    if fnum(totals.get("closed_retrieval_attempts")) > 0:
        parts.append(
            f"Post-close retrieval behavior was exercised: `{fmt_num(totals.get('closed_retrieval_attempts'))}` requests arrived after all active deals had been intentionally closed. "
            "The simulator counted them as explicit closed-content rejections, not live availability failures or billable retrieval attempts."
        )

    if evidence:
        class_counts = Counter(row.get("evidence_class") or "unknown" for row in evidence)
        known_classes = ["soft", "threshold", "hard", "economic", "market", "spam", "operational"]
        other_evidence = len(evidence) - sum(class_counts.get(name, 0) for name in known_classes)
        breakdown_parts = [f"`{class_counts.get(name, 0)}` {name}" for name in known_classes]
        if other_evidence:
            breakdown_parts.append(f"`{other_evidence}` other")
        parts.append(
            f"The policy layer recorded `{len(evidence)}` evidence events: {', '.join(breakdown_parts[:-1])}, "
            f"and {breakdown_parts[-1]} events. Soft and economic evidence are suitable for repair and reward exclusion; "
            "hard or convicted threshold evidence is the category that can later justify slashing or stronger sanctions."
        )
    else:
        parts.append("The policy layer recorded no evidence events, which is expected only for cooperative or pure-market control scenarios.")
    if fnum(totals.get("evidence_spam_claims")) > 0:
        parts.append(
            f"Deputy evidence spam was exercised: `{fmt_num(totals.get('evidence_spam_claims'))}` low-quality claims burned "
            f"`{fmt_money(totals.get('evidence_spam_bond_burned'))}` in bond and paid `{fmt_money(totals.get('evidence_spam_bounty_paid'))}` in bounties, "
            f"for spammer net gain `{fmt_money(totals.get('evidence_spam_net_gain'))}`."
        )
    if fnum(totals.get("new_deal_latent_requests")) > 0 or fnum(totals.get("new_deal_requests")) > 0:
        parts.append(
            f"Modeled write demand was exercised: `{fmt_num(totals.get('new_deal_latent_requests'))}` latent new deal requests became "
            f"`{fmt_num(totals.get('new_deal_requests'))}` effective requests after price elasticity, with "
            f"`{fmt_num(totals.get('new_deals_suppressed_price'))}` suppressed by price response. Effective requests produced "
            f"`{fmt_num(totals.get('new_deals_accepted'))}` accepted deals, "
            f"`{fmt_num(totals.get('new_deals_rejected_price'))}` price rejections, and "
            f"`{fmt_num(totals.get('new_deals_rejected_capacity'))}` capacity rejections. "
            f"The effective-request acceptance rate was `{fmt_pct(totals.get('new_deal_acceptance_rate'))}` and latent-demand acceptance was `{fmt_pct(totals.get('new_deal_latent_acceptance_rate'))}`."
        )
    if fnum(totals.get("storage_escrow_locked")) > 0:
        parts.append(
            f"Storage escrow lifecycle accounting was exercised: `{fmt_money(totals.get('storage_escrow_locked'))}` was locked for committed storage, "
            f"`{fmt_money(totals.get('storage_escrow_earned'))}` was earned over modeled service epochs, "
            f"`{fmt_money(totals.get('storage_escrow_refunded'))}` was refunded on close, and final outstanding storage escrow was "
            f"`{fmt_money(totals.get('storage_escrow_outstanding'))}`. Closed deals ended at "
            f"`{fmt_num(totals.get('final_closed_deals'))}`, expired deals ended at "
            f"`{fmt_num(totals.get('final_expired_deals'))}`, and open deals ended at `{fmt_num(totals.get('final_open_deals'))}`."
        )
    if fnum(totals.get("elasticity_overlay_activations")) > 0:
        parts.append(
            f"Elasticity overlay scaling was exercised: `{fmt_num(totals.get('elasticity_overlay_activations'))}` temporary overlay routes were activated, "
            f"`{fmt_num(totals.get('elasticity_overlay_serves'))}` overlay serves completed, and "
            f"`{fmt_num(totals.get('elasticity_overlay_expired'))}` routes expired by TTL. "
            f"Peak ready overlay routes were `{fmt_num(totals.get('max_elasticity_overlay_ready'))}` and peak active routes were "
            f"`{fmt_num(totals.get('max_elasticity_overlay_active'))}`."
        )
    if fnum(totals.get("staged_upload_attempts")) > 0:
        parts.append(
            f"Staged upload grief was exercised: `{fmt_num(totals.get('staged_upload_attempts'))}` provisional upload attempts produced "
            f"`{fmt_num(totals.get('staged_upload_rejections'))}` preflight rejections and "
            f"`{fmt_num(totals.get('staged_upload_cleaned'))}` retention cleanup events. Peak pending provisional state was "
            f"`{fmt_num(totals.get('max_staged_upload_pending_generations'))}` generations / "
            f"`{fmt_num(totals.get('max_staged_upload_pending_mdus'))}` MDUs, ending at "
            f"`{fmt_num(totals.get('final_staged_upload_pending_generations'))}` generations."
        )

    if repairs:
        started = sum(1 for row in repairs if row.get("event") == "repair_started")
        ready = sum(1 for row in repairs if row.get("event") == "repair_ready")
        completed = sum(1 for row in repairs if row.get("event") == "repair_completed")
        parts.append(
            f"Repair was exercised: `{started}` repair operations started, `{ready}` produced pending-provider readiness evidence, "
            f"and `{completed}` completed. The simulator models this as make-before-break reassignment, so the old assignment remains "
            "visible until replacement work catches up and the readiness gate is satisfied."
        )
    else:
        parts.append("No repair events occurred. For healthy or economic-only scenarios this is correct; for fault scenarios it may mean the policy is too passive.")

    if fnum(totals.get("reward_burned")) > 0:
        parts.append(
            f"Reward exclusion was active: `{fmt_money(totals.get('reward_burned'))}` modeled reward units were burned instead of paid to non-compliant slots."
        )
    if fnum(totals.get("provider_slashed")) > 0:
        parts.append(
            f"Simulated slashing was active: providers lost `{fmt_money(totals.get('provider_slashed'))}` bond units in aggregate."
        )
    if fnum(totals.get("saturated_responses")) > 0:
        parts.append(
            f"Provider bandwidth constraints mattered: the run recorded `{fmt_num(totals.get('saturated_responses'))}` saturated provider responses. "
            "That is a scale signal, not necessarily malicious behavior."
        )
    if fnum(totals.get("high_bandwidth_promotions")) > 0 or fnum(totals.get("hot_retrieval_attempts")) > 0:
        parts.append(
            f"High-bandwidth capability policy was exercised: `{fmt_num(totals.get('high_bandwidth_promotions'))}` providers were promoted, "
            f"`{fmt_num(totals.get('high_bandwidth_demotions'))}` were demoted, and hot retrievals received "
            f"`{fmt_num(totals.get('hot_high_bandwidth_serves'))}` serves from high-bandwidth providers."
        )
    if fnum(totals.get("platinum_serves")) or fnum(totals.get("gold_serves")) or fnum(totals.get("silver_serves")) or fnum(totals.get("fail_serves")):
        parts.append(
            f"Performance-market tiering was exercised: average modeled latency was `{fmt_num(totals.get('average_latency_ms'))}` ms, "
            f"with `{fmt_num(totals.get('platinum_serves'))}` Platinum, `{fmt_num(totals.get('gold_serves'))}` Gold, "
            f"`{fmt_num(totals.get('silver_serves'))}` Silver, and `{fmt_num(totals.get('fail_serves'))}` Fail serves. "
            f"Tiered performance rewards paid `{fmt_money(totals.get('performance_reward_paid'))}`."
        )
    if fnum(totals.get("top_operator_provider_count")) > 1 or fnum(totals.get("operator_deal_cap_violations")) > 0:
        parts.append(
            f"Operator concentration was measured across `{fmt_num(totals.get('operator_count'))}` operators. "
            f"The largest provider-share operator controlled `{fmt_bps(totals.get('top_operator_provider_share_bps'))}` of provider identities, while "
            f"the largest assignment-share operator ended with `{fmt_bps(totals.get('top_operator_assignment_share_bps'))}` of assigned slots. "
            f"The maximum same-operator slots in any deal was `{fmt_num(totals.get('max_operator_deal_slots'))}`."
        )
    if fnum(totals.get("repair_backoffs")) > 0:
        parts.append(
            f"Repair coordination was constrained: `{fmt_num(totals.get('repair_backoffs'))}` repair backoffs occurred across "
            f"`{fmt_num(totals.get('repair_attempts'))}` repair attempts. Cooldown backoffs accounted for "
            f"`{fmt_num(totals.get('repair_cooldowns'))}` events and attempt-cap backoffs accounted for "
            f"`{fmt_num(totals.get('repair_attempt_caps'))}` events. Pending-provider readiness timeouts accounted for "
            f"`{fmt_num(totals.get('repair_timeouts'))}` events."
        )
    if metric_sum(economy, "elasticity_rejections") > 0:
        parts.append(
            f"Elasticity spend failed closed: `{fmt_num(metric_sum(economy, 'elasticity_rejections'))}` expansion attempts were rejected rather than exceeding the cap."
        )
    if fnum(totals.get("audit_budget_backlog")) > 0:
        parts.append(
            f"Audit demand exceeded available budget: `{fmt_money(totals.get('audit_budget_backlog'))}` of unmet audit work remained after "
            f"`{fmt_num(totals.get('audit_budget_exhausted'))}` exhausted epochs."
        )

    faulty = [
        row
        for row in providers
        if fnum(row.get("offline_responses")) or fnum(row.get("withheld_responses")) or fnum(row.get("corrupt_responses")) or fnum(row.get("hard_faults"))
    ]
    if faulty:
        ids = ", ".join(row.get("provider_id", "") for row in faulty[:5])
        parts.append(f"The directly implicated provider set begins with: `{ids}`.")

    return "\n\n".join(parts)


def economic_assumption_lines(config: dict[str, Any]) -> list[str]:
    return [
        "The economic model is intentionally simple and deterministic. It is useful for comparing policy directions, not for setting final token economics without external market data.",
        "",
        "| Assumption | Value | Interpretation |",
        "|---|---:|---|",
        f"| Storage price | `{fmt_money(config.get('storage_price'))}` | Unitless price applied by the controller, demand-elasticity curve, and optional affordability gate. |",
        f"| Storage lock-in | enabled `{bool(config.get('storage_lockin_enabled'))}`, duration `{fmt_num(config.get('deal_duration_epochs'))}` epochs | If enabled, committed deals lock storage escrow upfront at the quoted storage price and earn it over the modeled duration. |",
        f"| Deal expiry | enabled `{bool(config.get('deal_expiry_enabled'))}` | If enabled, deals auto-expire once their modeled duration has fully earned. |",
        f"| Deal close/refund | epoch `{fmt_num(config.get('deal_close_epoch'))}`, count `{fmt_num(config.get('deal_close_count'))}`, share `{fmt_bps(config.get('deal_close_bps'))}` | Optional early close refunds unearned storage escrow and removes closed deals from active responsibility. |",
        f"| New deal requests/epoch | `{fmt_num(config.get('new_deal_requests_per_epoch'))}` | Latent modeled write demand before optional price elasticity suppression. Effective requests are accepted only when price and capacity gates pass. |",
        f"| Storage demand price ceiling | `{fmt_money(config.get('storage_demand_price_ceiling'))}` | If non-zero, new deal demand above this storage price is rejected as unaffordable. |",
        f"| Storage demand reference price | `{fmt_money(config.get('storage_demand_reference_price'))}` | If non-zero with elasticity enabled, demand scales around this price before hard affordability rejection. |",
        f"| Storage demand elasticity | `{fmt_bps(config.get('storage_demand_elasticity_bps'))}` | Demand multiplier change for a 100% price move relative to the reference price, clamped by configured min/max demand bps. |",
        f"| Storage target utilization | `{fmt_bps(config.get('storage_target_utilization_bps'))}` | If dynamic pricing is enabled, utilization above this target steps storage price up, otherwise down. |",
        f"| Retrieval price per slot | `{fmt_money(config.get('retrieval_price_per_slot'))}` | Paid per successful provider slot served, before the configured variable burn. |",
        f"| Retrieval target per epoch | `{fmt_num(config.get('retrieval_target_per_epoch'))}` | If dynamic pricing is enabled, retrieval attempts above this target step retrieval price up, otherwise down. |",
        f"| Retrieval demand shocks | `{json.dumps(config.get('retrieval_demand_shocks') or [])}` | Optional epoch-scoped retrieval demand multipliers used to test price shock response and oscillation. |",
        f"| Sponsored retrieval share | `{fmt_bps(config.get('sponsored_retrieval_bps'))}` | Share of retrieval attempts paid by requester/sponsor session funds instead of owner deal escrow. |",
        f"| Owner retrieval escrow debit | `{fmt_bps(config.get('owner_retrieval_debit_bps'))}` | Share of non-sponsored retrieval base and variable cost debited to owner escrow in scenarios that explicitly model owner-paid reads. |",
        f"| Dynamic pricing max step | `{fmt_bps(config.get('dynamic_pricing_max_step_bps'))}` | Per-epoch controller movement cap. Lower values are safer but slower to equilibrate. |",
        f"| Base reward per slot | `{fmt_money(config.get('base_reward_per_slot'))}` | Modeled issuance/subsidy paid only to reward-eligible active slots. |",
        f"| Provider storage cost/slot/epoch | `{fmt_money(config.get('provider_storage_cost_per_slot_epoch'))}` | Simplified provider cost basis; jitter may create marginal-provider distress. |",
        f"| Provider bandwidth cost/retrieval | `{fmt_money(config.get('provider_bandwidth_cost_per_retrieval'))}` | Simplified egress cost basis for retrieval-heavy scenarios. |",
        f"| Provider initial/min bond | `{fmt_money(config.get('provider_initial_bond'))}` / `{fmt_money(config.get('provider_min_bond'))}` | Simplified collateral model. Providers below the required bond are excluded from new responsibility and can trigger repair. |",
        f"| Provider bond per assigned slot | `{fmt_money(config.get('provider_bond_per_slot'))}` | Additional modeled collateral required for each assigned storage slot. |",
        f"| Provider cost shocks | `{json.dumps(config.get('provider_cost_shocks') or [])}` | Optional epoch-scoped fixed/storage/bandwidth cost multipliers used to model sudden operator cost pressure. |",
        f"| Provider churn policy | enabled `{bool(config.get('provider_churn_enabled'))}`, threshold `{fmt_money(config.get('provider_churn_pnl_threshold'))}`, after `{fmt_num(config.get('provider_churn_after_epochs'))}` epochs, cap `{fmt_num(config.get('provider_churn_max_providers_per_epoch'))}`/epoch | Converts sustained negative economics into draining exits; cap `0` means unbounded by this policy. |",
        f"| Provider churn floor | `{fmt_num(config.get('provider_churn_min_remaining_providers'))}` providers | Prevents an economic shock fixture from exiting the entire active set unless intentionally configured. |",
        f"| Provider supply entry | enabled `{bool(config.get('provider_entry_enabled'))}`, reserve `{fmt_num(config.get('provider_entry_reserve_count'))}`, cap `{fmt_num(config.get('provider_entry_max_per_epoch'))}`/epoch, probation `{fmt_num(config.get('provider_entry_probation_epochs'))}` epochs | Moves reserve providers through probation before they become assignment-eligible active supply. |",
        f"| Supply entry triggers | utilization >= `{fmt_bps(config.get('provider_entry_trigger_utilization_bps'))}` or storage price >= `{fmt_optional_money_threshold(config.get('provider_entry_trigger_storage_price'))}` | If both are zero, configured reserve supply enters as soon as the epoch window opens. |",
        f"| Performance reward per serve | `{fmt_money(config.get('performance_reward_per_serve'))}` | Optional tiered QoS reward. Multipliers are applied by latency tier and Fail tier receives the configured fail multiplier. |",
        f"| Elasticity trigger/spend | `{fmt_num(config.get('elasticity_trigger_retrievals_per_epoch'))}` retrievals/epoch / `{fmt_money(config.get('elasticity_max_spend'))}` cap | User-funded overflow spending starts only after the configured demand trigger and must stay inside the spend cap. |",
        f"| Elasticity overlay policy | enabled `{bool(config.get('elasticity_overlay_enabled'))}`, `{fmt_num(config.get('elasticity_overlay_providers_per_epoch'))}` providers/epoch, max `{fmt_num(config.get('elasticity_overlay_max_providers_per_deal'))}`/deal | Temporary overlay routes expand retrieval options without becoming durable base slots. |",
        f"| Elasticity overlay timing | ready delay `{fmt_num(config.get('elasticity_overlay_ready_delay_epochs'))}` epochs, TTL `{fmt_num(config.get('elasticity_overlay_ttl_epochs'))}` epochs | Models catch-up/readiness delay and scale-down expiration for overflow routes. |",
        f"| Staged upload attempts/epoch | `{fmt_num(config.get('staged_upload_attempts_per_epoch'))}` | Provisional generations that consume local provider-daemon staging space before content commit. |",
        f"| Staged upload commit rate | `{fmt_bps(config.get('staged_upload_commit_rate_bps'))}` | Share of provisional uploads that become committed content instead of remaining abandoned local state. |",
        f"| Staged upload retention/cap | `{fmt_num(config.get('staged_upload_retention_epochs'))}` epochs / `{fmt_num(config.get('staged_upload_max_pending_generations'))}` generations | Local cleanup and preflight limits used to bound abandoned provisional-generation storage pressure. |",
        f"| Audit budget per epoch | `{fmt_money(config.get('audit_budget_per_epoch'))}` | Minted audit budget; spending is capped by available budget and unmet miss-driven demand carries forward as backlog. |",
        f"| Evidence spam claims/epoch | `{fmt_num(config.get('evidence_spam_claims_per_epoch'))}` | Synthetic low-quality deputy claims used to test bond burn and bounty gating economics. |",
        f"| Evidence bond / bounty | `{fmt_money(config.get('evidence_spam_bond'))}` / `{fmt_money(config.get('evidence_spam_bounty'))}` | Spam claims burn bond unless convicted; bounty is paid only on convicted evidence. |",
        f"| Retrieval burn | `{fmt_bps(config.get('retrieval_burn_bps'))}` | Fraction of variable retrieval fees burned before provider payout. |",
    ]


def diagnostic_signal_lines(signals: dict[str, Any]) -> list[str]:
    availability = signals["availability"]
    saturation = signals["saturation"]
    repair = signals["repair"]
    capacity = signals["capacity"]
    economics = signals["economics"]
    high_bandwidth = signals["high_bandwidth"]
    performance = signals["performance"]
    demand = signals["demand"]
    staged = signals["staged_uploads"]
    concentration = signals["concentration"]
    return [
        "| Signal | Value | Why It Matters |",
        "|---|---:|---|",
        f"| Worst epoch success | `{fmt_pct(availability['worst_epoch_success_rate'])}` at epoch `{availability['worst_epoch']}` | Identifies the availability cliff instead of hiding it in aggregate success. |",
        f"| Unavailable reads | `{fmt_num(availability['unavailable_reads'])}` | Temporary read failures are a scale/reliability signal; they are not automatically permanent data loss. |",
        f"| Expired retrieval rejections | `{fmt_num(availability['expired_retrieval_attempts'])}` | Post-expiry requests should be rejected explicitly instead of counted as live availability failures or billable retrievals. |",
        f"| Closed retrieval rejections | `{fmt_num(availability['closed_retrieval_attempts'])}` | Post-close requests should be rejected explicitly instead of counted as live availability failures or billable retrievals. |",
        f"| Modeled data-loss events | `{fmt_num(availability['data_loss_events'])}` | Durability-loss signal. This should remain zero for current scale fixtures. |",
        f"| Degraded epochs | `{fmt_num(availability['degraded_epochs'])}` | Counts epochs with unavailable reads or success below 99.9%. |",
        f"| Recovery epoch after worst | `{availability['recovery_epoch_after_worst'] or 'not recovered'}` | Shows whether the network returned to clean steady state after the worst point. |",
        f"| Saturation rate | `{fmt_pct(saturation['saturation_per_retrieval_attempt'])}` | Provider bandwidth saturation per retrieval attempt. |",
        f"| Peak saturation | `{fmt_num(saturation['peak_saturated_responses'])}` at epoch `{saturation['peak_saturation_epoch']}` | Reveals when bandwidth, not storage correctness, became the bottleneck. |",
        f"| Repair readiness ratio | `{fmt_pct(repair['readiness_ratio'])}` | Measures whether pending providers catch up before promotion. |",
        f"| Repair completion ratio | `{fmt_pct(repair['completion_ratio'])}` | Measures whether healing catches up with detection. |",
        f"| Repair attempts | `{fmt_num(repair['attempts'])}` | Counts bounded attempts to open a repair or discover replacement pressure. |",
        f"| Repair backoff pressure | `{fmt_num(repair['backoffs_per_started_repair'])}` backoffs per started repair | Shows whether repair coordination is saturated. |",
        f"| Repair backoffs per attempt | `{fmt_num(repair['backoffs_per_attempt'])}` | Distinguishes capacity/cooldown pressure from successful repair starts. |",
        f"| Repair cooldowns / attempt caps / readiness timeouts | `{fmt_num(repair['cooldowns'])}` / `{fmt_num(repair['attempt_caps'])}` / `{fmt_num(repair['repair_timeouts'])}` | Shows whether throttling, rather than candidate selection alone, is bounding repair churn. |",
        f"| Suspect / delinquent slot-epochs | `{fmt_num(repair['suspect_slot_epochs'])}` / `{fmt_num(repair['delinquent_slot_epochs'])}` | Separates early warning state from threshold-crossed delinquency. |",
        f"| Final repair backlog | `{fmt_num(repair['final_repair_backlog'])}` slots | Started repairs minus completed or timed-out repairs at run end. |",
        f"| High-bandwidth providers | `{fmt_num(high_bandwidth['providers'])}` | Providers currently eligible for hot/high-bandwidth routing. |",
        f"| High-bandwidth promotions/demotions | `{fmt_num(high_bandwidth['promotions'])}` / `{fmt_num(high_bandwidth['demotions'])}` | Shows capability changes under measured demand. |",
        f"| Hot high-bandwidth serves/retrieval | `{fmt_num(high_bandwidth['hot_high_bandwidth_serves_per_hot_retrieval'])}` | Measures whether hot retrievals actually use promoted providers. |",
        f"| Avg latency / Fail tier rate | `{fmt_num(performance['average_latency_ms'])}` ms / `{fmt_pct(performance['performance_fail_rate'])}` | Separates correctness from QoS: slow-but-valid service can be available while still earning lower or no performance rewards. |",
        f"| Platinum / Gold / Silver / Fail serves | `{fmt_num(performance['platinum_serves'])}` / `{fmt_num(performance['gold_serves'])}` / `{fmt_num(performance['silver_serves'])}` / `{fmt_num(performance['fail_serves'])}` | Shows the latency-tier distribution for performance-market policy. |",
        f"| Performance reward paid | `{fmt_money(performance['performance_reward_paid'])}` | Quantifies the tiered QoS reward stream separately from baseline storage and retrieval settlement. |",
        f"| Provider latency p10 / p50 / p90 | `{fmt_num(performance['provider_latency_p10_ms'])}` / `{fmt_num(performance['provider_latency_p50_ms'])}` / `{fmt_num(performance['provider_latency_p90_ms'])}` ms | Shows whether aggregate averages hide slow provider tails. |",
        f"| New deal latent/effective demand | `{fmt_num(demand['new_deal_latent_requests'])}` / `{fmt_num(demand['new_deal_requests'])}` | Shows how much modeled write demand survived the price-elasticity curve. |",
        f"| New deal demand accepted/rejected/suppressed | `{fmt_num(demand['new_deals_accepted'])}` / `{fmt_num(demand['new_deals_rejected_price'] + demand['new_deals_rejected_capacity'])}` / `{fmt_num(demand['new_deals_suppressed_price'])}` | Shows whether modeled write demand is entering the network, blocked by price/capacity, or never arriving because quotes are unattractive. |",
        f"| New deal effective/latent acceptance | `{fmt_pct(demand['new_deal_acceptance_rate'])}` / `{fmt_pct(demand['new_deal_latent_acceptance_rate'])}` | Demand-side market health signal; a technically available network can still fail if users cannot afford storage. |",
        f"| Staged upload attempts/accepted/committed | `{fmt_num(staged['attempts'])}` / `{fmt_num(staged['accepted'])}` / `{fmt_num(staged['committed'])}` | Shows provisional upload pressure separately from committed storage demand. |",
        f"| Staged upload rejections/cleaned | `{fmt_num(staged['rejections'])}` / `{fmt_num(staged['cleaned'])}` | Preflight rejection and retention cleanup should bound abandoned provisional generations. |",
        f"| Staged pending generations/MDUs peak | `{fmt_num(staged['max_pending_generations'])}` / `{fmt_num(staged['max_pending_mdus'])}` | Detects whether local staged storage pressure exceeded configured caps. |",
        f"| Elasticity spend / rejections | `{fmt_money(economics['elasticity_spent'])}` / `{fmt_num(economics['elasticity_rejections'])}` | Shows whether user-funded overflow expansion stayed inside the spend window. |",
        f"| Elasticity overlays activated/served/expired | `{fmt_num(economics['elasticity_overlay_activations'])}` / `{fmt_num(economics['elasticity_overlay_serves'])}` / `{fmt_num(economics['elasticity_overlay_expired'])}` | Confirms temporary overflow routes are created, actually used, and later removed. |",
        f"| Elasticity overlay ready/active peak | `{fmt_num(economics['max_elasticity_overlay_ready'])}` / `{fmt_num(economics['max_elasticity_overlay_active'])}` | Shows catch-up/readiness lag and total temporary routing footprint. |",
        f"| Sponsored retrieval attempts/spend | `{fmt_num(economics['sponsored_retrieval_attempts'])}` / `{fmt_money(economics['sponsored_retrieval_spent'])}` | Shows public or requester-funded demand separately from owner-funded deal escrow. |",
        f"| Owner-funded attempts / owner escrow debit | `{fmt_num(economics['owner_funded_retrieval_attempts'])}` / `{fmt_money(economics['owner_retrieval_escrow_debited'])}` | Detects whether public demand is unexpectedly draining the deal owner's escrow. |",
        f"| Wash accounted spend / net gain | `{fmt_money(economics['retrieval_wash_accounted_spend'])}` / `{fmt_money(economics['retrieval_wash_net_gain'])}` | Worst-case colluding requester/provider economics after explicit base, sponsor, and owner-funded variable spend. |",
        f"| Storage escrow locked/earned/refunded | `{fmt_money(economics['storage_escrow_locked'])}` / `{fmt_money(economics['storage_escrow_earned'])}` / `{fmt_money(economics['storage_escrow_refunded'])}` | Shows quote-to-lock, provider earning, and close/refund accounting for committed storage. |",
        f"| Storage escrow outstanding | `{fmt_money(economics['storage_escrow_outstanding'])}` final; peak `{fmt_money(economics['max_storage_escrow_outstanding'])}` | Detects funds left locked after close/expiry semantics should have released them. |",
        f"| Storage fee provider payout/burned | `{fmt_money(economics['storage_fee_provider_payouts'])}` / `{fmt_money(economics['storage_fee_burned'])}` | Separates earned storage fees paid to eligible providers from fees withheld from non-compliant responsibility. |",
        f"| Deals open/closed/expired | `{fmt_num(economics['final_open_deals'])}` / `{fmt_num(economics['final_closed_deals'])}` / `{fmt_num(economics['final_expired_deals'])}` | Confirms close/refund/expiry semantics remove deals from active responsibility instead of continuing to accrue rewards. |",
        f"| Audit demand / spent | `{fmt_money(economics['audit_budget_demand'])}` / `{fmt_money(economics['audit_budget_spent'])}` | Shows whether enforcement evidence consumed the available audit budget. |",
        f"| Audit backlog / exhausted epochs | `{fmt_money(economics['audit_budget_backlog'])}` / `{fmt_num(economics['audit_budget_exhausted_epochs'])}` | Makes budget exhaustion explicit instead of hiding unmet audit work behind capped spending. |",
        f"| Evidence spam claims / convictions | `{fmt_num(economics['evidence_spam_claims'])}` / `{fmt_num(economics['evidence_spam_convictions'])}` | Shows whether the evidence-market spam fixture exercised low-quality claims and any successful convictions. |",
        f"| Evidence spam bond / net gain | `{fmt_money(economics['evidence_spam_bond_burned'])}` / `{fmt_money(economics['evidence_spam_net_gain'])}` | Spam should be negative-EV unless conviction-gated bounties justify the claim volume. |",
        f"| Top operator provider share | `{fmt_bps(concentration['top_operator_provider_share_bps'])}` | Shows whether many SP identities are controlled by one operator. |",
        f"| Top operator assignment share | `{fmt_bps(concentration['top_operator_assignment_share_bps'])}` | Shows whether placement caps translate identity concentration into slot concentration. |",
        f"| Max operator slots/deal | `{fmt_num(concentration['max_operator_deal_slots'])}` | Checks per-deal blast-radius limits against operator Sybil concentration. |",
        f"| Operator cap violations | `{fmt_num(concentration['operator_deal_cap_violations'])}` | Counts deals where operator slot concentration exceeded the configured cap. |",
        f"| Final storage utilization | `{fmt_bps(capacity['final_utilization_bps'])}` | Active slots versus modeled provider capacity. |",
        f"| Provider utilization p50 / p90 / max | `{fmt_bps(capacity['provider_capacity_utilization_p50_bps'])}` / `{fmt_bps(capacity['provider_capacity_utilization_p90_bps'])}` / `{fmt_bps(capacity['provider_capacity_utilization_max_bps'])}` | Detects assignment concentration and capacity cliffs. |",
        f"| Provider P&L p10 / p50 / p90 | `{fmt_money(economics['provider_pnl_p10'])}` / `{fmt_money(economics['provider_pnl_p50'])}` / `{fmt_money(economics['provider_pnl_p90'])}` | Shows whether aggregate P&L hides marginal-provider distress. |",
        f"| Provider cost shock epochs/providers | `{fmt_num(economics['provider_cost_shock_epochs'])}` / `{fmt_num(economics['max_provider_cost_shocked_providers'])}` | Shows when external cost pressure was active and how much of the provider population it affected. |",
        f"| Max cost shock fixed/storage/bandwidth | `{fmt_bps(economics['max_provider_cost_shock_fixed_multiplier_bps'])}` / `{fmt_bps(economics['max_provider_cost_shock_storage_multiplier_bps'])}` / `{fmt_bps(economics['max_provider_cost_shock_bandwidth_multiplier_bps'])}` | Distinguishes fixed-cost, storage-cost, and egress-cost shocks. |",
        f"| Provider churn events / final churned | `{fmt_num(economics['provider_churn_events'])}` / `{fmt_num(economics['churned_providers'])}` | Shows whether sustained economic distress became modeled provider exits rather than only a warning label. |",
        f"| Provider entries / probation promotions | `{fmt_num(economics['provider_entries'])}` / `{fmt_num(economics['provider_probation_promotions'])}` | Shows whether reserve supply entered and cleared readiness gating before receiving normal placement. |",
        f"| Reserve / probationary / entered-active providers | `{fmt_num(capacity['reserve_providers'])}` / `{fmt_num(capacity['probationary_providers'])}` / `{fmt_num(capacity['entered_active_providers'])}` | Separates unused reserve supply, in-flight onboarding, and newly promoted active supply. |",
        f"| Underbonded repairs / peak underbonded providers | `{fmt_num(economics['provider_underbonded_repairs'])}` / `{fmt_num(economics['max_underbonded_providers'])}` | Shows whether insufficient provider collateral became placement/repair pressure. |",
        f"| Final underbonded assigned slots / bond deficit | `{fmt_num(economics['final_underbonded_assigned_slots'])}` / `{fmt_money(economics['final_provider_bond_deficit'])}` | Checks whether repair removed responsibility from undercollateralized providers by run end. |",
        f"| Churn pressure provider-epochs / peak | `{fmt_num(economics['churn_pressure_provider_epochs'])}` / `{fmt_num(economics['max_churn_pressure_providers'])}` | Shows the breadth and duration of providers below the configured churn threshold. |",
        f"| Active / exited / reserve provider capacity | `{fmt_num(economics['final_active_provider_capacity'])}` / `{fmt_num(economics['final_exited_provider_capacity'])}` / `{fmt_num(capacity['final_reserve_provider_capacity'])}` slots | Measures supply remaining, removed, and still waiting outside normal placement. |",
        f"| Peak assigned slots on churned providers | `{fmt_num(economics['max_churned_assigned_slots'])}` | Shows the maximum repair burden created by economic exits. |",
        f"| Storage price start/end/range | `{fmt_money(economics['storage_price_start'])}` -> `{fmt_money(economics['storage_price_end'])}` (`{fmt_money(economics['storage_price_min'])}`-`{fmt_money(economics['storage_price_max'])}`) | Shows dynamic pricing movement and bounds. |",
        f"| Retrieval price start/end/range | `{fmt_money(economics['retrieval_price_start'])}` -> `{fmt_money(economics['retrieval_price_end'])}` (`{fmt_money(economics['retrieval_price_min'])}`-`{fmt_money(economics['retrieval_price_max'])}`) | Shows whether demand pressure moved retrieval pricing. |",
        f"| Retrieval latent/effective attempts | `{fmt_num(economics['retrieval_latent_attempts'])}` / `{fmt_num(economics['retrieval_attempts'])}` | Shows how much retrieval load was added by demand-shock multipliers. |",
        f"| Retrieval demand shock epochs/multiplier | `{fmt_num(economics['retrieval_demand_shock_epochs'])}` / `{fmt_bps(economics['max_retrieval_demand_multiplier_bps'])}` | Shows the size and duration of the modeled read-demand shock. |",
        f"| Price direction changes storage/retrieval | `{fmt_num(economics['storage_price_direction_changes'])}` / `{fmt_num(economics['retrieval_price_direction_changes'])}` | Detects controller oscillation rather than relying on visual inspection. |",
    ]


def regional_signal_lines(signals: dict[str, Any]) -> list[str]:
    regions = signals.get("regions", [])
    if not regions:
        return ["- No regional provider metadata was recorded."]
    lines = [
        "| Region | Providers | Utilization | Offline Responses | Saturated Responses | Negative P&L Providers | Avg P&L |",
        "|---|---:|---:|---:|---:|---:|---:|",
    ]
    for row in regions:
        lines.append(
            f"| `{row['region']}` | {fmt_num(row['providers'])} | {fmt_bps(row['utilization_bps'])} | "
            f"{fmt_num(row['offline_responses'])} | {fmt_num(row['saturated_responses'])} | "
            f"{fmt_num(row['negative_pnl_providers'])} | {fmt_money(row['avg_provider_pnl'])} |"
        )
    return lines


def bottleneck_provider_lines(signals: dict[str, Any]) -> list[str]:
    providers = signals.get("top_bottleneck_providers", [])
    if not providers:
        return ["- No provider bottleneck rows were recorded."]
    lines = [
        "| Provider | Region | Slots/Capacity | Utilization | Bandwidth Cap | Attempts | Offline | Saturated | P&L |",
        "|---|---|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for row in providers:
        lines.append(
            f"| `{row['provider_id']}` | `{row['region']}` | {fmt_num(row['assigned_slots'])}/{fmt_num(row['capacity_slots'])} | "
            f"{fmt_bps(row['capacity_utilization_bps'])} | {fmt_num(row['bandwidth_capacity_per_epoch'])} | "
            f"{fmt_num(row['retrieval_attempts'])} | {fmt_num(row['offline_responses'])} | "
            f"{fmt_num(row['saturated_responses'])} | {fmt_money(row['pnl'])} |"
        )
    return lines


def top_operator_lines(signals: dict[str, Any]) -> list[str]:
    operators = signals.get("top_operators", [])
    if not operators:
        return ["- No operator rows were recorded."]
    lines = [
        "| Operator | Providers | Provider Share | Assigned Slots | Assignment Share | Retrieval Attempts | Success | P&L |",
        "|---|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for row in operators:
        lines.append(
            f"| `{row['operator_id']}` | {fmt_num(row['provider_count'])} | {fmt_bps(row['provider_share_bps'])} | "
            f"{fmt_num(row['assigned_slots'])} | {fmt_bps(row['assignment_share_bps'])} | "
            f"{fmt_num(row['retrieval_attempts'])} | {fmt_pct(row['success_rate'])} | {fmt_money(row['pnl'])} |"
        )
    return lines


def build_timeline_rows(epochs: list[dict[str, str]]) -> list[str]:
    rows = []
    for row in epochs:
        evidence_count = (
            fnum(row.get("quota_misses"))
            + fnum(row.get("deputy_misses"))
            + fnum(row.get("invalid_proofs"))
            + fnum(row.get("withheld_responses"))
            + fnum(row.get("offline_responses"))
            + fnum(row.get("corrupt_responses"))
            + fnum(row.get("saturated_responses"))
            + fnum(row.get("evidence_spam_claims"))
            + fnum(row.get("new_deals_suppressed_price"))
            + fnum(row.get("new_deals_rejected_price"))
            + fnum(row.get("new_deals_rejected_capacity"))
            + fnum(row.get("elasticity_overlay_activations"))
            + fnum(row.get("elasticity_overlay_rejections"))
            + fnum(row.get("staged_upload_rejections"))
            + fnum(row.get("staged_upload_cleaned"))
        )
        notes = []
        if fnum(row.get("offline_responses")):
            notes.append(f"{fmt_num(row.get('offline_responses'))} offline responses")
        if fnum(row.get("withheld_responses")):
            notes.append(f"{fmt_num(row.get('withheld_responses'))} withheld")
        if fnum(row.get("invalid_proofs")):
            notes.append(f"{fmt_num(row.get('invalid_proofs'))} invalid proofs")
        if fnum(row.get("saturated_responses")):
            notes.append(f"{fmt_num(row.get('saturated_responses'))} saturated")
        if fnum(row.get("quota_misses")):
            notes.append(f"{fmt_num(row.get('quota_misses'))} quota misses")
        if fnum(row.get("evidence_spam_claims")):
            notes.append(f"{fmt_num(row.get('evidence_spam_claims'))} evidence spam claims")
        if fnum(row.get("new_deals_accepted")):
            notes.append(f"{fmt_num(row.get('new_deals_accepted'))} new deals accepted")
        if fnum(row.get("new_deals_suppressed_price")):
            notes.append(f"{fmt_num(row.get('new_deals_suppressed_price'))} price-suppressed deals")
        if fnum(row.get("new_deals_rejected_price")):
            notes.append(f"{fmt_num(row.get('new_deals_rejected_price'))} price-rejected deals")
        if fnum(row.get("new_deals_rejected_capacity")):
            notes.append(f"{fmt_num(row.get('new_deals_rejected_capacity'))} capacity-rejected deals")
        if fnum(row.get("elasticity_overlay_activations")):
            notes.append(f"{fmt_num(row.get('elasticity_overlay_activations'))} overlay routes activated")
        if fnum(row.get("elasticity_overlay_serves")):
            notes.append(f"{fmt_num(row.get('elasticity_overlay_serves'))} overlay serves")
        if fnum(row.get("elasticity_overlay_expired")):
            notes.append(f"{fmt_num(row.get('elasticity_overlay_expired'))} overlay routes expired")
        if fnum(row.get("elasticity_overlay_rejections")):
            notes.append(f"{fmt_num(row.get('elasticity_overlay_rejections'))} overlay expansion rejections")
        if fnum(row.get("staged_upload_rejections")):
            notes.append(f"{fmt_num(row.get('staged_upload_rejections'))} staged preflight rejections")
        if fnum(row.get("staged_upload_cleaned")):
            notes.append(f"{fmt_num(row.get('staged_upload_cleaned'))} staged generations cleaned")
        if fnum(row.get("repair_backoffs")):
            notes.append(f"{fmt_num(row.get('repair_backoffs'))} repair backoffs")
        if fnum(row.get("repair_cooldowns")):
            notes.append(f"{fmt_num(row.get('repair_cooldowns'))} repair cooldowns")
        if fnum(row.get("repair_attempt_caps")):
            notes.append(f"{fmt_num(row.get('repair_attempt_caps'))} attempt caps")
        if fnum(row.get("repair_timeouts")):
            notes.append(f"{fmt_num(row.get('repair_timeouts'))} repair timeouts")
        if fnum(row.get("data_loss_events")):
            notes.append(f"{fmt_num(row.get('data_loss_events'))} data-loss events")
        if fnum(row.get("repairing_slots")):
            notes.append(f"{fmt_num(row.get('repairing_slots'))} slots repairing")
        if fnum(row.get("suspect_slots")):
            notes.append(f"{fmt_num(row.get('suspect_slots'))} suspect slots")
        if fnum(row.get("delinquent_slots")):
            notes.append(f"{fmt_num(row.get('delinquent_slots'))} delinquent slots")
        if not notes:
            notes.append("steady state")
        rows.append(
            "| {epoch} | {success} | {evidence} | {started} | {ready} | {completed} | {burned} | {pnl} | {notes} |".format(
                epoch=row.get("epoch", ""),
                success=fmt_pct(safe_rate(row, "retrieval_successes", "retrieval_attempts")),
                evidence=fmt_num(evidence_count),
                started=fmt_num(row.get("repairs_started")),
                ready=fmt_num(row.get("repairs_ready")),
                completed=fmt_num(row.get("repairs_completed")),
                burned=fmt_money(row.get("reward_burned")),
                pnl=fmt_money(row.get("provider_pnl")),
                notes=", ".join(notes),
            )
        )
    return rows or ["| n/a | n/a | n/a | n/a | n/a | n/a | n/a | no epoch rows |"]


def counter_lines(counter: Counter[str]) -> list[str]:
    if not counter:
        return ["- None recorded."]
    return [f"- `{key}`: `{value}`" for key, value in counter.most_common(8)]


def candidate_exclusion_lines(repairs: list[dict[str, str]]) -> list[str]:
    rows = [row for row in repairs if row.get("reason") == "no_candidate"]
    if not rows:
        return ["- No no-candidate repair backoffs were recorded."]
    fields = [
        ("eligible_candidates", "Eligible candidates"),
        ("excluded_current_deal", "Excluded current deal providers"),
        ("excluded_current_provider", "Excluded current provider"),
        ("excluded_bond_headroom", "Excluded providers lacking bond headroom"),
        ("excluded_draining", "Excluded draining providers"),
        ("excluded_jailed", "Excluded jailed providers"),
        ("excluded_capacity", "Excluded capacity-bound providers"),
    ]
    lines = [
        "| Candidate Mode | No-Candidate Events | Eligible | Current Deal | Current Provider | Bond Headroom | Draining | Jailed | Capacity-Bound |",
        "|---|---:|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for mode in sorted({row.get("candidate_mode", "") or "unknown" for row in rows}):
        mode_rows = [row for row in rows if (row.get("candidate_mode", "") or "unknown") == mode]
        sums = {key: sum(fnum(row.get(key)) for row in mode_rows) for key, _ in fields}
        sums["excluded_bond_headroom"] += sum(fnum(row.get("excluded_underbonded")) for row in mode_rows)
        lines.append(
            f"| `{mode}` | {len(mode_rows)} | {fmt_num(sums['eligible_candidates'])} | "
            f"{fmt_num(sums['excluded_current_deal'])} | {fmt_num(sums['excluded_current_provider'])} | "
            f"{fmt_num(sums['excluded_bond_headroom'])} | "
            f"{fmt_num(sums['excluded_draining'])} | {fmt_num(sums['excluded_jailed'])} | "
            f"{fmt_num(sums['excluded_capacity'])} |"
        )
    return lines


def repair_excerpt_lines(repairs: list[dict[str, str]]) -> list[str]:
    if not repairs:
        return ["- No repair ledger events were recorded."]
    lines = [
        "| Epoch | Event | Deal | Slot | Old Provider | New Provider | Reason | Attempt | Cooldown Until |",
        "|---:|---|---:|---:|---|---|---|---:|---:|",
    ]
    for row in repairs[:12]:
        lines.append(
            f"| {row.get('epoch', '')} | `{row.get('event', '')}` | {row.get('deal_id', '')} | {row.get('slot', '')} | "
            f"`{row.get('old_provider', '')}` | `{row.get('new_provider', '')}` | `{row.get('reason', '')}` | "
            f"{row.get('attempt', '')} | {row.get('cooldown_until_epoch', '')} |"
        )
    if len(repairs) > 12:
        lines.append(f"| ... | ... | ... | ... | ... | ... | `{len(repairs) - 12}` more events omitted | ... | ... |")
    return lines


def provider_lines(providers: list[dict[str, str]]) -> list[str]:
    if not providers:
        return ["| n/a | n/a | n/a | n/a | n/a | n/a | n/a |"]
    return [
        "| {provider} | {slots} | {revenue} | {cost} | {slashed} | {pnl} | {risk} |".format(
            provider=f"`{row.get('provider_id', '')}`",
            slots=fmt_num(row.get("assigned_slots")),
            revenue=fmt_money(row.get("reward_revenue")) + " + " + fmt_money(row.get("retrieval_revenue")),
            cost=fmt_money(row.get("total_cost")),
            slashed=fmt_money(row.get("slashed")),
            pnl=fmt_money(row.get("pnl")),
            risk="yes" if fnum(row.get("churn_risk")) else "no",
        )
        for row in providers
    ]


def assertion_meaning(name: str) -> str:
    meanings = {
        "min_success_rate": "Availability floor: user-facing reads must stay above this success rate.",
        "max_success_rate": "Control bound: used when the scenario is not intended to prove availability loss.",
        "max_data_loss_events": "Durability invariant: stress may allow unavailable reads, but modeled data loss must stay at zero.",
        "max_unavailable_reads": "Availability invariant: live retrievals should not fail outside explicit stress contracts.",
        "min_expired_retrieval_attempts": "Post-expiry behavior: expired content requests must be counted separately from live availability failures.",
        "min_closed_retrieval_attempts": "Post-close behavior: intentionally closed content requests must be counted separately from live availability failures.",
        "max_repairs_started": "No-repair invariant for healthy baseline runs.",
        "min_repairs_started": "Repair liveness: policy must start reassignment when evidence warrants it.",
        "min_repairs_ready": "Repair readiness: pending providers must produce catch-up evidence before promotion.",
        "min_repairs_completed": "Repair completion: make-before-break reassignment must finish within the run.",
        "min_repair_attempts": "Repair attempt accounting: constrained fixtures must visibly attempt repair before backing off.",
        "max_repair_attempts": "Repair attempt ceiling: repair retry loops must remain bounded.",
        "min_repair_cooldowns": "Repair cooldown accounting: repeated retry pressure must be throttled and visible.",
        "max_repair_cooldowns": "Repair cooldown ceiling: cooldown throttling must not dominate healthy recovery.",
        "min_repair_attempt_caps": "Repair attempt-cap accounting: bounded retry fixtures must hit and report the cap.",
        "max_repair_attempt_caps": "Repair attempt-cap ceiling: healthy repair paths should not exhaust attempts.",
        "min_repair_timeouts": "Repair readiness timeout accounting: pending providers that fail catch-up must time out visibly.",
        "max_repair_timeouts": "Repair readiness timeout ceiling: healthy repair paths should not strand pending providers.",
        "min_high_bandwidth_promotions": "Capability promotion: measured fast providers should become high-bandwidth eligible.",
        "max_high_bandwidth_promotions": "Capability promotion ceiling: healthy baselines should not accidentally promote providers.",
        "min_high_bandwidth_providers": "Final high-bandwidth provider count should be non-zero in promotion fixtures.",
        "max_high_bandwidth_demotions": "Promotion fixture should not immediately demote providers unless regression is modeled.",
        "min_hot_retrieval_attempts": "Hot-service fixture must exercise hot retrieval demand.",
        "min_hot_high_bandwidth_serves": "Hot-service routing must use promoted high-bandwidth providers.",
        "min_platinum_serves": "Performance market must exercise the fastest service tier.",
        "min_gold_serves": "Performance market must exercise the middle positive service tier.",
        "min_silver_serves": "Performance market must exercise the low positive service tier.",
        "min_fail_serves": "Performance market fixture must expose slow or failed service that earns no QoS reward.",
        "max_fail_serves": "Healthy performance fixtures should keep Fail-tier service bounded.",
        "min_performance_reward_paid": "Tiered QoS rewards must pay non-zero reward in performance fixtures.",
        "max_performance_fail_rate": "Fail-tier service share must remain below the chosen service-class threshold.",
        "min_new_deal_latent_requests": "Demand fixture must exercise latent modeled write demand before price elasticity.",
        "min_new_deal_requests": "Demand fixture must exercise effective modeled write demand after price elasticity.",
        "min_new_deals_accepted": "Demand fixture must admit at least this many new storage deals.",
        "exact_new_deals_accepted": "Demand fixture expects an exact accepted-deal count.",
        "min_new_deals_suppressed_price": "Elastic demand fixture must suppress some latent demand when storage price is above the reference price.",
        "max_new_deals_suppressed_price": "Healthy affordability fixture should keep price-elastic demand suppression bounded.",
        "min_new_deals_rejected_price": "Overpriced-demand fixture must reject new deals because the quote exceeds user willingness to pay.",
        "max_new_deals_rejected_price": "Healthy affordability fixture should keep price-driven deal rejection bounded.",
        "max_new_deals_rejected_capacity": "Demand fixture should not accidentally reject requests because provider capacity was exhausted.",
        "max_new_deal_acceptance_rate": "Demand collapse fixture should keep accepted demand below this ceiling.",
        "min_new_deal_acceptance_rate": "Healthy demand fixture should accept at least this share of requested new deals.",
        "min_new_deal_latent_acceptance_rate": "Recovery fixture should accept at least this share of latent demand after price response.",
        "min_elasticity_overlay_activations": "Elasticity overlay fixture must activate temporary overflow routes.",
        "min_elasticity_overlay_serves": "Elasticity overlay routes must actually serve user reads after readiness.",
        "min_elasticity_overlay_expired": "Elasticity overlay TTL must remove temporary overflow routes.",
        "max_elasticity_overlay_rejections": "Positive-path overlay fixture should not hit spend-cap or candidate-selection rejection.",
        "max_final_elasticity_overlay_active": "Overlay scale-down should bound temporary active routes by run end.",
        "min_elasticity_spent": "Elasticity fixture must spend non-zero user-funded overflow budget.",
        "max_elasticity_spent": "Elasticity fixture must stay within the configured user-funded spend cap.",
        "min_staged_upload_attempts": "Staged upload fixture must exercise provisional generation pressure.",
        "min_staged_upload_committed": "Partial staged-upload flows should commit a non-zero share of provisional generations.",
        "min_staged_upload_rejections": "Staged upload grief must hit preflight rejection once pending provisional state reaches the cap.",
        "max_staged_upload_rejections": "Healthy staged upload flows should keep preflight rejection bounded.",
        "min_staged_upload_cleaned": "Staged upload retention must clean abandoned provisional generations.",
        "max_staged_upload_cleaned": "Healthy staged upload flows should not rely on excessive cleanup churn.",
        "max_max_staged_upload_pending_generations": "Staged upload pending generations must stay below the configured cap.",
        "max_max_staged_upload_pending_mdus": "Staged upload pending MDU footprint must stay below the configured cap.",
        "max_final_staged_upload_pending_generations": "Staged upload final pending generation count should remain bounded at run end.",
        "min_suspect_slots": "Health-state observability: soft failures should become suspect before punitive consequences.",
        "max_suspect_slots": "Healthy baseline should not produce suspect slot state.",
        "min_delinquent_slots": "Delinquency observability: threshold-crossed slots should expose delinquent state.",
        "max_delinquent_slots": "Transient jitter should not cross into delinquent slot state.",
        "max_quota_misses": "Healthy providers should not miss liveness quota.",
        "min_quota_misses": "Fault fixture must generate quota evidence.",
        "max_invalid_proofs": "Healthy providers should never produce invalid proofs.",
        "min_invalid_proofs": "Hard-fault fixture must generate invalid-proof evidence.",
        "exact_corrupt_responses": "Invalid-proof-only fixture should not also exercise corrupt retrieval bytes.",
        "max_paid_corrupt_bytes": "Corrupt data must not earn payment.",
        "min_reward_coverage": "Healthy slots should receive the expected rewards.",
        "min_provider_slashed": "Simulated slashing must affect hard-fault providers.",
        "min_providers_negative_pnl": "Market warning: some providers must become economically distressed.",
        "min_provider_cost_shock_active": "Cost-shock fixture must activate the configured cost-pressure window.",
        "min_max_provider_cost_shocked_providers": "Cost-shock fixture must affect at least this many providers.",
        "min_max_provider_cost_shock_storage_multiplier_bps": "Cost-shock fixture must raise modeled storage cost by at least this multiplier.",
        "min_max_provider_cost_shock_bandwidth_multiplier_bps": "Cost-shock fixture must raise modeled bandwidth cost by at least this multiplier.",
        "min_provider_churn_events": "Economic churn fixture must execute provider exits after sustained negative P&L.",
        "min_churned_providers": "Economic churn fixture must end with providers marked as exited.",
        "min_provider_entries": "Provider supply fixture must move reserve providers into onboarding.",
        "min_provider_probation_promotions": "Provider supply fixture must promote onboarded providers into active supply.",
        "min_entered_active_providers": "Provider supply fixture must end with newly entered providers in the active set.",
        "exact_reserve_providers": "Provider supply fixture should consume the configured reserve by run end.",
        "exact_probationary_providers": "Provider supply fixture should not leave providers stuck in probation by run end.",
        "max_max_probationary_providers": "Provider supply fixture should bound simultaneous probationary onboarding.",
        "min_provider_underbonded_repairs": "Bond-headroom fixture must trigger repair away from undercollateralized providers.",
        "min_max_underbonded_providers": "Bond-headroom fixture must expose at least this many underbonded providers.",
        "min_max_underbonded_assigned_slots": "Bond-headroom fixture must expose assigned responsibility on underbonded providers.",
        "max_final_underbonded_assigned_slots": "Bond-headroom fixture should repair away all underbonded active responsibility by run end.",
        "min_max_provider_bond_deficit": "Bond-headroom fixture must expose non-zero collateral deficit.",
        "min_churn_pressure_provider_epochs": "Economic churn fixture must expose sustained below-threshold provider pressure.",
        "min_max_churned_assigned_slots": "Economic churn fixture must create assigned-slot repair pressure after exits.",
        "min_final_active_provider_capacity": "Economic churn fixture must retain enough active replacement capacity.",
        "min_retrieval_demand_shock_active": "Retrieval-demand fixture must activate the configured demand-shock window.",
        "min_max_retrieval_demand_multiplier_bps": "Retrieval-demand fixture must apply at least this read-demand multiplier.",
        "min_retrieval_latent_attempts": "Retrieval-demand fixture must record baseline latent demand.",
        "min_retrieval_attempts": "Retrieval-demand fixture must produce elevated effective retrieval attempts.",
        "min_max_retrieval_price": "Retrieval-demand shock should move the retrieval price above this observed maximum.",
        "max_retrieval_price_direction_changes": "Retrieval price should not repeatedly oscillate under the configured shock.",
        "min_retrieval_base_burned": "Requester/session demand must pay a non-zero base burn.",
        "min_retrieval_variable_burned": "Variable retrieval activity must contribute non-zero burn.",
        "min_retrieval_provider_payouts": "Legitimate high demand must pay providers for bandwidth.",
        "min_retrieval_wash_accounted_spend": "Wash-retrieval fixture must record explicit requester, sponsor, or owner-funded spend.",
        "max_retrieval_wash_net_gain": "Wash retrieval should be uneconomic for a colluding requester/provider.",
        "min_retrieval_wash_net_gain": "Unsafe wash-retrieval fixture should expose positive colluding requester/provider gain.",
        "min_storage_escrow_locked": "Storage lock-in fixture must lock non-zero storage escrow at commit.",
        "min_storage_escrow_earned": "Storage lock-in fixture must earn storage fees over modeled service epochs.",
        "min_storage_escrow_refunded": "Early-close fixture must refund unearned storage escrow.",
        "max_storage_escrow_outstanding": "Storage escrow should not remain locked after the modeled close/expiry path should have released it.",
        "min_storage_fee_provider_payouts": "Earned storage fees should pay eligible providers.",
        "max_storage_fee_burned": "Healthy storage escrow fixture should not burn storage fees from non-compliance.",
        "exact_deals_expired": "Deal expiry fixture should expire the expected number of deals.",
        "exact_final_expired_deals": "Run-end expired deal count should match the scenario contract.",
        "exact_final_closed_deals": "Close/refund fixture should end with the configured number of closed deals.",
        "exact_deals_closed": "Close/refund fixture should close the configured number of deals.",
        "min_sponsored_retrieval_attempts": "Sponsored public retrieval fixture must route demand through sponsor/requester-funded sessions.",
        "min_sponsored_retrieval_spent": "Sponsored public retrieval fixture must pay non-zero session spend.",
        "max_owner_retrieval_escrow_debited": "Retrieval accounting invariant: owner deal escrow should not be charged for sponsored, expired, or closed-content requests.",
        "exact_owner_retrieval_escrow_debited": "Sponsored public retrieval should keep owner deal escrow unchanged.",
        "min_elasticity_rejections": "Spend cap must reject excess elasticity demand.",
        "max_elasticity_spent": "Elasticity spend must not exceed the configured cap.",
        "min_withheld_responses": "Withholding fixture must create visible withheld-response evidence.",
        "min_saturated_responses": "Scale fixture must expose provider bandwidth saturation.",
        "min_repair_backoffs": "Scale fixture must expose healing coordination pressure.",
        "max_providers_over_capacity": "Assignment must respect modeled provider capacity.",
        "min_top_operator_provider_share_bps": "Fixture must actually model a dominant operator controlling many provider identities.",
        "max_top_operator_assignment_share_bps": "Placement should cap the dominant operator's final assignment share.",
        "max_max_operator_assignment_share_bps": "No epoch should let one operator exceed the configured assignment-share ceiling.",
        "max_max_operator_deal_slots": "No deal should assign more than this many slots to one operator.",
        "max_operator_deal_cap_violations": "Per-deal operator cap should not be violated.",
        "min_final_storage_utilization_bps": "Network utilization should be high enough to make pricing/healing meaningful.",
        "max_final_storage_utilization_bps": "Network utilization should remain below the capacity cliff.",
        "min_final_storage_price": "Dynamic pricing should move storage price to or above this value by run end.",
        "max_final_storage_price": "Dynamic pricing should keep storage price at or below this value by run end.",
        "min_final_retrieval_price": "Dynamic pricing should move retrieval price to or above this value by run end.",
        "max_final_retrieval_price": "Dynamic pricing should keep retrieval price at or below this value by run end.",
        "max_audit_budget_carryover": "Tight audit-budget fixtures should not accumulate unused budget while misses remain.",
        "min_audit_budget_demand": "Fault fixtures should create non-zero audit demand from miss-driven evidence.",
        "min_audit_budget_spent": "Audit demand should spend at least this much budget in the fixture.",
        "min_audit_budget_backlog": "Tight audit-budget fixtures should expose unmet audit demand instead of hiding capped spend.",
        "min_audit_budget_exhausted": "Tight audit-budget fixtures should record at least this many budget-exhausted epochs.",
        "min_evidence_spam_claims": "Evidence-market spam fixture must submit low-quality claims.",
        "min_evidence_spam_bond_burned": "Unconvicted evidence spam should burn a non-zero bond.",
        "max_evidence_spam_bounty_paid": "Low-quality spam should not receive conviction-gated bounty payout.",
        "max_evidence_spam_net_gain": "Spam should be uneconomic or at least non-profitable under the modeled bond/bounty parameters.",
    }
    return meanings.get(name, "Custom assertion. Review the detail and fixture threshold.")


def assertion_lines(assertions: list[dict[str, Any]]) -> list[str]:
    if not assertions:
        return ["| none | `UNASSERTED` | No assertion contract was recorded. | n/a |"]
    lines = []
    for item in assertions:
        status = "PASS" if item.get("passed") else "FAIL"
        name = str(item.get("name", ""))
        lines.append(f"| `{name}` | `{status}` | {assertion_meaning(name)} | {item.get('detail', '')} |")
    return lines


def evidence_excerpt_lines(evidence: list[dict[str, str]]) -> list[str]:
    if not evidence:
        return ["| n/a | n/a | n/a | n/a | n/a | n/a | No evidence events were recorded. |"]
    lines = []
    for row in evidence[:12]:
        lines.append(
            f"| {row.get('epoch', '')} | {row.get('deal_id', '')} | {row.get('slot', '')} | `{row.get('provider_id', '')}` | "
            f"`{row.get('evidence_class', '')}` | `{row.get('reason', '')}` | `{row.get('consequence', '')}` |"
        )
    if len(evidence) > 12:
        lines.append(f"| ... | ... | ... | ... | ... | ... | `{len(evidence) - 12}` more events omitted |")
    return lines


def build_economic_narrative(
    totals: dict[str, Any],
    providers: list[dict[str, str]],
    economy: list[dict[str, str]],
    negative_pnl: list[dict[str, str]],
    churn_risk: list[dict[str, str]],
) -> str:
    retrieval_burned = fnum(totals.get("retrieval_base_burned")) + fnum(totals.get("retrieval_variable_burned"))
    minted = (
        fnum(totals.get("reward_pool_minted"))
        + fnum(totals.get("audit_budget_minted"))
        + fnum(totals.get("performance_reward_paid"))
    )
    burned = retrieval_burned + fnum(totals.get("reward_burned")) + fnum(totals.get("evidence_spam_bond_burned"))
    burn_ratio = burned / minted if minted else 0.0
    parts = [
        f"The run minted `{fmt_money(minted)}` reward/audit units and burned `{fmt_money(burned)}` units, "
        f"for a burn-to-mint ratio of `{fmt_pct(burn_ratio)}`.",
        f"Providers earned `{fmt_money(totals.get('provider_revenue'))}` in modeled revenue against `{fmt_money(totals.get('provider_cost'))}` in modeled cost, "
        f"ending with aggregate P&L `{fmt_money(totals.get('provider_pnl'))}`.",
        f"Retrieval accounting paid providers `{fmt_money(totals.get('retrieval_provider_payouts'))}`, burned `{fmt_money(totals.get('retrieval_base_burned'))}` in base fees, "
        f"and burned `{fmt_money(totals.get('retrieval_variable_burned'))}` in variable retrieval fees.",
        f"Wash-retrieval accounting shows explicit spend `{fmt_money(totals.get('retrieval_wash_accounted_spend'))}` against possible colluding-provider gain "
        f"`{fmt_money(totals.get('retrieval_wash_net_gain'))}`.",
        f"Sponsored retrieval accounting spent `{fmt_money(totals.get('sponsored_retrieval_spent'))}` across "
        f"`{fmt_num(totals.get('sponsored_retrieval_attempts'))}` sponsor-funded attempts; owner retrieval escrow debit was "
        f"`{fmt_money(totals.get('owner_retrieval_escrow_debited'))}`.",
        f"Storage escrow accounting locked `{fmt_money(totals.get('storage_escrow_locked'))}`, earned `{fmt_money(totals.get('storage_escrow_earned'))}`, "
        f"refunded `{fmt_money(totals.get('storage_escrow_refunded'))}`, paid providers `{fmt_money(totals.get('storage_fee_provider_payouts'))}`, "
        f"burned `{fmt_money(totals.get('storage_fee_burned'))}`, and ended with outstanding escrow `{fmt_money(totals.get('storage_escrow_outstanding'))}`.",
        f"Performance-tier accounting paid `{fmt_money(totals.get('performance_reward_paid'))}` in QoS rewards.",
        f"Audit accounting saw `{fmt_money(totals.get('audit_budget_demand'))}` of demand, spent `{fmt_money(totals.get('audit_budget_spent'))}`, "
        f"and ended with `{fmt_money(totals.get('audit_budget_backlog'))}` backlog after `{fmt_num(totals.get('audit_budget_exhausted'))}` exhausted epochs.",
    ]
    if fnum(totals.get("evidence_spam_claims")) > 0:
        parts.append(
            f"Evidence-spam accounting burned `{fmt_money(totals.get('evidence_spam_bond_burned'))}` in claim bonds, "
            f"paid `{fmt_money(totals.get('evidence_spam_bounty_paid'))}` in conviction-gated bounties, "
            f"and left the spammer with net gain `{fmt_money(totals.get('evidence_spam_net_gain'))}`."
        )
    if fnum(totals.get("new_deal_latent_requests")) > 0 or fnum(totals.get("new_deal_requests")) > 0:
        parts.append(
            f"Demand accounting saw `{fmt_num(totals.get('new_deal_latent_requests'))}` latent new deal requests, "
            f"`{fmt_num(totals.get('new_deal_requests'))}` effective requests after elasticity, accepted "
            f"`{fmt_num(totals.get('new_deals_accepted'))}`, suppressed `{fmt_num(totals.get('new_deals_suppressed_price'))}` by price response, rejected `{fmt_num(totals.get('new_deals_rejected_price'))}` on price, "
            f"and rejected `{fmt_num(totals.get('new_deals_rejected_capacity'))}` on capacity. "
            f"Effective-request acceptance rate was `{fmt_pct(totals.get('new_deal_acceptance_rate'))}`."
        )
    if fnum(totals.get("elasticity_overlay_activations")) > 0:
        parts.append(
            f"Elasticity overlay accounting spent `{fmt_money(totals.get('elasticity_spent'))}` to activate "
            f"`{fmt_num(totals.get('elasticity_overlay_activations'))}` temporary routes, served "
            f"`{fmt_num(totals.get('elasticity_overlay_serves'))}` reads through overlay providers, rejected "
            f"`{fmt_num(totals.get('elasticity_overlay_rejections'))}` expansion attempts, and expired "
            f"`{fmt_num(totals.get('elasticity_overlay_expired'))}` routes by TTL."
        )
    if fnum(totals.get("staged_upload_attempts")) > 0:
        parts.append(
            f"Staged upload accounting saw `{fmt_num(totals.get('staged_upload_attempts'))}` provisional attempts, "
            f"accepted `{fmt_num(totals.get('staged_upload_accepted'))}`, committed `{fmt_num(totals.get('staged_upload_committed'))}`, "
            f"rejected `{fmt_num(totals.get('staged_upload_rejections'))}` at preflight, and cleaned "
            f"`{fmt_num(totals.get('staged_upload_cleaned'))}` abandoned generations by retention policy. "
            f"The peak local staged footprint was `{fmt_num(totals.get('max_staged_upload_pending_generations'))}` generations / "
            f"`{fmt_num(totals.get('max_staged_upload_pending_mdus'))}` MDUs."
        )
    if fnum(totals.get("provider_cost_shock_active")) > 0:
        parts.append(
            f"Provider cost shocks were active for `{fmt_num(totals.get('provider_cost_shock_active'))}` shock-epochs, "
            f"affecting up to `{fmt_num(totals.get('max_provider_cost_shocked_providers'))}` providers. "
            f"The maximum modeled storage-cost multiplier reached `{fmt_bps(totals.get('max_provider_cost_shock_storage_multiplier_bps'))}`."
        )
    if fnum(totals.get("provider_churn_events")) > 0:
        parts.append(
            f"Provider churn policy executed `{fmt_num(totals.get('provider_churn_events'))}` exits, leaving "
            f"`{fmt_num(totals.get('churned_providers'))}` churned providers and `{fmt_num(totals.get('final_active_provider_capacity'))}` active capacity slots. "
        f"At peak, `{fmt_num(totals.get('max_churned_assigned_slots'))}` assigned slots sat on churned providers and needed repair/rerouting pressure."
        )
    if fnum(totals.get("provider_entries")) > 0 or fnum(totals.get("provider_probation_promotions")) > 0:
        parts.append(
            f"Supply entry moved `{fmt_num(totals.get('provider_entries'))}` reserve providers into probation and promoted "
            f"`{fmt_num(totals.get('provider_probation_promotions'))}` providers into active supply. "
            f"The run ended with `{fmt_num(totals.get('entered_active_providers'))}` newly entered active providers, "
            f"`{fmt_num(totals.get('reserve_providers'))}` reserve providers, and `{fmt_num(totals.get('probationary_providers'))}` probationary providers."
        )
    if fnum(totals.get("max_underbonded_providers")) > 0:
        parts.append(
            f"Bond-headroom accounting observed up to `{fmt_num(totals.get('max_underbonded_providers'))}` underbonded providers and "
            f"`{fmt_num(totals.get('max_underbonded_assigned_slots'))}` assigned slots on underbonded providers. "
            f"The policy triggered `{fmt_num(totals.get('provider_underbonded_repairs'))}` underbonded-slot repairs and ended with "
            f"`{fmt_num(totals.get('final_underbonded_assigned_slots'))}` assigned slots still underbonded."
        )
    if fnum(totals.get("retrieval_demand_shock_active")) > 0:
        parts.append(
            f"Retrieval demand shocks were active for `{fmt_num(totals.get('retrieval_demand_shock_active'))}` shock-epochs. "
            f"Latent retrieval attempts `{fmt_num(totals.get('retrieval_latent_attempts'))}` became `{fmt_num(totals.get('retrieval_attempts'))}` effective attempts, "
            f"and retrieval price changed direction `{fmt_num(totals.get('retrieval_price_direction_changes'))}` times."
        )
    if negative_pnl:
        parts.append(
            f"`{len(negative_pnl)}` providers ended with negative P&L and `{len(churn_risk)}` were marked as churn risk. "
            "That is economically important even when retrieval success is perfect."
        )
    else:
        parts.append("No provider ended with negative modeled P&L under the current assumptions.")
    if economy:
        last = economy[-1]
        parts.append(
            f"Final modeled storage price was `{fmt_money(last.get('storage_price'))}` and retrieval price per slot was `{fmt_money(last.get('retrieval_price_per_slot'))}`."
        )
    if metric_sum(economy, "elasticity_rejections"):
        parts.append(
            f"Elasticity attempted to exceed budget `{fmt_num(metric_sum(economy, 'elasticity_rejections'))}` times; modeled spend remained `{fmt_money(metric_sum(economy, 'elasticity_spent'))}`."
        )
    return "\n\n".join(parts)


def write_risk_register(
    path: Path,
    summary: dict[str, Any],
    providers: list[dict[str, str]],
    evidence: list[dict[str, str]],
    repairs: list[dict[str, str]],
    economy: list[dict[str, str]],
) -> None:
    config = summary["config"]
    totals = summary["totals"]
    guide = scenario_guide(str(config["scenario"]))
    assertions = summary.get("assertions", [])
    failed = [item for item in assertions if not item.get("passed")]
    negative_pnl = [p for p in providers if fnum(p.get("pnl")) < 0]
    elasticity_rejections = sum(fnum(row.get("elasticity_rejections")) for row in economy)
    rows = []
    if failed:
        for item in failed:
            rows.append(
                {
                    "risk": f"Assertion `{item.get('name')}` failed",
                    "severity": "high",
                    "evidence": str(item.get("detail", "")),
                    "impact": "The fixture no longer proves its intended policy property.",
                    "followup": "Fix simulator behavior or adjust the assertion only after explicit human policy approval.",
                }
            )
    if fnum(totals.get("data_loss_events")):
        rows.append(
            {
                "risk": "Modeled data loss",
                "severity": "critical",
                "evidence": f"{fmt_num(totals.get('data_loss_events'))} data-loss events.",
                "impact": "The network lost the durability invariant, which is not acceptable for scale thresholds.",
                "followup": "Block graduation. Investigate placement diversity, hard-fault repair, and replacement capacity.",
            }
        )
    if fnum(totals.get("unavailable_reads")):
        allows_scale_misses = scenario_allows_unavailable_reads(str(config["scenario"]))
        rows.append(
            {
                "risk": "User-facing availability loss",
                "severity": "medium" if allows_scale_misses else "critical",
                "evidence": f"{fmt_num(totals.get('unavailable_reads'))} unavailable reads; success rate {fmt_pct(totals.get('success_rate'))}.",
                "impact": "Temporary read misses are acceptable only when explicitly allowed by the scenario contract and data loss remains zero.",
                "followup": "If this is a scale fixture, track it as an availability tuning item. Otherwise block graduation and investigate routing, redundancy, repair timing, and provider selection.",
            }
        )
    if fnum(totals.get("expired_retrieval_attempts")) and fnum(totals.get("owner_retrieval_escrow_debited")):
        rows.append(
            {
                "risk": "Expired retrievals debited owner escrow",
                "severity": "high",
                "evidence": (
                    f"{fmt_num(totals.get('expired_retrieval_attempts'))} expired retrieval rejections and "
                    f"{fmt_money(totals.get('owner_retrieval_escrow_debited'))} owner retrieval escrow debit."
                ),
                "impact": "Post-expiry reads should fail as expired content rather than charging the deal owner for unavailable service.",
                "followup": "Block graduation. Add keeper/gateway guards so expired deals are not selected for billable retrieval sessions.",
            }
        )
    if fnum(totals.get("closed_retrieval_attempts")) and fnum(totals.get("owner_retrieval_escrow_debited")):
        rows.append(
            {
                "risk": "Closed retrievals debited owner escrow",
                "severity": "high",
                "evidence": (
                    f"{fmt_num(totals.get('closed_retrieval_attempts'))} closed retrieval rejections and "
                    f"{fmt_money(totals.get('owner_retrieval_escrow_debited'))} owner retrieval escrow debit."
                ),
                "impact": "Post-close reads should fail as closed content rather than charging the deal owner for unavailable service.",
                "followup": "Block graduation. Add keeper/gateway guards so closed deals are not selected for billable retrieval sessions.",
            }
        )
    if negative_pnl:
        rows.append(
            {
                "risk": "Provider economic churn pressure",
                "severity": "medium" if len(negative_pnl) < len(providers) / 2 else "high",
                "evidence": f"{len(negative_pnl)} of {len(providers)} providers ended with negative modeled P&L.",
                "impact": "A technically healthy network may still be unstable if rational providers exit.",
                "followup": "Review storage price, retrieval price, reward pool, provider cost assumptions, and dynamic-pricing thresholds.",
            }
        )
    if fnum(totals.get("provider_cost_shock_active")) > 0:
        rows.append(
            {
                "risk": "Provider cost shock exposure",
                "severity": "medium",
                "evidence": (
                    f"Cost shocks were active for {fmt_num(totals.get('provider_cost_shock_active'))} shock-epochs and affected up to "
                    f"{fmt_num(totals.get('max_provider_cost_shocked_providers'))} providers."
                ),
                "impact": "A technically healthy network may have delayed economic instability if prices and rewards do not react to operator cost pressure.",
                "followup": "Review provider cost telemetry assumptions, pricing floors, reward buffers, and whether cost shocks should remain monitoring-only or feed governance recommendations.",
            }
        )
    if fnum(totals.get("provider_churn_events")) > 0:
        rows.append(
            {
                "risk": "Provider capacity exit",
                "severity": "medium" if fnum(totals.get("data_loss_events")) == 0 else "critical",
                "evidence": (
                    f"{fmt_num(totals.get('provider_churn_events'))} provider exits removed "
                    f"{fmt_num(totals.get('final_exited_provider_capacity'))} capacity slots; peak assigned slots on churned providers was "
                    f"{fmt_num(totals.get('max_churned_assigned_slots'))}."
                ),
                "impact": "Economic exits can turn a pricing problem into repair pressure and capacity scarcity.",
                "followup": "Review churn caps, minimum replacement capacity, price-floor response, and whether draining exits need longer notice periods.",
            }
        )
    if fnum(totals.get("max_underbonded_providers")) > 0:
        rows.append(
            {
                "risk": "Provider bond headroom exhausted",
                "severity": "medium" if fnum(totals.get("final_underbonded_assigned_slots")) == 0 else "high",
                "evidence": (
                    f"Peak underbonded providers {fmt_num(totals.get('max_underbonded_providers'))}; "
                    f"peak assigned slots on underbonded providers {fmt_num(totals.get('max_underbonded_assigned_slots'))}; "
                    f"final bond deficit {fmt_money(totals.get('final_provider_bond_deficit'))}."
                ),
                "impact": "Undercollateralized providers should not continue accumulating responsibility, especially after hard-fault slashing.",
                "followup": "Review minimum bond, per-slot collateral, repair urgency, top-up UX, and whether underbonding should degrade placement before repair.",
            }
        )
    if fnum(totals.get("provider_entries")) > fnum(totals.get("provider_probation_promotions")):
        rows.append(
            {
                "risk": "Provider supply stuck in probation",
                "severity": "medium",
                "evidence": (
                    f"{fmt_num(totals.get('provider_entries'))} provider entries but only "
                    f"{fmt_num(totals.get('provider_probation_promotions'))} probation promotions."
                ),
                "impact": "Replacement capacity may be visible in reserve but unavailable for assignments when repair pressure arrives.",
                "followup": "Review probation length, readiness criteria, entry caps, and whether the scenario ran long enough to observe promotion.",
            }
        )
    if fnum(totals.get("retrieval_demand_shock_active")) > 0:
        severity = "medium" if fnum(totals.get("retrieval_price_direction_changes")) > 2 else "low"
        rows.append(
            {
                "risk": "Retrieval demand shock response",
                "severity": severity,
                "evidence": (
                    f"Retrieval demand shocks were active for {fmt_num(totals.get('retrieval_demand_shock_active'))} shock-epochs; "
                    f"retrieval price changed direction {fmt_num(totals.get('retrieval_price_direction_changes'))} times."
                ),
                "impact": "A controller that overreacts to burst reads can create unstable quotes or provider incentives even when reads remain available.",
                "followup": "Review retrieval demand targets, step clamps, EMA windows, and whether shock handling should be smoothed before keeper defaults.",
            }
        )
    if elasticity_rejections:
        rows.append(
            {
                "risk": "Elasticity demand rejected by spend cap",
                "severity": "medium",
                "evidence": f"{fmt_num(elasticity_rejections)} elasticity attempts were rejected.",
                "impact": "The system correctly fails closed, but users may experience capacity limits during demand spikes.",
                "followup": "Decide whether this is acceptable UX or whether user-funded burst budgets need product controls.",
            }
        )
    if fnum(totals.get("elasticity_overlay_activations")) > 0:
        severity = "medium" if fnum(totals.get("elasticity_overlay_rejections")) > 0 else "low"
        rows.append(
            {
                "risk": "Elasticity overlay routing pressure",
                "severity": severity,
                "evidence": (
                    f"{fmt_num(totals.get('elasticity_overlay_activations'))} overlays activated, "
                    f"{fmt_num(totals.get('elasticity_overlay_serves'))} overlay serves completed, "
                    f"{fmt_num(totals.get('elasticity_overlay_expired'))} overlays expired, and "
                    f"{fmt_num(totals.get('elasticity_overlay_rejections'))} overlay expansions were rejected."
                ),
                "impact": "Temporary overflow capacity can preserve reads under hot demand, but it needs explicit readiness, TTL, spend accounting, and routing visibility.",
                "followup": "Review overlay readiness proofs, TTL defaults, spend-window UX, gateway route ordering, and whether overlay providers affect audit or reward eligibility.",
            }
        )
    if fnum(totals.get("owner_retrieval_escrow_debited")) > 0:
        rows.append(
            {
                "risk": "Owner escrow drained by retrieval demand",
                "severity": "medium",
                "evidence": (
                    f"Owner retrieval escrow was debited {fmt_money(totals.get('owner_retrieval_escrow_debited'))} while "
                    f"sponsored retrieval spend was {fmt_money(totals.get('sponsored_retrieval_spent'))}."
                ),
                "impact": "Public demand can unexpectedly consume deal-owner funds if sponsor/requester-funded session accounting is absent or incomplete.",
                "followup": "Review sponsored-session funding, owner escrow isolation, gateway quote display, and close/refund semantics.",
            }
        )
    if (
        fnum(totals.get("storage_escrow_outstanding")) > 0
        and fnum(totals.get("final_closed_deals")) > 0
        and fnum(totals.get("final_open_deals")) == 0
    ):
        rows.append(
            {
                "risk": "Storage escrow left outstanding after close",
                "severity": "medium",
                "evidence": (
                    f"Final outstanding storage escrow was {fmt_money(totals.get('storage_escrow_outstanding'))} after "
                    f"{fmt_num(totals.get('final_closed_deals'))} deals closed."
                ),
                "impact": "Close/refund semantics may leave user funds locked or protocol/provider accounting ambiguous.",
                "followup": "Review deal close timing, earned-fee accrual, refund rounding, and whether expiry should auto-close storage escrow.",
            }
        )
    if fnum(totals.get("storage_fee_burned")) > 0:
        rows.append(
            {
                "risk": "Storage fees withheld from providers",
                "severity": "medium",
                "evidence": f"{fmt_money(totals.get('storage_fee_burned'))} earned storage-fee units were burned instead of paid.",
                "impact": "This is expected for non-compliant responsibility, but unexpected burns in a healthy escrow fixture indicate accounting or reward-eligibility drift.",
                "followup": "Review storage-fee eligibility, quota thresholds, and whether storage fees should follow base reward exclusion semantics.",
            }
        )
    if fnum(totals.get("saturated_responses")):
        rows.append(
            {
                "risk": "Provider bandwidth saturation",
                "severity": "medium",
                "evidence": f"{fmt_num(totals.get('saturated_responses'))} provider responses saturated before serving.",
                "impact": "Retrieval demand may exceed heterogeneous provider bandwidth before the storage layer notices a hard fault.",
                "followup": "Review bandwidth admission, route_attempt_limit, retrieval pricing, and elasticity policy.",
            }
        )
    if fnum(totals.get("performance_fail_rate")) > 0.25:
        rows.append(
            {
                "risk": "High Fail-tier QoS share",
                "severity": "medium",
                "evidence": f"Fail-tier serves were {fmt_pct(totals.get('performance_fail_rate'))} of tiered serves.",
                "impact": "Reads may remain available while many providers miss the intended performance market window.",
                "followup": "Review service-class placement, latency tier windows, high-bandwidth routing, and performance reward multipliers.",
            }
        )
    if fnum(totals.get("operator_deal_cap_violations")):
        rows.append(
            {
                "risk": "Operator assignment cap violation",
                "severity": "high",
                "evidence": f"{fmt_num(totals.get('operator_deal_cap_violations'))} deal/operator groups exceeded the configured cap.",
                "impact": "A single operator may gain too much per-deal blast radius despite multiple SP identities.",
                "followup": "Review operator identity, initial placement, replacement-candidate fallback, and per-deal cap defaults.",
            }
        )
    if fnum(totals.get("repair_backoffs")):
        rows.append(
            {
                "risk": "Repair coordination bottleneck",
                "severity": "medium",
                "evidence": (
                    f"{fmt_num(totals.get('repair_backoffs'))} repair backoffs across "
                    f"{fmt_num(totals.get('repair_attempts'))} attempts; "
                    f"{fmt_num(totals.get('repair_cooldowns'))} cooldowns and "
                    f"{fmt_num(totals.get('repair_attempt_caps'))} attempt-cap events; "
                    f"{fmt_num(totals.get('repair_timeouts'))} readiness timeouts."
                ),
                "impact": "The network may detect bad slots faster than it can safely heal them.",
                "followup": "Review max repair starts per epoch, replacement capacity, retry cooldowns, attempt caps, and catch-up probability assumptions.",
            }
        )
    if fnum(totals.get("repair_timeouts")):
        rows.append(
            {
                "risk": "Pending provider readiness timeout",
                "severity": "medium",
                "evidence": f"{fmt_num(totals.get('repair_timeouts'))} pending repairs timed out before readiness.",
                "impact": "Replacement providers may be selected but fail to reconstruct or prove readiness quickly enough.",
                "followup": "Review readiness proof requirements, timeout windows, catch-up bandwidth assumptions, and provider reputation effects for failed repair attempts.",
            }
        )
    if fnum(totals.get("audit_budget_backlog")):
        rows.append(
            {
                "risk": "Audit budget exhaustion",
                "severity": "medium",
                "evidence": (
                    f"{fmt_money(totals.get('audit_budget_backlog'))} audit backlog after "
                    f"{fmt_num(totals.get('audit_budget_exhausted'))} exhausted epochs."
                ),
                "impact": "The policy may detect more soft-failure work than the configured audit budget can process.",
                "followup": "Review audit budget per epoch, audit cost per miss, escalation semantics, and whether backlog should trigger governance review.",
            }
        )
    if fnum(totals.get("evidence_spam_net_gain")) > 0:
        rows.append(
            {
                "risk": "Profitable evidence spam",
                "severity": "high",
                "evidence": (
                    f"{fmt_money(totals.get('evidence_spam_net_gain'))} net spam gain from "
                    f"{fmt_num(totals.get('evidence_spam_claims'))} claims."
                ),
                "impact": "A deputy can profit by flooding low-quality evidence instead of producing useful enforcement work.",
                "followup": "Increase evidence bond, reduce bounty, add spam throttles, or require stronger conviction gating before keeper work.",
            }
        )
    if str(config.get("scenario", "")) == "wash-retrieval" and fnum(totals.get("retrieval_wash_net_gain")) >= 0:
        severity = "high" if fnum(totals.get("retrieval_wash_net_gain")) > 0 else "medium"
        rows.append(
            {
                "risk": "Wash retrieval remains profitable",
                "severity": severity,
                "evidence": (
                    f"{fmt_money(totals.get('retrieval_wash_net_gain'))} net gain after "
                    f"{fmt_money(totals.get('retrieval_wash_accounted_spend'))} explicit retrieval spend."
                ),
                "impact": "Colluding requesters and providers can turn fake traffic into provider payouts unless requester/session funding and burns cover the payout path.",
                "followup": "Require requester-paid variable fees, sufficient base burns, credit caps, and explicit burn/payout ledger accounting before keeper defaults.",
            }
        )
    if fnum(totals.get("new_deals_rejected_price")) > 0:
        rows.append(
            {
                "risk": "Storage demand rejected by price",
                "severity": "medium",
                "evidence": (
                    f"{fmt_num(totals.get('new_deals_rejected_price'))} new deal requests were rejected by storage price; "
                    f"acceptance rate was {fmt_pct(totals.get('new_deal_acceptance_rate'))}."
                ),
                "impact": "The network can be technically healthy while the market fails to admit useful storage demand.",
                "followup": "Review quote UX, price ceilings, dynamic-pricing step timing, and affordability targets.",
            }
        )
    if fnum(totals.get("new_deals_suppressed_price")) > 0:
        rows.append(
            {
                "risk": "Storage demand suppressed by price elasticity",
                "severity": "medium",
                "evidence": (
                    f"{fmt_num(totals.get('new_deals_suppressed_price'))} latent new deal requests were suppressed before requesting; "
                    f"latent-demand acceptance rate was {fmt_pct(totals.get('new_deal_latent_acceptance_rate'))}."
                ),
                "impact": "Demand may silently leave the market before a hard quote rejection appears in protocol telemetry.",
                "followup": "Review reference price, elasticity assumptions, price-step timing, quote telemetry, and whether demand should recover as utilization falls.",
            }
        )
    if fnum(totals.get("staged_upload_rejections")) > 0 or fnum(totals.get("staged_upload_cleaned")) > 0:
        rows.append(
            {
                "risk": "Staged upload retention pressure",
                "severity": "medium",
                "evidence": (
                    f"{fmt_num(totals.get('staged_upload_rejections'))} provisional uploads were rejected at preflight and "
                    f"{fmt_num(totals.get('staged_upload_cleaned'))} abandoned generations were cleaned; peak pending was "
                    f"{fmt_num(totals.get('max_staged_upload_pending_generations'))} generations / "
                    f"{fmt_num(totals.get('max_staged_upload_pending_mdus'))} MDUs."
                ),
                "impact": "Abandoned provisional generations can consume provider-daemon disk or operator attention if cleanup and preflight caps are missing.",
                "followup": "Review staged-generation TTL, max pending cap, dry-run cleanup UX, and whether preflight rejection should be gateway-visible before upload.",
            }
        )
    if evidence and not repairs and str(config["scenario"]) not in {
        "ideal",
        "underpriced-storage",
        "overpriced-storage",
        "wash-retrieval",
        "viral-public-retrieval",
        "elasticity-cap-hit",
        "elasticity-overlay-scaleup",
        "deputy-evidence-spam",
        "staged-upload-grief",
    }:
        rows.append(
            {
                "risk": "Evidence without repair",
                "severity": "high",
                "evidence": f"{len(evidence)} evidence events and 0 repair events.",
                "impact": "The simulator may be measuring bad behavior without enforcing recovery.",
                "followup": "Review enforcement mode and repair thresholds.",
            }
        )
    if fnum(totals.get("paid_corrupt_bytes")):
        rows.append(
            {
                "risk": "Corrupt bytes paid",
                "severity": "critical",
                "evidence": f"{fmt_num(totals.get('paid_corrupt_bytes'))} corrupt bytes were paid.",
                "impact": "The policy allows provably bad service to earn rewards.",
                "followup": "Block graduation until reward accounting excludes corrupt responses.",
            }
        )
    if not rows:
        rows.append(
            {
                "risk": "No material risk surfaced",
                "severity": "low",
                "evidence": "Assertions passed, no negative provider P&L, no elasticity cap hit, and no availability loss.",
                "impact": "This run is suitable as a control or candidate for deeper implementation planning.",
                "followup": "Compare against adjacent scenarios and confirm assertion thresholds.",
            }
        )

    lines = [
        f"# Risk Register: {guide['title']}",
        "",
        guide["intent"],
        "",
        "## Material Risks",
        "",
        "| Risk | Severity | Evidence | Impact | Recommended Follow-Up |",
        "|---|---|---|---|---|",
    ]
    for row in rows:
        lines.append(f"| {row['risk']} | `{row['severity']}` | {row['evidence']} | {row['impact']} | {row['followup']} |")
    lines.extend(
        [
            "",
            "## Evidence Counters",
            "",
            f"- Evidence events: `{len(evidence)}`",
            f"- Repair events: `{len(repairs)}`",
            f"- Failed assertions: `{len(failed)}`",
            f"- Providers with negative P&L: `{len(negative_pnl)}`",
            f"- Elasticity rejections: `{fmt_num(elasticity_rejections)}`",
            f"- Elasticity overlay activations/serves/expired: `{fmt_num(totals.get('elasticity_overlay_activations'))}` / `{fmt_num(totals.get('elasticity_overlay_serves'))}` / `{fmt_num(totals.get('elasticity_overlay_expired'))}`",
            f"- Elasticity overlay rejections/final active/peak ready: `{fmt_num(totals.get('elasticity_overlay_rejections'))}` / `{fmt_num(totals.get('final_elasticity_overlay_active'))}` / `{fmt_num(totals.get('max_elasticity_overlay_ready'))}`",
            f"- Sponsored retrieval attempts/spend: `{fmt_num(totals.get('sponsored_retrieval_attempts'))}` / `{fmt_money(totals.get('sponsored_retrieval_spent'))}`",
            f"- Owner retrieval escrow debited: `{fmt_money(totals.get('owner_retrieval_escrow_debited'))}`",
            f"- Wash retrieval accounted spend/net gain: `{fmt_money(totals.get('retrieval_wash_accounted_spend'))}` / `{fmt_money(totals.get('retrieval_wash_net_gain'))}`",
            f"- Storage escrow locked/earned/refunded/outstanding: `{fmt_money(totals.get('storage_escrow_locked'))}` / `{fmt_money(totals.get('storage_escrow_earned'))}` / `{fmt_money(totals.get('storage_escrow_refunded'))}` / `{fmt_money(totals.get('storage_escrow_outstanding'))}`",
            f"- Storage fee provider payout/burned: `{fmt_money(totals.get('storage_fee_provider_payouts'))}` / `{fmt_money(totals.get('storage_fee_burned'))}`",
            f"- Final open/closed/expired deals: `{fmt_num(totals.get('final_open_deals'))}` / `{fmt_num(totals.get('final_closed_deals'))}` / `{fmt_num(totals.get('final_expired_deals'))}`",
            f"- Data-loss events: `{fmt_num(totals.get('data_loss_events'))}`",
            f"- Saturated responses: `{fmt_num(totals.get('saturated_responses'))}`",
            f"- Performance Fail-tier serves: `{fmt_num(totals.get('fail_serves'))}`",
            f"- Performance reward paid: `{fmt_money(totals.get('performance_reward_paid'))}`",
            f"- Top operator provider share: `{fmt_bps(totals.get('top_operator_provider_share_bps'))}`",
            f"- Top operator assignment share: `{fmt_bps(totals.get('top_operator_assignment_share_bps'))}`",
            f"- Operator cap violations: `{fmt_num(totals.get('operator_deal_cap_violations'))}`",
            f"- Suspect slot-epochs: `{fmt_num(totals.get('suspect_slots'))}`",
            f"- Delinquent slot-epochs: `{fmt_num(totals.get('delinquent_slots'))}`",
            f"- Repair attempts: `{fmt_num(totals.get('repair_attempts'))}`",
            f"- Repair backoffs: `{fmt_num(totals.get('repair_backoffs'))}`",
            f"- Repair cooldowns: `{fmt_num(totals.get('repair_cooldowns'))}`",
            f"- Repair attempt-cap events: `{fmt_num(totals.get('repair_attempt_caps'))}`",
            f"- Repair readiness timeouts: `{fmt_num(totals.get('repair_timeouts'))}`",
            f"- Audit budget demand: `{fmt_money(totals.get('audit_budget_demand'))}`",
            f"- Audit budget spent: `{fmt_money(totals.get('audit_budget_spent'))}`",
            f"- Audit budget backlog: `{fmt_money(totals.get('audit_budget_backlog'))}`",
            f"- Audit budget exhausted epochs: `{fmt_num(totals.get('audit_budget_exhausted'))}`",
            f"- Evidence spam claims: `{fmt_num(totals.get('evidence_spam_claims'))}`",
            f"- Evidence spam bond burned: `{fmt_money(totals.get('evidence_spam_bond_burned'))}`",
            f"- Evidence spam bounty paid: `{fmt_money(totals.get('evidence_spam_bounty_paid'))}`",
            f"- Evidence spam net gain: `{fmt_money(totals.get('evidence_spam_net_gain'))}`",
            f"- Provider cost shock active epochs: `{fmt_num(totals.get('provider_cost_shock_active'))}`",
            f"- Max cost-shocked providers: `{fmt_num(totals.get('max_provider_cost_shocked_providers'))}`",
            f"- Provider churn events: `{fmt_num(totals.get('provider_churn_events'))}`",
            f"- Churned providers: `{fmt_num(totals.get('churned_providers'))}`",
            f"- Provider entries/promotions: `{fmt_num(totals.get('provider_entries'))}` / `{fmt_num(totals.get('provider_probation_promotions'))}`",
            f"- Reserve/probationary/entered-active providers: `{fmt_num(totals.get('reserve_providers'))}` / `{fmt_num(totals.get('probationary_providers'))}` / `{fmt_num(totals.get('entered_active_providers'))}`",
            f"- Underbonded repairs: `{fmt_num(totals.get('provider_underbonded_repairs'))}`",
            f"- Final/peak underbonded providers: `{fmt_num(totals.get('final_underbonded_providers'))}` / `{fmt_num(totals.get('max_underbonded_providers'))}`",
            f"- Final/peak underbonded assigned slots: `{fmt_num(totals.get('final_underbonded_assigned_slots'))}` / `{fmt_num(totals.get('max_underbonded_assigned_slots'))}`",
            f"- Final active/exited/reserve provider capacity: `{fmt_num(totals.get('final_active_provider_capacity'))}` / `{fmt_num(totals.get('final_exited_provider_capacity'))}` / `{fmt_num(totals.get('final_reserve_provider_capacity'))}`",
            f"- Retrieval demand shock active epochs: `{fmt_num(totals.get('retrieval_demand_shock_active'))}`",
            f"- Retrieval price direction changes: `{fmt_num(totals.get('retrieval_price_direction_changes'))}`",
            f"- Latent new deal requests: `{fmt_num(totals.get('new_deal_latent_requests'))}`",
            f"- Effective new deal requests: `{fmt_num(totals.get('new_deal_requests'))}`",
            f"- New deals accepted: `{fmt_num(totals.get('new_deals_accepted'))}`",
            f"- New deals suppressed by price elasticity: `{fmt_num(totals.get('new_deals_suppressed_price'))}`",
            f"- New deals rejected by price: `{fmt_num(totals.get('new_deals_rejected_price'))}`",
            f"- New deals rejected by capacity: `{fmt_num(totals.get('new_deals_rejected_capacity'))}`",
            f"- Staged upload attempts/accepted/committed: `{fmt_num(totals.get('staged_upload_attempts'))}` / `{fmt_num(totals.get('staged_upload_accepted'))}` / `{fmt_num(totals.get('staged_upload_committed'))}`",
            f"- Staged upload rejections/cleaned: `{fmt_num(totals.get('staged_upload_rejections'))}` / `{fmt_num(totals.get('staged_upload_cleaned'))}`",
            f"- Final/peak staged pending generations: `{fmt_num(totals.get('final_staged_upload_pending_generations'))}` / `{fmt_num(totals.get('max_staged_upload_pending_generations'))}`",
            f"- Final/peak staged pending MDUs: `{fmt_num(totals.get('final_staged_upload_pending_mdus'))}` / `{fmt_num(totals.get('max_staged_upload_pending_mdus'))}`",
            "",
            "## Review Questions",
            "",
            "- Are the modeled thresholds strict enough to catch griefing without punishing honest jitter?",
            "- Does the risk severity match how we would respond in a real devnet incident?",
            "- Should any risk item become a keeper test, gateway e2e test, or explicit governance parameter decision?",
        ]
    )
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def graduation_semantics(scenario: str) -> str:
    semantics = {
        "ideal": "This is a control fixture. Graduation means the simulator can stay quiet when no policy action is warranted.",
        "flapping-provider": "Graduation means thresholds tolerate intermittent infra jitter without repair churn, jail, or slash.",
        "single-outage": "Graduation means an honest outage triggers repair after threshold while preserving the durability invariant.",
        "sustained-non-response": "Graduation means repeated soft failure can become per-slot delinquency and repair without treating soft evidence as slashable fraud.",
        "withholding": "Graduation means routing and evidence capture handle refusal-to-serve before any stronger punishment is considered.",
        "corrupt-provider": "Graduation means hard evidence, reward exclusion, repair, and simulated slash accounting are all deterministic.",
        "invalid-synthetic-proof": "Graduation means invalid liveness-proof evidence alone can trigger repair and simulated slash accounting without corrupt byte retrieval evidence.",
        "malicious-corrupt": "Graduation means hard evidence, reward exclusion, repair, and simulated slash accounting are all deterministic.",
        "lazy-provider": "Graduation means subsidy/reward gating catches useful-work failures even if user reads are still available.",
        "staged-upload-grief": "Graduation means abandoned provisional generations are bounded by visible preflight rejection and retention cleanup without triggering repair, slash, or committed-data availability loss.",
        "elasticity-overlay-scaleup": "Graduation means user-funded overflow routes can be activated, become ready, serve reads, and expire without turning into permanent base responsibility or bypassing spend caps.",
        "overpriced-storage": "Graduation means demand-side affordability failures are visible as price rejections rather than being mistaken for healthy market equilibrium.",
        "demand-elasticity-recovery": "Graduation means price-sensitive demand suppression and recovery are visible before governance tunes storage-price defaults.",
        "provider-cost-shock": "Graduation means provider cost stress is visible as churn pressure and pricing mismatch before it is turned into live governance parameters.",
        "provider-economic-churn": "Graduation means bounded economic exits create visible capacity and repair pressure without violating durability.",
        "provider-supply-entry": "Graduation means reserve-provider onboarding and probationary promotion are explicit enough to tune replacement supply before keeper lifecycle state is implemented.",
        "provider-bond-headroom": "Graduation means minimum bond and per-slot collateral constraints are explicit enough to exclude or repair undercollateralized providers before keeper bond state is implemented.",
        "retrieval-demand-shock": "Graduation means burst read demand and retrieval-price response are measurable, bounded, and reviewable before dynamic pricing keeper defaults are chosen.",
        "audit-budget-exhaustion": "Graduation means audit demand is bounded by budget and turns into backlog or policy review instead of unbounded issuance.",
        "deputy-evidence-spam": "Graduation means low-quality deputy evidence is economically negative-EV and cannot trigger live provider punishment without conviction.",
        "price-controller-bounds": "Graduation means price movement is bounded and explainable, not that the economic parameters are final.",
        "subsidy-farming": "Graduation means non-compliant responsibility is not profitably subsidized by base rewards.",
        "storage-escrow-close-refund": "Graduation means storage lock-in, earned-fee payout, early close refund, and run-end outstanding escrow are deterministic before keeper close/refund semantics are implemented.",
        "storage-escrow-noncompliance-burn": "Graduation means earned storage fees can be withheld from non-compliant responsibility and burned without confusing storage lock-in or availability accounting.",
        "storage-escrow-expiry": "Graduation means fully earned storage deals can auto-expire without continuing active responsibility or leaving hidden escrow.",
        "expired-retrieval-rejection": "Graduation means post-expiry reads return explicit expired-content rejection semantics without counting as unavailable reads or debiting retrieval escrow.",
        "closed-retrieval-rejection": "Graduation means post-close reads return explicit closed-content rejection semantics without counting as unavailable reads or debiting retrieval escrow.",
        "coordinated-regional-outage": "Graduation means regional placement assumptions preserve durability and make temporary availability misses explicit.",
        "repair-candidate-exhaustion": "Graduation means repair backoff is visible and capacity is respected rather than silently over-assigning providers.",
        "replacement-grinding": "Graduation means pending-provider readiness failures are bounded by timeout, cooldown, and attempt caps instead of leaving unbounded in-flight repairs.",
        "high-bandwidth-promotion": "Graduation means measured provider capability can promote hot-path eligibility without degrading availability or over-assigning capacity.",
        "high-bandwidth-regression": "Graduation means hot-path eligibility can be revoked when measured saturation regresses without causing durability loss.",
        "performance-market-latency": "Graduation means latency-tier windows, service-class attribution, and tiered performance rewards are deterministic and inspectable before keeper params are implemented.",
        "operator-concentration-cap": "Graduation means operator identity and per-deal assignment caps can limit Sybil blast radius before keeper placement parameters are implemented.",
        "large-scale-regional-stress": "Graduation means the scale model preserves durability, exposes bottlenecks, and gives humans enough context to tune availability and economics.",
    }
    return semantics.get(
        scenario,
        "Graduation is case-by-case: define which invariant is being proven, which threshold is merely diagnostic, and which implementation layer should receive the next test.",
    )


def write_graduation_report(path: Path, summary: dict[str, Any]) -> None:
    config = summary["config"]
    totals = summary["totals"]
    assertions = summary.get("assertions", [])
    failed = [item for item in assertions if not item.get("passed")]
    scenario = config["scenario"]
    guide = scenario_guide(str(scenario))
    assertions_ready = bool(assertions) and not failed
    data_loss_ready = fnum(totals.get("data_loss_events")) == 0
    availability_ready = fnum(totals.get("unavailable_reads")) == 0 or (
        scenario_allows_unavailable_reads(str(scenario)) and assertions_ready
    )
    corrupt_ready = fnum(totals.get("paid_corrupt_bytes")) == 0
    repair_ready = True
    if scenario in {
        "single-outage",
        "withholding",
        "corrupt-provider",
        "invalid-synthetic-proof",
        "malicious-corrupt",
        "lazy-provider",
        "setup-failure",
    }:
        repair_ready = (
            fnum(totals.get("repairs_started")) > 0
            and fnum(totals.get("repairs_ready")) > 0
            and fnum(totals.get("repairs_completed")) > 0
        )
    hard_enforcement_ready = (
        scenario not in {"corrupt-provider", "invalid-synthetic-proof", "malicious-corrupt"}
        or fnum(totals.get("provider_slashed")) > 0
    )
    ready = assertions_ready and data_loss_ready and availability_ready and corrupt_ready and repair_ready and hard_enforcement_ready

    if ready and scenario in {
        "ideal",
        "single-outage",
        "withholding",
        "corrupt-provider",
        "invalid-synthetic-proof",
        "malicious-corrupt",
        "lazy-provider",
        "setup-failure",
        "deputy-evidence-spam",
        "high-bandwidth-promotion",
        "high-bandwidth-regression",
        "performance-market-latency",
        "operator-concentration-cap",
        "staged-upload-grief",
        "elasticity-overlay-scaleup",
        "viral-public-retrieval",
        "storage-escrow-close-refund",
        "storage-escrow-noncompliance-burn",
        "storage-escrow-expiry",
        "expired-retrieval-rejection",
        "closed-retrieval-rejection",
    }:
        recommendation = "Candidate for implementation planning."
        rationale = "The fixture passed its assertion contract and exercised the expected enforcement path."
    elif ready:
        recommendation = "Candidate for further simulation review."
        rationale = "The fixture passed, but it primarily informs economic/product policy rather than immediate keeper enforcement."
    else:
        recommendation = "Do not graduate yet."
        rationale = "One or more readiness checks failed or the fixture is missing an assertion contract."

    lines = [
        f"# Graduation Assessment: {guide['title']}",
        "",
        guide["intent"],
        "",
        "## Recommendation",
        "",
        f"**{recommendation}** {rationale}",
        "",
        "## Readiness Checklist",
        "",
        "| Check | Result | Why It Matters |",
        "|---|---|---|",
        f"| Assertion contract passes | `{str(assertions_ready).lower()}` | The scenario must have explicit machine-readable policy expectations. |",
        f"| No modeled data loss | `{str(data_loss_ready).lower()}` | Temporary unavailable reads can be scenario-specific, but durability loss should block graduation. |",
        f"| Availability within scenario contract | `{str(availability_ready).lower()}` | Enforcement must not harm users beyond the availability bounds chosen for this case. |",
        f"| Corrupt bytes not paid | `{str(corrupt_ready).lower()}` | Bad data must never be economically rewarded. |",
        f"| Repair path exercised when expected | `{str(repair_ready).lower()}` | Fault scenarios should prove detection, pending-provider readiness, and promotion. |",
        f"| Hard enforcement represented when expected | `{str(hard_enforcement_ready).lower()}` | Corruption fixtures should prove the simulated slash/jail accounting path before keeper work. |",
        "",
        "## Scenario-Specific Graduation Semantics",
        "",
        graduation_semantics(str(scenario)),
        "",
        "## Candidate Next Artifact",
        "",
    ]
    if recommendation == "Candidate for implementation planning." and scenario in {
        "high-bandwidth-promotion",
        "high-bandwidth-regression",
    }:
        lines.append("Create a keeper/runtime planning ticket that names the capability thresholds, probe telemetry, hot-route preference, assignment caps, and demotion conditions this fixture should enforce.")
    elif recommendation == "Candidate for implementation planning." and scenario == "performance-market-latency":
        lines.append("Create a keeper/runtime planning ticket that names service-class params, latency-tier windows, reward multipliers, telemetry inputs, and which QoS tiers affect placement without becoming slashable evidence.")
    elif recommendation == "Candidate for implementation planning." and scenario == "operator-concentration-cap":
        lines.append("Create a keeper/runtime planning ticket that names operator identity source, per-deal assignment caps, replacement fallback behavior, and concentration alert thresholds.")
    elif recommendation == "Candidate for implementation planning." and scenario == "staged-upload-grief":
        lines.append("Create a gateway/provider-daemon planning ticket that names staged-generation TTL, pending-generation caps, preflight rejection semantics, cleanup events, and operator dry-run/apply tooling.")
    elif recommendation == "Candidate for implementation planning." and scenario == "elasticity-overlay-scaleup":
        lines.append("Create a keeper/gateway/provider-daemon planning ticket that names MsgSignalSaturation inputs, overlay readiness proof, spend-window accounting, TTL expiration, route preference, and overlay reward/audit rules.")
    elif recommendation == "Candidate for implementation planning." and scenario == "viral-public-retrieval":
        lines.append("Create a keeper/gateway planning ticket that names sponsored-session funding, owner escrow isolation, retrieval burn/payout accounting, quote display, and close/refund semantics.")
    elif recommendation == "Candidate for implementation planning." and scenario == "storage-escrow-close-refund":
        lines.append("Create a keeper/gateway planning ticket that names storage quote parity, upfront lock-in, per-epoch earned-fee payout, early close refund, expiry auto-close, and refund rounding semantics.")
    elif recommendation == "Candidate for implementation planning." and scenario == "storage-escrow-noncompliance-burn":
        lines.append("Create a keeper/gateway planning ticket that names storage-fee reward eligibility, burn ledger attribution, delinquency windows, repair interaction, and provider payout query semantics.")
    elif recommendation == "Candidate for implementation planning." and scenario == "storage-escrow-expiry":
        lines.append("Create a keeper/gateway planning ticket that names expiry auto-close, final earned-fee settlement, deal GC timing, query state, and retrieval behavior after expiry.")
    elif recommendation == "Candidate for implementation planning." and scenario == "expired-retrieval-rejection":
        lines.append("Create a keeper/gateway planning ticket that names expired-deal query state, post-expiry retrieval response codes, no-bill retrieval accounting, and UI/API messaging for expired content.")
    elif recommendation == "Candidate for implementation planning." and scenario == "closed-retrieval-rejection":
        lines.append("Create a keeper/gateway planning ticket that names closed-deal query state, post-close retrieval response codes, no-bill retrieval accounting, and UI/API messaging for intentionally closed content.")
    elif recommendation == "Candidate for implementation planning." and scenario == "deputy-evidence-spam":
        lines.append("Create a keeper/runtime planning ticket that names evidence bond escrow, burn-on-expiry, conviction-gated bounty payout, spam throttles, and deputy reputation inputs.")
    elif recommendation == "Candidate for implementation planning.":
        lines.append("Create a keeper/e2e planning ticket that names the exact evidence rows, reward-accounting rule, and repair transition this fixture should enforce.")
    elif recommendation == "Candidate for further simulation review.":
        lines.append("Create a policy-review note that compares this scenario against at least one baseline and one adversarial variant.")
    else:
        lines.append("Do not create implementation tickets until the failing readiness check has a human-approved policy resolution.")
    lines.extend(
        [
            "",
            "## Missing Human Decisions",
            "",
            "- Confirm whether the assertion bounds are the intended policy thresholds.",
            "- Confirm whether this scenario should graduate to keeper tests, gateway e2e tests, provider-daemon tests, or remain simulator-only.",
            "- Confirm which metrics become governance parameters versus internal monitoring thresholds.",
            "- Confirm whether any economic assumption is realistic enough to affect product or token policy.",
        ]
    )
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def write_graphs(graphs_dir: Path, epochs: list[dict[str, str]], economy: list[dict[str, str]]) -> None:
    write_line_svg(
        graphs_dir / "retrieval_success_rate.svg",
        "Retrieval Success Rate",
        [safe_rate(row, "retrieval_successes", "retrieval_attempts") for row in epochs],
    )
    write_line_svg(
        graphs_dir / "slot_states.svg",
        "Active Slots",
        [fnum(row.get("active_slots")) for row in epochs],
        secondary=[fnum(row.get("repairing_slots")) for row in epochs],
        secondary_label="Repairing Slots",
    )
    write_line_svg(
        graphs_dir / "provider_pnl.svg",
        "Provider P&L",
        [fnum(row.get("provider_pnl")) for row in economy],
    )
    write_line_svg(
        graphs_dir / "provider_cost_shock.svg",
        "Provider Cost",
        [fnum(row.get("provider_cost")) for row in economy],
        secondary=[fnum(row.get("provider_revenue")) for row in economy],
        secondary_label="Provider Revenue",
    )
    write_line_svg(
        graphs_dir / "provider_churn.svg",
        "Churned Providers",
        [fnum(row.get("churned_providers")) for row in economy],
        secondary=[fnum(row.get("provider_churn_events")) for row in economy],
        secondary_label="Provider Churn Events",
    )
    write_line_svg(
        graphs_dir / "provider_supply.svg",
        "Provider Entries",
        [fnum(row.get("provider_entries")) for row in economy],
        secondary=[fnum(row.get("provider_probation_promotions")) for row in economy],
        secondary_label="Probation Promotions",
    )
    write_line_svg(
        graphs_dir / "provider_bond_headroom.svg",
        "Underbonded Providers",
        [fnum(row.get("underbonded_providers")) for row in economy],
        secondary=[fnum(row.get("provider_underbonded_repairs")) for row in economy],
        secondary_label="Underbonded Repairs",
    )
    write_line_svg(
        graphs_dir / "burn_mint_ratio.svg",
        "Burn / Mint Ratio",
        [burn_mint_ratio(row) for row in economy],
    )
    write_line_svg(
        graphs_dir / "storage_escrow_lifecycle.svg",
        "Storage Escrow Lifecycle",
        [fnum(row.get("storage_escrow_outstanding")) for row in economy],
        secondary=[fnum(row.get("storage_escrow_refunded")) for row in economy],
        secondary_label="Refunded Escrow",
    )
    write_line_svg(
        graphs_dir / "price_trajectory.svg",
        "Price Trajectory",
        [fnum(row.get("storage_price")) for row in economy],
        secondary=[fnum(row.get("retrieval_price_per_slot")) for row in economy],
        secondary_label="Retrieval Price",
    )
    write_line_svg(
        graphs_dir / "retrieval_demand.svg",
        "Retrieval Attempts",
        [fnum(row.get("retrieval_attempts")) for row in epochs],
        secondary=[fnum(row.get("retrieval_latent_attempts")) for row in epochs],
        secondary_label="Latent Retrieval Attempts",
    )
    write_line_svg(
        graphs_dir / "storage_demand.svg",
        "New Deals Accepted",
        [fnum(row.get("new_deals_accepted")) for row in economy],
        secondary=[
            fnum(row.get("new_deals_rejected_price")) + fnum(row.get("new_deals_suppressed_price"))
            for row in economy
        ],
        secondary_label="Price Rejections + Suppressed",
    )
    write_line_svg(
        graphs_dir / "capacity_utilization.svg",
        "Capacity Utilization BPS",
        [fnum(row.get("storage_utilization_bps")) for row in economy],
    )
    write_line_svg(
        graphs_dir / "saturation_and_repair.svg",
        "Saturation And Repair Pressure",
        [fnum(row.get("saturated_responses")) for row in epochs],
        secondary=[fnum(row.get("repair_backoffs")) for row in epochs],
        secondary_label="Repair Backoffs",
    )
    write_line_svg(
        graphs_dir / "repair_backlog.svg",
        "Repair Backlog",
        repair_backlog_series(epochs),
    )
    write_line_svg(
        graphs_dir / "repair_readiness.svg",
        "Repair Readiness Timeouts",
        [fnum(row.get("repair_timeouts")) for row in epochs],
        secondary=[fnum(row.get("repairs_ready")) for row in epochs],
        secondary_label="Repairs Ready",
    )
    write_line_svg(
        graphs_dir / "high_bandwidth_promotion.svg",
        "High-Bandwidth Providers",
        [fnum(row.get("high_bandwidth_providers")) for row in epochs],
        secondary=[fnum(row.get("high_bandwidth_promotions")) for row in epochs],
        secondary_label="Promotions",
    )
    write_line_svg(
        graphs_dir / "hot_retrieval_routing.svg",
        "Hot Retrieval Attempts",
        [fnum(row.get("hot_retrieval_attempts")) for row in epochs],
        secondary=[fnum(row.get("hot_high_bandwidth_serves")) for row in epochs],
        secondary_label="Hot High-BW Serves",
    )
    write_line_svg(
        graphs_dir / "performance_tiers.svg",
        "Platinum Serves",
        [fnum(row.get("platinum_serves")) for row in epochs],
        secondary=[fnum(row.get("fail_serves")) for row in epochs],
        secondary_label="Fail Serves",
    )
    write_line_svg(
        graphs_dir / "operator_concentration.svg",
        "Top Operator Assignment Share BPS",
        [fnum(row.get("max_operator_assignment_share_bps")) for row in epochs],
        secondary=[fnum(row.get("operator_deal_cap_violations")) for row in epochs],
        secondary_label="Cap Violations",
    )
    write_line_svg(
        graphs_dir / "evidence_pressure.svg",
        "Soft Evidence Events",
        [fnum(row.get("quota_misses")) + fnum(row.get("deputy_misses")) for row in epochs],
        secondary=[fnum(row.get("invalid_proofs")) for row in epochs],
        secondary_label="Invalid Proofs",
    )
    write_line_svg(
        graphs_dir / "evidence_spam.svg",
        "Evidence Spam Bond Burn",
        [fnum(row.get("evidence_spam_bond_burned")) for row in economy],
        secondary=[fnum(row.get("evidence_spam_bounty_paid")) for row in economy],
        secondary_label="Bounty Paid",
    )
    write_line_svg(
        graphs_dir / "audit_budget.svg",
        "Audit Budget Spent",
        [fnum(row.get("audit_budget_spent")) for row in economy],
        secondary=[fnum(row.get("audit_budget_carryover")) for row in economy],
        secondary_label="Carryover",
    )
    write_line_svg(
        graphs_dir / "audit_backlog.svg",
        "Audit Backlog",
        [fnum(row.get("audit_budget_backlog")) for row in economy],
        secondary=[fnum(row.get("audit_budget_exhausted")) for row in economy],
        secondary_label="Exhausted Epoch",
    )
    write_line_svg(
        graphs_dir / "sponsored_retrieval_accounting.svg",
        "Sponsored Retrieval Spend",
        [
            fnum(row.get("sponsored_retrieval_base_spent"))
            + fnum(row.get("sponsored_retrieval_variable_spent"))
            for row in economy
        ],
        secondary=[fnum(row.get("owner_retrieval_escrow_debited")) for row in economy],
        secondary_label="Owner Escrow Debit",
    )
    write_line_svg(
        graphs_dir / "elasticity_spend.svg",
        "Elasticity Spend",
        [fnum(row.get("elasticity_spent")) for row in economy],
        secondary=[fnum(row.get("elasticity_rejections")) for row in economy],
        secondary_label="Rejected Expansions",
    )
    write_line_svg(
        graphs_dir / "elasticity_overlay_routes.svg",
        "Elasticity Overlay Active Routes",
        [fnum(row.get("elasticity_overlay_active")) for row in economy],
        secondary=[fnum(row.get("elasticity_overlay_serves")) for row in economy],
        secondary_label="Overlay Serves",
    )
    write_line_svg(
        graphs_dir / "staged_upload_pressure.svg",
        "Staged Pending Generations",
        [fnum(row.get("staged_upload_pending_generations")) for row in economy],
        secondary=[fnum(row.get("staged_upload_rejections")) for row in economy],
        secondary_label="Preflight Rejections",
    )


def safe_rate(row: dict[str, str], num: str, denom: str) -> float:
    denominator = fnum(row.get(denom))
    if denominator == 0:
        return 0.0
    return fnum(row.get(num)) / denominator


def burn_mint_ratio(row: dict[str, str]) -> float:
    burned = (
        fnum(row.get("retrieval_base_burned"))
        + fnum(row.get("retrieval_variable_burned"))
        + fnum(row.get("reward_burned"))
        + fnum(row.get("evidence_spam_bond_burned"))
    )
    minted = fnum(row.get("reward_pool_minted")) + fnum(row.get("audit_budget_minted"))
    return burned / minted if minted else 0.0


def repair_backlog_series(epochs: list[dict[str, str]]) -> list[float]:
    backlog = 0.0
    out = []
    for row in epochs:
        backlog += (
            fnum(row.get("repairs_started"))
            - fnum(row.get("repairs_completed"))
            - fnum(row.get("repair_timeouts"))
        )
        out.append(max(0.0, backlog))
    return out


def write_line_svg(
    path: Path,
    title: str,
    values: list[float],
    secondary: list[float] | None = None,
    secondary_label: str = "",
) -> None:
    width = 860
    height = 420
    left = 86
    right = 36
    top = 78
    bottom = 78
    plot_width = width - left - right
    plot_height = height - top - bottom
    all_values = values + (secondary or [])
    if not all_values:
        all_values = [0.0]
    lo_raw = min(all_values)
    hi_raw = max(all_values)
    lo = 0.0 if lo_raw >= 0 else lo_raw
    hi = hi_raw
    if hi == lo:
        hi = lo + 1.0
    padding = (hi - lo) * 0.06
    if lo_raw < 0:
        lo -= padding
    hi += padding

    def points(series: list[float]) -> str:
        if len(series) == 1:
            xs = [left]
        else:
            xs = [left + i * plot_width / (len(series) - 1) for i in range(len(series))]
        pts = []
        for x, value in zip(xs, series):
            y = top + plot_height - ((value - lo) / (hi - lo)) * plot_height
            pts.append(f"{x:.1f},{y:.1f}")
        return " ".join(pts)

    y_ticks = [lo + (hi - lo) * i / 4 for i in range(5)]
    x_count = max(len(values), len(secondary or []), 1)
    x_tick_indices = sorted({round(i * (x_count - 1) / min(5, max(1, x_count - 1))) for i in range(min(6, x_count))})
    y_grid = []
    for tick in y_ticks:
        y = top + plot_height - ((tick - lo) / (hi - lo)) * plot_height
        y_grid.append(
            f'<line x1="{left}" y1="{y:.1f}" x2="{width - right}" y2="{y:.1f}" stroke="#e5e7eb" stroke-width="1"/>'
        )
        y_grid.append(
            f'<text x="{left - 10}" y="{y + 4:.1f}" font-family="sans-serif" font-size="11" text-anchor="end" fill="#4b5563">{escape_xml(axis_tick(tick))}</text>'
        )
    x_grid = []
    for idx in x_tick_indices:
        x = left if x_count == 1 else left + idx * plot_width / (x_count - 1)
        label = str(idx + 1)
        x_grid.append(
            f'<line x1="{x:.1f}" y1="{top}" x2="{x:.1f}" y2="{top + plot_height}" stroke="#f3f4f6" stroke-width="1"/>'
        )
        x_grid.append(
            f'<text x="{x:.1f}" y="{top + plot_height + 22}" font-family="sans-serif" font-size="11" text-anchor="middle" fill="#4b5563">{escape_xml(label)}</text>'
        )

    primary_label = title
    secondary_polyline = ""
    secondary_legend = ""
    if secondary:
        secondary_polyline = f'  <polyline fill="none" stroke="#d97706" stroke-width="2.5" points="{points(secondary)}" />'
        secondary_legend = f'''  <line x1="{left + 190}" y1="52" x2="{left + 220}" y2="52" stroke="#d97706" stroke-width="3"/>
  <text x="{left + 226}" y="56" font-family="sans-serif" font-size="12" fill="#374151">{escape_xml(secondary_label or "Secondary")}</text>'''
    svg = f'''<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}">
  <rect width="100%" height="100%" fill="#ffffff"/>
  <text x="{left}" y="26" font-family="sans-serif" font-size="18" font-weight="700" fill="#111827">{escape_xml(title)}</text>
  <line x1="{left}" y1="52" x2="{left + 30}" y2="52" stroke="#2563eb" stroke-width="3"/>
  <text x="{left + 36}" y="56" font-family="sans-serif" font-size="12" fill="#374151">{escape_xml(primary_label)}</text>
{secondary_legend}
  <rect x="{left}" y="{top}" width="{plot_width}" height="{plot_height}" fill="#ffffff" stroke="#d1d5db"/>
  {"".join(y_grid)}
  {"".join(x_grid)}
  <line x1="{left}" y1="{top + plot_height}" x2="{width - right}" y2="{top + plot_height}" stroke="#111827" stroke-width="1.2"/>
  <line x1="{left}" y1="{top}" x2="{left}" y2="{top + plot_height}" stroke="#111827" stroke-width="1.2"/>
  <text x="{left + plot_width / 2:.1f}" y="{height - 24}" font-family="sans-serif" font-size="13" text-anchor="middle" fill="#111827">Epoch</text>
  <text transform="translate(22 {top + plot_height / 2:.1f}) rotate(-90)" font-family="sans-serif" font-size="13" text-anchor="middle" fill="#111827">{escape_xml(title)}</text>
  <polyline fill="none" stroke="#2563eb" stroke-width="2.5" points="{points(values)}" />
{secondary_polyline}
</svg>
'''
    path.write_text(svg, encoding="utf-8")


def axis_tick(value: float) -> str:
    if abs(value) >= 1000:
        return f"{value:,.0f}"
    if abs(value) >= 100:
        return f"{value:.0f}"
    if abs(value) >= 10:
        return f"{value:.1f}"
    if abs(value) >= 1:
        return f"{value:.2f}"
    return f"{value:.4f}"


def escape_xml(value: str) -> str:
    return value.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def generate_policy_delta(baseline_dir: Path, candidate_dir: Path, out_dir: Path) -> None:
    baseline = load_json(baseline_dir / "summary.json")
    candidate = load_json(candidate_dir / "summary.json")
    baseline_name = str(baseline["config"].get("scenario", "baseline"))
    candidate_name = str(candidate["config"].get("scenario", "candidate"))
    baseline_guide = scenario_guide(baseline_name)
    candidate_guide = scenario_guide(candidate_name)
    keys = sorted(set(baseline["totals"].keys()) | set(candidate["totals"].keys()))
    material = []
    for key in keys:
        b = fnum(baseline["totals"].get(key))
        c = fnum(candidate["totals"].get(key))
        if b == 0 and c == 0:
            continue
        material.append((key, b, c, c - b))
    ranked = sorted(material, key=lambda item: abs(item[3]), reverse=True)
    lines = [
        f"# Policy Delta: {baseline_guide['title']} -> {candidate_guide['title']}",
        "",
        "## Summary",
        "",
        f"Baseline scenario `{baseline_name}` represents: {baseline_guide['intent']}",
        "",
        f"Candidate scenario `{candidate_name}` represents: {candidate_guide['intent']}",
        "",
        "This report is intended to answer: what changed when we moved from the control case to the candidate policy/fault case, and are those changes desirable?",
        "",
    ]
    if baseline["config"].get("epochs") != candidate["config"].get("epochs"):
        lines.extend(
            [
                "**Comparability note:** these runs use different epoch counts, so raw volume metrics such as retrieval attempts, rewards, and costs are not directly comparable without normalization. Prefer rates, evidence classes, and scenario-specific invariants for review.",
                "",
            ]
        )
    lines.extend(
        [
        "## Decision Metrics",
        "",
        "| Metric | Baseline | Candidate | Interpretation |",
        "|---|---:|---:|---|",
        *decision_metric_lines(baseline, candidate),
        "",
        "## High-Signal Changes",
        "",
        "| Metric | Baseline | Candidate | Delta | Interpretation |",
        "|---|---:|---:|---:|---|",
        ]
    )
    for key, b, c, delta in ranked[:12]:
        lines.append(f"| `{key}` | {b:.6f} | {c:.6f} | {delta:.6f} | {delta_interpretation(key, b, c, delta)} |")
    lines.extend(
        [
            "",
            "## Full Metric Delta",
            "",
            "| Metric | Baseline | Candidate | Delta |",
            "|---|---:|---:|---:|",
        ]
    )
    for key, b, c, delta in material:
        lines.append(f"| `{key}` | {b:.6f} | {c:.6f} | {c - b:.6f} |")
    lines.extend(
        [
            "",
            "## Human Review Questions",
            "",
            "- Did the candidate preserve the baseline availability invariant?",
            "- Did the candidate create evidence and repair activity only where expected?",
            "- Did rewards move away from non-compliant providers without over-penalizing healthy providers?",
            "- Did market metrics move in a direction that supports provider retention rather than hidden churn?",
        ]
    )
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "policy_delta.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


def decision_metric_lines(baseline: dict[str, Any], candidate: dict[str, Any]) -> list[str]:
    baseline_totals = baseline["totals"]
    candidate_totals = candidate["totals"]
    metrics = [
        ("success_rate", "Availability invariant."),
        ("unavailable_reads", "Temporary read failures; acceptable only in explicitly bounded stress cases."),
        ("expired_retrieval_attempts", "Post-expiry read requests rejected as expired content instead of live availability failures."),
        ("closed_retrieval_attempts", "Post-close read requests rejected as closed content instead of live availability failures."),
        ("data_loss_events", "Durability invariant; should stay zero for current fixtures."),
        ("reward_coverage", "Whether compliant slots remain economically recognized."),
        ("repairs_started", "Whether the candidate exercised repair."),
        ("repairs_completed", "Whether repair finished within the modeled window."),
        ("repair_attempts", "Whether repair retry/accounting pressure changed."),
        ("repair_cooldowns", "Whether repair retry cooldown throttling was exercised."),
        ("repair_attempt_caps", "Whether per-slot repair attempt caps were hit."),
        ("repair_timeouts", "Whether pending provider readiness failures were exercised."),
        ("suspect_slots", "Whether soft warning state was exercised."),
        ("delinquent_slots", "Whether threshold-crossed slot state was exercised."),
        ("quota_misses", "Soft liveness evidence created by the candidate."),
        ("invalid_proofs", "Hard evidence created by the candidate."),
        ("paid_corrupt_bytes", "Corrupt data payment safety invariant."),
        ("providers_negative_pnl", "Economic sustainability/churn indicator."),
        ("provider_cost_shock_active", "Whether an external provider-cost shock was active."),
        ("max_provider_cost_shocked_providers", "How much provider population the cost shock affected."),
        ("max_provider_cost_shock_storage_multiplier_bps", "Peak modeled storage-cost shock multiplier."),
        ("saturated_responses", "Whether heterogeneous provider bandwidth became a bottleneck."),
        ("repair_backoffs", "Whether healing coordination or replacement capacity became constrained."),
        ("high_bandwidth_promotions", "Whether measured fast providers became hot-route eligible."),
        ("high_bandwidth_demotions", "Whether capability regression removed hot-route eligibility."),
        ("hot_high_bandwidth_serves", "Whether hot traffic actually used promoted providers."),
        ("platinum_serves", "Whether the fastest performance tier was exercised."),
        ("fail_serves", "Whether slow/failed QoS service appeared."),
        ("performance_reward_paid", "Whether tiered performance rewards were paid."),
        ("retrieval_latent_attempts", "Baseline retrieval demand before shock multipliers."),
        ("retrieval_demand_shock_active", "Whether a retrieval demand shock was active."),
        ("max_retrieval_demand_multiplier_bps", "Peak modeled retrieval-demand multiplier."),
        ("retrieval_price_direction_changes", "Whether retrieval pricing oscillated."),
        ("sponsored_retrieval_attempts", "How many retrieval attempts used sponsor/requester-funded sessions."),
        ("sponsored_retrieval_spent", "How much sponsor/requester-funded retrieval spend was modeled."),
        ("owner_retrieval_escrow_debited", "Whether public reads drained owner deal escrow."),
        ("storage_escrow_locked", "How much storage escrow was locked upfront."),
        ("storage_escrow_earned", "How much storage escrow was earned over service epochs."),
        ("storage_escrow_refunded", "How much unearned storage escrow was refunded."),
        ("storage_escrow_outstanding", "Whether any storage escrow remained locked at run end."),
        ("storage_fee_provider_payouts", "How much earned storage fee was paid to providers."),
        ("storage_fee_burned", "How much earned storage fee was withheld or burned."),
        ("deals_expired", "How many deal expiry events occurred."),
        ("final_closed_deals", "How many deals closed by run end."),
        ("final_expired_deals", "How many deals expired by run end."),
        ("new_deal_latent_requests", "How much write demand existed before price elasticity."),
        ("new_deal_requests", "How much modeled write demand remained after price elasticity."),
        ("new_deals_accepted", "How much new storage demand entered the network."),
        ("new_deals_suppressed_price", "How much latent demand was suppressed before requesting because storage price was unattractive."),
        ("new_deals_rejected_price", "How much demand was rejected because storage price exceeded willingness to pay."),
        ("new_deals_rejected_capacity", "How much demand was rejected because placement capacity was exhausted."),
        ("new_deal_acceptance_rate", "Demand-side market health among effective requests."),
        ("new_deal_latent_acceptance_rate", "Demand-side market health relative to latent demand."),
        ("elasticity_overlay_activations", "How many temporary overflow routes were activated."),
        ("elasticity_overlay_serves", "Whether overflow routes actually served retrievals."),
        ("elasticity_overlay_expired", "Whether temporary routes aged out by TTL."),
        ("elasticity_overlay_rejections", "Whether spend caps or candidate selection rejected overlay expansion."),
        ("max_elasticity_overlay_ready", "Peak ready overflow route footprint."),
        ("max_elasticity_overlay_active", "Peak active overflow route footprint including pending readiness."),
        ("staged_upload_attempts", "How much provisional upload pressure was modeled."),
        ("staged_upload_rejections", "Whether preflight caps rejected abandoned provisional generations."),
        ("staged_upload_cleaned", "Whether retention cleanup removed abandoned provisional generations."),
        ("max_staged_upload_pending_generations", "Peak local pending provisional-generation footprint."),
        ("max_staged_upload_pending_mdus", "Peak local pending provisional MDU footprint."),
        ("top_operator_assignment_share_bps", "Whether one operator dominates assignments."),
        ("max_operator_deal_slots", "Whether per-deal operator blast radius is bounded."),
        ("operator_deal_cap_violations", "Whether operator assignment caps were violated."),
        ("final_storage_utilization_bps", "Final active-slot utilization against modeled provider capacity."),
    ]
    lines = []
    for key, meaning in metrics:
        lines.append(
            f"| `{key}` | {fnum(baseline_totals.get(key)):.6f} | {fnum(candidate_totals.get(key)):.6f} | {meaning} |"
        )
    return lines


def delta_interpretation(key: str, baseline: float, candidate: float, delta: float) -> str:
    if key == "success_rate":
        if candidate >= baseline:
            return "Availability was preserved or improved."
        return "Availability degraded; this should block graduation unless intentional."
    if key == "unavailable_reads":
        if delta > 0:
            return "Temporary read misses increased; acceptable only in explicitly bounded scale scenarios."
        return "Temporary read misses did not increase."
    if key == "expired_retrieval_attempts":
        if delta > 0:
            return "More post-expiry reads were rejected explicitly instead of treated as live availability failures."
        return "Post-expiry rejection volume did not increase."
    if key == "closed_retrieval_attempts":
        if delta > 0:
            return "More post-close reads were rejected explicitly instead of treated as live availability failures."
        return "Post-close rejection volume did not increase."
    if key == "data_loss_events":
        if candidate > 0:
            return "Durability invariant failed; this should block graduation."
        return "Durability invariant remained clean."
    if key in {"repairs_started", "repairs_completed", "repairing_slots"}:
        if delta > 0:
            return "Repair path was exercised in the candidate scenario."
        return "Repair activity did not increase."
    if key in {"quota_misses", "deputy_misses", "invalid_proofs", "withheld_responses", "offline_responses", "suspect_slots", "delinquent_slots"}:
        if delta > 0:
            return "Candidate generated additional policy evidence."
        return "Candidate did not add this evidence class."
    if key in {"reward_burned", "provider_slashed"}:
        if delta > 0:
            return "Candidate increased enforcement/accounting penalties."
        return "No additional penalty was applied."
    if key in {"provider_pnl", "provider_revenue", "provider_cost"}:
        return "Economic accounting changed; inspect provider distribution before drawing conclusions."
    if key in {
        "provider_cost_shock_active",
        "max_provider_cost_shocked_providers",
        "max_provider_cost_shock_fixed_multiplier_bps",
        "max_provider_cost_shock_storage_multiplier_bps",
        "max_provider_cost_shock_bandwidth_multiplier_bps",
        "provider_churn_events",
        "churned_providers",
        "churn_pressure_provider_epochs",
        "max_churn_pressure_providers",
        "final_active_provider_capacity",
        "final_exited_provider_capacity",
        "max_churned_assigned_slots",
    }:
        return "Provider economic pressure changed; inspect churn, capacity exit, and price response."
    if key == "providers_negative_pnl":
        if delta > 0:
            return "More providers are economically distressed."
        return "Provider distress did not increase."
    if key in {
        "retrieval_base_burned",
        "retrieval_variable_burned",
        "retrieval_provider_payouts",
        "sponsored_retrieval_attempts",
        "sponsored_retrieval_spent",
        "owner_retrieval_escrow_debited",
    }:
        return "Retrieval market accounting changed with demand volume or price settings."
    if key in {
        "retrieval_latent_attempts",
        "retrieval_demand_shock_active",
        "max_retrieval_demand_multiplier_bps",
        "retrieval_price_direction_changes",
        "storage_price_direction_changes",
    }:
        return "Retrieval demand or pricing control changed; inspect price trajectory and oscillation bounds."
    if key in {"platinum_serves", "gold_serves", "silver_serves", "fail_serves", "performance_reward_paid"}:
        return "Performance-market tiering changed; inspect service-class latency and reward assumptions."
    if key in {
        "new_deal_latent_requests",
        "new_deal_requests",
        "new_deals_accepted",
        "new_deals_suppressed_price",
        "new_deals_rejected_price",
        "new_deals_rejected_capacity",
        "new_deal_acceptance_rate",
        "new_deal_latent_acceptance_rate",
    }:
        return "Storage demand changed; inspect price affordability and capacity admission assumptions."
    if key in {
        "elasticity_overlay_activations",
        "elasticity_overlay_expired",
        "elasticity_overlay_serves",
        "elasticity_overlay_rejections",
        "final_elasticity_overlay_active",
        "max_elasticity_overlay_active",
        "final_elasticity_overlay_ready",
        "max_elasticity_overlay_ready",
    }:
        return "Elasticity overlay pressure changed; inspect spend caps, readiness delay, TTL, and route preference semantics."
    if key in {
        "storage_escrow_locked",
        "storage_escrow_earned",
        "storage_escrow_refunded",
        "storage_escrow_outstanding",
        "storage_fee_provider_payouts",
        "storage_fee_burned",
        "deals_closed",
        "deals_expired",
        "final_open_deals",
        "final_closed_deals",
        "final_expired_deals",
    }:
        return "Storage escrow lifecycle changed; inspect quote parity, earned-fee payout, close/refund timing, and outstanding escrow."
    if key in {
        "staged_upload_attempts",
        "staged_upload_accepted",
        "staged_upload_committed",
        "staged_upload_rejections",
        "staged_upload_cleaned",
        "final_staged_upload_pending_generations",
        "max_staged_upload_pending_generations",
        "final_staged_upload_pending_mdus",
        "max_staged_upload_pending_mdus",
    }:
        return "Staged upload pressure changed; inspect retention TTL, preflight caps, and cleanup semantics."
    if key in {"top_operator_assignment_share_bps", "max_operator_assignment_share_bps", "max_operator_deal_slots", "operator_deal_cap_violations"}:
        return "Operator concentration changed; inspect placement diversity and cap semantics."
    if key == "saturated_responses":
        if delta > 0:
            return "Candidate exposed provider bandwidth saturation."
        return "Bandwidth saturation did not increase."
    if key in {"repair_backoffs", "repair_cooldowns", "repair_attempt_caps", "repair_timeouts"}:
        if delta > 0:
            return "Candidate exposed repair coordination limits."
        return "Repair coordination limits did not increase."
    if key in {"high_bandwidth_promotions", "high_bandwidth_providers"}:
        if delta > 0:
            return "Provider capability promotion increased."
        return "Provider capability promotion did not increase."
    if key == "high_bandwidth_demotions":
        if delta > 0:
            return "Provider capability regression increased; inspect whether this was intended."
        return "Provider capability demotion did not increase."
    if key in {"hot_retrieval_attempts", "hot_high_bandwidth_serves", "high_bandwidth_serves"}:
        return "Hot routing or high-bandwidth serve accounting changed."
    if key == "final_storage_utilization_bps":
        return "Final storage utilization changed against modeled provider capacity."
    return "Metric changed; inspect the full report for causal context."


def generate_sweep_report(sweep_dir: Path, out_dir: Path) -> None:
    run_dirs = discover_run_dirs(sweep_dir)
    rows = [sweep_row(run_dir) for run_dir in run_dirs]
    varied = varied_parameters(rows)
    metric_ranges = sweep_metric_ranges(rows)
    high_risk = sorted(
        [row for row in rows if risk_rank(str(row["risk_level"])) >= risk_rank("medium")],
        key=lambda row: (risk_rank(str(row["risk_level"])), str(row["label"])),
        reverse=True,
    )
    mode = sweep_mode(rows, varied)
    payload = {
        "mode": mode,
        "run_count": len(rows),
        "runs": rows,
        "varied_parameters": varied,
        "metric_ranges": metric_ranges,
        "high_risk_runs": high_risk,
        "best_observed_run": best_observed_run(rows),
    }
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "sweep_summary.json").write_text(
        json.dumps(stable_json_value(payload), indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    write_sweep_summary_md(out_dir / "sweep_summary.md", payload)


def discover_run_dirs(sweep_dir: Path) -> list[Path]:
    if sweep_dir.joinpath("summary.json").exists():
        return [sweep_dir]
    dirs = sorted(path.parent for path in sweep_dir.glob("*/summary.json"))
    if not dirs:
        raise SystemExit(f"no simulator run directories found in {sweep_dir}")
    return dirs


def sweep_row(run_dir: Path) -> dict[str, Any]:
    summary = load_json(run_dir / "summary.json")
    config = summary.get("config", {})
    totals = summary.get("totals", {})
    assertions = summary.get("assertions", [])
    failed_assertions = [str(item.get("name", "")) for item in assertions if not item.get("passed")]
    risk_level, risk_reasons = sweep_risk(summary)
    return {
        "label": run_dir.name,
        "run_dir": stable_sweep_artifact_path(run_dir),
        "scenario": str(config.get("scenario", run_dir.name)),
        "seed": config.get("seed"),
        "assertions_passed": bool(assertions) and not failed_assertions,
        "failed_assertions": failed_assertions,
        "risk_level": risk_level,
        "risk_reasons": risk_reasons,
        "config": {key: config.get(key) for key in SWEEP_CONFIG_KEYS if key in config},
        "totals": {key: fnum(totals.get(key)) for key in SWEEP_METRICS if key in totals},
    }


def stable_sweep_artifact_path(run_dir: Path) -> str:
    parts = [run_dir.name]
    if run_dir.parent.name:
        parts.insert(0, run_dir.parent.name)
    return "sweep-artifacts/" + "/".join(parts)


def sweep_risk(summary: dict[str, Any]) -> tuple[str, list[str]]:
    config = summary.get("config", {})
    totals = summary.get("totals", {})
    scenario = str(config.get("scenario", ""))
    assertions = summary.get("assertions", [])
    failed = [item for item in assertions if not item.get("passed")]
    reasons = []
    level = "low"

    def raise_to(candidate: str, reason: str) -> None:
        nonlocal level
        if risk_rank(candidate) > risk_rank(level):
            level = candidate
        reasons.append(reason)

    if failed:
        raise_to("critical", f"{len(failed)} assertion contract failures")
    if fnum(totals.get("data_loss_events")) > 0:
        raise_to("critical", "modeled data loss occurred")
    if fnum(totals.get("paid_corrupt_bytes")) > 0:
        raise_to("critical", "corrupt bytes were paid")
    if fnum(totals.get("providers_over_capacity")) > 0:
        raise_to("critical", "providers were assigned above modeled capacity")
    if fnum(totals.get("operator_deal_cap_violations")) > 0:
        raise_to("high", "operator per-deal assignment caps were violated")
    if fnum(totals.get("unavailable_reads")) > 0:
        if scenario_allows_unavailable_reads(scenario):
            raise_to("medium", "temporary unavailable reads are present in an allowed stress fixture")
        else:
            raise_to("high", "unavailable reads outside an explicit stress allowance")
    if fnum(totals.get("success_rate"), 1.0) < 0.99:
        raise_to("high", "retrieval success fell below 99%")
    if fnum(totals.get("repair_backoffs")) > 0:
        raise_to("medium", "repair coordination backoffs occurred")
    if fnum(totals.get("repair_timeouts")) > 0:
        raise_to("medium", "pending repair readiness timeouts occurred")
    if fnum(totals.get("saturated_responses")) > 0:
        raise_to("medium", "provider bandwidth saturation occurred")
    if fnum(totals.get("performance_fail_rate")) > 0.25:
        raise_to("medium", "high Fail-tier QoS share")
    if fnum(totals.get("providers_negative_pnl")) > 0:
        raise_to("medium", "some providers ended with negative modeled P&L")
    if fnum(totals.get("provider_churn_events")) > 0:
        raise_to("medium", "provider economic churn removed active capacity")
    if fnum(totals.get("audit_budget_backlog")) > 0:
        raise_to("medium", "audit budget backlog remained at run end")
    if fnum(totals.get("evidence_spam_net_gain")) > 0:
        raise_to("high", "evidence spam was profitable")
    if scenario == "wash-retrieval":
        wash_net = fnum(totals.get("retrieval_wash_net_gain"))
        if wash_net > 0:
            raise_to("high", "wash retrieval was profitable after explicit spend")
        elif fnum(totals.get("retrieval_attempts")) > 0 and wash_net == 0:
            raise_to("medium", "wash retrieval carried no net cost")
    if (
        fnum(totals.get("evidence_spam_claims")) > 0
        and fnum(totals.get("evidence_spam_bond_burned")) == 0
        and fnum(totals.get("evidence_spam_convictions")) < fnum(totals.get("evidence_spam_claims"))
    ):
        raise_to("medium", "unconvicted evidence spam carried no burn cost")
    if fnum(totals.get("new_deals_rejected_price")) > 0:
        raise_to("medium", "new storage demand was rejected by price")
    if fnum(totals.get("new_deals_suppressed_price")) > 0 and not (
        scenario == "demand-elasticity-recovery" and fnum(totals.get("new_deals_accepted")) > 0
    ):
        raise_to("medium", "latent storage demand was suppressed by price elasticity")
    if scenario == "demand-elasticity-recovery" and fnum(totals.get("new_deal_latent_requests")) > 0:
        if (
            fnum(config.get("storage_demand_reference_price")) > 0
            and fnum(config.get("storage_price")) > fnum(config.get("storage_demand_reference_price"))
            and fnum(totals.get("new_deals_suppressed_price")) == 0
        ):
            raise_to("medium", "storage demand did not respond to high initial price")
        if fnum(totals.get("new_deals_accepted")) == 0:
            raise_to("high", "storage demand never recovered into accepted deals")
    if (
        scenario == "retrieval-demand-shock"
        and fnum(totals.get("retrieval_demand_shock_active")) > 0
        and fnum(totals.get("max_retrieval_price")) <= fnum(config.get("retrieval_price_per_slot"))
    ):
        raise_to("medium", "retrieval demand shock did not move retrieval price")
    if fnum(totals.get("retrieval_price_direction_changes")) > 2:
        raise_to("medium", "retrieval price oscillated repeatedly")
    if fnum(totals.get("elasticity_overlay_rejections")) > 0:
        raise_to("medium", "elasticity overlay expansion was rejected")
    if fnum(totals.get("elasticity_overlay_activations")) > 0 and fnum(totals.get("elasticity_overlay_serves")) == 0:
        raise_to("medium", "elasticity overlays activated but did not serve reads")
    if fnum(totals.get("owner_retrieval_escrow_debited")) > 0:
        raise_to("medium", "owner retrieval escrow was debited")
    if (
        fnum(totals.get("storage_escrow_outstanding")) > 0
        and fnum(totals.get("final_closed_deals")) > 0
        and fnum(totals.get("final_open_deals")) == 0
    ):
        raise_to("medium", "storage escrow remained outstanding after deal close")
    if (
        scenario == "storage-escrow-expiry"
        and fnum(config.get("deal_duration_epochs")) > 0
        and fnum(config.get("deal_duration_epochs")) <= fnum(config.get("epochs"))
        and fnum(totals.get("final_open_deals")) > 0
    ):
        raise_to("high", "matured storage deals remained open after configured duration")
    if fnum(totals.get("storage_fee_burned")) > 0:
        raise_to("medium", "storage fees were burned instead of paid")
    if fnum(totals.get("final_underbonded_assigned_slots")) > 0:
        raise_to("high", "underbonded assigned slots remained at run end")
    elif fnum(totals.get("max_underbonded_providers")) > 0:
        raise_to("medium", "provider bond headroom became constrained")
    if scenario == "provider-supply-entry" and fnum(totals.get("reserve_providers")) > 0:
        raise_to("medium", "reserve providers remained unused at run end")
    if fnum(totals.get("staged_upload_rejections")) > 0:
        raise_to("medium", "staged upload preflight rejections occurred")
    if not reasons:
        reasons.append("assertions passed and no material sweep risk surfaced")
    return level, reasons


def risk_rank(level: str) -> int:
    return {"low": 0, "medium": 1, "high": 2, "critical": 3}.get(level, 0)


def varied_parameters(rows: list[dict[str, Any]]) -> dict[str, list[str]]:
    keys = sorted({key for row in rows for key in row["config"].keys()})
    varied = {}
    for key in keys:
        values = sorted({stable_param(row["config"].get(key)) for row in rows})
        if len(values) > 1:
            varied[key] = values
    return varied


def stable_param(value: Any) -> str:
    if isinstance(value, (dict, list, tuple)):
        return json.dumps(value, sort_keys=True)
    return str(value)


def sweep_metric_ranges(rows: list[dict[str, Any]]) -> dict[str, dict[str, float]]:
    ranges = {}
    for key in SWEEP_METRICS:
        values = [fnum(row["totals"].get(key)) for row in rows if key in row["totals"]]
        if not values:
            continue
        ranges[key] = {
            "min": min(values),
            "max": max(values),
            "delta": max(values) - min(values),
            "mean": sum(values) / len(values),
        }
    return ranges


def sweep_mode(rows: list[dict[str, Any]], varied: dict[str, list[str]]) -> str:
    policy_keys = [key for key in varied if key not in {"scenario", "seed"}]
    scenarios = {row["scenario"] for row in rows}
    if policy_keys:
        return "Sensitivity Sweep"
    if len(scenarios) > 1:
        return "Regression Suite Summary"
    return "Run Set Summary"


def best_observed_run(rows: list[dict[str, Any]]) -> dict[str, Any]:
    if not rows:
        return {}
    return min(
        rows,
        key=lambda row: (
            fnum(row["totals"].get("data_loss_events")),
            -fnum(row["totals"].get("success_rate")),
            fnum(row["totals"].get("unavailable_reads")),
            fnum(row["totals"].get("providers_over_capacity")),
            fnum(row["totals"].get("providers_negative_pnl")),
            fnum(row["totals"].get("repair_backoffs")),
            str(row["label"]),
        ),
    )


def write_sweep_summary_md(path: Path, payload: dict[str, Any]) -> None:
    rows = payload["runs"]
    varied = payload["varied_parameters"]
    best = payload["best_observed_run"]
    high_risk = payload["high_risk_runs"]
    lines = [
        f"# Policy Simulation {payload['mode']}",
        "",
        f"This report aggregates `{payload['run_count']}` completed simulator run output directories. It does not rerun the simulator or mutate raw run artifacts.",
        "",
        "## Executive Summary",
        "",
        *sweep_decision_lines(payload),
        "",
        "## Run Matrix",
        "",
        "| Run | Scenario | Seed | Risk | Assertions | Success | Unavailable Reads | Expired Reads | Closed Reads | Data Loss | Repairs | Backoffs | Saturated | Negative P&L | Storage Price | Retrieval Price |",
        "|---|---|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for row in sorted(rows, key=lambda item: (item["scenario"], stable_param(item.get("seed")), item["label"])):
        totals = row["totals"]
        lines.append(
            f"| `{row['label']}` | `{row['scenario']}` | `{row.get('seed')}` | `{row['risk_level']}` | "
            f"`{'PASS' if row['assertions_passed'] else 'FAIL'}` | {fmt_pct(totals.get('success_rate'))} | "
            f"{fmt_num(totals.get('unavailable_reads'))} | {fmt_num(totals.get('expired_retrieval_attempts'))} | "
            f"{fmt_num(totals.get('closed_retrieval_attempts'))} | "
            f"{fmt_num(totals.get('data_loss_events'))} | "
            f"{fmt_num(totals.get('repairs_started'))}/{fmt_num(totals.get('repairs_completed'))} | "
            f"{fmt_num(totals.get('repair_backoffs'))} | {fmt_num(totals.get('saturated_responses'))} | "
            f"{fmt_num(totals.get('providers_negative_pnl'))} | {fmt_money(totals.get('final_storage_price'))} | "
            f"{fmt_money(totals.get('final_retrieval_price'))} |"
        )
    lines.extend(
        [
            "",
            "## Key Metric Ranges",
            "",
            "| Metric | Min | Max | Delta | Mean | Review Meaning |",
            "|---|---:|---:|---:|---:|---|",
            *sweep_metric_range_lines(payload["metric_ranges"]),
            "",
            "## Varied Parameters",
            "",
            *varied_parameter_lines(varied),
            "",
            "## Parameter Sensitivity",
            "",
            *parameter_sensitivity_lines(rows, varied),
            "",
            "## High-Risk Runs",
            "",
            *high_risk_lines(high_risk),
            "",
            "## Best Observed Run",
            "",
            f"`{best.get('label', 'n/a')}` is the best observed run under the current ordering: zero data loss first, then highest retrieval success, then fewer unavailable reads, capacity violations, negative-P&L providers, and repair backoffs.",
            "",
            "This is not an automatic policy choice. It is the run humans should inspect first when deciding which parameter set deserves keeper or e2e implementation work.",
            "",
            "## Review Questions",
            "",
            "- Which changed parameter plausibly caused the largest movement in availability, repair pressure, and provider economics?",
            "- Did any run improve availability by hiding economic distress, capacity over-assignment, or repair backlog?",
            "- Are unavailable reads explicitly allowed by the scenario contract, and did modeled data loss remain zero?",
            "- Which parameter set should become the baseline for the next keeper/e2e planning slice?",
        ]
    )
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def sweep_decision_lines(payload: dict[str, Any]) -> list[str]:
    rows = payload["runs"]
    critical = [row for row in rows if row["risk_level"] == "critical"]
    failed = [row for row in rows if not row["assertions_passed"]]
    data_loss = [row for row in rows if fnum(row["totals"].get("data_loss_events")) > 0]
    lines = [
        f"- Mode: `{payload['mode']}`.",
        f"- Runs analyzed: `{len(rows)}`.",
        f"- Varied parameters: `{len(payload['varied_parameters'])}`.",
        f"- Critical-risk runs: `{len(critical)}`.",
        f"- Assertion failures: `{len(failed)}`.",
        f"- Runs with modeled data loss: `{len(data_loss)}`.",
    ]
    if data_loss:
        lines.append("- Decision posture: block graduation until durability failure is understood and fixed.")
    elif failed:
        lines.append("- Decision posture: do not promote parameters from failing assertion contracts without explicit human approval.")
    elif critical:
        lines.append("- Decision posture: inspect critical runs before selecting a parameter baseline.")
    else:
        lines.append("- Decision posture: safe to use this report for policy-parameter review before keeper work.")
    return lines


def sweep_metric_range_lines(ranges: dict[str, dict[str, float]]) -> list[str]:
    if not ranges:
        return ["| n/a | n/a | n/a | n/a | n/a | No comparable metrics were present. |"]
    lines = []
    for key in SWEEP_METRICS:
        row = ranges.get(key)
        if not row:
            continue
        lines.append(
            f"| `{key}` | {row['min']:.6f} | {row['max']:.6f} | {row['delta']:.6f} | {row['mean']:.6f} | {sweep_metric_meaning(key)} |"
        )
    return lines


def sweep_metric_meaning(key: str) -> str:
    meanings = {
        "success_rate": "Primary availability outcome; should not regress silently.",
        "unavailable_reads": "Temporary user-facing misses; allowed only in explicit stress contracts.",
        "expired_retrieval_attempts": "Post-expiry read requests rejected as expired content, not live availability misses.",
        "closed_retrieval_attempts": "Post-close read requests rejected as closed content, not live availability misses.",
        "data_loss_events": "Durability invariant; non-zero values block graduation.",
        "reward_coverage": "Shows whether compliant responsibility remains economically recognized.",
        "repairs_started": "Detection and repair activation pressure.",
        "repairs_completed": "Healing throughput under the parameter set.",
        "repair_attempts": "Repair retry pressure before starts or backoffs.",
        "repair_backoffs": "Replacement capacity or repair-start bottlenecks.",
        "repair_cooldowns": "Retry cooldowns that intentionally throttle repair churn.",
        "repair_attempt_caps": "Per-slot attempt caps hit before a replacement could start.",
        "repair_timeouts": "Pending replacement providers that failed readiness before timeout.",
        "high_bandwidth_promotions": "Measured provider capability promotions.",
        "high_bandwidth_demotions": "Capability demotions after performance regression.",
        "high_bandwidth_providers": "Final provider count eligible for high-bandwidth routing.",
        "high_bandwidth_serves": "Serves attributed to high-bandwidth providers.",
        "hot_retrieval_attempts": "Hot-service demand exercised by the run.",
        "hot_high_bandwidth_serves": "Hot retrieval serves handled by promoted high-bandwidth providers.",
        "platinum_serves": "Serves in the fastest latency tier.",
        "gold_serves": "Serves in the middle positive latency tier.",
        "silver_serves": "Serves in the low positive latency tier.",
        "fail_serves": "Serves slower than the configured positive latency tiers.",
        "average_latency_ms": "Average modeled successful-service latency.",
        "performance_fail_rate": "Share of tiered serves that landed in the Fail tier.",
        "platinum_share": "Share of tiered serves that landed in the fastest performance tier.",
        "performance_reward_paid": "Tiered QoS rewards paid separately from baseline storage and retrieval settlement.",
        "top_operator_assignment_share_bps": "Final assignment share of the largest operator.",
        "max_operator_assignment_share_bps": "Worst observed assignment share of any operator across epochs.",
        "top_operator_provider_share_bps": "Provider identity share controlled by the largest operator.",
        "max_operator_deal_slots": "Maximum same-operator slots in any one deal.",
        "operator_deal_cap_violations": "Deal/operator groups above the configured cap.",
        "suspect_slots": "Soft warning slot-epochs before thresholded delinquency.",
        "delinquent_slots": "Threshold-crossed slot-epochs that should be visible to operators.",
        "quota_misses": "Soft liveness evidence generated by the run.",
        "invalid_proofs": "Hard-fault evidence generated by the run.",
        "paid_corrupt_bytes": "Payment safety invariant; should remain zero.",
        "audit_budget_demand": "Total audit work implied by soft-failure evidence and carried backlog.",
        "audit_budget_spent": "Audit budget actually consumed under the configured cap.",
        "audit_budget_backlog": "Unmet audit demand remaining at run end.",
        "audit_budget_exhausted": "Epochs where audit demand exceeded available budget.",
        "evidence_spam_claims": "Low-quality deputy evidence submissions in the spam fixture.",
        "evidence_spam_convictions": "Spam claims that still reached conviction and earned bounty.",
        "evidence_spam_bond_burned": "Evidence bond burned for unconvicted spam claims.",
        "evidence_spam_bounty_paid": "Conviction-gated bounty paid to the evidence spammer.",
        "evidence_spam_net_gain": "Spammer net economics; positive values indicate an abuse risk.",
        "retrieval_wash_accounted_spend": "Explicit modeled requester, sponsor, or owner-funded retrieval spend counted against wash traffic.",
        "retrieval_wash_net_gain": "Worst-case colluding requester/provider net gain; positive values indicate wash abuse risk.",
        "retrieval_attempts": "Effective retrieval attempts after demand shock multipliers and inactive-content rejection.",
        "provider_cost_shock_active": "Epochs where external provider cost pressure was active.",
        "max_provider_cost_shocked_providers": "Largest provider population affected by cost shock in any epoch.",
        "max_provider_cost_shock_fixed_multiplier_bps": "Peak modeled fixed-cost multiplier during cost shock.",
        "max_provider_cost_shock_storage_multiplier_bps": "Peak modeled storage-cost multiplier during cost shock.",
        "max_provider_cost_shock_bandwidth_multiplier_bps": "Peak modeled bandwidth-cost multiplier during cost shock.",
        "provider_churn_events": "Provider exits executed by the economic churn policy.",
        "churned_providers": "Providers marked as exited by run end.",
        "provider_entries": "Reserve providers admitted into probation by the supply-entry policy.",
        "provider_probation_promotions": "Probationary providers promoted into assignment-eligible active supply.",
        "reserve_providers": "Providers still outside normal placement as reserve supply.",
        "probationary_providers": "Providers in onboarding probation and not yet eligible for normal placement.",
        "max_reserve_providers": "Peak providers still outside normal placement as reserve supply.",
        "max_probationary_providers": "Peak providers simultaneously in onboarding probation.",
        "entered_active_providers": "Providers that entered from reserve and are active by run end.",
        "provider_underbonded_repairs": "Repairs started because a provider lacked required bond headroom.",
        "final_underbonded_providers": "Providers below the configured bond requirement at run end.",
        "max_underbonded_providers": "Peak providers below the configured bond requirement.",
        "final_underbonded_assigned_slots": "Assigned slots still held by underbonded providers at run end.",
        "max_underbonded_assigned_slots": "Peak assigned slots held by underbonded providers.",
        "final_provider_bond_deficit": "Run-end aggregate provider bond deficit under configured collateral rules.",
        "max_provider_bond_deficit": "Peak aggregate provider bond deficit under configured collateral rules.",
        "churn_pressure_provider_epochs": "Provider-epochs below the churn threshold.",
        "max_churn_pressure_providers": "Peak providers simultaneously eligible for churn.",
        "final_active_provider_capacity": "Provider capacity remaining after economic exits.",
        "final_exited_provider_capacity": "Provider capacity removed by economic exits.",
        "final_reserve_provider_capacity": "Provider capacity still held outside normal placement as reserve supply.",
        "final_probationary_provider_capacity": "Provider capacity in onboarding probation at run end.",
        "max_churned_assigned_slots": "Peak assigned slots on churned providers before repair catches up.",
        "retrieval_latent_attempts": "Baseline read demand before demand-shock multipliers.",
        "retrieval_demand_shock_active": "Epochs where read-demand shock multipliers were active.",
        "max_retrieval_demand_multiplier_bps": "Peak modeled read-demand multiplier.",
        "storage_price_direction_changes": "Storage price controller direction changes across the run.",
        "retrieval_price_direction_changes": "Retrieval price controller direction changes across the run.",
        "storage_escrow_locked": "Storage escrow charged upfront for committed deals.",
        "storage_escrow_earned": "Storage escrow earned over modeled service epochs.",
        "storage_escrow_refunded": "Unearned storage escrow returned by deal close/refund.",
        "storage_escrow_outstanding": "Storage escrow still locked at run end.",
        "storage_fee_provider_payouts": "Earned storage fees paid to eligible providers.",
        "storage_fee_burned": "Earned storage fees withheld from non-compliant slots.",
        "deals_closed": "Deal close events executed across the run.",
        "deals_expired": "Deal expiry events executed across the run.",
        "final_open_deals": "Deals still active at run end.",
        "final_closed_deals": "Deals closed by run end.",
        "final_expired_deals": "Deals expired by run end.",
        "retrieval_base_burned": "Base retrieval fees burned across live retrieval attempts.",
        "retrieval_variable_burned": "Variable retrieval fee burn withheld from provider payout.",
        "retrieval_provider_payouts": "Retrieval fees paid to providers for served slots.",
        "sponsored_retrieval_attempts": "Retrieval attempts funded by requester/sponsor sessions.",
        "sponsored_retrieval_spent": "Total sponsored retrieval base plus variable spend.",
        "owner_retrieval_escrow_debited": "Deal-owner escrow debited for non-sponsored retrievals.",
        "elasticity_overlay_activations": "Temporary overflow routes activated by user-funded elasticity.",
        "elasticity_overlay_expired": "Temporary overflow routes removed by TTL.",
        "elasticity_overlay_serves": "Retrieval serves completed by overlay routes.",
        "elasticity_overlay_rejections": "Overlay expansion rejected by spend cap or candidate selection.",
        "final_elasticity_overlay_active": "Run-end temporary overlay routes, including routes pending readiness.",
        "max_elasticity_overlay_active": "Peak temporary overlay routes, including routes pending readiness.",
        "final_elasticity_overlay_ready": "Run-end overlay routes ready for routing.",
        "max_elasticity_overlay_ready": "Peak overlay routes ready for routing.",
        "providers_negative_pnl": "Market sustainability and churn pressure.",
        "saturated_responses": "Provider bandwidth bottleneck signal.",
        "providers_over_capacity": "Placement/capacity invariant; should remain zero.",
        "final_storage_utilization_bps": "Supply utilization against modeled capacity.",
        "min_storage_price": "Lowest storage price observed during the run.",
        "max_storage_price": "Highest storage price observed during the run.",
        "final_storage_price": "Storage-controller endpoint under this run.",
        "min_retrieval_price": "Lowest retrieval price observed during the run.",
        "max_retrieval_price": "Highest retrieval price observed during the run.",
        "final_retrieval_price": "Retrieval-controller endpoint under this run.",
        "provider_pnl": "Aggregate provider economics; inspect distribution before deciding.",
    }
    return meanings.get(key, "Review this metric against the scenario contract.")


def varied_parameter_lines(varied: dict[str, list[str]]) -> list[str]:
    if not varied:
        return ["- No parameters varied across the discovered runs."]
    lines = ["| Parameter | Values |", "|---|---|"]
    for key, values in varied.items():
        rendered = ", ".join(f"`{value}`" for value in values[:8])
        if len(values) > 8:
            rendered += f", ... `{len(values) - 8}` more"
        lines.append(f"| `{key}` | {rendered} |")
    return lines


def parameter_sensitivity_lines(rows: list[dict[str, Any]], varied: dict[str, list[str]]) -> list[str]:
    keys = [key for key in varied if key not in {"scenario", "seed"}]
    if not keys:
        return ["- No non-scenario policy or scale parameter varied, so this run set is best read as a regression suite."]
    lines = [
        "| Parameter | Value | Runs | Avg Success | Total Unavailable | Total Data Loss | Avg Backoffs | Avg Negative P&L | Avg Final Storage Price |",
        "|---|---|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for key in keys[:8]:
        grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for row in rows:
            grouped[stable_param(row["config"].get(key))].append(row)
        for value, group in sorted(grouped.items()):
            count = len(group)
            lines.append(
                f"| `{key}` | `{value}` | {count} | {fmt_pct(avg_metric(group, 'success_rate'))} | "
                f"{fmt_num(sum_metric(group, 'unavailable_reads'))} | {fmt_num(sum_metric(group, 'data_loss_events'))} | "
                f"{fmt_num(avg_metric(group, 'repair_backoffs'))} | {fmt_num(avg_metric(group, 'providers_negative_pnl'))} | "
                f"{fmt_money(avg_metric(group, 'final_storage_price'))} |"
            )
    if len(keys) > 8:
        lines.append(f"| ... | ... | ... | ... | ... | ... | ... | ... | `{len(keys) - 8}` more varied parameters omitted |")
    return lines


def avg_metric(rows: list[dict[str, Any]], key: str) -> float:
    if not rows:
        return 0.0
    return sum_metric(rows, key) / len(rows)


def sum_metric(rows: list[dict[str, Any]], key: str) -> float:
    return sum(fnum(row["totals"].get(key)) for row in rows)


def high_risk_lines(rows: list[dict[str, Any]]) -> list[str]:
    if not rows:
        return ["- No medium, high, or critical risk runs were detected."]
    lines = ["| Run | Scenario | Risk | Reasons |", "|---|---|---|---|"]
    for row in rows[:12]:
        lines.append(
            f"| `{row['label']}` | `{row['scenario']}` | `{row['risk_level']}` | "
            f"{'; '.join(str(reason) for reason in row['risk_reasons'])} |"
        )
    if len(rows) > 12:
        lines.append(f"| ... | ... | ... | `{len(rows) - 12}` more risk runs omitted |")
    return lines


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-dir", type=Path, help="single simulator output directory")
    parser.add_argument("--baseline-dir", type=Path)
    parser.add_argument("--candidate-dir", type=Path)
    parser.add_argument("--sweep-dir", type=Path, help="directory containing one or more simulator run output directories")
    parser.add_argument("--out-dir", type=Path)
    return parser


def default_out_dir(args: argparse.Namespace) -> Path:
    if args.out_dir:
        return args.out_dir
    if args.run_dir:
        return args.run_dir / "report"
    if args.candidate_dir:
        return args.candidate_dir / "delta"
    if args.sweep_dir:
        return args.sweep_dir / "sweep_report"
    raise SystemExit("--out-dir is required unless --run-dir, --candidate-dir, or --sweep-dir is set")


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    out_dir = default_out_dir(args)
    if args.run_dir:
        generate_run_report(args.run_dir, out_dir)
    if args.baseline_dir and args.candidate_dir:
        generate_policy_delta(args.baseline_dir, args.candidate_dir, out_dir)
    if args.sweep_dir:
        generate_sweep_report(args.sweep_dir, out_dir)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
