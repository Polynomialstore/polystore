# RFC: Funded retrieval channels — decision and counterexamples

Status: **draft research; no channel implementation, wire format, economics or
deployment approved**. Decision owner: [#259](https://github.com/Polynomialstore/polystore/issues/259).
Existing-session scaling: [#337](https://github.com/Polynomialstore/polystore/issues/337).
Inspected baseline: `66ec21b1ff6f5a73e2077640f539c289fbf3b3c9`.
This document does not amend `spec.md` or the frozen pricing RFC.

## Decision so far

The selected product workload is **independent paid reads for CDN-style
distribution**, as clarified by the user during execution. Do not implement a
payment channel yet. First measure residual control/state cost after V3 aggregate
submission and early completion release. A channel could amortize funding,
wallet interactions and history across **independent paid transfers**, but
cannot simply amortize away fresh proofs or verified delivery. No quantified
speedup is established by this RFC.

The user approved #341's finite qualification budget: at most 1,000,000 new
sessions or 4 GiB added application DB, whichever comes first, preserving
history. That is neither approval of channel semantics nor an unlimited
production state budget. The final channel decision consumes #343's qualified
existing-session results; it does not block that work.

## CDN workload and the payer-locality decision

Use a trace with transfer ID, payer, assigned provider/payee, generation, logical
range, offered time, required verified-output latency and failure/retry schedule.
One transfer is one separately authorized, billable delivery. Its transport
chunks, duplicate HTTP requests and interrupted retries do not create additional
billable transfers. A deliberate later paid read of the same bytes is a new
transfer, not an overlap-deduplication trick.

| Trace stratum | Existing V3 baseline | Channel question |
| --- | --- | --- |
| Repeated aligned 1 KiB paid reads with payer/payee/generation locality | One funded fixed range per independent read; authenticate a complete 128 KiB encoded blob | Can funding/ACK checkpoints materially reduce control cost while retaining each read's fresh challenge and delivery assurance? |
| Boundary-crossing reads spanning systematic providers | One range, up to eight K8 provider liabilities | A one-payee channel cannot pay the other seven; measure separate channels/checkpoints or explicitly design multi-payee liability |
| 1 GiB sequential download | One legal V3 fixed range, many bounded transport chunks, up to eight obligations and 132 samples | Already amortized; compare against aggregate verification, not one open/ACK/proof per HTTP chunk |

Small independent reads are the primary stratum; the 1 GiB case is a control,
not a substitute for a CDN request trace. Include cache-hot and cold providers,
popular-object fan-out, unique readers, repeat readers, concurrent requests,
root/assignment changes and close/recovery traffic. Report both verified-output
p50/p95/p99 and committed-payment latency: those are different outcomes.
Product throughput and latency targets, object-size distribution, repeat-reader
fraction and channel reuse duration remain **unselected**. Sweep offered load
and report the measured saturation knee; do not invent an SLA or percentage
improvement threshold.

The important unresolved product choice is **who pays and who acknowledges**:

| CDN funding shape | Amortization opportunity | Required contract boundary |
| --- | --- | --- |
| Each reader pays its assigned provider | Repeated reads by the same reader/provider/generation can share funding; one-off readers cannot | Separate reader channels and recovery; do not assume object popularity implies payer locality |
| Publisher or application funds delivery to many readers | Repeated sponsor/provider traffic could share funding despite reader churn | Explicit bounded reader authorization and authenticated consumer delivery ACK; the sponsor must not self-certify that another reader received bytes |

Current V3 freezes `Owner == Payer`; only the frozen owner can ACK or refund
(`retrieval_v3_session.go`: prepare, acknowledge and refund). Requester-funded
sponsored opens still debit that requester. VoucherAuth grants one-time access,
not a publisher-funded cumulative budget or delegated consumer ACK. A shared
sponsor channel therefore needs an approved additive authorization/payment
contract, not substitution of a sponsor ID into existing requests. A funded
user-gateway key is not an acceptable shortcut.

For an analytical lower bound, let N be independent paid transfers and U the
distinct payer/payee/generation/channel-lifetime scopes. At least U channel
opens are needed; average funding reuse is N/U, not reads per popular object.
Ten thousand one-off readers each making one one-provider read have N=U=10000:
no funding-open amortization, although proof aggregation may still help. Reader
traffic billed to a common publisher has a different U but also the new trust
boundary above. These are counting counterexamples, not achieved capacity.
Fresh unknown ranges still incur the checkpoint constraint below. Online
checkpoint batching trades admission latency against occupancy; retain that
delay and every missed request in the fair comparison.

## Minimal candidate and its unavoidable tradeoff

Initial research boundary: one payer, one authorized serving payee, one admitted
deal generation, bounded collateral and height-based authorization expiry. Do
not replace real session IDs with synthetic channel IDs in existing endpoints.
Audit/repair continue to use their existing independent protocol sessions.

For like-for-like fresh challenges, a funded checkpoint must commit bounded
transfer/range descriptors (or their authenticated commitment with available
openings) on-chain **before** the future anchor. Later responses bind that
checkpoint, range and original seed. An off-chain signature claiming an earlier
time proves no chain-observable order. A post-anchor selected range is invalid.

This means arbitrary new paid ranges cannot all be authorized off-chain with
unchanged current freshness at zero on-chain checkpoint cost. Batch planned
ranges before their anchor, or select a different assurance model explicitly.
Sampling once over an entire channel instead of each required transfer changes
security; it is a separate alternative, not like-for-like scaling.

Separate the following messages and authority:

1. Fund/open: bind original funding source, payer, payee, generation and terms.
2. Range authorization/checkpoint: reserve bounded value and commit descriptors
   before the anchor; it is permission to serve, **not** evidence of delivery.
3. Delivery ACK: consumer signs only after every required complete chunk has
   been authenticated, written and durably checkpointed.
4. Proof/settlement: verify required fresh statements and ACK binding before
   paying; proof possession alone proves no delivered bytes.
5. Close/challenge: reconcile latest ACK and unresolved liabilities before
   releasing any collateral that could cover them.

Reuse the existing aggregate verifier, not a second crypto implementation.
Verifying O(transfers) statements still costs O(transfers) work even when there
are fewer transaction records. Each envelope remains bounded by the applicable
entry, total-proof and encoded-byte limits before crypto/allocation. A channel's
outstanding checkpoints and global outstanding liabilities need separate bounds;
a per-message cap is not a total-state bound.

## Economics must be selected, not hidden in batching

Executable independent arithmetic:

```sh
python3 -m unittest discover -s scripts -p test_retrieval_channel_decision.py -v
```

Two independently paid transfers, each 101 billed blobs, price 1, base fee 3,
completion burn 1 bps, deposit 500, one payee:

| Alternative | Base burn | Completion burn | Provider payout | Refund |
| --- | ---: | ---: | ---: | ---: |
| Preserve per-transfer fee/rounding | 6 | 2 | 200 | 292 |
| One channel fee, cumulative rounding | 3 | 1 | 201 | 295 |

Both conserve 500; they are economically different. The second alternative's
second completion adds zero burn after the first cumulative ceil rounding.
Neither alternative is approved. For K8, current burn is calculated per settled
obligation; combining different payees would introduce another rounding change.
Network transaction fees are separate from these application fees and remain
in the measured comparison.

Under the first alternative, atomic reservation of both transfers requires 208.
At 207 it must reject before nonce, voucher, balance, liability or events change.
Sequential admission may accept the first 104-unit transfer, leaving 103 and
rejecting the second. Compare those different admission contracts explicitly.
Check canonical nonnegative bounded integers, multiplication/addition overflow,
denomination, frozen prices, fee payer and original refund destination.

## Close, disappearance and retained history

A monotonic sequence does not by itself make unilateral close safe. A newer
valid ACK must supersede a stale close without replacing it with a conflicting
same-sequence state. Cumulative value cannot decrease or exceed collateral;
exact replay must not pay or credit twice. Signatures bind transfer identity,
so retrying a transport chunk cannot create new coverage or a new liability.

For collateral C, paid value P, latest acknowledged value A and reserved value R,
the candidate invariant is `0 <= P <= A <= R <= C`. Unconditionally withdrawable
value is at most `C - R`; paid value has already left the account. Missing proof
does not make `A - P` disappear. A newer ACK for 202 with only 101 paid cannot
be erased by a stale close showing 101.

The proof-availability/close choice is unresolved: require timely durable proof
availability before ACK, allow a separately specified proof grace period, or
retain disputed collateral pending an approved resolution rule. Each has
liveness/storage costs. Do not silently add a refund deadline, strand a valid
acknowledged provider claim, or promise finite state while unresolved claims can
persist forever. A height-bound challenge period also needs an explicit online
monitoring/watchtower and censorship assumption; no such service exists here.

Generation/root/assignment or access-policy changes may stop **new** authorized
transfers but cannot redirect old payees or refund sources. Define the last
height for new checkpoints, final ACK/proof acceptance and close challenges
separately, including equality edges and overflow. Historical artifacts must
remain available for every still-authorized proof/recovery claim. The existing
generation-ref mechanism is reusable ownership machinery, not a complete
channel retention policy.

Browser/provider restart needs durable exact signed intent before broadcast,
recorded hashes, unknown-hash quarantine, committed-state reconciliation, and
no second funding when a prior open may have committed. Recovery storage is
bounded separately from chain rows. Do not introduce a funded user-gateway key.

## Contract and implementation gates

| Decision | Required acceptance evidence / reusable seam |
| --- | --- |
| Versioned ID and signed domains | Distinct open/authorization/checkpoint/ACK/close domains; bind chain/channel, payer/payee, setup, roots/generation, sequence, range commitment, frozen denom/price, cumulative value and expiry. Select exact byte encoding, publish fixed transcripts/digests and actual native/EVM signature mutation/wrong-signer vectors before implementation. Reuse `pkg/retrievalchallenge` encoders and existing signer comparators; never custom curve code. |
| Funding and settlement | Choose fee frequency/rounding, collateral reservation, fee payer, authorized deputy relation and refund source; independent conservation vectors plus real keeper atomic rollback tests |
| Freshness and full-byte delivery | Chain-observable checkpoint before future anchor; reject rebound/post-anchor ranges; preserve strict multipart integrity and browser verify/write/flush-before-ACK ordering |
| Liability and close | Newer ACK challenges stale close; same-sequence conflict, partial payment, delayed proof, disappearance and deadline-edge tests; explicit unresolved-liability rule |
| Bounds and recovery | One-over entry/proof/byte/checkpoint bounds fail before expensive work; persistent restart, ambiguous broadcast, root rotation, unavailable archive and bounded cleanup tests |
| Economic/security approval | Human selects the contract; then revise #259 with exact messages/ABI, storage ownership and runnable red tests; create only independently reviewable required implementation children |
| Material need | Frozen equal-service trace against legal V3 reuse plus aggregate verification; target derived from the actual product requirement and matched-run noise, not an invented multiplier |

The adjacent Python checks are **decision counterexamples**, not signature,
proof, delivery, byte-envelope, keeper or recovery implementation tests. They
cover arithmetic, atomic/sequential underfunding, canonical amounts, model
replay/liability and chain-observable order. Exact signature/transcript formats,
close horizons and protocol limits remain deliberately unselected. Merging this
research does not complete those implementation gates or close #259's final
go/no-go.

Report opens, ACKs, paid obligations, proof entries/work, checkpoints, transactions,
gas wanted/used, phase/tail latency, verified logical/encoded bytes, state slope,
allocations, peak/live memory and recovery cost. Retain failed/unknown offers in
the denominator. If #343 plus the product trace show no material unmet need,
close #259 as not planned with that evidence; do not build channel machinery.
