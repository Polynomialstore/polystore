# Note: Long Deals, Provider Ephemerality, Pricing Transience, and Renewal Semantics (Draft)

Last updated: 2026-01-23

This note answers common questions about how **long-lived user deals** interact with:
- provider exit / rotation,
- price changes over time,
- “rent” vs “escrow” semantics,
- and the new **deal expiry + renewal** mechanics.

---

## 1) Long deals vs long provider assignments

A long deal (“5 years”) SHOULD NOT imply the same storage provider must hold the data for 5 years.

PolyStore should decouple:
- **user permanence** (the deal can be long), from
- **provider ephemerality** (providers can drain/exit; the system repairs/replaces slots).

Operationally:
- providers can enter a **draining** state,
- the network replaces their slots over time (bounded by a churn budget),
- deals continue on new providers without user intervention.

---

## 2) What is locked in: service or token?

PolyStore pricing is denominated in **NIL**. There is no fiat peg and no oracle.

Users lock in a *service obligation* (store bytes for N blocks), priced in NIL at the time funds are deposited/charged.

Implication:
- If NIL’s fiat price changes, the fiat-equivalent price of storage changes.
- The market pricing controller must respond to supply/demand in NIL terms.

---

## 3) What happens if storage_price changes mid-deal?

Under the frozen pricing contract:
- Storage charges happen when content size increases (at commit time).
- Retrieval session pricing is “spot at session open”.

Implication:
- Previously committed bytes are not repriced.
- Additional bytes are priced at the *current* storage_price at the time they are added.

---

## 4) Extending a deal (renewal)

PolyStore renewal semantics are specified in `rfcs/rfc-deal-expiry-and-extension.md`:

- Renewal uses **spot `storage_price` at extension time**.
- Extending appends time after the current end (or from now if already expired, within grace).
- Renewal charges for **existing committed bytes**:
  `extension_cost = ceil(storage_price * current_size_bytes * additional_duration_blocks)`.

A renewal grace window (`deal_extension_grace_blocks`) provides:
- a non-punitive period to renew after expiry,
- an explicit retention horizon for providers before GC.

---

## 5) Deal expiry and data deletion

- After `end_block` the deal is expired and cannot be mutated; new retrieval sessions cannot be opened.
- Providers SHOULD retain data until `end_block + deal_extension_grace_blocks`, then MAY garbage collect.

This is intentionally aligned with the “chaos monkey” intuition:
- short renewal cadence exercises the system,
- providers can exit with minimal penalty when the network is healthy.

---

## 6) Rent vs escrow: what’s still unresolved

The current accounting RFC describes transfers into a deal’s `escrow_balance` and deterministic debits for retrieval sessions.
It does **not** fully specify end-of-deal refund/close semantics for storage lock-in funds.

This matters because it affects:
- capital efficiency for users,
- the extent to which self-dealing can farm emissions,
- long-run token sinks vs inflation.

Pre-alpha default recommendation:
- implement expiry + renewal + provider GC first,
- keep escrow close/refund as a follow-on RFC with explicit invariants and anti-wash design.
