# Harness consumer decisions

## Validate the complete manifest at one consumption owner

**When:** slice06 harness consumer pass.

**Decision:** route the existing manifest reads through a lightweight harness
helper that uses the shared schema and canonical identity recipe. A wrong hash
or incomplete inventory fails before health polling. The alternative checked
only a free-standing version string at each journey.

**Gap:** existing journeys received a gateway stamp and unrelated npm pins; they
needed one reliable statement of the constructed runtime identity.

**Rationale:** per-journey checks would duplicate artifact rules and permit a
partial inventory to pass readiness. Controlled HTTP verifies the actual new
URL and VM bearer, while a falsified identity check proves malformed metadata
cannot be certified.

**Consequence:** future inventory formats change at the shared schema/recipe;
the harness remains a consumer. Captured metadata fixtures live with tests and
do not depend on the eventual location of archived spec evidence.

## Await the existing workspace readiness predicate

**When:** consumer migration review.

**Decision:** allow the existing workspace predicate to return a promise and
await it. The browser fixture now reads the current announcement within that
poll. The alternative retained its detached fetch and last-snapshot variable.

**Gap:** asynchronous manifest failures could escape the existing synchronous
poll, and treating a promise as a boolean could certify a stale observation.

**Rationale:** one awaited callback keeps query, announcement, failure, and
readiness in the same existing owner. A deliberate false asynchronous predicate
reproduced the early-success bug before the two-line wait change earned green.

**Consequence:** announcement errors propagate to the journey; fresh metadata is
compared before readiness. Polling budgets and ordinary journey behavior remain
with their current owners.

## Name the temporary backend diagnostic mapping

**When:** consumer pass; prescribed boundary confirmed by root.

**Decision:** map the existing backend gateway diagnostic to runtimeVersion at
Workspace polling, share observation, and release-verifier connection edges.
Expose no agent or duetfs package readiness field. Slice10 removes the explicitly
named transition helper; it is not a permanent compatibility domain.

**Gap:** the public runtime report changes before the backend storage migration.

**Rationale:** changing or duplicating persisted state would exceed this pass
and leave two identities to reconcile. The release-verifier test supplies the
actual historical connection field and earns one runtime result through this
mapping; a redundant isolated getter test was removed.

**Consequence:** only the backend/browser observation edges retain the old field
name. Root owns storage migration and the final removal census.

## Verify installed CLI bytes instead of package version text

**When:** model-refresh probe migration.

**Decision:** resolve the PATH executable to its physical file, stream its SHA,
check length and mode against the announced duet artifact, then run the existing
bounded skills/media checks. Remove the npm version check and source-layout
catalog.js import. The alternative guessed installed source package paths or
accepted version text without matching bytes.

**Gap:** the compiled CLI has no installed JavaScript package tree and its runtime
stamp identifies a complete artifact inventory.

**Rationale:** actual filesystem bytes establish the claimed executable identity
without a source-layout dependency. A deliberate removal of the hash check let
the fake CLI execute; restoring it rejects the mismatch with an empty command
receipt before any provider work.

**Consequence:** stale PATH selection fails even if another gateway process is
healthy. The bootstrap/image lane must earn launcher convergence. Paid product
assertions remain in their existing journey and were not exercised here.
