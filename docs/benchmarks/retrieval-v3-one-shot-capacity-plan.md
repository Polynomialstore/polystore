# Retrieval V3 one-shot chain-capacity qualification plan

Status: benchmark specification; no one-shot capacity result has been measured yet.
This plan is the chain-control-plane portion of
[#343](https://github.com/Polynomialstore/polystore/issues/343). It does not
replace that issue's delivery, recovery, or endurance qualification.

## Decision

The base-chain number should be the sustained rate of **settled one-shot
retrieval sessions**, not the rate of proof confirmation alone and not a
configured admission constant.

One measured result is already available: the retained 160M-gas run confirmed
473.6146 pre-opened, one-proof sessions per second, or 40.92 million per day by
linear extrapolation. That run deliberately excluded session opening, owner ACK,
settlement, delivery, expiry, and refund. It remains valid proof-path evidence,
but it is not the base-chain one-shot-session number.

`MaxRetrievalSessionOpensPerBlock = 128` is a provisional resource guardrail.
It is not a measured saturation point, a product target, or a capacity claim.
Qualification builds must raise it and its coupled resource ceilings far enough
that they do not select the result. Changing any production default is a later,
separately reviewed decision.

Until this plan is executed, the honest slide wording is:

> Base-chain one-shot lifecycle capacity: qualification pending. Proof-only
> reference: 473.6 confirmations/s (40.92M/day extrapolated).

## Capacity unit

One benchmark session represents one independent CDN-style paid read:

- one 1 KiB logical range;
- one complete 128 KiB encoded blob delivered and authenticated;
- one requester-funded or explicitly sponsored open through the EVM precompile;
- one provider obligation and one nonconstant sampled chained proof;
- one requester EVM ACK; and
- exactly-once burn, provider payout, and terminal settlement.

Use a pool of independently funded requesters and assigned providers in a
deterministic round-robin. Record the distribution. A single hot signer may be a
useful control, but it must not be the only result presented as CDN-style load.

The primary metric is:

```text
settled_sessions_per_second =
  sessions first observed terminal and economically settled in the interval
  / elapsed wall-clock time between the enclosing committed blocks
```

Also report settled sessions per committed block and the linear daily
extrapolation `rate * 86,400`. The daily value is not an endurance claim.

## Why this is a pipeline, not a one-block script

A session opened at height `H` commits its unpredictable anchor at `H+1` and
cannot accept a response until `H+2`. Therefore all required transitions for one
session cannot validly execute in one block.

The equivalent throughput benchmark is a steady-state pipeline:

| Height | Cohort A | Cohort B | Cohort C |
| --- | --- | --- | --- |
| `H` | open | - | - |
| `H+1` | anchor | open | - |
| `H+2` | proof + ACK + settlement | anchor | open |
| `H+3` | - | proof + ACK + settlement | anchor |

After the two-block warm-up, every measured block admits a new cohort while a
mature cohort executes its proof and ACK in deterministic transaction order.
ACK-before-proof and proof-before-ACK must both be represented; the second valid
transition settles the obligation. This preserves the real minimum lifecycle
latency while measuring the pipeline's throughput.

## Timed scope

The saturation interval includes consensus and execution of every required
on-chain transition:

1. EVM-precompile session open and fee lock;
2. anchor capture;
3. native `MsgSubmitRetrievalSessionProofBatchV3` verification;
4. EVM-precompile ACK; and
5. terminal payment settlement and immediate reference release.

The fixture must use valid encoded bytes, proof material, signatures, balances,
and pricing. Warm a backlog of mature sessions and prepare their terminal
transactions before the timer so off-chain construction does not starve the
chain. During the timed steady state, commit equal rates of new opens and older
terminal sessions; afterward, drain and reconcile every newly opened session.
A low-load companion run must prove that the same production paths derive the
ACK and proof from an actual 128 KiB delivery. The saturation result must
therefore be labeled **chain-control-plane capacity**, not HTTP delivery or
end-to-end service throughput.

[#343](https://github.com/Polynomialstore/polystore/issues/343) remains the
owner of the separate public-path result that includes authenticated delivery,
browser/provider work, queueing, recovery, and unresolved outcomes.

## Transaction profiles

Run both profiles and keep their labels distinct:

1. **Public-path one-shot.** One EVM open transaction, one EVM ACK transaction,
   and the provider-daemon's current one-session/one-obligation PSB2 proof
   transaction per session. This is the primary current-product number.
2. **Implemented batch ceiling.** The same lifecycle, but coalesce eligible
   same-provider proofs into the existing PSB2 envelope, up to 64 sessions per
   proof transaction. This is an implemented chain-interface ceiling, not a
   claim that the current provider dispatcher performs cross-session collection.

Do not batch opens or ACKs through benchmark-only messages. Report actual PSB2
sessions/message and proofs/message rather than assuming full occupancy.

## Profiles and load sweep

Use the existing four-validator harness and its exact artifact/build-manifest
checks. Begin with the current comparable Linux topology, then repeat on one
validator per comparable host before describing the result as distributed-network
capacity. Every published line must state validator count, co-hosting, CPU model,
logical CPUs, `GOMAXPROCS`, memory, OS, storage, and network topology.

Run the same workload under:

- the canonical 160,000,000 gas / 2 MiB block profile; and
- the existing experimental ceiling of 448,000,000 gas / 2 MiB, with the same
  one-second target cadence.

At each profile, use 128 new sessions per block only as a comparability control,
then sweep `256, 512, 1024` and continue doubling until throughput stops
increasing or a health gate fails. Refine around the last passing knee. These are
offered loads, not assumed capacities; include rejected and unresolved sessions
in the reconciliation.

The experimental binary/profile must raise all coupled admission ceilings based
on the maximum offered point:

- opens per block;
- expiry references per deadline block;
- anchor references per height; and
- live retrieval-session contexts.

Preflight must prove none can bind the offered pipeline plus backlog. Any
capacity rejection from one of these guards invalidates that point as a hardware
or execution ceiling. Keep the experimental override out of production defaults
and record its exact source diff and artifact hashes.

Do not exceed the existing 448M activation gas ceiling in this qualification.
A higher ceiling changes a separate protocol safety boundary and needs its own
review and adversarial-block qualification.

## Passing point and stop rules

A point passes only when all of the following hold on the exact candidate:

- at least ten saturated steady-state blocks and ten seconds of positive backlog;
- every accepted open maps to exactly one session and every measured completion
  is terminal, economically settled, and committed on all validators;
- no invalid, unknown, duplicate, dropped, or unresolved outcome is hidden from
  the offered-load denominator;
- commit interval p95 is at most 1.6 seconds with a one-second target cadence;
- per-validator `FinalizeBlock` p95 is at most 700 ms;
- maximum consensus round is zero and there are no missed validator signatures;
- the 2 MiB block limit, gas limit, mempool, CPU, RSS, and database growth are all
  recorded, whether or not they bind; and
- payer debit equals base-fee burn plus locked variable fee, while terminal burn,
  provider payout, escrow, refunds, module balance, and supply reconcile exactly.

The quoted result is the highest repeated point that passes, not the largest
load the harness can submit and not a single lucky block. Use at least five
bounded repetitions near the knee and publish medians plus p50/p95/p99 tails.
If no point above 128 passes, report the measured bottleneck rather than treating
128 as validated.

Stop the entire qualification before either retention budget is reached:

- 1,000,000 cumulative new sessions; or
- 4 GiB of added application-database data,

whichever occurs first. Preserve all existing retry, historical query, recovery,
and refund semantics. No pruning or refund-deadline change is authorized. Measure
application database bytes per session and verify live/expiry/anchor/generation
references drain while terminal history remains.

## Required artifacts

Retain enough evidence to recompute the result without trusting the summary:

- clean source commit, benchmark-harness blob, experimental override diff, and
  SHA-256 build manifest for chain, native library, user-gateway, CLI, and any
  inventory exporter;
- exact command, environment, genesis/consensus parameters, pricing, funded
  accounts, provider assignment, and hardware/topology manifest;
- per-block committed transaction types, gas wanted/used, bytes, session IDs,
  open and settlement counts, commit times, consensus rounds, and signatures;
- all-validator state roots and session/economic reconciliation;
- per-component CPU and RSS samples, Go/native/JS memory scopes kept distinct;
- application-database start/end sizes and retained rows/index counts; and
- low-load delivery-path evidence plus raw saturation evidence and checksums.

## Result format

Use this sentence only after the gates pass:

> PolyStore sustained **X settled one-shot retrieval sessions/s** (**Y/day** by
> short-run extrapolation), including on-chain admission, proof verification,
> requester acknowledgement, and payment settlement, on **[exact validator
> topology and hardware]** under **[gas/bytes/cadence profile]**. Encoded-byte
> delivery and off-chain preparation were outside the saturation interval.

Publish the public-path and implemented-batch results separately. Keep the
473.6146/s proof-only result as a diagnostic comparison, not as the lifecycle
denominator.

## Relation to retrieval channels

This benchmark establishes the cost of one on-chain session per independent
read. A future retrieval channel changes the unit: the chain would open/fund a
long-lived relationship, carry many authenticated reads off-chain, and later
checkpoint, dispute, or close it.

Channel capacity therefore cannot be obtained by multiplying this result by an
assumed factor. Its qualification must report off-chain verified deliveries/s,
reads per channel, on-chain opens/checkpoints/closes per delivered read, worst-case
dispute load, locked-liquidity duration, replay/accounting recovery, and CDN-style
requester/provider distribution. The one-shot result remains the base-chain
fallback and the denominator for the measured amortization gain.
