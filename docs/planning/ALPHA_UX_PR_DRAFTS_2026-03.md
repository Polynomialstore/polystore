# Alpha UX PR Drafts (March 2026)

This document contains ready-to-paste PR bodies for the alpha UX stacked branch set.

Use each PR against the branch base listed in the header, not against `main`, until the full stack is reviewed.

## PR 1

Branch:
- `alpha-ux-01-shared-marketing-shell`

Base:
- `main`

Title:
- `refactor(website): extract shared homepage marketing shell`

Body:

```md
## Summary

This PR extracts the polished homepage shell into reusable website marketing components without changing the current homepage message or route structure.

## What Changed

- added a shared hero component
- added a shared track card component
- refactored the homepage to use those components

## Why

The alpha launch work needs to reuse the homepage visual language for storage onboarding, provider onboarding, and status pages. This PR isolates the existing polished shell before changing the information architecture.

## Testing

- `cd nil-website && npm run lint`
- `cd nil-website && npm run build`

## Notes For Reviewers

- this PR is intentionally low-risk
- the expected result is visual parity with the pre-refactor homepage
- follow-up PRs in the stack will change copy and routes
```

## PR 2

Branch:
- `alpha-ux-02-homepage-persona-split`

Base:
- `alpha-ux-01-shared-marketing-shell`

Title:
- `feat(website): split homepage by alpha user persona`

Body:

```md
## Summary

This PR reorients the homepage around the two alpha personas:

- users who want to store data
- operators who want to run storage providers

## What Changed

- updated homepage CTA hierarchy
- added alpha storage, provider, and status route surfaces
- updated top-level navigation to expose the new alpha paths

## Why

The existing homepage and nav structure did not clearly separate the alpha launch funnels. This PR creates that split before deeper onboarding work lands.

## Testing

- `cd nil-website && npm run lint`
- `cd nil-website && npm run build`

## Notes For Reviewers

- the new alpha pages are intentionally lightweight in this PR
- follow-up PRs fill in storage onboarding, provider onboarding, and status content
```

## PR 3

Branch:
- `alpha-ux-03-storage-onboarding`

Base:
- `alpha-ux-02-homepage-persona-split`

Title:
- `feat(website): add guided alpha storage onboarding`

Body:

```md
## Summary

This PR adds the browser-first alpha storage-user path.

## What Changed

- upgraded `AlphaStorage` from placeholder to a guided onboarding page
- reused existing wallet, faucet, and dashboard-related components
- added explicit checklist and success criteria for first store and retrieve flow

## Why

For alpha launch, storage users should have the easiest path. This PR makes the browser-first flow first-class and easy to find from the homepage.

## Testing

- `cd nil-website && npm run lint`
- `cd nil-website && npm run build`

## Notes For Reviewers

- this is intentionally browser-first rather than local-gateway-first
- agent-assisted storage setup comes later in the stack
```

## PR 4

Branch:
- `alpha-ux-04-provider-onboarding-ui`

Base:
- `alpha-ux-03-storage-onboarding`

Title:
- `feat(website): make provider onboarding remote-first`

Body:

```md
## Summary

This PR makes provider onboarding remote-first and home-server friendly.

## What Changed

- changed `SpOnboarding` default track to remote/headless
- reframed provider onboarding around home server + Cloudflare Tunnel and public host setups
- kept local demo as a legacy/development path instead of the primary story
- updated the alpha provider page to point operators into the remote-first runbook

## Why

The previous provider UI still read like a local demo tool. For alpha launch, the real target is a remote operator host, often behind NAT, with a coding agent available locally.

## Testing

- `cd nil-website && npm run lint`
- `cd nil-website && npm run build`

## Notes For Reviewers

- this PR changes messaging and default posture, not backend behavior
- prompt generation and repo-tracked onboarding artifacts land in the next PR
```

## PR 5

Branch:
- `alpha-ux-05-onboarding-bundles-and-prompts`

Base:
- `alpha-ux-04-provider-onboarding-ui`

Title:
- `feat(website): add agent onboarding prompts`

Body:

```md
## Summary

This PR adds repo-tracked onboarding prompts and quickstarts for both alpha personas.

## What Changed

- added provider and storage quickstart docs
- added Codex and Claude Code prompt files under `docs/onboarding-prompts/`
- added a reusable prompt panel component
- embedded copyable prompts into the alpha storage and alpha provider pages

## Why

The onboarding plan assumes many provider operators will have access to a coding agent locally. The website should give them a direct launchpad into repo-local setup, not just a wall of shell snippets.

## Testing

- `cd nil-website && npm run lint`
- `cd nil-website && npm run build`

## Notes For Reviewers

- prompts are static and repo-tracked in this PR
- live/generated onboarding bundles are intentionally deferred to a later stack
```

## PR 6

Branch:
- `alpha-ux-06-provider-bootstrap-doctor`

Base:
- `alpha-ux-05-onboarding-bundles-and-prompts`

Title:
- `feat(scripts): add provider doctor and bootstrap helpers`

Body:

```md
## Summary

This PR adds agent-friendly provider helpers to `scripts/run_devnet_provider.sh`.

## What Changed

- added `print-config`
- added `doctor`
- added `verify`
- added `bootstrap`
- updated the remote provider quickstart to document the new commands

## Why

Remote provider onboarding still required too much log-reading and manual inference. These commands give Codex/Claude and human operators a tighter loop for setup, diagnosis, and verification.

## Testing

- `bash -n scripts/run_devnet_provider.sh`
- `PROVIDER_KEY=provider1 ./scripts/run_devnet_provider.sh print-config`
- `PROVIDER_KEY=provider1 ./scripts/run_devnet_provider.sh doctor`
- `PROVIDER_KEY=provider1 ./scripts/run_devnet_provider.sh verify`

## Notes For Reviewers

- existing `init/register/start/stop` behavior is preserved
- the new commands are additive and intended to reduce onboarding ambiguity
```

## PR 7

Branch:
- `alpha-ux-07-alpha-status`

Base:
- `alpha-ux-06-provider-bootstrap-doctor`

Title:
- `feat(website): add live alpha status surface`

Body:

```md
## Summary

This PR adds a live alpha status page shared by storage users and provider operators.

## What Changed

- replaced the placeholder alpha status page with a live operational surface
- reused existing status and LCD/provider data sources already present in the site
- exposed public endpoint visibility, provider rows, and known-issues framing

## Why

Both alpha personas need a single place to check whether the network is healthy before debugging their own setup. This page is that shared operational entry point.

## Testing

- `cd nil-website && npm run lint`
- `cd nil-website && npm run build`

## Notes For Reviewers

- this page is based on existing website-side status probes and LCD data
- it is intentionally not a new backend monitoring service
```

## PR 8

Branch:
- `alpha-ux-08-docs-and-nav-cleanup`

Base:
- `alpha-ux-07-alpha-status`

Title:
- `docs(website): align alpha launch navigation and packets`

Body:

```md
## Summary

This PR aligns navigation and collaborator docs with the new alpha persona split.

## What Changed

- updated nav labels so `sp-onboarding` and `devnet` read as secondary/runbook-debug surfaces
- updated provider CTAs to point at alpha status rather than generic devnet join info
- updated collaborator packets to point storage users and provider operators at the alpha quickstarts
- removed outdated launch framing in the testnet docs entry point

## Why

By this point in the stack, the website already has the right alpha flows. This PR removes the leftover conflicting story so users are not routed back into older devnet-first framing.

## Testing

- `cd nil-website && npm run lint`
- `cd nil-website && npm run build`

## Notes For Reviewers

- this PR is mostly copy, nav, and documentation alignment
- no new onboarding logic is introduced here
```

## PR 9

Branch:
- `alpha-ux-09-stack-handoff`

Base:
- `alpha-ux-08-docs-and-nav-cleanup`

Title:
- `docs(planning): add alpha ux stack handoff`

Body:

```md
## Summary

This PR adds an internal handoff note for the completed alpha UX stack.

## What Changed

- added a repo-tracked planning document that records:
  - branch order
  - base branches
  - commit IDs
  - changed file areas
  - verification gates
  - review guidance

## Why

The stack is reviewable, but a reviewer should not have to reconstruct merge order and intent from commit history alone. This document makes the stack operational.

## Testing

- doc-only change

## Notes For Reviewers

- this is a handoff aid, not a user-facing product change
- it should be merged only after the main stack content is accepted
```
