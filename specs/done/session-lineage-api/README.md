# Session Lineage API

## Overview

Sessions form a durable tree. A session started by another session records the
parent in `createdBySessionId`; public clients can page either the roots or one
parent's readable direct children. This supports a Jobs view that presents
user-started work separately from work delegated by that work without inventing
a second “job” entity.

Permanent deletion follows the same tree. Deleting one session starts a bounded
frontier that seals each reached node and durably disposes that node's runner
and metadata when its own prerequisites are complete. Sibling and descendant
steps may overlap. Archive remains a local presentation choice for one session
and never cascades. The UI that renders the relationship is intentionally
separate from this API feature.

## Why this shape

Lineage is a property of a session, not of its agent or execution mode. Children
may move into another agent's working directory and may be ordinary
conversations or state-machine-backed jobs. Keeping one canonical parent fact
lets every consumer agree on the tree without duplicating it in a Jobs model.

Collection reads are reader-relative. Being allowed to read a parent does not
grant access to every child, so direct-child pagination runs through the same
discovery lanes that protect the ordinary session list. A missing, deleting, or
unreadable parent is indistinguishable from any other missing session. Cursors
are opaque and bound to their parent and filters because a cursor from another
relationship would otherwise skip or repeat rows silently.

Deletion is seal-first and asynchronous because runner disposal crosses the
Convex/API/gateway boundary. A synchronous recursive request would couple API
latency and reliability to subtree size and external availability. Instead,
Convex owns one durable work row per session and bounded traversal; the API owns
gateway and provider transport; the existing Action Retrier owns retry timing.
An accepted delete therefore returns an empty `204` once durable work exists,
while physical cleanup continues without any path that can restore visibility.

The work is per session rather than one growing cascade document. That keeps
each transaction bounded, lets overlapping ancestor/descendant deletes
coalesce, and permits sibling disposal through the platform scheduler's normal
concurrency. The first delete that claims a shared node keeps its root identity
for stable observability.

## Invariants

- `createdBySessionId` is immutable lineage. Deleting a parent does not rewrite
  surviving historical summaries or reparent descendants.
- `topLevel=true` means no parent. Omitting it preserves the unrestricted list.
- The nested collection returns exactly one readable child layer, never a
  recursive flattening. A grandchild appears only when its own parent is read.
- Root and child filters are applied by indexed discovery before pagination;
  filtering a page after it is read is incorrect.
- A parent is point-authorized before its collection is exposed. Child rows
  still pass reader-relative discovery admission.
- Each cursor belongs to one reader, relationship, bucket, and archive mode.
  Only `nextCursor: null` ends traversal; a short or empty page may continue.
- Archive changes only the selected session.
- Permanent delete authorizes the selected root once. Descendants inherit that
  lifecycle decision and are not independently authorized.
- Delete is idempotent: missing, already deleting, already removed, replayed,
  and lost-response retries return the same empty `204` success.
- Sealing a node and opening its immutable child range are transactionally
  ordered against nested creation. Either the child commits first and is found,
  or the parent seals first and the child create is rejected.
- Traversal, external disposal, and metadata cleanup are bounded durable steps,
  not call-stack recursion or an unbounded in-memory subtree.
- A canonical session is physically removed only after its child scan and
  external disposal complete. Its canonical row and deletion-work row disappear
  in the same transaction.
- Gateway absence gates physical deletion. Provider deletion is best effort and
  never blocks Duet cleanup.
- Recovery of a lost Action Retrier completion re-enters the same
  generation-checked retry owner; it is not a second queue or backoff policy.

## Where the mechanics live

- Public schemas and cursor domains: `SessionListQuerySchema`,
  `SessionChildrenQuerySchema`, `SessionListCursorCodec`, and
  `SessionChildrenCursorCodec` in `packages/contract/src/sessions/index.ts`.
- HTTP routes: the root and direct-child reads in
  `apps/api/src/routes/agent.ts`; public deletion and the private disposal
  callback in `apps/api/src/routes/session-deletions.ts`.
- Reader admission and indexed projection: `access.ts`, `discovery.ts`, and
  `queries.ts` under `packages/backend/convex/domains/agentSessions/`.
- Durable traversal and cleanup: `deletion.ts`; external scheduling, completion,
  and recovery: `deletionExternal.ts` and `deletionExternalAction.ts` in that
  same domain. The `agentSessionDeletionWork` table is declared in
  `packages/backend/convex/schema.ts`.
- Gateway tombstoning: the session coordinator and ledger under
  `packages/gateway/src/agent-sessions/`.
- Public documentation: `apps/docs/app/sessions/page.mdx`; agent-facing usage:
  `packages/skills-registry/skills/start-session/SKILL.md` and its generated
  registry copy.
- Behavioral proof: the session contract tests, backend `creation.tests.ts`,
  `session-list.tests.ts`, `deletion.test.ts`, and `deletionExternal.test.ts`,
  API `sessions.test.ts` and `session-deletions-internal.test.ts`, gateway
  tests, and the named staging journey in
  `packages/test-harness/src/staging-e2e-synthetic`.

The implementation-time decisions that future changes inherit remain in
[`choices.md`](choices.md).

## Plan corrections and rejected alternatives

The initial plan expected new canonical list indexes. Repository inspection
showed that authorized collection pagination had already moved to
`agentSessionDiscovery`. The shipped design copies the parent fact into that
projection, adds relationship-aware discovery indexes, and keeps only one
canonical parent index for deletion traversal. Reintroducing a parallel
canonical list reader would create two authorization and pagination owners.

Filtering children after reading an unrestricted page was rejected because it
can return short pages, skip matching rows beyond the cursor, and leak timing
about unreadable sessions. Recursive child reads were rejected because the UI
needs navigable structure and because flattening makes authorization and stable
pagination ambiguous.

A synchronous gateway/provider delete path was removed rather than retained as
a fallback. Two deletion owners would disagree after partial failure and could
physically remove state before a runner was tombstoned. Likewise, an aggregate
cascade row, a feature-specific sibling semaphore, and a generic repair cron
were unnecessary once per-session work and the existing scheduler were used.

Action Retrier 0.3.1 can swallow an error from its completion mutation and then
mark the run complete. The shipped bounded deletion-only sweep reconciles that
measured edge by run generation. This is deliberately narrower than an
independent repair system.

The deployed journey also exposed two fixture assumptions: asynchronous create
responses cannot immediately be reused as readable parents, and custom agents
are hidden until onboarding completes. The final journey waits for the public
prerequisite state and unlocks fixture agents through the public onboarded
route; it does not weaken product assertions to tolerate those conditions.

## Deployed evidence

The named `session-lineage-api` journey passed against `service.example.invalid` on
2026-08-28 as run `staging-e2e-synthetic`. It proved
root/direct-child/grandchild reads, opaque pagination, bucket filters,
cross-agent plain and scheduled children, archive non-cascade, empty `204`
deletion acceptance, immediate public absence, eventual all-zero physical
census, unrelated-session survival, and cleanup with no orphans.
The durable result excerpt is retained in
[`acceptance-receipt.json`](acceptance-receipt.json); the full local transcript
is intentionally excluded because it contains disposable staging identities.

There was no visual baseline or image provenance: this feature changed public
API and lifecycle behavior only.
