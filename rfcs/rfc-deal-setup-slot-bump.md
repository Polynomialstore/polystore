# RFC: Deal Setup Slot Bump for Striped Deals

**Status:** Draft / Devnet Alpha Viability Candidate
**Scope:** Minimal chain protocol (`polystorechain/`), EVM intents, website/gateway orchestration during initial deal setup
**Depends on:** `spec.md` §6.0, `spec.md` §8.4, `rfcs/rfc-mode2-onchain-state.md`, `rfcs/rfc-provider-exit-and-draining.md`

---

## 1. Problem statement

PolyStore currently assumes that once providers are deterministically assigned to a new striped deal, those slots are immediately usable.

In practice, there is a specific failure mode that is both common and painful:

- a provider looks healthy enough to be selected,
- the deal is created successfully,
- but the first real per-slot interaction fails immediately,
- and the user discovers this only when trying to upload the first content generation.

Examples:

- the slot endpoint times out or rejects uploads,
- the provider-daemon is partially configured,
- the provider is reachable on LCD but not actually usable for `upload_manifest` or `upload_shard`,
- the provider is technically "Active" but operationally not ready for this new assignment.

The current protocol has repair and replacement machinery for post-activation failures, but it does **not** have a clean, protocol-level escape hatch for **pre-activation setup failures**.

This creates a bad UX:

- the user can create a deal,
- the upload flow stalls on a bad slot,
- and there is no first-class way to ask the chain for "give me a different provider for this slot before I commit any content."

---

## 2. Design goal

Add a **fast, deterministic, owner-controlled slot replacement path** for **empty striped deals**.

In plain terms:

> If a slot fails during initial deal setup, the deal owner should be able to bump that slot to a new provider before the first content commit.

This is intentionally narrower than a general "provider quality" or "reputation" system.

This RFC is about:

- **setup-time failure recovery**,
- **before the first committed manifest exists**,
- **without slashing or proving fraud**,
- **without make-before-break complexity**, because there is no committed content yet.

This RFC should be read as a **devnet-alpha viability design**, not as a claim that this is the final mainnet-ready abstraction.

The intent is:

- unblock real deal setup on the trusted devnet,
- validate the browser/gateway/operator workflow,
- keep the protocol surface as small as possible,
- and defer richer readiness, conviction, and replacement semantics until later RFCs.

If a later protocol design introduces a better readiness handshake, assignment probation model, or unified repair/setup state machine, that later design should be allowed to replace or absorb this mechanism.

### 2.1 Alpha implementation boundary

For devnet alpha, this RFC proposes a deliberately small slice:

- one new owner-authorized setup-time bump message,
- one deterministic replacement rule,
- minimal per-slot retry state,
- a simple per-slot bump cap,
- and browser/gateway retry orchestration around that chain hook.

That is the whole point of the alpha design: make initial deal setup viable without pretending we have already solved the full provider-readiness problem.

### 2.2 Known limitations of the alpha design

This alpha design is intentionally incomplete.

Known limitations:

- it relies on the owner or client stack to observe setup failure and trigger the bump,
- it does not prove on-chain that the provider was actually at fault,
- it treats setup failure as a direct reassignment event rather than a richer readiness state transition,
- it does not add global provider quality, conviction, or penalties,
- it does not guarantee that the replacement provider is truly ready, only that it is the next deterministic candidate,
- and it does not unify setup-time failures with the later repair lifecycle.

These are acceptable tradeoffs for trusted-devnet viability, but they should not be confused with a finished protocol model.

### 2.3 Possible final-state directions

If this feature proves necessary, a later and more complete design may replace this alpha slice with something stronger, such as:

- an explicit `PENDING` or probationary assignment state for newly assigned slots,
- a provider readiness handshake or setup attestation,
- richer endpoint capability validation before assignment,
- batch or automatic replacement flows for multi-slot setup failure,
- a unified state machine that handles both setup-time failure and post-activation repair,
- or provider-side observability and policy consequences once the network has enough reliable evidence to justify them.

This RFC does not choose among those end states. It only proposes the smallest useful bridge from today's brittle setup flow to a more robust future design.

---

## 3. Core principles

### 3.1 Assignment is not readiness

