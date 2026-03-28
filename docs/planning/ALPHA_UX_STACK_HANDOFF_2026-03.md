# Testnet UX Stack Handoff (March 2026)

This document records the stacked branch sequence for the testnet launch UX work.

Status:
- complete as a stacked branch set
- not merged to `main`

## Intent

This stack reframes the website and onboarding around the two testnet personas:

- data storage users
- data provider operators

It also adds the agent-first provider/operator posture that assumes users may have access to a local coding agent.

## Stack Order

Review and merge in this order only:

1. `alpha-ux-01-shared-marketing-shell`
   - Commit: `3b3d90c`
   - Title: `refactor(website): extract shared homepage marketing shell`
   - Base: `main`
   - Purpose: extract the polished homepage hero/card shell into reusable components.

2. `alpha-ux-02-homepage-persona-split`
   - Commit: `fb6bf93`
   - Title: `feat(website): split homepage by alpha user persona`
   - Base: `alpha-ux-01-shared-marketing-shell`
   - Purpose: make the homepage immediately route users to `Store Data` or `Run A Provider`.

3. `alpha-ux-03-storage-onboarding`
   - Commit: `58dca3a`
   - Title: `feat(website): add guided alpha storage onboarding`
   - Base: `alpha-ux-02-homepage-persona-split`
   - Purpose: add the browser-first alpha storage path.

4. `alpha-ux-04-provider-onboarding-ui`
   - Commit: `e62e076`
   - Title: `feat(website): make provider onboarding remote-first`
   - Base: `alpha-ux-03-storage-onboarding`
   - Purpose: make provider onboarding remote-first and Cloudflare-Tunnel-friendly.

5. `alpha-ux-05-onboarding-bundles-and-prompts`
   - Commit: `0ca65cb`
   - Title: `feat(website): add agent onboarding prompts`
   - Base: `alpha-ux-04-provider-onboarding-ui`
   - Purpose: add repo-tracked onboarding prompts and website prompt panels.

6. `alpha-ux-06-provider-bootstrap-doctor`
   - Commit: `e1b6422`
   - Title: `feat(scripts): add provider doctor and bootstrap helpers`
   - Base: `alpha-ux-05-onboarding-bundles-and-prompts`
   - Purpose: add `print-config`, `doctor`, `verify`, and `bootstrap` to the provider script.

7. `alpha-ux-07-alpha-status`
   - Commit: `8cf1851`
   - Title: `feat(website): add live alpha status surface`
   - Base: `alpha-ux-06-provider-bootstrap-doctor`
   - Purpose: add a shared live status page for storage users and provider operators.

8. `alpha-ux-08-docs-and-nav-cleanup`
   - Commit: `2baec59`
   - Title: `docs(website): align alpha launch navigation and packets`
   - Base: `alpha-ux-07-alpha-status`
   - Purpose: align nav labels and collaborator docs with the new alpha entry flow.

## Files Added Or Reworked

Primary website surfaces:
- `nil-website/src/pages/Home.tsx`
- `nil-website/src/pages/AlphaStorage.tsx`
- `nil-website/src/pages/AlphaProvider.tsx`
- `nil-website/src/pages/AlphaStatus.tsx`
- `nil-website/src/pages/SpOnboarding.tsx`

Shared website components:
- `nil-website/src/components/marketing/AlphaHero.tsx`
- `nil-website/src/components/marketing/TrackCard.tsx`
- `nil-website/src/components/marketing/PromptPanel.tsx`

Provider/operator docs:
- `docs/ALPHA_PROVIDER_QUICKSTART.md`
- `docs/REMOTE_SP_JOIN_QUICKSTART.md`
- `docs/onboarding-prompts/provider.md`
- `docs/onboarding-prompts/sp-onboarding.schema.json`

Storage-user docs:
- `docs/ALPHA_STORAGE_USER_QUICKSTART.md`
- `docs/onboarding-prompts/storage.md`

Collaborator packets:
- `docs/TRUSTED_DEVNET_COLLABORATOR_PACKET.md`
- `docs/TRUSTED_DEVNET_COLLABORATOR_PACKET_NILSTORE_ORG.md`

Provider automation:
- `scripts/run_devnet_provider.sh`

## Verification Gates Used

UI PRs:
- `cd nil-website && npm run lint`
- `cd nil-website && npm run build`

Provider script PR:
- `bash -n scripts/run_devnet_provider.sh`
- `PROVIDER_KEY=provider1 ./scripts/run_devnet_provider.sh print-config`
- `PROVIDER_KEY=provider1 ./scripts/run_devnet_provider.sh doctor`
- `PROVIDER_KEY=provider1 ./scripts/run_devnet_provider.sh verify`

Note:
- website builds emit existing Vite/Rollup warnings about chunk size and externalized browser-incompatible modules from dependencies
- those warnings were pre-existing and were not introduced by this stack

## Review Guidance

Review this stack by responsibility, not just chronologically:

1. UI shell and homepage split
   - PRs 1 and 2

2. User flows
   - PRs 3 and 4

3. Agent-first onboarding artifacts
   - PRs 5 and 6

4. Operational surface and cleanup
   - PRs 7 and 8

## Expected Outcome After Merge

If merged in order, the public website should:

- route users cleanly into `Store Data` or `Become A Provider`
- present storage onboarding as browser-first
- present provider onboarding as remote-first
- give coding-agent onboarding prompts directly on the website and in repo docs
- expose a live shared alpha status page
- keep old `devnet` and `sp-onboarding` surfaces as secondary/debugging paths rather than the primary story

## Follow-On Work

The next sensible stack after this one is:

1. generated onboarding bundles from live hub config
2. screenshots / PR descriptions for the stack
3. storage-side agent tooling comparable to the provider-side `doctor` and `bootstrap` additions
