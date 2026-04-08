# NilStore Economy & Tokenomics

## Overview

The NilStore economy is designed to align incentives between Storage Providers (SPs), Data Owners (Users), and the Protocol itself using a single utility token: **$NIL** ($STOR). The model enforces physical infrastructure commitment while enabling elastic, user-funded scaling.

## 1. The Performance Market (Proof-of-Useful-Data)

Unlike "Space Race" models that reward random data filling, NilStore rewards **latency**.

### 1.1 Unified Liveness
Storage proofs (`MsgProveLiveness`) serve two functions:
1.  **Storage Audit:** Proves the SP holds the data (PoUD via KZG).
2.  **Performance Check:** The block height of proof inclusion determines the reward tier.

### 1.2 Tiered Rewards
Rewards are calculated based on the delay between the **Challenge Block** and the **Proof Inclusion Block**.

**Note:** The tier windows and multipliers below are illustrative examples; the canonical tier cutoffs are protocol parameters (see `spec.md`).

| Tier | Latency (Blocks) | Reward Multiplier | Requirement |
| :--- | :--- | :--- | :--- |
| **Platinum** | 0 - 1 | 100% | NVMe / RAM |
| **Gold** | 2 - 5 | 80% | SSD |
| **Silver** | 6 - 10 | 50% | HDD |
| **Fail** | > 10 | 0% (Slash) | Offline / Glacier |

### 1.3 Inflationary Decay
The base reward per proof follows a halving schedule to cap total supply.
`Reward = BaseReward * (1 / 2 ^ (BlockHeight / HalvingInterval))`

## 2. Elasticity & Scaling

NilStore allows data to scale automatically to meet demand without manual intervention.

### 2.1 Virtual Stripes
A file is stored on a "Stripe" (12 providers). If these providers become saturated (high latency or load), they can signal saturation (`MsgSignalSaturation`).

### 2.2 The Budget Check
The protocol checks the Data Owner's `MaxMonthlySpend` limit.
*   **If Budget Allows:** The protocol spawns a new "Virtual Stripe" (12 new providers) and replicates the data "Hot".
*   **If Budget Exceeded:** The scaling request is denied to protect the user's wallet.

## 3. Token Flow

### 3.1 Inflow (Users)
Users fund deals by depositing $NIL into **Escrow**.
*   `MsgCreateDeal`: Initial deposit.
*   `MsgAddCredit`: Top-up escrow.

### 3.2 Outflow (Providers)
Providers earn tokens via:
1.  **Inflation:** Minted $NIL for valid proofs (Base Capacity Reward).
2.  **Bandwidth Fees:** Paid from User Escrow for retrieval receipts.

### 3.3 Sinks (Burning)
*   **Slashing:** Example policy: missed proofs / non-response violations trigger a slash and potential jailing. Exact windows and amounts are protocol parameters.
*   **Burner:** The `polystorechain` module has burn permissions to remove slashed assets from circulation.

## 5. Protocol Parameters (Proposal Defaults)

This section records **baseline defaults** intended to unblock implementation and testnet calibration.

Canonical accounting rules are frozen in `rfcs/rfc-pricing-and-escrow-accounting.md`. Policy defaults and open questions are tracked in `notes/mainnet_policy_resolution_jan2026.md`.

### 5.1 Storage Price (Lock-in at Ingest)

Derive `storage_price` (Dec per byte per block) from a human target “GiB-month price”:

`storage_price = target_GiBMonth_price / (GiB * MONTH_LEN_BLOCKS)`

Proposed targets:
- Devnet/testnet: `0.10 NIL / GiB-month`
- Mainnet: `1.00 NIL / GiB-month`

### 5.2 Retrieval Fees (Session Settlement)

- `base_retrieval_fee`: burned at session open (anti-spam).
  - Devnet/testnet: `0.0001 NIL`
  - Mainnet: `0.0002 NIL`
- `retrieval_price_per_blob`: locked at session open; settled at completion; per `128 KiB` blob.
  - derive from a GiB target: `retrieval_price_per_blob ≈ target_GiBRetrieval_price / 8192`
  - Devnet/testnet: `0.05 NIL / GiB`
  - Mainnet: `0.10 NIL / GiB`
- `retrieval_burn_bps`: burn cut on completion.
  - Devnet/testnet: `500` (5%)
  - Mainnet: `1000` (10%)

### 5.3 Slashing/Jailing Ladder (Hard vs Soft Failures)

Proposed intent:
- Invalid proofs / wrong-data proofs are **hard faults** (slash immediately).
- Non-response is **thresholded** (convict only after N failures within a window).
- Quota shortfall is **soft** (HealthState decay → repair/evict; no slash by default).

See `notes/mainnet_policy_resolution_jan2026.md` for the proposed parameter table.

### 5.4 Provider Bonding

Proposed model:
- a base provider bond (anti-sybil), plus
- assignment collateral scaled by slot bytes and `storage_price`.

See `notes/mainnet_policy_resolution_jan2026.md`.

### 5.5 Deputy Market + Audit Debt (Defaults)

Baseline decisions:
- Audit debt funding: Option A (protocol-funded audit budget).
- Proxy retrieval premium: 20% (devnet/testnet), 10% (mainnet).
- Non-response evidence incentives: `evidence_bond=0.01 NIL`, `failure_bounty=0.02 NIL`, burn 50% of evidence bond on TTL expiry.

Audit budget sizing (Option A):
- Define: `epoch_slot_rent = storage_price * total_active_slot_bytes * epoch_len_blocks`
- Mint: `audit_budget_mint = ceil(audit_budget_bps/10_000 * epoch_slot_rent)`, capped by `audit_budget_cap_bps`.
- Carryover: unused budget may roll forward up to 2 epochs (bounded).
- Defaults:
  - Devnet/testnet: `audit_budget_bps=200`, `audit_budget_cap_bps=500`, carryover≤2 epochs
  - Mainnet: `audit_budget_bps=100`, `audit_budget_cap_bps=200`, carryover≤2 epochs

See `notes/mainnet_policy_resolution_jan2026.md`.

### 5.6 Credits (Organic Retrieval → Quota Reduction)

Baseline phase-in:
- Devnet: accounting only; credits do not reduce quota (caps=0).
- Testnet: credits enabled with conservative caps (hot 25%, cold 10%).
- Mainnet: launch with caps=0; enable later after determinism + evidence gates are green.

See `notes/mainnet_policy_resolution_jan2026.md`.

## 4. S3 Adapter (Web2 Gateway)

The `polystore_gateway` adapter allows Web2 applications to write to NilStore using standard S3 APIs.
*   **PUT:** Shards file -> Computes KZG -> Creates Deal on Chain.
*   **GET:** Retrieves shards -> Verifies KZG -> Reconstructs File.