Initial deterministic assignment means:

- "this provider is the protocol's first guess for this slot,"

not:

- "this provider has proven it can serve this deal's first generation."

### 3.2 Pre-activation failures are operational, not slashable by default

If an owner cannot upload initial artifacts to a newly assigned slot, that does **not** by itself prove protocol fraud or slashable behavior.

The protocol should treat this as an **operational mismatch** and provide a bounded reassignment path.

### 3.3 No make-before-break before first commit

Before the first successful `MsgUpdateDealContent*`:

- there is no committed content,
- there is no live read path to preserve,
- there is no shard history to migrate.

Therefore setup-time slot replacement can be **direct reassignment**, not the normal `REPAIRING -> pending_provider -> promotion` lifecycle.

### 3.4 Owner may request a bump, but may not choose the replacement

To preserve anti-self-dealing and deterministic placement:

- the owner can request **"replace slot X"**,
- but the chain chooses the replacement provider deterministically from the eligible pool.

### 3.5 Bumping must be bounded

The setup bump path must not allow infinite churn or provider grinding.

The chain must cap:

- how many times a slot can be bumped during setup,
- and which providers are eligible on each successive attempt.

---

## 4. Non-goals

This RFC does **not** attempt to solve:

- global provider reputation,
- long-term provider ranking,
- post-activation repair semantics,
- slashing for setup-time unresponsiveness,
- subjective latency-based placement,
- macro placement optimization,
- cross-deal quality scoring.

Those may exist later, but they are explicitly out of scope here.

This RFC also does **not** claim that the exact message shape, state layout, or slot status semantics here are permanent. They are proposed as the smallest useful alpha implementation that preserves deterministic placement while making the devnet usable.

---

## 5. Definitions

### 5.1 Setup phase

A deal is in **setup phase** iff all of the following hold:

- `redundancy_mode == 2`
- `current_gen == 0`
- `total_mdus == 0`
- `size == 0`

Equivalently:

- the deal exists,
- slots have been assigned,
- but no content generation has been committed yet.

### 5.2 Setup failure

A **setup failure** is an off-chain observation that an assigned provider cannot successfully participate in initial deal setup.

Examples:

- slot upload timeout,
- `upload_manifest` failure,
- `upload_shard` failure,
- persistent refusal or transport failure during first-generation artifact placement.

Setup failure is **not** chain-verifiable evidence by itself.

### 5.3 Setup bump

A **setup bump** is a deterministic reassignment of one striped slot to a different provider while the deal is still in setup phase.

### 5.4 Tried provider set

For each `(deal_id, slot)`, the chain maintains a bounded record of providers already attempted during setup, so they are not immediately reselected.

---

## 6. Protocol mechanism

### 6.1 New message

Add a new owner-authorized message:

```proto
message MsgBumpDealSetupSlot {
  string creator = 1;         // deal owner
  uint64 deal_id = 2;
  uint32 slot = 3;
  string expected_provider = 4; // optional optimistic-concurrency guard
}
```

And the EVM equivalent:

```proto
message EvmBumpDealSetupSlotIntent {
  uint64 deal_id = 1;
  uint32 slot = 2;
  string expected_provider = 3; // optional
}
```

The purpose of `expected_provider` is to prevent stale UI retries from bumping the wrong current assignee.

If supplied, the chain MUST require:

- `mode2_slots[slot].provider == expected_provider`

Otherwise the transaction fails and the caller must refresh deal state.

### 6.2 Preconditions

`MsgBumpDealSetupSlot` MUST fail unless:

1. the caller is `Deal.owner`
2. the deal is in setup phase
3. `redundancy_mode == 2`
4. `slot < len(mode2_slots)`
5. the slot is currently assigned
6. the slot has not exceeded the per-slot setup bump cap

This message MUST be rejected once the first content commit succeeds.

### 6.3 Deterministic candidate selection

The replacement provider is chosen deterministically from the provider registry.

Eligibility filter:

- `Provider.status == "Active"`
- `Provider.draining == false`
- matches the deal's base `service_hint`
- not already present in `Deal.providers[]` for another slot
- not equal to the current provider of the target slot
- not already present in the setup tried set for `(deal_id, slot)`
- has at least one usable endpoint registered

