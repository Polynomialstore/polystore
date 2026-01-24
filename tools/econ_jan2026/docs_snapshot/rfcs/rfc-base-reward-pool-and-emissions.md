# RFC: Base Reward Pool & Emission Schedule (Draft)

Status: Draft (pre-alpha)  
Last updated: 2026-01-22

## 1. Scope

This RFC specifies a **deterministic, consensus-safe** protocol-funded issuance mechanism (“base reward pool”) intended to:
- Subsidize storage supply and liveness during bootstrap.
- Decay into a **fee-dominant steady state** (issuance becomes comparatively small).
- Remain compatible with the frozen pricing & escrow accounting contract.

Non-goals:
- No off-chain price or fiat oracle inputs.
- No changes to `rfcs/rfc-pricing-and-escrow-accounting.md`.

## 2. Definitions

Let:

- `storage_price` be the on-chain storage price (NIL per byte per block), produced by the market pricing controller.
- `epoch_len_blocks` be the number of blocks per epoch.
- `total_active_slot_bytes` be the sum of `slot_bytes` over all **ACTIVE** slots (excluding REPAIRING, etc.).

Define:

**Epoch slot rent (notional):**
```
epoch_slot_rent = storage_price * total_active_slot_bytes * epoch_len_blocks
```
Units: NIL (since storage_price is NIL/byte/block).

This quantity is already referenced by the audit budget design as the “rent base” used for deterministic budgeting and minting.

## 3. Emission function (normative)

Each epoch `e`, the chain mints a base reward pool:
```
base_reward_pool_e = ceil( base_reward_bps(e) / 10_000 * epoch_slot_rent )
```

Where `base_reward_bps(e)` is defined by a **bounded decay-to-tail** schedule:

```
k = floor( (height_e - emission_start_height) / base_reward_halving_interval_blocks )

base_reward_bps(e) = base_reward_bps_tail
                   + floor( (base_reward_bps_start - base_reward_bps_tail) / 2^k )
```

Notes:
- This is a stepwise (per-halving-interval) schedule. It is trivial to compute deterministically with integer arithmetic.
- “Excess over tail” halves every `base_reward_halving_interval_blocks`.

### 3.1 Parameters (minimal set)

- `emission_start_height` (uint64): reference height for emission schedule (genesis height recommended).
- `base_reward_halving_interval_blocks` (uint64): typically ~1 year worth of blocks.
- `base_reward_bps_start` (uint64, bps): bootstrap intensity.
- `base_reward_bps_tail` (uint64, bps): bounded long-run tail emission intensity.

Recommended defaults (mainnet posture, adjustable by governance):
- `base_reward_bps_start = 425`  (≈4.25% of notional rent per epoch when epoch is “1 month”; scale depends on epoch length)
- `base_reward_bps_tail  = 25`   (≈0.25% of notional rent per epoch when epoch is “1 month”)
- `base_reward_halving_interval_blocks ≈ YEAR_LEN_BLOCKS`

Devnet/testnet posture:
- Increase `base_reward_bps_start` (e.g., 600–1200 bps) and shorten halving interval if you want stronger subsidy and faster iteration.

## 4. Reward distribution (normative)

Base rewards are intended to pay for *being a reliable storage provider*.
Eligibility is therefore gated by liveness/quota compliance; weight is based on bytes under responsibility.

For each ACTIVE slot `s` in epoch `e`:
- `slot_bytes_s` is the on-chain responsibility in bytes.
- `compliance_s ∈ [0,1]` is computed as:
  - `1.0` if the slot satisfies quota requirements for the epoch (credits + synthetic proofs + organic proofs, with existing caps),
  - otherwise a fractional value if partial credit is supported; else `0.0`.

Define weight:
```
w_s = slot_bytes_s * compliance_s
```

Let:
```
W = sum_s w_s
```

Payout to a slot:
```
payout_s = floor( base_reward_pool_e * w_s / W )   if W > 0 else 0
```

Unallocated remainder:
- `base_reward_pool_e - sum_s payout_s` MUST be **burned** (or routed to a protocol sink) and MUST NOT be redistributed among successful slots.
  This prevents cartel strategies where some providers intentionally fail to increase the pool share of others.

### 4.1 Exclusions

Slots with `status != ACTIVE` (including REPAIRING) receive **no** base rewards.

Providers that are jailed receive **no** base rewards for the jail duration.

## 5. Rounding & determinism

- All per-epoch minting uses `ceil(...)`.
- All per-slot payout uses `floor(...)`.
- All computations MUST be performed with fixed-point or integer arithmetic as defined in the SDK (no floating-point).
- Any remainder MUST be handled deterministically as described above.

## 6. Rationale (design intent)

- **Data-scaled:** issuance scales with `total_active_slot_bytes`, which is expensive to manipulate because increasing it requires paying/locking funds under the existing pricing contract.
- **Calibratable:** tuning is in bps terms (intuitive: “issuance as a % of notional rent”).
- **Tail emission:** bounded long-run issuance avoids a cliff where bootstrap ends and provider incentives collapse.
- **Consensus-safe:** depends only on chain state and height.

## 7. Open items

- Exact definition of `compliance_s` for partial quota compliance (binary vs fractional).
- Whether a performance/latency multiplier should be layered into `w_s` (and how to measure it deterministically).
- Where the burned remainder is routed (module burn vs community pool).

