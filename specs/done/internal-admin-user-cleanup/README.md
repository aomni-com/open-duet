# Internal admin user cleanup

## Overview

Internal operators can preview and start a durable cleanup for a user from the
admin panel or REST API. The operation removes the user's live memberships,
deletes a workspace only when that user is its sole live member, transfers a
shared payer only when exactly one eligible owner remains, and retires the
identity through the canonical anonymizing path. Financial, usage, audit, and
provider history remains queryable.

## Why this shape

Cleanup is asynchronous because workspace teardown, membership-session
reconciliation, and provider work outlive an HTTP request. A frozen plan and one
resource row per action make retries safe and let the operator distinguish an
accepted workspace teardown from provider completion.

The workspace and membership domains already own their lifecycle effects, so
cleanup composes `deleteWorkspaceImpl`,
`deleteWorkspaceMembershipGeneration`, and `reassignWorkspacePayer` instead of
reimplementing cascades. The user row is retained and anonymized so historical
audit and financial references remain valid. Shared workspaces are protected by
an explicit sole-member check; payer transfer is blocked when ownership is
ambiguous.

## Principles and invariants

- Self-delete is refused before an operation row is inserted.
- The reviewed user-link set is assigned one lifecycle owner, retained-history
  policy, or explicit blocker in `ownership.ts`; bounded reads block on overflow.
- Membership generation ids are frozen and revalidated, so a rejoin cannot be
  removed by an old plan.
- Personal credentials and OAuth families are fenced during identity retirement;
  workspace `system_vm` and app principals for a surviving workspace remain.
- Workspace deletion means canonical teardown accepted or scheduled. Provider
  VM, backup, and membership-reconciliation work may remain pending.
- A completed operation can still contain a resource-level `provider_pending`
  outcome; completion means the local cleanup rail finished, not every external
  provider has reported completion.
- Start is idempotent for active, completed, blocked, and failed operations;
  blocked or failed work is retried explicitly and is replanned against current
  state.
- Audit reason and request id validation happens before cleanup state is written.

## Code pointers and proof

`packages/backend/convex/domains/internalAdmin/ownership.ts` is the finite
ownership manifest. `planner.ts` owns deterministic classification, while
`cleanup.ts` owns preview, start, dispatch, status, and retry. The two Convex
schema tables are `internalAdminCleanupOperations` and
`internalAdminCleanupResources` in `packages/backend/convex/schema.ts`.

The REST contract lives in `packages/contract/src/internal-admin/index.ts` and
`apps/api/src/routes/internal-admin.ts`:

- `GET /v1/internal-admin/users?q=` previews a normalized user lookup.
- `POST /v1/internal-admin/users/:userId/cleanup` starts cleanup with `{reason}`.
- `GET /v1/internal-admin/cleanup/:operationId` reads status.
- `POST /v1/internal-admin/cleanup/:operationId/retry` replans blocked or failed work.

The panel is `apps/web/spa/routes/internal-admin.tsx`; it previews resources,
shows blockers and provider-pending status, polls scheduled work, and exposes
retry without owning lifecycle state.

The focused contract and preflight behavior is pinned by
`packages/backend/convex/domains/internalAdmin/cleanup.test.ts`,
`cleanupPlanner.test.ts`, `packages/backend/convex/domains/users/retire.test.ts`,
and `apps/api/src/routes/internal-admin-cleanup.test.ts` plus the SPA client
tests. The full dispatcher journey remains a staging/package-level follow-up;
the implementation is covered here by the canonical lifecycle owners it calls.

## Divergences and dead ends

The initial ownership draft treated workspace soft deletion as a generic row
cascade. The shipped manifest records the canonical soft-delete rail, retained
history, and provider-specific blockers instead. Generated Convex Auth links
were corrected to their actual `accountId`, `sessionId`, and `identifier`
fields. The legacy `/v1/internal-admin/search` contract remains unchanged.

## Visual provenance

The panel was checked through the existing internal-admin visual coverage and
baseline workflow. The generated provenance is recorded in
`apps/web/tests/visual/coverage-ledger.generated.json` and
`visual-coverage/index.generated.html`; the gate still reports an unrelated
1% `workspace-escape` baseline drift. No feature-specific reference image
defined this feature.