Suggested deterministic ranking rule:

```text
seed = SHA256("polystore/setup-bump/v1" || deal_id || slot || bump_nonce)
rank(provider) = SHA256(seed || provider_addr)
pick provider with smallest rank among eligible candidates
```

This preserves:

- deterministic consensus,
- owner inability to hand-pick providers,
- bounded retry progression across successive bumps.

### 6.4 State updates on success

On successful bump:

1. add the previous provider to the tried set for `(deal_id, slot)`
2. increment the slot's setup bump nonce
3. set `mode2_slots[slot].provider = new_provider`
4. keep `mode2_slots[slot].status = ACTIVE`
5. keep `pending_provider = ""`
6. keep `repair_target_gen = 0`
7. mirror the change into legacy `providers[]`

No deal generation increment occurs.

No `REPAIRING` state is entered.

No make-before-break handoff is required.

### 6.5 Why no `REPAIRING` state here

`REPAIRING` is for deals that already have committed content and must preserve availability while a replacement catches up.

Setup bump is different:

- the deal is empty,
- there is no committed generation to preserve,
- the old provider has no protocol obligation to transfer content,
- the new provider does not need catch-up.

Therefore setup bump is a direct reassignment, not a repair lifecycle.

---

## 7. Required state additions

This RFC intentionally keeps new state minimal.

For devnet alpha, these additions are meant to be pragmatic rather than idealized. If a later design wants to fold this state into a broader per-slot readiness or repair ledger, this RFC should not block that refactor.

### 7.1 Per-slot setup bump nonce

Add:

- `SetupBumpNonce(deal_id, slot) -> uint64`

Purpose:

- deterministic candidate reseeding on each successive bump.

### 7.2 Tried provider tracking

Add:

- `SetupTriedProvider(deal_id, slot, provider) -> bool`

Purpose:

- prevent immediate reselection of the same failing provider for the same slot during setup.

### 7.3 New param

Add:

- `max_setup_bumps_per_slot`

Suggested devnet default:

- `3`

Rationale:

- enough to recover from obvious bad first guesses,
- not enough to let owners grind indefinitely through the provider pool.

The exact default is a devnet tuning value, not a final protocol constant.

---

## 8. UI / gateway behavior

This RFC is most valuable when the browser and gateway use it automatically.

### 8.1 Happy path

1. User creates a striped deal.
2. Chain assigns `N = K+M` providers.
3. Browser/gateway uploads initial artifacts to the assigned slots.
4. All slots succeed.
5. Browser submits `MsgUpdateDealContent*`.
6. Setup phase ends.

### 8.2 Sad path: one slot fails during upload

1. User creates a striped deal.
2. Upload to slot `s` fails.
3. Browser/gateway identifies the failing provider for slot `s`.
4. Browser submits `MsgBumpDealSetupSlot(deal_id, slot=s, expected_provider=current_provider)`.
5. Chain deterministically swaps in a new provider for that slot.
6. Browser refreshes deal state and resolves the new endpoint.
7. Browser retries only the failed slot upload.
8. Once all slots succeed, browser commits content normally.

### 8.3 Metadata failures

If replicated metadata upload fails on one assigned provider during setup, the same setup bump path applies.

The key question is not whether the failing request was:

- `upload_manifest`,
- metadata MDU upload,
- or shard upload.

The relevant fact is:

- "this assigned slot/provider is unusable for first-generation setup."

### 8.4 Multi-slot failure

If multiple slots fail, the client MAY bump them independently, one at a time.

Batch bumping is a possible future extension, but is not required for this RFC.

---

## 9. Economic and security treatment

### 9.1 No slashing

A setup bump does **not** imply protocol guilt.

This RFC introduces:

- no slash,
- no jail,
- no fraud proof,
- no global reputation penalty.

It is an owner escape hatch, not a punishment path.

### 9.2 No reward edge

Before first content commit:

- there is no liveness reward to protect,
- no synthetic quota yet tied to meaningful stored content,
- and no read availability to preserve.

So direct reassignment is safe.

### 9.3 Anti-grinding

This RFC limits grinding by:

