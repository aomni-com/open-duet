# Runtime identity cutover

This pass prepares source; it does not authorize or execute deployment, migration,
publication or VM work. Each environment follows its own deployment boundary.
Production can continue on its old API while its VMs adopt the independently
preserved held transition artifacts. Staging source can already be strict.

## Deployment sequence

After that environment's complete old-VM adoption census, deploy the canonical
writer phase. It emits only `runtimeVersion` and image identity, while the schema
temporarily admits the three former workspace component fields. The existing
backend-first API promotion window also admits old register/sync arguments and
normalizes them into that single canonical writer. Its fleet-health projection
also provides the old API parser's required arrays from the same runtime tally;
the new API strips those temporary projection aliases. There is no persisted alias
or old-artifact distributor.

Once the new API owns the domain, run
`migrations:migrateWorkspaceRuntimeIdentity041026` through the existing Convex
migration component. It preserves an already recorded runtime identity, otherwise
copies the former gateway column, and removes all former component fields. VM
names, attachments, actual image references and image observations stay intact.
VM-less rows remain without an invented runtime identity. Verify completed
migration status and a complete workspace census with no former component fields.

Only then deploy the separate schema-tightening commit (its local proof is in
`tightening-receipt.json`), which removes those
columns and both backend argument/projection bridges. Repeat the sequence independently in
production. Keep the lifecycle fence/replay mutations and one-shot migration
tools until both environment waves and accepted deferred requests have settled.

## First strict update and ordinary recovery

The frozen held runtime reports `runtime` plus equal gateway aliases. The strict
API strips those unknown aliases. Its bootstrap and update manager still fetch
`/v1/vm/runtime-release/manifest` and `/v1/vm/runtime-release/artifacts/:name`;
those routes remain the canonical artifact transport, with the same VM bearer
REDACTED_TOKEN No path rename or compatibility endpoint is needed. The held
runtime, its bootstrap and Bun stay frozen; rebuilding them from strict source
would discard their first-adoption admission behavior.

Recurring strict sync requires the complete machine set. Registration's existing
post-commit fallback returns the committed token but can lack an authoritative
snapshot; the strict gateway applies no such fallback and obtains the complete
set on its next authenticated sync. This is ordinary registration recovery,
not continued old-API response support.

The temporary first-adoption boot input and outgoing wire aliases are removed
from strict source. Complete current/previous releases, corruption repair, boot
probation, quarantine, update-envelope rescue and the existing maintenance gate
remain ordinary runtime guarantees. Historical audit provenance retains its
original component labels; new registration audit events use `runtimeVersion`.
The fleet runtime tally contains reported identities only; an attached VM without
a report remains visible with its runtime field absent and adds no invented build.

## Deployment ordering evidence

The installed Convex CLI's `lib/deploy2.ts` runs `runCommand` before `runPush`.
Thus seed publication and API construction execute against the currently deployed
backend; only API promotion follows the backend push. The seed publication
implementation, backend endpoints and shared seed contract are unchanged against
the recorded old production baseline. No deployment-rail behavior is changed.

Focused test counterexamples are retained here. Local gates exercise actual row
rewrites, canonical backend observation persistence, strict outgoing reports,
registration recovery and existing release transport. Live staging acceptance,
native strict-runtime/image proof and fleet operations remain root-owned gates.
