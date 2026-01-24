# RFC: Provider Exit, Draining, and Slot Rotation (Draft, updated for deal expiry)

Status: Draft (pre-alpha)  
Last updated: 2026-01-23

## 1. Problem statement

NilStore should support:
- Long-lived user deals (“store this for years”).
- **Ephemeral provider participation** (providers can leave without punitive penalties when the network is healthy).

The primary risk with very long assignments is operational stagnation:
- Providers fear upgrading/rebooting hardware.
- The network never exercises repair pathways (“chaos monkey” failure testing).

## 2. Design principle

**Decouple deal duration from provider assignment duration.**

Deals may be long. Provider assignments should be *continuously re-allocatable* via repair/replacement.

This RFC is intentionally orthogonal to deal **expiry/renewal**:
- a deal may expire and be renewed (see `rfcs/rfc-deal-expiry-and-extension.md`),
- provider draining is about *who holds the slot*, not whether the deal continues.

## 3. Protocol mechanism: voluntary exit via repair

This RFC defines a deterministic, non-punitive exit path:

### 3.1 New provider registry flag

Add:
- `Provider.draining: bool`

Semantics:
- If `draining=true`, the provider MUST NOT receive new assignments.
- Existing assignments remain ACTIVE until replaced (or until the deal expires).

### 3.2 New messages

**MsgSetProviderDraining(provider, draining: bool)**  
- Callable by the provider’s operator key.
- Setting `draining=true` begins a drain process.

**MsgRequestSlotExit(provider, deal_id, slot_index)** (optional convenience)  
- Requests that a specific slot be prioritized for replacement.

### 3.3 Drain scheduler (deterministic)

Each epoch, a deterministic scheduler MAY select a bounded amount of bytes assigned to draining providers and mark them for replacement (REPAIRING), subject to guardrails:

Parameters:
- `max_drain_bytes_per_epoch` (uint64): cap to avoid repair congestion.
- `max_repairing_bytes_ratio_bps` (uint64): global cap on REPAIRING bytes as share of active bytes.

Selection rule (deterministic):
- Iterate draining providers in address order.
- For each provider, iterate their assigned slots in `(deal_id, slot_index)` order.
- Promote slots into REPAIRING until caps are hit.

Replacement proceeds using the existing repair workflow.

**Protocol retrieval note:** repair/catch-up requires transferring bytes; these transfers MUST be session-accounted via protocol repair sessions (`MsgOpenProtocolRetrievalSession(purpose=PROTOCOL_REPAIR, auth=RepairAuth{...})`). Restricted deals do not block repair.

### 3.4 Economic treatment

- While draining but still ACTIVE, the provider is eligible for rewards **only if** it remains compliant (quota/liveness).
- Once a slot is in REPAIRING, it is excluded from quotas and rewards.
- A provider that *initiates drain* and continues service until replacement should not be slashed.
- A provider that stops serving *before replacement* is treated the same as any other non-compliant provider (convictions → slashing/jail/eviction).

### 3.5 Interaction with deal expiry

- If a deal expires, providers are expected to stop serving it and eventually GC it (per the expiry RFC).
- The drain scheduler SHOULD NOT prioritize replacing slots for **expired** deals, because expiry is the natural termination path.
- This reduces repair load and prevents churn budgets from being spent on dead state.

## 4. Optional: routine rotation (“chaos monkey budget”)

To continuously test repair pathways, governance MAY enable:
- `rotation_bytes_per_epoch` (uint64), default 0.

When enabled, the scheduler additionally selects a small deterministic set of ACTIVE slots to reassign, even if the provider is not draining.

This should be staged and rolled out only after repair is production-grade.

## 5. Rationale

- Enables long-lived user storage with provider churn.
- Avoids trapping providers in long legacy assignments.
- Improves systemic resilience by exercising repair and replacement regularly.
- Deterministic: no off-chain coordination required.

## 6. Open items

- Interaction with “hot vs cold” service hints: hot deals likely want tighter exit constraints.
- UX policy for temporary maintenance windows (distinct from full draining).
- Whether draining providers must post additional bond during drain (likely no).