- deterministic replacement selection,
- excluding already-tried providers for the slot,
- capping total bumps per slot,
- preventing owner-selected replacement identities.

### 9.4 Provider-side interpretation

Being bumped during setup should be treated as:

- an operational signal,
- not as slashable evidence.

Separate observability may later count setup bump frequency for ops dashboards, but that is off-chain and non-normative.

---

## 10. Interaction with existing RFCs

### 10.1 striped on-chain state

This RFC complements [rfc-mode2-onchain-state.md](rfcs/rfc-mode2-onchain-state.md):

- setup bump happens **before** the normal repair state machine matters,
- post-activation repairs still use `REPAIRING` and `pending_provider`.

### 10.2 Provider exit / draining

Providers with `draining=true` remain ineligible for setup bump selection, just as they are ineligible for new placements generally.

### 10.3 Challenge / quota policy

This RFC does not change:

- quota derivation,
- synthetic challenge accounting,
- eviction triggers,
- or epoch-end repair logic.

Those begin to matter only after the first committed content generation exists.

---

## 11. Implementation checklist

The checklist below is intentionally scoped for the trusted devnet. It should be treated as an alpha delivery slice, not as a claim that every interface here is the final long-term contract.

### 11.1 Chain

1. Add `MsgBumpDealSetupSlot`
2. Add EVM bump intent and precompile wiring
3. Add `SetupBumpNonce` and `SetupTriedProvider` collections
4. Add `max_setup_bumps_per_slot` param
5. Implement deterministic setup bump selector
6. Mirror slot replacement into `providers[]`
7. Emit events:
   - `deal_id`
   - `slot`
   - `old_provider`
   - `new_provider`
   - `bump_nonce`

### 11.2 Website

1. Detect slot-specific upload failures in the striped upload flow
2. Call the bump transaction for the failing slot
3. Refresh LCD deal state
4. Resolve new provider endpoint
5. Retry the failed slot only
6. Surface explicit UI copy:
   - "slot 3 failed during setup"
   - "requesting replacement"
   - "replacement assigned"
   - "retrying upload"

### 11.3 Gateway

If the gateway orchestrates setup uploads, it SHOULD expose structured slot failure reasons so the browser can trigger the correct bump transaction instead of falling back to generic upload failure handling.

### 11.4 Suggested PR rollout for devnet alpha

The safest implementation path is three small PRs, each test-gated on its own.

#### PR A: Chain message + state + deterministic selector

Goal:

- make setup bump exist as a native chain capability before touching wallet or UI wiring.

Primary files:

- `polystorechain/proto/polystorechain/polystorechain/v1/tx.proto`
- `polystorechain/proto/polystorechain/polystorechain/v1/params.proto`
- `polystorechain/x/polystorechain/keeper/msg_server.go`
- `polystorechain/x/polystorechain/keeper/keeper.go`
- `polystorechain/x/polystorechain/types/keys.go`
- `polystorechain/x/polystorechain/keeper/msg_server_test.go`
- new focused keeper tests next to existing `msg_server_*` coverage

Scope:

- add `MsgBumpDealSetupSlot`
- add `max_setup_bumps_per_slot`
- add per-slot setup bump nonce / tried-provider state
- implement setup-phase validation
- implement deterministic replacement selection
- mirror slot replacement into `providers[]`
- emit explicit events for bump success

Test gate:

- `cd polystorechain && go test ./x/polystorechain/...`

Exit criteria:

- a Cosmos-message path can bump a setup-phase slot deterministically,
- stale/non-owner/post-commit requests fail cleanly,
- and the chain state after bump is queryable and internally consistent.

#### PR B: EVM/precompile bridge wiring

Goal:

- make setup bump available through the same wallet-first path used by `createDeal` and `updateDealContent`.

Primary files:

- `polystorechain/proto/polystorechain/polystorechain/v1/tx.proto`
- `polystorechain/x/polystorechain/types/eip712.go`
- `polystorechain/x/polystorechain/keeper/msg_server.go`
- `polystorechain/x/polystorechain/keeper/msg_server_evmbdg_test.go`
- `polystore-website/src/lib/polystorePrecompile.ts`
- `polystore-website/src/lib/eip712.ts`
- any precompile ABI fixture or generated binding that currently exposes `createDeal` / `updateDealContent`

