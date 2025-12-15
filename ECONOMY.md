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
*   **Burner:** The `nilchain` module has burn permissions to remove slashed assets from circulation.

## 4. S3 Adapter (Web2 Gateway)

The `nil_gateway` adapter allows Web2 applications to write to NilStore using standard S3 APIs.
*   **PUT:** Shards file -> Computes KZG -> Creates Deal on Chain.
*   **GET:** Retrieves shards -> Verifies KZG -> Reconstructs File.
