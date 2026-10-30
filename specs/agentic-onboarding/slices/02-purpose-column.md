# 02 — The purpose column and its one writer

## Contract unlocked

A workspace can carry a purpose — one optional plain-text column, written
once at onboarding completion, alongside `duetName`. Nothing else about
onboarding changes yet.

## API seam

- `packages/backend/convex/schema.ts` workspaces table:
  `purpose: v.optional(v.string())` beside `duetName`.
- `completeWorkspaceOnboarding` (`domains/workspaces/birth.ts`): optional
  `purpose` arg validated with `WorkspacePurposeSchema`, written write-once
  exactly like `duetName` (`workspace.purpose ?? requested`). The
  `onboarding.completed` analytics properties gain
  `goal: <goalId> | 'custom' | 'none'` (goal id travels as a sibling request
  field for analytics only — it is NOT stored). Never send the purpose text
  to analytics.
- `WorkspaceOnboardingRequestSchema` (contract): gains optional `purpose`
  and optional `goal`. Both request-union branches must carry them — if the
  union invites drift, restructure it around one shared base object that
  owns `duetName`/`purpose`/`goal` (designed-today shape, not a bolt-on).
- `POST /v1/ws/:workspaceSlug/onboarding` (`apps/api/src/routes/marketplace.ts`):
  passes `purpose`/`goal` through to the mutation. The route keeps its home —
  it orchestrates installs, which are marketplace-owned.
- whoami `WorkspaceSummary` gains optional `purpose` — the staging journey's
  persistence assert reads it, and it is the obvious read for any future
  settings surface. One trust domain inside a workspace; no extra scoping.

The recommendations endpoint (slice 01) never persists anything: a user who
abandons onboarding leaves nothing behind, and the purpose has exactly one
write path.

## Playable deliverable

A curl/REST call completing onboarding with a purpose, then whoami (or the
existing `testing/workspaces:rawWorkspacesForTest` query) showing it stored.

## Verification

- `write-tests` red first: mutation tests (write-once semantics — second
  completion cannot overwrite; absent stays absent), route test asserting
  pass-through, whoami echo test, contract tests.
- `bun test --changed` (the change spans contract/backend/api).

## Delegated to the implementer

Where `goal` sits in the request shape; the shared-base restructuring of the
onboarding request union (do it only if adding the fields twice would
otherwise duplicate them).

## Stays green

`agent-naming` and `campaign-conversions` staging journeys (API-level
callers — `purpose` is optional), all existing birth/marketplace tests.
