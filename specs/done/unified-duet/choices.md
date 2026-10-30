# Implementation choices

This is the consolidated account of decisions I made where the request left a
meaningful gap. It describes the final design; implementation and operational
receipts live elsewhere. The choices with the greatest product reach are the
private harness/public CLI split, process-owned runtime paths, and explicit
machine reactivation after removal.

## Source ownership and dependencies

**1. Separate the reusable harness from the public command.** When a gateway
needs agent behavior, it imports the private harness; the public CLI combines
that harness with workspace HTTP commands and terminal presentation. **When:**
workspace ownership. **Gap:** the request did not choose package boundaries.
I chose two purpose-specific owners because putting HTTP composition in the
harness would create a circular dependency with the shared contracts. A new SDK
package would add another owner. **Consequence:** only the CLI is published;
lightweight consumers can read protocol types without loading the terminal UI.

**2. Preserve the imported compiler and expose generated declarations.** When
another package type-checks a harness import, it reads generated type declarations;
Bun builds application bundles from owned source. **When:** workspace ownership
and CLI composition. **Gap:** the imported compiler differs from the monorepo's.
I kept the established compiler rather than rewriting measured source for every
consumer's settings. Evaluation helpers use Bun-compatible resolution; emitted
core declarations retain their existing convention. **Consequence:** a gateway
build first builds the harness memory export, and the import remains checked
without a compiler migration hidden inside this consolidation.

**3. Share compatible dependencies and retain incompatible versions locally.**
When an imported provider dependency and an existing app accept the same version,
the root lockfile shares it. Browser/auth cookie consumers retain their newer
cookie library; imported Express consumers keep their older compatible version.
**When:** source import and dependency maintenance. **Gap:** one lockfile could
force upgrades or keep separate install graphs. I chose ordinary scoped lock
entries where compatibility requires them and the frozen source versions where
ranges agree. **Consequence:** compatible apps inherit the shared provider
versions, while existing cookie behavior and types remain intact; no second
package installer graph or Bun upgrade is required.

## Human identity and model billing

**4. Reuse live membership policy without browser presentation reads.** When a
human key calls a workspace API, the backend reads current membership and role;
it does not reconstruct permission grants saved on that key. **When:** user
identity. **Gap:** one identity did not prescribe an authorization implementation.
I reused the browser's policy owner while keeping onboarding/display data out
of ordinary API authentication. Duplicated permission logic would drift.
**Consequence:** changing membership immediately changes that person's key
access, and lightweight API calls do not need a browser-session presentation.

**5. Expire pending approvals from the removed login flow.** When an old approval
request still expects workspace/grant selection, migration expires it; the
person starts the new login flow. Previously issued human keys retain their
hashes and user identities. **When:** identity migration. **Gap:** the request
said nothing about already-open approval pages. I declined to reinterpret an
old approval as consent to a different request. **Consequence:** that short
login may need repeating, but existing issued logins are preserved.

**6. Allow human keys to perform ordinary account operations.** When someone
uses the CLI to manage their named keys or sync machines, the human principal
passes the same account-owner checks as browser and operator impersonation
sessions. OAuth and app credentials retain their existing separate ownership.
**When:** user identity. **Gap:** the request did not define account-management
eligibility or optional login names. I used the existing human boundary, with
client name as descriptive metadata and a default when absent. **Consequence:**
normal account operations need no second credential or browser-only exception.

**7. Distinguish selection errors from bad credentials.** When a valid bound VM
or app key names a conflicting workspace, the model API returns
workspace_mismatch with HTTP 403. A human request without a workspace returns
workspace_ambiguous and selection guidance; a disallowed human target uses
insufficient_scope. **When:** explicit model workspace. **Gap:** the error
contract was unspecified. I kept the small existing error vocabulary rather
than treating a valid key as invalid. **Consequence:** clients can correct the
target without asking the person to replace their login.

**8. Select billing through indexed membership reads and existing settlement.**
When a human starts a model generation for workspace B, preflight checks B and
its live role, then the existing generation/reservation record carries that
workspace through settlement. **When:** explicit model workspace. **Gap:** the
query and billing ownership were open. I declined whole-account browser
materialization and a new captured-payer field because existing indexes and
ledger rules already own those facts. **Consequence:** changing the person's
default later cannot redirect an admitted generation, and payer policy stays
with the existing billing owner.

