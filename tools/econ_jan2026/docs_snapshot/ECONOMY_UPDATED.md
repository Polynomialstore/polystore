# PolyStore Economy (Draft, updated)

Last updated: 2026-01-22

This document is a first-draft synthesis of:
- the existing token flow narrative,
- the frozen pricing & escrow accounting RFC,
- the proposed base reward pool / emission schedule design.

It is intentionally **parameterized**: the policy knobs are explicit and governance-adjustable.

## 1. Role clarity: what pays for what?

PolyStore has two funding sources for storage providers (SPs):

1) **User-funded fees (escrow accounting, deterministic)**
   - Users deposit NIL into a deal’s escrow.
   - Storage lock-in charges and retrieval session fees debit/lock/burn from that escrow according to the frozen accounting contract.

2) **Protocol-funded issuance (base reward pool, deterministic)**
   - The protocol mints NIL on a schedule to subsidize reliable storage during bootstrap.
   - Issuance decays into a bounded tail, so fees can dominate in a mature network.

**Fee-dominant steady state (“equilibrium”):**
- The marginal SP can cover operating costs primarily from user fees.
- Issuance becomes comparatively small, acting as an additional security/liveness budget rather than the primary income stream.

## 2. Pricing & escrow accounting (frozen contract)

PolyStore’s pricing contract is “lock-in pricing” for storage and “spot-at-open” for retrieval sessions.

- Storage: when a deal’s `size_bytes` increases, it pays a lock-in charge based on `storage_price`, the byte delta, and a fixed deal duration.
- Retrieval: sessions lock a base fee (burned) and variable fee (paid to SPs with burn cut) at open, and settle deterministically at completion.

See: `rfcs/rfc-pricing-and-escrow-accounting.md` (frozen).

## 3. Base reward pool & emission schedule (recommended)

### 3.1 What base rewards pay for

Base rewards are protocol-funded issuance intended to pay for:
- providing storage capacity and availability,
- participating in unified liveness (synthetic challenges and/or organic retrieval credits),
- maintaining responsiveness and avoiding long-run degradation of service.

Base rewards are not a substitute for user fees long-term; they are a bootstrap and security budget.

### 3.2 Emission function (normative)

The recommended design mints per epoch as a bps fraction of “epoch slot rent”:

- Define:
  `epoch_slot_rent = storage_price * total_active_slot_bytes * epoch_len_blocks`

- Mint:
  `base_reward_pool = ceil(base_reward_bps(epoch)/10_000 * epoch_slot_rent)`

- Schedule:
  `base_reward_bps(epoch)` decays by halving the **excess over a tail** every halving interval.

This is:
- deterministic,
- consensus-safe,
- self-scaling with network usage (active bytes),
- calibratable in intuitive bps units.

See: `rfcs/rfc-base-reward-pool-and-emissions.md` (draft).

### 3.3 Distribution (recommended)

Rewards should be distributed:
- by bytes under responsibility (`slot_bytes`),
- gated by quota compliance (unified liveness),
- excluding REPAIRING slots and jailed providers.

Unallocated remainder should be burned (not redistributed) to avoid cartel incentives.

## 4. Bonding, slashing, and provider ephemerality

Bonding should protect the system against non-response and invalid proofs, but it should not trap providers in legacy assignments.

Recommended principle:
- user deals can be long,
- provider assignments should be replaceable (drain/repair/rotation),
- healthy providers should be able to exit with minimal punitive penalties.

See: `rfcs/rfc-provider-exit-and-draining.md` (draft).

## 5. Parameter recommendations (starting point)

These are placeholders for devnet/testnet; mainnet should be more conservative.

### 5.1 Emissions

- `base_reward_bps_start = 425`
- `base_reward_bps_tail  = 25`
- `base_reward_halving_interval_blocks ≈ 1 year`

### 5.2 Quotas / credits (from existing draft posture)

- `quota_bps`: ~500 (5%) per epoch
- `quota_min_blobs`: 1
- `quota_max_blobs`: 256
- `credit_cap_bps`: hot ~20%, cold ~200%

### 5.3 Retrieval fee split (from existing draft posture)

- `retrieval_base_fee_per_session`: burned, anti-spam
- `retrieval_burn_bps`: ~1000 (10%)

### 5.4 Bonding (from existing draft posture)

- `min_provider_bond`: 10_000_000 NIL
- `bond_months`: 2
- `provider_unbonding_blocks`: ~1 month

## 6. Key open questions

1) Does storage lock-in escrow represent a **non-refundable fee** or a **refundable deposit** at deal end?
   This materially changes long-run token sinks and the profitability of self-dealing.

2) Should base rewards include latency tiers, or should latency incentives be left primarily to retrieval fees?

3) What is the maximum safe “repairing bytes” fraction during heavy churn or mass draining?

