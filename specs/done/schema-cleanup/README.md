# Schema cleanup

## Overview

The 2026-07 schema audit left Duet with a smaller, stricter Convex model and
finished the useful behavior that the old schema only implied. Rate limits and
usage reporting each have one storage model, billing metadata has a typed
boundary, model usage carries real token and app attribution, file activity
derives user identity from its authenticated actor, and dormant product fields
were completed, removed, or explicitly deferred when the trustworthy identity
rail does not exist yet.

This was a hard cutover. Staging and production were explicitly declared
disposable, backed up, reset to the final schema, and reseeded rather than
carrying migration machinery into the product. The environment records live in
[`cutover/`](cutover/). The implementation decisions that remain part of the
architecture are recorded in [`choices.md`](choices.md).

## Why the schema has this shape

The governing distinction is whether data tells the truth:

- A field that receives real, useful values remains even if no screen reads it
  yet. Audit data, timestamps, and stable denormalized identifiers are valid
  future-facing records.
- A field with a reader but no real writer is an unfinished promise. The
  promise must be completed or removed; a schema is not a product roadmap.
- A field with neither writer nor reader is dead state. Indexes and functions
  are also removed when nothing needs them because they do not preserve user
  history.
- `appVisitorUserId` is the explicit deferred-field exception. The user chose
  to retain its typed storage seam for a future visitor-session rail while
  forbidding any production writer from guessing a visitor from an app owner.
  The unused helper that made that incorrect guess was removed.
- Written data is still removed when its presence would mislead a reader.
  Partial file size/time observations and the official-hub seed version looked
  authoritative without representing a complete lifecycle.
- Externally covered diagnostics may remain dormant. For example, subscription
  payment failure details remain useful support evidence even though Stripe
  already supplies the user-facing notification.

These rules favor honest ownership over maximal retention. They also explain
why app and agent rows remain separate, while duplicated helpers, indexes,
rate-limit tables, rollup tables, and copied slugs do not.

## Invariants

### One owner per concept

- `consumeRateLimit` owns fixed-window consumption over the single
  `rateLimits` table. Callers contribute a typed key and policy; they do not
  recreate persistence logic.
- `usageRollups` owns usage at every reporting granularity through one explicit
  granularity dimension, so a new period is a row shape rather than a table.
  Settlement hands it typed dimensions rather than making reports infer meaning
  from ledger strings.
- The model gateway response is the origin of token counts. Its generation
  metadata is the carrier, and the usage-rollup fold is the only reporting
  aggregate. Generation and ledger records also retain token audit context.
- `appAttributionForKey` derives app identity from the authenticated app key.
  Callers cannot claim a different app. Human visitor attribution remains
  intentionally absent until a trustworthy visitor-session rail exists.
- `actorContext` is the stored identity for file activity. Read queries may
  enrich it to a user ID, but ingest never accepts a caller-supplied user ID
  and missing historical identity rows do not make file history unreadable.
- App and agent rows own their slugs. Anchor settings do not keep a copied slug.
- Shared enum vocabularies are owned by `@repo/contract`; Convex validators
  derive from those vocabularies instead of declaring parallel lists.

### Billing data stays typed without losing audit context

Reservation lifecycle fields and wallet allocation have known shapes.
Provider- or caller-specific details live under the metadata `context` bag, so
new audit context cannot silently become ledger-owned state. Malformed optional
token analytics are omitted rather than turning an otherwise valid monetary
settlement into a retry or failure.

### Runtime contracts move coherently

Convex validation is only one half of a deployed contract. API and gateway
producers must move with it when request shapes become stricter. VM fleet skew
is handled explicitly: old gateways may still send legacy file-event size/time
fields, so ingest accepts and ignores those fields while storage and read
responses omit them. Removal from the wire is safe only after the fleet no
longer sends them.

The VM update-control row is an explicit emergency brake. If the singleton is
absent, updates flow; only `paused: true` stops convergence. A reset may restore
an explicit enabled row for operator visibility, but correctness cannot depend
on seeding it.

The authenticated API VM release manifest owns the desired agent and duetfs
versions. Deployment checks compare the fresh VM's gateway and agent versions
to live API values, avoiding a second set of those release constants in the
test harness. Duetfs remains announced by the manifest but is not a staging
convergence assertion.

### Browser file paths preserve identity

The browser proxy decodes each raw request-path segment exactly once and
re-encodes it for the API boundary. This keeps literal percent sequences,
encoded-looking filenames, absolute Drive paths, queries, and path boundaries
distinct. Next.js catch-all parameters are not the source of truth because the
deployed router has already transformed them.

### No cutover scaffolding survives

There are no compatibility schemas, dual readers/writers, migration receipt
tables, or environment-preflight analyzers in the shipped system. Recovery
exports and the cutover records preserve operational history; temporary code
does not.

## Plan-to-reality divergences

The original plan assumed retained usage history, row-by-row fixups, and drain
windows. The user later confirmed both environments were unused and chose
backup-first resets. That decision eliminated the highest-risk migration paths
and produced the simpler final schema directly.

Resetting exposed two operational dependencies that schema validation alone
could not show:

- The official hub had to be restored only after its workspaces ran the current
  VM producer. Otherwise the stale gateway immediately reported an obsolete
  reconciliation shape. The supported idempotent operator flow remained the
  owner; no rows were patched around it.
- Removing the VM update singleton originally paused all rollout. The final
  semantics make an absent row unpaused and reserve the singleton for explicit
  operator intent.

The live staging closeout also refined two test contracts. A rebooted active
turn may safely finish or be interrupted; the durable state machine determines
whether it belongs in active or historical Jobs, and a fresh accepted prompt
proves the old lock is gone. Separately, a Drive filename containing the
literal text `%2F` exposed a deployed-only double-decoding bug. The proxy now
owns raw-path decoding, and a deterministic focused journey pins that transport
seam without depending on model-generated links.

## Deliberate non-goals

- App and agent tables are not merged; their replication projections differ.
- Audit provenance is not restructured, and retention/pruning policy remains a
  separate concern.
- `appVisitorUserId` is not guessed from the app key's owner.
- Disabling an agent prevents new launches and projection but does not tear
  down existing sessions. Deletion owns teardown.
- Generated portraits are presentation, not stored agent content; missing icon
  assets never write avatar files into Drive.
- The file-event sequence remains the workspace cursor contract.

## Code map

- Schema and shared validators:
  [`packages/backend/convex/schema.ts`](../../../packages/backend/convex/schema.ts)
  and
  [`packages/backend/convex/validators.ts`](../../../packages/backend/convex/validators.ts)
- Rate limits:
  [`packages/backend/convex/domains/shared/rateLimits.ts`](../../../packages/backend/convex/domains/shared/rateLimits.ts)
- Billing metadata and usage:
  [`packages/backend/convex/domains/credits/metadata.ts`](../../../packages/backend/convex/domains/credits/metadata.ts),
  [`usageRollups.ts`](../../../packages/backend/convex/domains/credits/usageRollups.ts),
  and
  [`reservations.ts`](../../../packages/backend/convex/domains/credits/reservations.ts)
- Model usage and app attribution:
  [`packages/backend/convex/services/aiGateway.ts`](../../../packages/backend/convex/services/aiGateway.ts),
  [`packages/backend/convex/domains/modelGateway/actions.ts`](../../../packages/backend/convex/domains/modelGateway/actions.ts),
  [`packages/backend/convex/domains/modelGateway/preflight.ts`](../../../packages/backend/convex/domains/modelGateway/preflight.ts)
  and
  [`settlement.ts`](../../../packages/backend/convex/domains/modelGateway/settlement.ts)
- File identity:
  [`apps/api/src/gateway/actor.ts`](../../../apps/api/src/gateway/actor.ts),
  [`packages/backend/convex/domains/fileActivity/model.ts`](../../../packages/backend/convex/domains/fileActivity/model.ts),
  [`packages/backend/convex/domains/fileActivity/queries.ts`](../../../packages/backend/convex/domains/fileActivity/queries.ts)
  and
  [`packages/contract/src/file-attribution/index.ts`](../../../packages/contract/src/file-attribution/index.ts)
- Agent completion surfaces:
  [`packages/backend/convex/domains/agents/model.ts`](../../../packages/backend/convex/domains/agents/model.ts),
  [`apps/api/src/routes/agents.ts`](../../../apps/api/src/routes/agents.ts),
  and
  [`apps/web/spa/agents/agent-avatar.tsx`](../../../apps/web/spa/agents/agent-avatar.tsx)
- VM convergence and release ownership:
  [`packages/backend/convex/domains/workspaces/vmSync.ts`](../../../packages/backend/convex/domains/workspaces/vmSync.ts)
  and
  [`apps/api/src/routes/vm.ts`](../../../apps/api/src/routes/vm.ts)
- Browser path transport:
  [`apps/web/src/server/duet-proxy.ts`](../../../apps/web/src/server/duet-proxy.ts)
  and
  [`packages/test-harness/src/staging-e2e-synthetic`](../../../packages/test-harness/src/staging-e2e-synthetic)
- Live closeout:
  [`packages/test-harness/src/staging-e2e-synthetic`](../../../packages/test-harness/src/staging-e2e-synthetic)
  and
  [`staging-e2e-synthetic`](../../../packages/test-harness/src/staging-e2e-synthetic)

Behavior-level tests are colocated with their modules or live under the owning
package's `src/` test directory. The schema index oracle is
[`packages/backend/src/usage-rollups-index-oracle.test.ts`](../../../packages/backend/src/usage-rollups-index-oracle.test.ts).

## Verification and visual provenance

The full staging run passed every leg it reached before stopping at the Drive
literal-percent transport. Google OAuth was intentionally skipped because no
dedicated identity was configured, and cleanup reported zero orphans. Later
connected-provider, sharing, official-agent, browser-completion, route-sweep,
and build-app legs were not reached. After deploying the proxy correction, the focused
`drive-percent-identities` journey passed both literal-percent cases and
reloads, again with zero orphans. The durable run identifiers and environment
evidence are recorded in
[`cutover/staging.md`](cutover/staging.md).

Repository history contains no visual asset under this spec. The two
user-visible completions—agent portraits and internal-admin sync health—are covered
by repository-owned playground screenshot baselines under
`apps/web/tests/visual/`; there is no spec-local imagery to preserve.