**9. Construct Duet billing headers in one lightweight harness module.** When
a local command or its secondary model request uses Duet, it sends the
process-selected workspace and active tier. Direct provider and connected
subscription requests receive no Duet billing headers. **When:** model workspace
and CLI composition. **Gap:** the host input was prescribed, helper ownership
was not. I used one provider-independent helper rather than separate transport
implementations or a request-context framework. **Consequence:** a CLI process
has one workspace selection; SDK clients capture it when constructed. Bound VM
credentials may omit the selector.

## Mac sync identity and removal

**10. Give one Mac one transfer certificate across workspace instances.** When
a Mac adds another workspace, that workspace's Syncthing instance copies the
Mac's shared certificate pair. It retains a separate transfer database because
one Syncthing instance cannot map the VMs' common folder ID to several local
directories. **When:** sync machines. **Gap:** separating machine from login did
not specify local certificate ownership. I publish a complete certificate
directory atomically, avoiding different peers during concurrent first starts.
**Consequence:** adding a workspace does not add another account machine, while
each workspace keeps independent transfer state.

**11. Reconcile machine removal through the existing VM snapshot.** When a Mac
is removed or loses writable membership, the next successful VM sync supplies
the complete live machine set and removes absent mirror registrations and tunnel
accepts. **When:** sync machines. **Gap:** a one-time detach cannot reach an
offline VM. I used the existing desired-state query and registry rather than a
new poller; Syncthing configuration must succeed before committing the registry
change. **Consequence:** removal converges when the VM reconnects, and a failed
configuration write remains retryable.

**12. Require explicit activation to re-enable a removed Mac.** When a person
runs foreground sync or installs it again, registration can reactivate their
existing machine and certificate. Background retries never register it. Explicit
registration uses the current account and control plane, saving their returned
machine ID rather than submitting a cached server ID. **When:** sync-machine
integration. **Gap:** removal could permanently forbid the peer or force a new
certificate. I chose a reversible account action because people should be able
to turn sync back on. **Consequence:** routine retries cannot undo removal, but
explicit reactivation preserves the computer's transfer identity.

**13. Switch the whole sync session when login, API origin or machine changes.**
When a running daemon notices changed saved config, it samples those three values
once, stops old mirror handles, clears their retry state and starts from the new
session. Each handle and its tunnel renewals retain the snapshot that created
it. **When:** final sync integration. **Gap:** refreshing login during background
sync did not specify consistency with the saved machine. I declined reloading
credentials independently on every request because a configuration change could
mix one account's key with another account's machine ID. **Consequence:** account,
control-plane and key changes briefly restart sync transfers; workspace folders
and the Mac certificate remain intact, and subsequent reconciliation uses the
new complete session.

**14. Bind mirror storage to the server and durable workspace identity.** When
someone switches servers or joins an unrelated workspace with the same name,
sync uses a separate default folder and transfer database. A replaced human key
or machine registration keeps the existing workspace's storage. **When:** final
sync integration. **Gap:** automatic mirroring did not specify how matching
names across accounts or servers should map to files. I chose one identifier
from the API address and workspace ID rather than treating a display name as
identity or introducing a binding registry. **Consequence:** default folder
names are identifiers under `~/duet`; `duet sync status` pairs them with workspace
names and paths. An explicit foreground directory remains the caller's chosen
folder, while its transfer state is still isolated by workspace.

## CLI composition and configuration

**15. Extend the existing command registry.** When a command has local and remote
forms, the same registry selects the remote form from an explicit workspace
flag and otherwise dispatches locally. **When:** unified CLI. **Gap:** the user
chose the behavior, not the parser structure. I extended the existing dispatcher
rather than placing a second parser behind a wrapper. **Consequence:** remote
families and local commands share result/error handling; saved defaults choose
targets and billing without silently changing execution mode.

**16. Move only the old saved user-global Duet login.** When canonical config
loads, it transfers the old user-global Duet env entry before provider env
loading; project and explicitly selected env files keep their own values.
**When:** unified CLI. **Gap:** credential migration details were unspecified.
I declined deleting every Duet entry from provider files because that would
erase intentional project overrides. **Consequence:** future login saves have
one config owner, while provider settings and explicit project inputs survive.

