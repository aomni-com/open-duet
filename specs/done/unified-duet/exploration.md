> Historical interview and territory record. The [shipped rationale](README.md) and maintained code settle these original questions.

# Unified Duet exploration map

Duet will own its agent harness and public CLI in this repository. Repo-owned
VM application tools will ship as one verified release, through the gateway's
existing activation and recovery mechanism. npm will distribute the public
`duet` CLI to installations outside the VM; publishing npm will never be a
prerequisite for a VM update. The change should remove machinery overall.

This is the completed exploration map, not a claim that implementation or
fleet migration has happened.

## Known knowns

The user's settled requirements are:

- Import `~/dev/duet-agent` into this monorepo. Duet is its only consumer.
- Own one VM release and one VM update process. Remove agent npm publishing
  and catalog bumping from the VM deployment path.
- Merge duetfs functionality into the `duet` CLI, whose npm publication belongs
  to this repository. No one uses duetfs; retire its command and package without
  a compatibility wrapper or an installed Mac daemon migration.
- Remove duetfs installation and updating from VMs.
- Build, verify, and publish a new VM image containing the combined release,
  updated bootstrap, and command paths. Promote the verified staging image to
  production and update both environments' provisioning digest references.
- Migrate every existing Duet VM in place, in staging and production, including
  removal of the old npm-installed tools. Future VMs must boot into the same layout.
- Use one command vocabulary: existing local memory and training remain local
  by default; `--workspace` explicitly selects remote operations.
- Human CLI authentication is one user key, shared by remote commands, sync,
  and model access. It identifies the user; current membership and role decide
  workspace access. There is no separate sync login or files-only sync credential.

