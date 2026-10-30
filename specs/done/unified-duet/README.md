# Unified Duet

Duet owns its agent harness and the public duet command in this repository.
A harness change reaches hosted workspaces through the gateway's complete runtime
release. npm distributes the command to people's computers independently of VM
application delivery. This removes the separate agent repository's publish,
catalog update and VM package-install ceremony.

## One login, explicit workspaces

A human key identifies a person. Current memberships and roles determine what
that person can do; workspace selection names the operation and its model
billing target. It does not mint another credential. Named keys remain separately
revocable, while ordinary commands and Mac sync share the saved login. App and
OAuth delegation retain their existing boundaries.

Saved defaults select operation targets and model billing; they do not select
execution mode. Local memory and training remain local unless the caller
explicitly selects their remote form. Missing model selection refuses rather
than guessing from membership order. Once a generation is admitted, its recorded
workspace remains its settlement target even if a local default changes. Existing
payer and ledger policy remain authoritative.

The canonical security policy is [SECURITY.md](../../../SECURITY.md). CLI
composition and configuration belong to [packages/duet](../../../packages/duet/README.md),
while membership, credentials and billing belong to
[backend](../../../packages/backend/README.md). The [choices ledger](choices.md)
records the discretionary decisions and their tradeoffs. The human-row migration
preserved issued key hashes and user identities; obsolete pending grant-selection
approvals expired rather than being reinterpreted as the new login request.

## Computers and workspaces are different identities

A computer needs a durable sync identity because removing a lost Mac should stop
its mirrors without revoking the person's login on other computers. That identity
is metadata, not another login secret. The Mac's transfer certificate survives
key replacement; background retries cannot reactivate a removed machine, while
an explicit foreground activation can.

A daemon reconciliation samples the saved login, API location and machine as one
session. Replacing that session stops its mirrors before starting new ones;
running handles and tunnel renewals retain the credentials that created them.
This makes account switching one coherent change instead of mixing a new key
with an old machine ID halfway through a request sequence.

Mirrored files and the transfer engine's database belong to the normalized API
location and durable workspace ID together. A display name is not a storage
identity: two unrelated workspaces named research must not exchange old local
files merely because their names match. Login replacement and workspace renaming
preserve the same workspace's storage. The resulting default directory uses an
opaque storage key; sync status supplies the readable workspace name and actual
path. Foreground sync can deliberately select a transfer directory, while its
engine database remains scoped to the workspace.

[Mac sync](../../../packages/duet/src/sync/README.md) owns the detailed lifecycle
and [daemon-status.ts](../../../packages/duet/src/sync/daemon-status.ts) owns the
shared storage identity. Syncthing remains the transfer and conflict-resolution
owner. Per-workspace engine instances share the Mac certificate because the VMs'
common folder identifier cannot map to several local directories in one instance.

## One complete runtime

The runtime is a verified inventory of the gateway, its helper, the command and
all required native assets. Content determines its identity; download addresses
do not. One constructor feeds API delivery and image construction, and one
manager owns activation, repair, probation, quarantine and rollback. A child
operation uses the physical release that started it, so switching the current
link cannot mix old code with new assets midway through work.

The image owns the OS, native tools and service wiring. Application updates do
not need an image rebuild. Runtime adoption never rewrites a VM's actual image
provenance: an old image can run the current application release. Workspace and
gateway Bun runtimes retain their separate image-owned roles. The public npm
version remains separate from the VM's content identity. The
[constructor proof](assets/runtime-constructor/README.md) distinguishes stable
source inputs from independently compiled executable bytes; equal source does
not promise an equal runtime identity.

Compilation alone is insufficient: database and image tools need their native
data beside the executable. Including those files in the complete inventory makes
relocation, repair and rollback honest. Destination permissions describe installed
roles, not Vercel's hosting mount permissions. Authenticated API streaming serves
the same verified bytes without another artifact platform.

The [API release owner](../../../apps/api/README.md#runtime-release-rollout),
[gateway](../../../packages/gateway/README.md) and
[image boundary](../../../packages/vm-image/README.md) own the mechanics.
The reusable [agent runtime](../../../packages/agent/README.md) remains separate
from public CLI composition so protocol and memory consumers do not import
terminal UI or create a contract dependency cycle.

## Preserve existing machines and work

Existing machines were aligned in place. A temporary transition could communicate
with the old control plane while installing complete releases; the strict control
plane followed after every attached VM was ready. Activation waited for live
agent, training and backup work. Independent customer services survived;
gateway-owned apps passed fresh supervisor readiness and TCP checks after
gateway transitions.
No VM was rebooted, reprovisioned or resized for alignment.

First-adoption restoration covered boot wiring and payload layout, never a stale
copy of mutable user state. Once the new gateway could admit work, recovery could
no longer restart the original layout over that work. Temporary recovery copies
were removed only after current and previous both resolved to complete certified
ordinary releases and the migration jobs had settled. A second distinct strict
runtime let the ordinary retention rule replace the transitional rollback target.
Temporary lifecycle fencing, compatibility code and one-shot migration producers
have no permanent role. The ordinary bootstrap's boot guard, probation and matched
rollback remain runtime owners.

The frozen [source reference](assets/source-reference.json) identifies the
imported harness. Its maintained tests, evaluations, benchmark fixtures and
routing/provider behavior are preservation inputs, not an invitation to rewrite
measured behavior. The [release evidence](assets/release-integration/README.md)
and [VM adoption evidence](assets/vm-adoption/README.md) retain the actual
sequence and its limits.

## Alternatives rejected

Keeping duetfs code or a second VM package updater would preserve the coordination
cost this consolidation removes. A single harness-and-CLI package would create
a circular contract dependency and pull native presentation into lightweight
consumers. Separate sync credentials would duplicate human authorization.
Killing customer services to reach an idle rollout would confuse agent work with
persistent app ownership. A permanent legacy distributor would turn a bounded
migration into another release process. Shared staging backend code remains owned
by release deployments, so an unrelated preview cannot replace it beneath the
canonical API.

The public npm identity remains @duetso/agent, with binary duet, because the
unscoped duet name belongs to an unrelated package. The unified command is a
new major release. Public publication is owned by this repository and waits for
the matching API/backend deployment; VM updates continue through runtime delivery.
The public package bundles private source while retaining pinned native dependency
owners and its documented Bun prerequisite. It exposes no duetfs alias. Historical duetfs versions remain on npm by the
user's choice, but have no owner or consumer in the current release process.
The old repository's publisher and temporary retirement resources are retired.

## Visual provenance

The [human-login comparisons](assets/human-ui/README.md) preserve historical
screenshots and the accepted person/computer separation. Those historical grant
controls are comparison evidence, not an approved design to keep. The
[public install comparisons](assets/public-install/README.md) retain the
established docs/install layout, runtime prerequisite and executable-copy target.
The [runtime fleet comparisons](assets/runtime-admin/README.md) preserve the
one-runtime operator view, including desktop/mobile overflow and complete identity
copying. Their receipts distinguish full captures, crops and uncaptured regions.

The [final sync-guide comparisons](assets/final-sync-docs/README.md) preserve
before/candidate production-route captures at both viewports, plus native-size
changed sections and page endings. Their target was the established readable
docs layout with accurate storage association and path discovery. Historical
slug-only folder examples and unsupported agent-editing prose were corrected;
they were not visual requirements to retain. Screenshot review establishes
presentation, while source regressions own sync behavior.

The [historical roadmap](visualizations/roadmap.html), exploration and research
records preserve the original questions and reference inputs. They are planning
provenance; this rationale and the maintained code own the finished design.