**17. Derive the model host from the saved API environment.** When someone logs
into staging, local model commands select staging's model gateway. An explicit
model-host input still wins; a custom API origin can serve both route families.
**When:** unified CLI. **Gap:** one login did not specify model-host selection.
I reused the existing production/staging topology rather than adding another
saved setting or accidentally billing production after staging login.
**Consequence:** a custom separately hosted model API uses the existing explicit
model-host override.

**18. Detect VM-managed commands from their installed layout.** When a command
runs from the managed release path, or sees the current runtime manifest, it
refuses an npm self-upgrade. **When:** unified CLI. **Gap:** the VM/external
boundary needed a durable detection rule. I used physical installation layout
rather than gateway-injected environment state, which disappears in a fresh
SSH shell. **Consequence:** public installs can still upgrade through npm, and
interactive VM shells use the same release manager as gateway children.

## Complete runtime delivery

**19. Compile one Linux command with its required native data beside it.** When
a VM runs Duet memory or image tools, it executes the compiled Linux command
and loads its database/image assets from that release directory. **When:**
packaging proof and runtime release. **Gap:** the payload shape was open. I
reused the imported benchmark constructor and included the required Photon
image asset rather than shipping a checkout and installed packages.
**Consequence:** relocation and rollback include those assets; native data is
part of application identity, not an incidental file elsewhere on the VM.

**20. Hash a canonical inventory independently of download addresses.** When
any runtime executable or asset changes bytes, length or installed mode, the
single content identity changes. The shared contract sorts and serializes that
inventory, excluding its version and URLs. **When:** runtime release. **Gap:**
the hash recipe was open. I declined hashing transport addresses or independent
package versions because identical bytes can move between hosts.
**Consequence:** API, image and installer agree on one equality token, without
an npm pin or component ordering protocol.

**21. Build from the declared local dependency closure.** When the CLI gains a
local workspace dependency, compilation follows its package declaration and
copies that owned source into a stable external scratch directory. Unrelated
workspaces contribute manifests required by the frozen lockfile. **When:**
runtime release. **Gap:** build-tree assembly was unspecified. I declined a
second handwritten package roster or a copy inside the build's own output.
**Consequence:** dependency declarations remain authoritative, scratch is
removed after builds, and an output location has one build owner. A stable path
alone does not promise reproducible compiler bytes.

**22. Use the existing authenticated API streaming route.** When a VM fetches
the complete runtime, ordinary API delivery streams its artifacts with the
existing VM authentication. **When:** packaging transport. **Gap:** hosting
was open. The complete payload fits the existing delivery platform, so a new
artifact store or special deployment class would introduce an unnecessary
owner. **Consequence:** artifact transport, credentials and verification stay
with the established API and runtime manager.

**23. Cache complete verification of an immutable API release directory.** When
many VMs poll one deployed API, they share its first successful inventory scan;
a failed scan can retry, and each downloaded artifact is checked again before
streaming. **When:** runtime release. **Gap:** verification cadence was open.
I declined rehashing the executable on every heartbeat because every workspace
would pay for identical deployment bytes. **Consequence:** already verified
files must stay immutable for that API process; changed bytes require a new
directory or process.

**24. Apply filesystem modes at installation, not at API hosting.** When Vercel
mounts a data artifact with executable permissions, API verification still
checks its bytes and length. Authored packaging checks source modes, and the VM
installer applies the inventory's destination modes. **When:** runtime transport
integration. **Gap:** the hosting platform's permissions were unspecified.
I kept one portable inventory rather than adding Vercel-specific identities.
**Consequence:** host mount permissions cannot change an otherwise identical
runtime, while installed executable/data roles remain enforced.

**25. Capture physical runtime paths before switching current.** When gateway
starts an agent, training process or nested shell, its command paths and PATH
refer to that gateway's physical release directory. Interactive shells follow
the current link. **When:** runtime release. **Gap:** matching top-level commands
did not specify nested invocation. I declined resolving the mutable current
link for every child because an update could mix old gateway and new harness
inside one running process. **Consequence:** existing work stays on its original
complete release until restart.

