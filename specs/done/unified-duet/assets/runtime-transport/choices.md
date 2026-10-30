# API transport decisions

## Verify once for immutable release directories

**When:** runtime API transport pass.

**Decision:** coalesce one complete inventory verification per release directory
for the lifetime of an API process. Evict failures. Recheck the requested file
before streaming. The alternative rehashed the compiled executable on every VM
sync poll.

**Gap:** whole-inventory verification includes a large executable, while VM polls
are frequent.

**Rationale:** the API serves a baked, immutable deployment inventory. Repeated
full scans would impose disk work on every workspace without improving that
trust boundary. A promise cache coalesces concurrent first polls and preserves
bounded streaming memory. Recovery and post-announcement requested-file tamper
tests cover the failure behavior.

**Consequence:** changing a successful release directory requires a fresh API
process or a new directory. Incomplete builds can recover without restarting.
This does not turn a mutable workspace directory into a trusted release owner.

## Share verification with Vercel packaging

**When:** runtime API transport pass.

**Decision:** the shared Node packaging script invokes the API's existing disk
verifier through Bun, then copies the exact constructor directory and sets its
runtime location. API packaging refuses missing or unmanifested files. Other
Hono apps remain independent of runtime payloads. The alternative duplicated
schema, identity, and hashing logic in the packaging script.

**Gap:** the shared packaging script runs under Node, while the source verifier
is TypeScript and its contract owner is resolved by Bun.

**Rationale:** Bun already owns source bundling in this build rail. Reusing the
verifier keeps schema and inventory decisions in one place, without another
installer or intermediate artifact format. Tests and an actual Vercel build
verify copied hashes, modes, and inventory; the emitted Node API serves those
same bytes.

**Consequence:** packaging needs Bun during the build. The emitted function
requires only its Node handler and copied inventory at runtime.

## Keep the existing backend diagnostic column until fleet migration

**When:** runtime API transport pass; confirmed by root integration.

**Decision:** the new API parses runtime-only version reports, then maps that
identity to the existing backend gateway diagnostic column. Registration does
the same. No agent or duetfs package version is selected by API configuration.
A new persisted runtime column was the unbuilt alternative.

**Gap:** the new public report shape and the existing backend storage vocabulary
change at different owned seams.

**Rationale:** adding parallel persisted identities would create duplicated
state before the fleet/schema migration. Real Convex tests falsified ignoring
the runtime field, then proved the current report reaches the existing column.
The root owns the eventual storage rename and migration.

**Consequence:** the backend column name remains historical temporarily; the
new API does not retain or publish a gateway alias. The explicitly named
transition client request is root-owned and exists only for bootstrap ordering.

## Preserve the operational bootstrap as a deployment gate

**When:** independent review.

**Decision:** retain no old artifact routes or descriptor aliases in the new API,
as prescribed by root. Record the inability of existing gateways to consume the
new envelope as a deployment blocker, owned by the bootstrap/fleet gate.

**Gap:** source tests do not prove already-deployed gateways can cross the change.

**Rationale:** independent review reproduced the old consumer's expectation of
per-component update targets and its old-envelope rescue parser. Root's planned
handoff installs the transition runtime under the old API before promoting the
new server; treating an optional new field as upgrade compatibility would be
false.

**Consequence:** this commit is not safe for independent API deployment. The
root's old-API handoff, idle fencing, offline recovery, and fleet census must
all produce actual receipts before promotion.
