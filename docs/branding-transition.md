# PolyStore Branding Transition

This repository now uses **PolyStore** as the canonical product and public-facing brand.

## Finalized external names

- Product and website copy: `PolyStore`
- Public domain and service hosts: `polynomialstore.com`
- Public testnet environment prefix: `POLYSTORE_TESTNET_*`
- GitHub repo path: `https://github.com/Polynomialstore/polystore`

`NILSTORE_TESTNET_*` is no longer supported in the public testnet scripts or website bootstrap flow. `POLYSTORE_TESTNET_*` is the only canonical public prefix.

## Frozen technical surfaces

The following technical identifiers remain intentionally unchanged for now:

- `nilchain`
- `NilFS`
- `X-Nil-*` protocol headers
- `nil_*`/`nil-*` module, package, service, and implementation-surface names such as `nil_gateway`, `nil_core`, `nil_cli`, and `nil-website`
- existing generated or protocol-bound identifiers that still encode `nil`

These names are part of the current protocol and implementation surface area. They should only change in a deliberate follow-up migration with explicit compatibility and versioning decisions.

## Practical rule

When editing website copy, docs, onboarding flows, or public configuration, use `PolyStore` and `POLYSTORE_TESTNET_*`.

When editing protocol, package, module, or runtime internals, keep the existing `nil*` identifiers unless the work is explicitly scoped as a technical rename.