**26. Share admission and recovery with the existing runtime manager.** When
activation reaches its final idle check, one maintenance flag closes new agent,
training, backup and desktop starts. Failure or cancellation reopens admission;
success holds it through gateway restart. Failed content enters quarantine and
cannot become current or rollback; a different repaired release can recover.
**When:** runtime release. **Gap:** admission races, corruption and probation
needed ownership. I reused the existing manager, lock and boot-health state
rather than separate gates or a recovery daemon. **Consequence:** active work
never yields to a deadline, and complete install, repair, rollback and retention
share one owner.

## Existing VM transition

**27. Make migration a bounded systemd job.** When the host coordinator
vanishes while an old gateway is frozen, the VM's existing service manager
terminates the migration's mutators before private recovery runs. **When:** VM
transition. **Gap:** failure ownership was unspecified. I declined an
unmanaged SSH background process and a permanent migration daemon.
**Consequence:** transition had a bounded local recovery owner without a VM
reboot; its job and recovery copies are removed after alignment.

**28. Clean transfer files only after matching job settlement.** When a result
file appears, the worker may still be running. The host first matches a
settlement record to the actual run and target, then consumes its terminal
receipt and cleans transferred bytes. **When:** VM transition. **Gap:** transfer
cleanup ordering was open. I declined equating receipt existence with process
completion. **Consequence:** uncertain launches retain files for reconciliation;
a lost cleanup response stays pending without erasing a verified adoption.
This was migration bookkeeping, not a permanent updater protocol.

**29. End original-layout recovery when new work can be admitted.** Before
migration commits, failed target boot restores the exact original unit, links
and payload layout. After commitment, recovery observes or repairs the new
runtime rather than restarting the original. **When:** VM transition. **Gap:**
the rollback boundary was open. I chose admission as the boundary because new
work may already depend on the new release. **Consequence:** retries preserve
the open gateway, and restoration snapshots cover wiring rather than mutable
customer data.

**30. Preserve disk-image provenance separately from application alignment.**
When an existing VM adopts the runtime, its image reference remains the one
that originally provisioned its disk; new images serve future births. Adoption
also requires unchanged OS boot identity. **When:** VM transition. **Gap:** the
no-reboot requirement did not specify recording provenance. I declined calling
an application-file update an image replacement. **Consequence:** operators can
tell original provisioning from current software, and an unrelated reboot cannot
be certified as the intended in-place migration.

**31. Preserve independent customer services after their agent has ended.**
When a completed agent leaves a server or database running outside the gateway
service, migration distinguishes that conclusively orphaned process from live
agent, training or backup work and checks its dependencies before retiring old
software. **When:** fleet transition. **Gap:** the user's preservation requirement
did not define that process boundary. I declined either killing these services
or treating every old process as an active turn forever. **Consequence:**
independent services keep their process identities; gateway-managed apps retain
their ordinary restart/reconciliation behavior. The special migration inspection
is removed after both fleets settle.

**32. Retire temporary compatibility through certified complete releases.**
The adoption payload had only the named wire aliases needed to talk to the old
API; it could not install old npm or gateway-only directives. At strict cutover,
the first complete strict runtime was certified before a second distinct strict
runtime replaced it, leaving strict current and certified strict previous.
**When:** runtime transition and fleet cutover. **Gap:** safe compatibility
retirement and rollback settlement were open. I used the normal manager's
retention rule rather than rewriting links, retaining duplicate identities, or
adding a legacy artifact distributor. **Consequence:** API revisions alone do
not count as new runtime bytes, and all temporary aliases, producers and private
recovery copies can be removed without losing a usable rollback target.

**33. Read historical rows before removing transitional schema.** When strict
schema removes component observations and human grant fields, the migration
examines all paginated history, not just currently attached VMs. **When:** row
cutover. **Gap:** legacy-data coverage and unused device credentials were open.
I used explicit existing migrations while preserving human key identities;
absent retired device-key/credential-owned sync consumers did not justify a new
retirement mechanism. **Consequence:** historical rows remain readable under the
strict schema, with no extra permanent migration owner.

## External publication and deployment

