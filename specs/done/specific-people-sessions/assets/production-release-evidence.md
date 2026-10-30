# Specific-People Sessions — Production Release Evidence

**Status:** Complete

## Authority

- At `2026-08-29T15:12:26Z`, the user instructed the implementation agent to
  “push to prod.” This authorizes the complete two-phase production rollout:
  migration-safe promotion, the eleven named resumable Convex migrations,
  strict-schema promotion, and production verification.
- The user then directed that both Convex phases deploy directly from
  `packages/backend`, followed only after strict Convex succeeds by one final
  `staging` to `main` merge for the production Vercel release. No phase-one
  Vercel production deployment will be started.
- The instruction does not authorize creating production identities or
  weakening the required owner/editor/two-viewer behavior proof.

## Phase one

- Direct migration-safe Convex production deployment: completed at
  `2026-08-29T15:18:43Z`; Convex reported successful schema validation and
  function deployment.
- All eleven migrations completed with terminal `success`, `isDone: true`, and
  null cursors. Redacted processed counts in runner order: `421`, `402`,
  `39,358`, `0`, `9,203`, `4`, `0`, `20,114`, `65,147`, `56,243`, and `324`.
- Completed-series no-op proof: the rerun reported `Migration already done`,
  and the subsequent status read preserved every terminal timestamp and
  processed count.

## Phase two

- Direct strict-schema Convex production deployment: completed; Convex's
  production schema validation succeeded before the branch promotion.
- Final `staging` to `main` merge and Vercel production deployment: completed
  at the user's direction after strict Convex succeeded.
- Release and deployed-docs convergence: passed at `2026-08-29T15:59:30Z`.
  The public verifier reported backend schema `1`, web cache schema `12`, and
  one matching gateway version across the API manifest, gateway health, and
  probe workspace.
- The staging-accepted bounded agent-dispatch correction was subsequently
  promoted through the ordinary `staging` to `main` Vercel release. The
  production read-only verifier passed after convergence and again reported
  backend schema `1`, web cache schema `12`, and one matching gateway version
  across the API manifest, gateway health, and probe workspace.
- Public behavior proof: the user accepted the passing strict staging journey as
  the behavior gate because staging mirrors production. The production census
  found no qualifying existing roster and created no production identities.

## Strict staging journey

- A focused run reached UI creation and exposed a request-lifetime mismatch:
  Convex had durably prepared the initial prompt, but the public API waited for
  a cold runner until Vercel returned `504`. Agent gateway dispatch now gets a
  15-second foreground opportunity and otherwise returns the existing durable
  `queued` result for the existing drain to deliver.
- Two later runs proved UI creation and the core API behavior, then exposed
  journey-only dependencies on global browser network idleness and on a VM app
  runtime unrelated to the app-principal authorization proof. The journey now
  settles the exact session-list DOM and provisions only the app identity/key
  the proof consumes.
- Final focused acceptance passed on 2026-08-29. Evidence recorded UI-created
  specific audience, owner override, generic denial, three audience pages, SSE
  reconnect denial, app-principal survival after creator removal, final-member
  personal archive, and matching deployed release identities.
- Final cleanup reported `status: pass`; every synthetic user, workspace,
  invite, mail message, app, and session was deleted with `orphans: []`.

## Cleanup and closeout

- Smoke session absence: not applicable; no production smoke session was created.
- Copied credential revocation: not applicable; no credential overlay was created.
- Temporary verifier removal: complete.
- Current-tree repository gate: passed on 2026-08-29. All 23 package tasks,
  API's 743 tests (seven environment-gated skips), and the visual coverage,
  visual owner union, and asset ownership checks completed with zero failures in
  29m 12s. The closeout gate was rerun after removing the one-time verifier.
