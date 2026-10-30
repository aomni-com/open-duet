# 04 — Seed the official catalog into the local e2e fixture

Pure risk retirement on a green baseline: today `local-onboarding-e2e.ts`
boots a fresh Convex with **no marketplace listings at all** and completes
onboarding with zero selections (`skip: true`). The minimum-3 rule
(slice 07) would deadlock it. Fix the fixture before the product rule
exists, so any seeding surprises surface untangled from the cutover diff.

## Contract unlocked

The local onboarding e2e runs against a seeded verified catalog — the team
step shows the real official agents locally.

## API seam

Extend the `local-onboarding-e2e.ts` fixture (test-harness only; zero
product code): after `convexDev` boots, seed official listings via the
proven pattern in `packages/backend/src/official-hub-seed.test.ts` —
`internalAdmin/officialHub:beginSync` / `completeSync` with
`buildOfficialSyncPlan` from `@repo/official-agents-seed`. Both mutations
are idempotent.

## Playable deliverable

The existing e2e, unchanged in flow, now asserting the team step renders
the official agent cards (count > 0; today's zero-select continue still
works — the flow itself is byte-identical until slice 06).

## Verification

The local e2e run itself, from the test-harness package. Watch for heavy
side-effects (`createWorkspaceRow` schedules a VM; the seed test proves it
tolerates a no-VM local Convex — this slice confirms that inside the e2e's
full stack).

## Delegated to the implementer

Whether to seed all 21 agents or a stable subset ≥3 (all 21 preferred —
it's what staging shows).

## Stays green

The e2e's existing assertions; `official-hub-seed.test.ts`.
