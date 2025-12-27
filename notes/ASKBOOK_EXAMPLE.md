# Canonical AskBook example (informative)

This illustrates the canonical AskBook entry format and hashing approach. Implementations MUST follow the normative definitions in `spec.md` §6 for hash functions and bounds.

Partition: `{region="us-east", qos_class="standard"}`

Entry (canonical encoding order):
```
{
  sp_id: 0x1234,
  region: "us-east",
  qos_class: "standard",
  p0: 1.00 * BaseFee,       // falls in β_band=1.0 within [β_floor, β_ceiling]
  k: 0.25,                  // within k_bounds
  γ: 2.0,                   // within γ_bounds
  cap_free_GiB: 5000,
  min_term_epochs: 30,
  price_curve_id: "PSET-V1",
  placement_cells: [0x01af, 0x01b0] // optional, if published
}
```

Hashing:
- Encode fields in a canonical byte format (e.g., SSZ/CBOR as per spec) and hash with Poseidon (or Blake2s if specified) to produce the leaf.
- `AskBookRoot` = MerkleRoot(leaves across all regions/QoS); partition offsets index the slice for `{region, qos_class}`.

Defaults (from spec):
- Caps: `β_floor=0.70`, `β_ceiling=1.30`, `premium_max=0.5×BaseFee`, `price_cap_GiB=2×` median(BaseFee by region/class), `σ_sec_max ≤ 10%/epoch`.
- Bounds on slope: `k ∈ k_bounds`, `γ ∈ γ_bounds` (set in the `$STOR-1559` PSet).
