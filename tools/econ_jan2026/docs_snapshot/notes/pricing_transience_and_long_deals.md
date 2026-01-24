# Note: Long Deals, Provider Ephemerality, and Pricing Transience (Draft)

Last updated: 2026-01-22

This note answers common questions about how **long-lived user deals** interact with:
- provider exit / rotation,
- price changes over time,
- “rent” vs “escrow” semantics.

## 1) Long deals vs long provider assignments

A long deal (“5 years”) SHOULD NOT imply the same storage provider must hold the data for 5 years.

The system should treat provider assignments as *continuously replaceable* via repair/replacement:
- If a provider wants to leave, it can enter a **draining** state.
- The network replaces its slots over time (bounded by a churn budget).

This preserves “user permanence” while allowing “provider ephemerality”.

## 2) What is locked in: service or token?

NilStore pricing is denominated in NIL.
A user locks in a *service obligation* (store bytes for N blocks), priced in NIL at the time funds are deposited.

There is no fiat peg or oracle. If NIL’s fiat price changes, the fiat-equivalent price of storage changes.

## 3) What happens if storage_price changes mid-deal?

Under the frozen pricing contract:

- Storage lock-in charges happen when content size increases:
  the deal pays `storage_cost = ceil(storage_price * delta_size_bytes * duration)` where `duration = end_block - start_block` is fixed for the deal.  
  (This has the practical effect that adding bytes late in a deal still pays for the full duration; treat it as reserving/allocating capacity for that full term.)

- Retrieval pricing is “spot at session open”:
  a retrieval session locks prices at open and settles at completion.

Implication:
- Previously committed bytes are not repriced.
- Additional bytes are priced at the *current* storage_price at the time they are added.

## 4) Extending a deal

The frozen contract explicitly says a future `ExtendDeal` is out-of-scope.
If/when added, the cleanest semantics are:
- pay the current storage_price for `current_size_bytes * extension_duration`.

This supports a “monthly renewal” UX: users can prepay 1 month, then auto-extend.

## 5) Is “rent” taken continuously?

The current accounting RFC describes **up-front charging into an escrow balance** and debits for retrieval sessions and elasticity.
It does *not* fully specify whether the storage lock-in component is refunded or consumed over time.

This is a policy-critical missing piece because it affects:
- capital efficiency for users,
- whether self-dealing can farm emissions,
- long-run token sinks vs inflation.

Recommendation (for testnet):
- Treat storage lock-in as a true fee (non-refundable), or implement deterministic rent consumption over time,
  before relying on `total_active_slot_bytes` as a scale factor for emissions on mainnet.