The territory already provides a useful release owner: the
[gateway release manager](https://github.com/aomni-com/duet/blob/a2fcdd2d03a1108579fd779dc776132908f15e61/packages/gateway/src/gateway-release.ts)
verifies and durably stages artifacts, atomically changes the current release,
retains a previous release, repairs corruption, and supports rollback. Its
[bootstrap](https://github.com/aomni-com/duet/blob/a2fcdd2d03a1108579fd779dc776132908f15e61/packages/gateway/src/gateway-bootstrap.ts) runs before the
gateway. Extend this ownership rather than adding a second updater.

Human access already has a membership-derived implementation in
[`authorizedBrowserSessionPayload`](../../../packages/backend/convex/domains/apiKeys/model.ts).
Reuse that authorization policy for user keys rather than creating a parallel
CLI permission model. [SECURITY.md](../../../SECURITY.md) currently specifies a
different API-key model and must change with the implementation.

## Known unknowns and decision ledger

| Question | Decision and why | Closed by |
| --- | --- | --- |
| Import only source, or unify delivery too? | Unify source, release, and VM updates; source import alone retains the costly publication loop. | User |
| Include VM duetfs in the release? | Remove its VM installation. Its useful client functionality joins `duet`. | User |
| Keep old duetfs clients or auth flows? | No compatibility wrapper or Mac daemon migration; there are no consumers. | User |
| Separate remote command namespace? | No. Use explicit `--workspace` targeting for overlapping commands. | User, option A |
| Separate workspace and sync credentials? | No. One user key authenticates all human CLI operations; membership supplies workspace permissions. | User |
| Replace existing VMs? | Migrate all existing VMs in place with a script; retain workspace data and operational credentials. | User |
| How do future VMs get the new layout? | Publish a verified new VM image and update provisioning references; the existing fleet receives the same application layout through in-place migration. | Required by the settled future-VM contract |
| Should npm publish gate VM delivery? | No. VM delivery uses repo-built artifacts; npm is the external CLI distribution channel. | User |
| How should ordinary updates treat running agents? | Preserve the existing behavior: defer while an agent is live. Migration must respect live work too. | Territory; preserve existing behavior |
| What runtime packaging should the VM use? | OPEN build check. Prove the smallest complete Linux payload with CLI, RPC, and memory smoke tests before selecting compiled executable or packaged runtime files. | Linux packaging probe unblocks |
| Where should larger release bytes be served? | OPEN build check. Measure artifact size against the current API deployment packaging. Keep the existing delivery path if it fits; change byte storage only if measured constraints require it. | Build and deployment probe unblocks |
| Can every existing VM be reached and migrated? | OPEN operational check. Inventory both environments, record an outcome for each VM, and resolve failures before claiming fleet completion. | Fleet inventory and per-VM verification unblock |

Machine and app credentials remain operational credentials for their existing
owners. The requested user-key simplification concerns human authentication;
it does not require rewriting unrelated third-party OAuth protocols.

## Unknown knowns extracted from the conversation

The intended owner is the Duet team working in this repo, not an independent
agent-library ecosystem. Independent agent releases and their coordination
work therefore have no consumer to justify them.

The user's measure of success is iteration speed and a net simpler system.
Deletion is part of the result: publishing and catalog pins, VM npm rails,
independent version probes, separate sync auth, duplicated CLI implementations,
and unused duetfs compatibility should disappear where their consumers disappear.

There are two delivery audiences: Duet-controlled VMs and public CLI users.
They consume the same repo-owned functionality through different distribution
outputs. VM updates and public npm publication can run from the same repo release
process without making one depend on the other.

Existing VMs are real migration consumers. They must be updated and verified,
not left on old images or counted as migrated because a new image was built.
There are no existing duetfs clients requiring compatibility.

The user wants consumer-app authentication: one saved key representing the
person, rather than a collection of workspace and sync grants exposed to them.
Workspace selection is an operation parameter, not part of that key's identity.

## Unknown unknowns from the territory sweep

The sweep covered release construction and serving, install/repair/rollback,
bootstrap and VM command paths, agent RPC/memory/Train consumers, both CLI
dispatchers and login stores, Mac sync identity, device authorization, model
preflight, npm workflows, and published installation instructions. It did not
execute builds, query the live fleet, or modify production.

### Release identity must include every shipped artifact

**Sharp edge.** The [API release builder](https://github.com/aomni-com/duet/blob/a2fcdd2d03a1108579fd779dc776132908f15e61/apps/api/scripts/build-gateway-release.mjs)
and [VM image](../../../packages/vm-image/Dockerfile) stamp release identity from the
gateway entry bundle. Agent-only and helper-only changes must change the combined
release identity. One shared release constructor should own the artifact set and
its content stamp for both API deployment and image construction.

### Older installers cannot establish the new artifact set

**Decided: in-place transition script.** The
[wire descriptor](../../../packages/contract/src/vm/index.ts) and
[installer](https://github.com/aomni-com/duet/blob/a2fcdd2d03a1108579fd779dc776132908f15e61/packages/gateway/src/gateway-release.ts) assume the current
gateway and helper artifacts. The migration must establish the complete matched
release, compatible bootstrap, and command paths before starting the new gateway.
Do not rely on an older updater to download new runtime files it does not know.
Remove old npm installations after the new runtime has been verified.

Use the existing [exe client](../../../packages/exe/src/exe.ts) for in-VM execution
and the [fleet selection precedent](../../../scripts/restart-vm-fleet.ts) for
environment-aware, bounded rollout. Report every failure; preserve drives,
memory, and credentials. The script performs the one-time transition; subsequent
updates belong to the release manager.

The new image must bake the same release constructed for API deployment, along
with the updated bootstrap and executable paths. Follow the existing
[image publication contract](../../../packages/vm-image/README.md#publishing): verify
the staging image, promote that exact digest to production, and deliver the
immutable digest references to provisioning. Verify fresh VM boot against the
new image as well as in-place migration of an existing VM. Existing VMs receive
the application transition script; their disks do not need to be reprovisioned.

### The agent needs runtime assets and a deliberate Bun version

**OPEN packaging probe.** The source project's
[PGlite loader](/Users/synthetic-user/dev/duet-agent/src/memory/pglite.ts) loads WASM/data
assets and pgvector; its
[SWE-bench packaging](/Users/synthetic-user/dev/duet-agent/benchmarks/swebench/src/packaging.ts)
already compiles a Linux executable with sidecars. OpenTUI also needs the target
platform's native dependency. A successful version command alone is insufficient:
prove RPC startup and real scratch-memory operations.

Preserve the gateway/workspace runtime compatibility boundary documented in
the [VM image README](../../../packages/vm-image/README.md). A combined application
release does not require changing the Bun runtime used by workspace applications.
Measure the resulting payload against
[Vercel packaging](../../../scripts/vercel-bundle.mjs) before selecting its storage.

### An interactive harness has its own npm updater

**Decided: VM release ownership.** The source
[interactive run command](/Users/synthetic-user/dev/duet-agent/src/cli/run.ts),
[auto-upgrader](/Users/synthetic-user/dev/duet-agent/src/cli/auto-upgrade.ts), and explicit
upgrade command can install npm versions independently. Every VM command path,
including interactive shells, must use the managed release. npm updates apply
only to external CLI installations.

### User keys require explicit workspace selection for model billing

**Decided: target is separate from identity.** The
[model preflight](../../../packages/backend/convex/domains/modelGateway/preflight.ts)
currently infers a workspace from a single-workspace key; the
[model proxy](../../../apps/model-gateway/src/index.ts) does not carry a workspace
selector into preflight. Add an explicit selected-workspace contract from the
CLI through preflight. Authenticate the user, check their live membership and
role, and charge that workspace through the existing accounting owner. A key
must never have to change just because the target workspace changes.

### Mirror device identity is currently tied to the credential

**Decided: separate identity from authentication.** The
[mirror routes](../../../apps/api/src/routes/mirror.ts) and
[device binding](../../../packages/backend/convex/domains/apiKeys/userKeys.ts)
use the sync credential document as the machine identity. A shared user key
cannot stand for two Macs. Keep a non-secret machine identity associated with
the authenticated user and Syncthing peer; it is not another login or API key.
Preserve membership-removal cleanup, device removal, and file attribution.

### CLI merge reaches documentation and install surfaces

**Decided: retire duetfs consistently.** The
[CLI dispatcher](https://github.com/aomni-com/duet/blob/a2fcdd2d03a1108579fd779dc776132908f15e61/packages/duetfs/src/cli.ts),
[Mac launch agent](https://github.com/aomni-com/duet/blob/a2fcdd2d03a1108579fd779dc776132908f15e61/packages/duetfs/src/sync/launchd.ts),
[install instructions](../../../apps/lander/src/install-copy.ts), and
[public docs](../../../apps/docs/app/sync/page.mdx) name duetfs. Update the public
instructions and executable paths with the unified CLI. Preserve local harness
memory and provider configuration; no unused duetfs compatibility state needs
to be maintained.

## Completion evidence

The implementation needs behavioral tests at the merged CLI and authorization
seams, a Linux runtime packaging smoke test, release integrity/activation/repair/
rollback tests, and a migration check against an older VM layout. Agent-only edits
must change the release identity. An interrupted update must leave a usable matched
release, and a second migration run must converge without damaging user state.

Finish with the root closeout gate, a dedicated live staging journey, verified
external npm package contents, a published and verified new VM image with updated
provisioning references, and an actual in-place fleet migration report for both
environments. Build completion alone is not fleet completion. Coordinate
the backend/API contract cutover with the VM transition so old VMs remain operable
until each one is migrated. No compatibility mechanism survives without a real
remaining consumer and a removal condition.
