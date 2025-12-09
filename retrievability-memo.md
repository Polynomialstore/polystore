# NilStore Retrievability Memo – Problem Statement

## 1. Purpose

Define the precise retrievability guarantee NilStore aims to provide and the conditions under which Storage Providers (SPs) must be punished when they fail to uphold it. This memo is intentionally **problem‑only**: no protocol design, only what must be true of the system’s behavior.

---

## 2. Core Invariants

For every active Deal and its assigned Storage Providers, the retrieval subsystem must enforce **both** of the following:

1. **Retrievability / Accountability**

   > **Either** the encrypted data is reliably retrievable when requested under the protocol’s rules,  
   > **or** there exists (with very high probability) a verifiable record of SP failure that leads to economic or reputational punishment.

2. **Self‑Healing Placement**

   > When an SP’s observed performance on a Deal is persistently below protocol thresholds  
   > (too many failed/slow challenges, bad proofs, or missing retrievals),  
   > that SP must be **automatically removed** from that Deal’s replica set and replaced by healthier SPs.

“Implementation detail” in this context includes *how* we probe, *who* probes (users, SPs, auditors), *how* we measure performance, and *how* we repair replication, as long as these invariants are enforced.

---

## 3. Actors and Roles (at this layer)

- **Data Owner / Payer (Client)**  
  Creates Deals, pays for storage and bandwidth. May be online frequently (hot data) or rarely (archive).

- **Storage Providers (SPs)**  
  Hold ciphertext for assigned Deals and are paid to store and serve it. Subject to rewards and slashing.

- **Auditors / Watchers (could be SPs, clients, or third parties)**  
  Perform retrievals or checks that can expose SP misbehavior. May be “declared” or “secret”.

- **Protocol / Chain**  
  Assigns Deals to SPs, defines challenge schedules, verifies proofs/receipts, and applies rewards/slashing.

---

## 4. What “Retrievable Reliably” Means (Problem-Level)

We need a minimal, protocol‑level notion of “reliably retrievable” that is testable and enforceable:

- **Liveness:**
  - There exists a defined set of conditions under which a retrieval is considered a valid test:
    - Request format, challenge parameters, allowed time window, etc.
  - Under those conditions, an honest SP:
    - Responds within the protocol’s latency bounds (accounting for network jitter),
    - Serves the correct ciphertext for the requested parts of the Deal.

- **Correctness:**
  - The data returned can be objectively checked against the Deal’s on‑chain commitments (e.g. via KZG/Merkle proofs).
  - “Close enough” is **not** acceptable: for the purposes of enforcement, data is either correct (passes cryptographic checks) or wrong.

- **Repeatability / predictability:**
  - The rules for when a retrieval test counts (what counts as a “challenge”) are known and fixed in the protocol.
  - Clients and auditors can know beforehand what kind of retrievals are admissible as evidence.

We are *not* trying to guarantee that *every* arbitrary HTTP fetch succeeds (networks fail); we’re guaranteeing that **protocol‑valid retrieval attempts** either succeed or give us punishable evidence.

---

## 5. Failure Modes We Care About

We are specifically trying to catch and punish:

1. **Non-response / unavailability**
   - SP does not respond to valid retrieval attempts within the allowed window.
   - SP is persistently offline or overloaded for assigned Deals.

2. **Wrong data**
   - SP returns ciphertext that does not match the Deal’s committed data, detectable via proofs.

3. **Selective behavior**
   - SP behaves correctly for some requests and systematically fails others (e.g., censoring particular deals or clients, or only passing obvious audits).

4. **On-demand fetching / lazy SPs**
   - SP tries to reconstruct data on the fly from elsewhere (e.g., S3) in a way that systematically violates the agreed performance profile (too slow, not actually storing).

We explicitly want a system where **sustained** versions of these behaviors are economically irrational because they get exposed and punished with high probability.

---

## 6. Evidence Requirements

For the invariant to be meaningful, the system must be able to produce **objective evidence** of failure when an SP does not make data retrievable. That implies:

- **Verifiability:**
  - Any alleged failure must come with a transcript and/or proof that:
    - A valid retrieval challenge was issued,
    - The SP’s response (or lack thereof) violated protocol rules,
    - The cryptographic checks (KZG, Merkle, signatures) support that conclusion.
  - This evidence must be checkable on‑chain or by all parties off‑chain in a consistent way.

- **Attribution:**
  - The evidence must clearly identify:
    - Which SP is at fault,
    - Which Deal (and possibly which chunk/MDU) was involved,
    - When (epoch/height) the failure occurred.

