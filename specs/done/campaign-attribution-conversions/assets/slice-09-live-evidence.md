# Slice 09 — live staging journey evidence

Run: `bun run e2e:staging -- --journey campaign-conversions`, 2026-07-26,
run ID `staging-e2e-synthetic`, exit 0.

Stages, in order: `campaign:enter`, `campaign:handoff`, `signup:magic-link`,
`signup:idempotency`, `workspace:active`, `onboarding:complete`,
`messages:five`, `conversion:wait`, `cleanup`.

Evidence highlights:

- One immutable acquisition and one signup marker
  (`signupProcessedAt: 1785045083245`); repeated bootstrap returned 204.
- Lead and signup kept separate attributions; conversion followed acquisition.
- `classifyFit` terminated on the fifth message with score 96 and stable
  `conversionId: conversion:tx73cd4t…:ts7cm17f…`; no prompt text appeared in
  control evidence.
- All four destinations reported `skipped` (explicitly disabled pending real
  provider credentials — reported, not faked).
- `staleWakeNoop: true`; the transient mailbox was empty after evaluation.
- Cleanup: `status: pass`, four resources deleted (lead, mail message, user,
  workspace), zero orphans.

First attempt failed at the repeated-bootstrap `page.evaluate` racing the
SPA's post-magic-link client redirects ("Execution context was destroyed").
Fixed with the bounded `evaluateThroughClientNavigations` retry in
`packages/test-harness/src/staging-e2e-synthetic`; second run passed clean.

## Post-close rerun — lander-owned campaign actions

Run `staging-e2e-synthetic` (2026-07-26, after
the api-dispatcher/proxy collapse): the lander handles signup, lead, and
scan itself and calls Convex directly; full ladder passed, score 100, all
destinations skipped, cleanup `pass`, zero orphans. One deploy race en
route: the first lander build snapshotted its env before the secrets
fanout landed and 500'd on the lead call; an empty-commit rebuild fixed it
— fan out env vars before pushing app code that needs them.

## Post-close rerun — unsigned handoff + Sonnet 5

Run `staging-e2e-synthetic` (2026-07-26, after
the HMAC handoff removal and the classifier's switch to
`anthropic/claude-sonnet-5`): full stage ladder passed, classify-fit
terminated at score 100 with a stable conversion ID, all destinations
reported skipped, `staleWakeNoop: true`, cleanup `pass` with zero orphans.
This run is the live proof of the raw-attribution-ID handoff and of
Sonnet 5 gateway availability. It also caught a deploy-ordering lesson: the
Convex-side removal deployed minutes before the Vercel api build, and the
old api route 502'd (`handoff_unavailable`) until the push-triggered build
landed — Convex and the api app must ship together for handoff-shape
changes.