Scope:

- add `EvmBumpDealSetupSlotIntent`
- add `MsgBumpDealSetupSlotFromEvm`
- implement EIP-712 hashing + nonce semantics
- expose precompile method and event surface for setup bump
- add website-side typed-data / ABI support only as far as needed to call the new method

Test gate:

- `cd polystorechain && go test ./x/polystorechain/...`
- `npm -C polystore-website run test:unit`

Exit criteria:

- a wallet-signed setup bump can be submitted through the precompile path,
- signatures/nonces/replay rules mirror the existing EVM bridge posture,
- and the website has the client-side ABI/types needed to call it.

#### PR C: Website upload recovery + retry UX

Goal:

- turn slot-specific setup failure into an actionable bump-and-retry flow instead of a dead-end upload error.

Primary files:

- `polystore-website/src/lib/upload/engine.ts`
- `polystore-website/src/hooks/useDirectUpload.ts`
- `polystore-website/src/hooks/useCreateDeal.ts`
- `polystore-website/src/hooks/useDirectCommit.ts`
- `polystore-website/src/components/Dashboard.tsx`
- any deal-detail or upload-state components that surface striped progress
- Playwright coverage under `polystore-website/tests/`

Scope:

- surface slot-specific upload errors from the engine
- map failing shard/metadata upload back to `(deal_id, slot, provider)`
- call the new setup bump wallet flow
- refresh deal state / provider discovery after bump
- retry only the failed slot
- show explicit UI states for:
  - setup failure detected
  - replacement requested
  - replacement assigned
  - slot retry in progress
  - unrecoverable exhaustion after bump cap

Test gate:

- `npm -C polystore-website run test:unit`
- `npm -C polystore-website run build`
- targeted Playwright coverage for failed-slot bump-and-retry

Exit criteria:

- on a synthetic `upload_shard` or `upload_manifest` slot failure, the user can recover without manually recreating the deal,
- the flow remains wallet-first,
- and success/error states are visible in the upload UI.

Recommended sequencing:

1. merge PR A first
2. merge PR B second
3. merge PR C only after the chain and EVM surfaces are stable

This sequencing keeps the devnet usable at each step and avoids building UI assumptions ahead of protocol support.

---

## 12. Test gates

1. **Owner-only:** non-owner cannot bump setup slot
2. **Striped deals only:** legacy full-replica or malformed deals reject
3. **Setup-phase only:** bump rejected after first content commit
4. **Expected provider guard:** stale expected provider rejects
5. **Deterministic replacement:** same state yields same replacement
6. **No reselection:** previously tried provider is not immediately reselected
7. **Cap enforced:** slot rejects bumps beyond `max_setup_bumps_per_slot`
8. **Upload recovery e2e:** failed slot upload -> bump -> retry -> commit succeeds

---

## 13. Open questions

This section is especially important because the RFC is intentionally alpha-scoped. Some of these questions may be answered by replacing this mechanism rather than extending it.

1. Should setup bump require a fresh deal query proof in the UI before signing, or is `expected_provider` enough?
2. Should the chain require a non-empty endpoint list, or a stronger endpoint-shape validation, when selecting a setup bump candidate?
3. Do we want a future batch form:
   - `MsgBumpDealSetupSlots(deal_id, [slot...])`
   for multi-slot failure storms?
4. Should we record setup bump counts in provider query surfaces for operator observability, while still avoiding any slash/reputation semantics?

---

## 14. Summary

This RFC adds one narrow but high-value capability:

> If a striped-slot provider fails during the very first deal setup, the owner can ask the chain for a deterministic replacement before committing content.

That matches the real failure mode users hit today:

- the provider looked fine at selection time,
- but failed the first real assignment-time test.

The protocol response should be:

- fast,
- bounded,
- deterministic,
- non-punitive,
- and integrated directly into the initial upload flow.

For avoidance of doubt: this RFC is proposing a **minimal alpha implementation for devnet viability**. It is meant to make trusted-devnet deal setup work reliably now, while preserving room to redesign setup readiness and slot replacement more cleanly before final protocol lock-in.