- **Non‑forgeability:**
  - SPs cannot fabricate “fake” client failures against competitors.
  - Clients/auditors cannot forge SP misbehavior; they can only record what actually happened.

Without such evidence, “punish SPs” degenerates into heuristics and reputation; the retrievability invariant is then not enforceable.

---

## 7. Coverage Requirements

To punish SPs reliably, we need sufficient **coverage** of tests over time:

- **Per SP / per Deal coverage:**
  - For each `(SP, Deal)` pair, there must be enough retrieval‑like or proof‑like challenges over the lifetime of the Deal to:
    - Detect cheating with high probability before the SP has collected most of the rewards.
- **Under client dormancy:**
  - Even if the original client goes completely offline (archive use case), the system must still:
    - Generate enough checks (via synthetic challenges, SP audits, or delegated auditors),
    - To expose SPs that have dropped data or stopped serving.

This is where ideas like “SP audit debt proportional to data stored” come in: they are mechanisms to ensure **coverage scales with storage**, but they are secondary to the requirement that coverage exists.

---

## 8. Punishment Requirements

Once evidence of failure exists, punishment must be:

- **Predictable:**
  - The rules for slashing or reward loss are fixed in the protocol.
  - SPs can compute expected penalties from cheating.

- **Material:**
  - The economic loss from being caught (slashing + lost future rewards) must outweigh the savings from not storing or serving data.
  - Repeated offenses should be more expensive (e.g., escalating penalties, jailing, or exclusion from future Deals).

- **Timely:**
  - Punishment should arrive “close enough” in time to the misbehavior that it meaningfully alters incentives; if SPs can cheat for long periods before any risk, the invariant weakens.

The exact slashing function and parameters are an implementation detail; what matters at the problem level is that **cheating SPs are measurably worse off than honest ones** over any reasonable time horizon.

---

## 9. Self‑Healing Requirements (Placement Repair)

Punishment alone is not sufficient; the system must also **heal itself** when SPs underperform. That implies:

- **Per‑(SP, Deal) health tracking:**
  - The protocol maintains some notion of health or reliability for each `(SP, Deal)` pair, derived from:
    - Failed or slow retrieval challenges,
    - Failed synthetic proofs,
    - Severe or repeated QoS violations.

- **Automatic eviction from Deals:**
  - If an SP’s health for a given Deal crosses a “bad enough” threshold (as defined by the protocol):
    - That SP must be **marked unhealthy** for that Deal,
    - Scheduled for **eviction** from the Deal’s replica set once safe.

- **Safe re‑replication:**
  - Before fully evicting a failing SP, the protocol must:
    - Recruit replacement SPs for the Deal according to the placement rules,
    - Ensure new replicas have come online and passed initial liveness checks,
    - Only then remove the failing SP from `Deal.providers[]` (or its equivalent).

- **Global consequences for chronically bad SPs:**
  - If an SP is unhealthy across many Deals, the same evidence and health metrics should escalate to:
    - Jailing or suspension (no new Deals),
    - Stronger slashing,
    - Eventual deregistration if misbehavior persists.

The exact health metric, thresholds, and replacement strategy are implementation details. At the problem level we require that:

- Deals are not left indefinitely assigned to SPs that repeatedly fail retrieval challenges.
- Over time, each Deal’s replica set tends to consist only of SPs that actually meet the retrievability guarantee.

---

## 10. Non‑Goals / Out-of-scope for this problem statement

To keep the problem focused, we’re **not** requiring that:

- Clients never free‑ride (a malicious client can always download and then refuse to admit it).
- The system perfectly hides who is a client vs auditor vs SP (full anonymity / traffic analysis resistance).
- Every occasional network glitch is punished; the goal is to punish **systematic**, protocol‑level misbehavior, not random packet loss.

We only require that:

- Honest SPs can satisfy the retrievability conditions with very low risk of punishment.
- Dishonest SPs who drop data, refuse service, or serve bad data **cannot** systematically avoid punishment.

---

## 11. Restated Goal

NilStore’s retrieval subsystem must be designed so that, for every SP and every Deal they accept:

1. There is a well‑defined notion of a **valid retrieval challenge** and response;
2. The system continuously or periodically exercises those challenges with sufficient coverage;
3. Whenever an SP fails these challenges, there is a high chance of producing **verifiable, attributable, non‑forgeable evidence**; and
4. Given that evidence, the protocol **must** inflict material economic penalty on the SP; and
5. Persistently underperforming SPs are **automatically removed and replaced** in the Deals they serve, so that replication and service quality are restored without manual intervention.

All other design choices (who issues challenges, how we hide audits, SP audit debt, onion fallback, etc.) are judged by how well they help satisfy this invariant.