**34. Bundle private source while retaining native dependency owners.** When
someone installs the public package, it contains the composed Bun entry with
private workspace code inlined and the Pi patch preserved. Native modules remain
pinned external dependencies; Mac Syncthing uses its existing per-architecture
binary packages, and bundled libraries carry their notices. **When:** public
distribution. **Gap:** the externally installable package shape was open.
I declined exposing private workspace imports or downloading native code at
runtime. **Consequence:** npm installation is self-contained outside this repo,
but the public command still requires its documented Bun runtime.

**35. Gate new immutable npm versions on the deployed release.** When main's
publication job finds a new CLI version, it waits for production API and backend
to report that exact git revision and schema before publishing. It checks registry
integrity and performs a fresh registry install. Existing versions are reported
as existing, never overwritten; registry errors other than absence fail.
**When:** public distribution. **Gap:** publication ordering and repeat behavior
were unspecified. I chose one serialized main workflow rather than manual
publishing or a second VM release signal. **Consequence:** CLI versions need an
explicit bump, and publication fails visibly if production does not converge
within the bounded wait.

**36. Transfer publisher authority through GitHub's sealed-secret boundary.**
When this repo lacked the old repo's npm credential, a temporary workflow
encrypted it to this repo's GitHub public key; the operator handled only the
envelope. **When:** publication ownership. **Gap:** credential delivery was open.
I used the two existing repository secret owners rather than another secret
store, a replacement credential, or permanent publication from the old repo.
**Consequence:** this repo owns the publisher credential; retiring the old
publisher waits for the replacement registry release to work, and temporary
transfer machinery has no lasting role.

**37. Let release branches alone publish the shared backend.** When a dependency
or feature preview builds, it uses shared staging backend code; only staging
branch and production API deployments publish backend/seed changes. **When:**
release integration. **Gap:** preview publication was open. I kept the API as
sole deployment owner and declined a backend per branch or a new deployment
lock. **Consequence:** preview API changes must tolerate the shared backend
until promoted through staging; an unrelated preview cannot replace it beneath
the canonical staging API.

**38. Keep configuration transport atomic and deployment uploads clean.** When
secret fanout updates Vercel, its existing owner sends one atomic API upsert
through a private temporary JSON file, then removes it. Exact multiline values
stay out of command arguments and failed writes retain prior values. Ordinary
Vercel uploads also exclude local operational artifacts. **When:** configuration
and release preparation. **Gap:** transport and upload exclusions were open.
I replaced the remove/add operation and declined manual checkout pruning or a
second configuration source. **Consequence:** one fanout owner preserves values,
and deployment builds cannot accidentally include local migration caches.

## Provider operations and verification ownership

**39. Tag disposable resources at creation and bound provider operations.**
When a test VM is allocated, its ownership tag is deduplicated into creation
arguments rather than added afterward. Both provider transports have finite
operation budgets; cold-image creation gets a longer budget than ordinary
commands. **When:** provider integration. **Gap:** ownership ordering and stall
timing were open. I chose the existing pool/client owners rather than
fixture-only exceptions or another controller. **Consequence:** duplicate tags
cannot trigger needless deletion, and a timeout means an uncertain operation
that must be reconciled by resource identity, not assumed absent.

**40. Keep release proof and native fixture cleanup with their existing owners.**
When a release-sensitive journey runs the CLI, the shared harness checks the
physical executable against the complete manifest; readiness waits use the
existing asynchronous poll owner. Native rendering fixtures restore the same
window descriptor as production and clean their animation globals. Disposable
repair/rollback drills execute the selected native command against a copy of
seeded memory before accepting their receipt. **When:** CLI and runtime
verification. **Gap:** these boundaries could use package-version probes,
duplicated manifest rules or order-dependent test globals. I declined those
shortcuts because they would certify a different executable or contaminate
later database work. **Consequence:** proof follows installed behavior without
adding a second runtime authority; disposable proof producers retire after use.

**41. Preserve publication evidence before waiting for registry visibility.**
When npm accepts a release, the publisher records its source, deployed revision
and packed bytes immediately, with installation verification still false. It
then waits up to one minute for structured missing-version responses before
checking registry integrity and a fresh install. **When:** final publication.
**Gap:** npm can briefly serve metadata from before the accepted write. I chose
a bounded read retry and an honest checkpoint rather than another publish attempt
or treating an accepted write as verified installation. **Consequence:** a slow
registry can still fail verification, but the accepted publication retains its
provenance and cannot be mistaken for a fully verified release.
