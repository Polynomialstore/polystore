# Four-validator retrieval settlement smoke (#260)

`scripts/retrieval_four_validator_workload.py --mode settlement-smoke` retains
complete open/proof/confirmation lifecycle timing for six fresh sessions and
22 proof openings across K8/K2 slot zero. `--proof-only` prepares those same
sessions before timing proof submission and adds bounded adversarial checks.
Both modes compare committed successful transaction hash, signed bytes, height,
code and gas across all four validators, then check settlement after a persistent
restart at both the original state height and a later height.

The proof-only path submits five transactions before successful proof acceptance:
wrong signer and wrong system-z for each layout, then a two-message K8 transaction
whose first proof is valid and whose later proof has a changed canonical y scalar.
The latter must fail native verification and roll back the earlier message. Fixed
20M gas makes these actual committed failures, not simulation results. An unknown
outcome, CheckTx-only rejection, unexpected success or unrelated error fails the
run without retrying. Each failure must preserve every queried session, deal,
activity record, module stake balance and workload stake balance. Stake supply may
increase only by independently verified SDK mint issuance.

After settlement, the proof-only path resubmits the first proof and confirmation
for each layout. Current keeper behavior is idempotent success for an authorized,
unexpired completed session. All four retries must leave the same state unchanged.
Transaction ante fees and sequences may change; they use aatom and are explicitly
excluded from the stake-liability equality. The immutable stake snapshots and
four-node outcomes are retained under `adversarial_phases` in `evidence.json`.

Supply conservation retains the generated **normal SDK mint genesis**, including
its minter and parameters in `smoke_mint_profile` and the frozen genesis hash.
For every block between economic snapshots, `mint_issuance` retains all finalize
block events and successful transaction event lists, independently compared
across four validators. The pinned `mint` module account address identifies the
only permitted bank `coinbase` recipient. Its stake amount must equal the single
SDK `mint` event's numeric amount; zero issuance requires no bank coinbase event.
Duplicate attributes, missing events, unexpected minters or denominations, and
transaction mint events fail the run. Failed transaction events are excluded
because execution state was rolled back.

The supply equation is `after - before = verified SDK issuance - retrieval burns`;
negative/retry phases require `after - before = verified SDK issuance`. Payouts,
module balances, escrow and served credit retain their exact original assertions.
Accounting covers snapshot intervals through the later restart height, subject to
the lifecycle deadline and a 4096-block interval limit. Existing nilchain base
rewards, epoch audit budgets and storage rewards can mint too: their appearance
fails this profile until explicitly accounted for. There is no assumption that
staying in an early epoch eliminates other mint sources. This is a diagnostic
profile, not general production monetary accounting. No provider transport,
delivered bytes or capacity qualification is established by this fixture workload.

Use the existing required binary/library/new-home and full-row nonconstant
`--fixture-k8` / `--fixture-k2` arguments, adding `--proof-only` for the adversarial
path. Preserve the supplied runtime and source provenance and retained private
homes. Source tests exercise mutation rejection and orchestration without nodes;
**this extension still needs actual runs of both modes** before runtime evidence
or completion can be claimed.
