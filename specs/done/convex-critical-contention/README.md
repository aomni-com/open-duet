# Critical Convex contention

Authenticated request bursts and per-call billing used shared write paths that
exhausted optimistic retries. The implementation separates frequently changing
usage from workspace configuration and gives background charges an account-owned
settlement lane. It is deployed to production; the spending backfill is complete.

## Why these boundaries

A workspace is the wrong serialization boundary for money: multiple workspaces
can share one payer. A global queue would avoid competing wallet writers but
would make unrelated accounts wait for each other. The compatible Convex Batch
Worker 0.2.2 supplies named serial loops and recovery without requiring a Convex
upgrade or a second application retry system. See the
[settlement owner](../../../packages/backend/convex/domains/credits/settlementQueue.ts).

Scheduled mutations alone did not provide the required serialization. The
bounded pending selection belongs to a snapshot query so new arrivals do not
invalidate an in-progress batch's range read. Failed items leave the pending
selection and remain repairable; retrying an unchanged poison item forever would
hide failure and prevent progress.

Moving money into the queue does not authorize approximate accounting. The
[ledger](../../../packages/backend/convex/domains/credits/ledger.ts) and
[reservations](../../../packages/backend/convex/domains/credits/reservations.ts)
retain atomic, account-wide wallet decisions and monthly-first allocation.
Admission observes committed accounting; durable acceptance is not settlement
and does not reserve unknown costs from other in-flight requests.

[Workspace spending](../../../packages/backend/convex/domains/credits/workspaceSpend.ts)
has its own exact owner because billing should not invalidate unrelated workspace
configuration reads. Additive migration is necessary because deployment and
backfill are separate events. Live writes must win over stale legacy totals.

## Invariants

- Settlement follows the current payer's lane. A service reference belongs to
  its workspace across payer changes, so replaying an already charged job cannot
  debit the replacement payer. Model generation identity likewise survives
  duplicate and late terminal reports.
- A failed item rolls back its money changes without discarding accepted work
  or blocking later items. Corrected generation reports can retry failed pricing;
  late failures cannot replace accepted generation costs.
- Each charge retains its event time. A prior-month debit can enter the ledger
  without resetting a newer spending window. Credit-epoch and reservation rules
  remain owned by the existing money transaction.
- Credential timestamp writes share one throttle across ordinary API use and
  model preflight. Throttling only one caller still invalidates the other's
  request-counter reads; the first live staging burst exposed this omission.
- Wider authenticated counters preserve allowance already spent under the old
  layout during rollout. Money itself is not sharded.

The behavior checks live in
[settlement-queue](../../../packages/backend/src/settlement-queue.test.ts),
[service-proxy](../../../packages/backend/src/service-proxy.test.ts),
[model-gateway](../../../packages/backend/src/model-gateway.test.ts),
[credits](../../../packages/backend/src/credits.test.ts), and
[api-keys](../../../packages/backend/src/api-keys.test.ts). The
[billing contention](../../../packages/backend/src/billing-contention.test.ts),
[credential throttle](../../../packages/backend/convex/domains/apiKeys/authenticate.test.ts)
and [counter rollout](../../../packages/backend/convex/domains/apiKeys/apiRateLimit.test.ts)
checks pin the corresponding concurrency boundaries.
Real-local concurrency uses `skipQueue: true`: the HTTP client's default mutation
queue otherwise conceals server contention. Checks assert final ledger values,
not successful enqueue responses alone.

## Verification and rollout boundary

The registered `billing-contention` staging journey verifies concurrent credential
use, mixed model/service charges and preflight/session/file traffic. The final
staging revision `f624522c23a4757da168fc6c63fd073b75d0b97f` passed receipt
`staging-e2e-synthetic`: 64 credential uses, 32 settlements, eight
activity rounds, exactly 3,200 micro-USD debited, one ledger entry per reference
and clean teardown. The Docker wrapper stalled installing Bun before testing;
the same registered backend-only journey ran successfully with the installed
Bun runtime against live staging. Earlier Docker-based runs also passed.

The compatible web reader deployed first in both environments. The complete
change then merged to main as `b03083bb78e38d6d4befdd76cde470695eb8a7ac`; production
Convex reported that exact revision after the API deployment completed. Production
`backfillWorkspaceSpending` finished with `state: success`, `isDone: true` and
823 workspaces processed on 2026-09-11. Staging backfill had already completed.
Live web signup-refusal checks passed on staging and production with the named
403 and no intent cookie; these do not constitute a live Google OAuth journey.

With both backfills complete, removing the legacy spending schema fields and
fallback is eligible for the subsequent cleanup deployment. Counter compatibility
reads likewise have a one-window removal gate. The backend
[accounting documentation](../../../packages/backend/README.md) owns operational
entry points. Normal signup refusals remain a separate policy outcome documented
in [SECURITY.md](../../../SECURITY.md).

The root closeout run was not wholly green: the unchanged internal-admin suite
seeds 1,001 workspaces before testing a fleet read bounded to 1,000 rows per
status. The fleet case passes alone and fails after that fixture. Focused reruns verify corrected billing, credential and pagination checks; the
fleet fixture issue remains.

Dashboard Insights retain historical events. Only post-deployment timestamps can
show recurrence; a historical entry is not evidence that a new deployment failed.
No visual baseline or inspiration image defined this backend change.
