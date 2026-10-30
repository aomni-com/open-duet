# @repo/test-harness

`@repo/test-harness` holds integration fixtures that are too cross-cutting for a
single app test. It provides isolated Convex local deployments, Docker opt-in
helpers, exe.dev VM pooling, an in-memory MCP harness, and the end-to-end demo
probe used to exercise the system through real seams.

## Boundary

This package is test infrastructure, not production support code. Helpers here
may know how to boot multiple apps together, allocate temporary ports, or clean
up external test resources; production packages should not depend on those
orchestration shortcuts.

External-resource helpers are intentionally opt-in and cleanup-oriented. A test
that creates Docker containers or exe.dev VMs should make that cost explicit and
leave a sweep path behind.

**A leaked VM is not merely untidy — it steals CPU from every other VM,
including production workspaces.** The exe.dev account's CPU is shared across
running VMs, and one leaked-probe episode held each VM at 4.3% of nominal CPU;
deleting the leaks took that to 27.5% and cut an agent's turn-start from 446s to
29s. So a run that leaks VMs silently degrades live users, and the symptom
(everything is inexplicably slow) looks nothing like the cause.

Two rules follow, because the ledger alone is not enough — it cannot run when a
run is killed or crashes:

- **Every identity a journey mints is `ephemeral: true` and in the ledger** —
  both, including identities added mid-debug for diagnostics.
  `POST /v1/admin/login-as` with `create: true` mints a user _and provisions a
  full VM_, so an unregistered diagnostic login leaks a VM per failed run.
  Ledger labels must contain the run id. The `ephemeral` option is explicit
  (never inferred — login-as can also mint real customers): it marks the
  workspace, tags the VM `duet-ephemeral`
  (`convex/domains/workspaces/vmTags.ts`), and schedules the identity's
  erasure — 6h by default, an epoch-ms timestamp to choose the moment, 24h
  hard cap — via a 3-hourly cron (`convex/domains/users/ephemeralModel.ts`).
  The ledger remains the first line (immediate, verified); the expiry is the
  backstop for killed runs.
  Workspace-browser journeys normally accept the workspace identity selected
  by login-as. A journey may request a validated explicit slug when the identity
  itself is part of the behavior under test; it remains ephemeral and uses the
  same ledger cleanup. The fixture derives the matching bootstrap owner name so
  the new workspace exists before login-as selects it.
- **A journey that signs up through the browser cannot mint anything.** The
  real sign-in page takes no `ephemeral` option, so the rule above has nothing
  to attach to — and every such run stranded its workspace and VM until the
  expiry was moved to the one moment that always happens: the insert in
  `convex/domains/users/model.ts`. An account born on a configured test inbox
  (`DUET_SIGNUP_TEST_IDENTITIES`, staging-only) gets the same 6h expiry with
  nobody asking, so the sweep reclaims it whether or not a ledger was wired up.
  Note this is deliberately wider than the trial-gate exemption
  (`classifySignupIdentity`): the abuse journey's deny leg must stay un-exempt
  to give the gate something to refuse, and keying reclamation on that same
  marker is what once left it immortal. Journeys still record what a signup
  created — the ledger frees the VM in minutes rather than hours — but discover
  it after the fact, and must let provisioning name the VM before deleting the
  workspace, or teardown snapshots an identity that does not exist yet and the
  VM outlives the row that pointed at it.
- **Sweep after every journey.** The tag is what makes a sweep safe: every VM
  is otherwise named `duet-ws-<sha256(workspaceId)[:24]>` with the same
  `duet-workspace` tag, and **one account backs both staging and prod**, so
  nothing else distinguishes a dead test VM from a paying customer's.
  `bun packages/exe/scripts/sweep-ephemeral-vms.ts` lists them; `--delete`
  removes them. Never sweep by name or by age.

Local service fixtures are lease-bound to their test runner. Their supervisors
own the full service process group and tear it down when the runner disappears,
including abrupt exits where test hooks cannot run.

Their isolation is deliberately incomplete: each Convex fixture gets a private
`HOME` so deployments cannot see each other's state, but the immutable download
caches under it are shared with the real `HOME`, because per-boot downloads put
the network on the critical path of every test. Anything a fixture _writes_ stays
private; only fetched assets are shared, and the first boot on a machine is the
one that pays to populate them.

That isolation is what lets the Convex-backed packages run their test files
concurrently (`bun test --parallel=N`). Two resources bound how far that goes,
and they are rationed in different places:

- **Boots.** Bundling and pushing the Convex directory costs a couple of cores
  per boot, and `turbo` multiplies package concurrency by per-package width, so
  no `package.json` number can bound the machine-wide total. The fixture
  therefore rations boots itself: a machine-wide slot directory (atomic `mkdir`
  as the lock, pid-stamped, crash-reclaimable, `DUET_CONVEX_BOOT_SLOTS` to
  override) that every process on the box shares. Slots are held from spawn to
  ready only — a serving deployment does not occupy one.
- **Live deployments.** Serving is cheaper than booting but not free, and a
  package's `--parallel=N` is what bounds how many deployments its tests keep
  alive at once. Raising a width is a claim about this resource, and the claim
  is only ever settled by repeated full-suite runs staying green with full test
  counts — a lucky single run has approved widths here that later fell over.

The test-harness package itself stays at one worker. Its lifecycle tests start,
kill, and observe fixture runners; with two Bun workers, every assertion can
finish while worker IPC remains open and the package never returns control to
the root gate. Serial execution preserves the same coverage and lets fixture
ownership settle before the next file starts.

Boots themselves are mostly clones: the first boot of a given project source
pays the full push once and its stopped deployment becomes a template later
boots copy (`convex-dev.ts` owns the mechanics). Two properties make the cache
trustworthy rather than merely fast — a stale template only means the clone's
push does real work, never wrong code; and every clone proves its own push
landed by reading back a per-clone nonce query, because a skipped push leaves
`"use node"` actions pointing at source files of the template builder's dead
backend. Related, and easy to regress: every fixture process tree gets its
TMPDIR pointed inside its runtime directory, because the backend extracts
Node-action source there and only cleans it on graceful exit — and fixture
stops are deliberately SIGKILL (disposable state earns no grace; a stop caught
mid-escalation by the test runner's reaper orphans the very backend it was
killing). Only template builds stop gracefully, since their sqlite is about to
be snapshotted. If the machine's disk ever fills mysteriously during test
work, look for leaked `.tmp*` directories in the system tmpdir first.

What the pools guarantee across sessions is SAFETY, not flake-freedom: two
entire suites racing each other boot cleanly, leak nothing, and run every test
— but their combined mutation intensity can exceed the per-mutation execution
budget the local backend enforces, and dense files may shed tests. One full
suite at a time runs green; sessions iterating should be on the narrowest
runner anyway (see AGENTS.md), not racing gates.

Boot failures that say nothing about the deployment — a lost port race, the
version fetch Convex insists on making over the network and treats as fatal —
are retried, each attempt on a fresh runtime copy with its own slot. The retry
must never reuse a runtime: the supervisor deletes its directory the moment its
child exits, so respawning into it is ENOENT.

Test budgets in deployment-backed suites are floored at 60s — the package
`--timeout` and every explicit per-test budget alike. This is not generosity:
when a test hits bun's timeout, bun kills every child process the worker has
spawned ("killed N dangling processes"), which takes the file's deployment
down and fails every test after it with ECONNRESET. A tight budget is
therefore a file-wide bomb under full-gate load, where mutations stretch
several-fold; a generous one costs a passing test nothing. Never "tighten" a
budget below 60s in a file that boots a deployment.

The boot budget (`readyTimeoutMs`) lives here, in `convex-dev.ts`, and nowhere
else. A call site that passes its own re-imposes a ceiling this fixture has
already found too low under load, and it will fail as a mystery timeout in a
full run while passing alone. Deployment env vars are applied as one batched
`env set --from-file` write — single-quoted, which round-trips JSON and PEM
values exactly where double-quoting corrupts them — and never in parallel:
concurrent writes to the deployment-env document 503 and the CLI does not
retry.

The staging acceptance runner follows the same rule at product scale. Its
orchestrator owns one run-tagged ledger across direct API setup and real browser
work; resources are recorded as soon as their ids exist, cleanup always runs,
and an unverified deletion fails the run. Runtime credentials come from the
encrypted staging environment and are excluded from URLs and artifacts. Browser
diagnostics and deployed-route evidence share one owner so ignored navigation
cancellations cannot weaken unrelated failures. All staging requests share one
transport policy so protection bypass and timing evidence cannot drift between
acceptance legs. Fresh-workspace acceptance is a required leg: it first proves
the deterministic seed and filtered apps API, then drives that same `hello` app
through Files without replacing its identity. The two-account share journey is
required end to end, and it does not stop at bytes: the recipient opens the
shared app itself, in frame, while it is still private — the case where a public
URL refuses everyone — then publishes their own replica and proves the origin
app stayed private. Agent continuity is also a
required leg: it follows one durable state-machine session through a real VM
restart, wake, live steer/follow-up delivery, interruption, Job projection, and
reactivation. The journey removes its final wake before the shared ledger tears
down the workspace. Drive deep links are required through the emitting side: a
root-agent session must use the shipped agent-management teaching, render the
registered anchor's folder link, and hand that literal link to the authenticated
Files surface without opening another browser context. Storage tier resize is
also required by the full run. `bun run e2e:staging` with no arguments is that
full run (`runStagingLiveFullRun`), in the same pinned Playwright container as
the visual gate so local and CI browser behavior agree.

The full run and a journey differ in what they hold constant, not just in
length. The full run is ONE workspace's whole life — signed up, provisioned,
used, billed, shared, torn down — checked at each of its named legs, so a later
leg inherits whatever the earlier ones left on it. A journey is one flow from a
cold start: it provisions exactly the fixture profile it declares, asserts, and
cleans up, owing nothing to any other journey. A flow belongs in a journey when
being provable from nothing is the point, and in the full run when its value is
that it meets a workspace which has already lived a while. Some flows are worth
both, and both call the same acceptance function rather than restating it.

Staging journeys are also selectable. A selection provisions only its declared
fixture profile and retains the same per-journey evidence and cleanup contract
used by the full run:

```bash
bun run e2e:staging -- --journey public-routes
```

The service-catalog closeout is a paid, backend-only journey. It creates two
ephemeral identities, calls ElevenLabs TTS/music, completes a Firecrawl crawl,
checks an unlisted 404, exercises shared-pool ownership and expiry, and matches
the resulting credit rows to vendor cost plus the 20% margin:

```bash
bun run --cwd packages/test-harness live:service-catalog
# equivalently: bun run e2e:staging -- --journey service-catalog
```

It requires a staging ElevenLabs key with voice-create scope. If the key is
read-only, the journey fails with `VOICE_CREATE_PREREQUISITE` after cleanup;
that result is a prerequisite gap, never a passing skip. Set
`DUET_SERVICE_CATALOG_VOICE_FIXTURE` to override the small WAV fixture used by
the voice-create leg.

A journey consumes real staging resources, so run the one a change owns once, at
the end of the work. The full run takes about an hour and belongs to dedicated
e2e sessions. Local gates do not execute staging journeys.

The `workspace-backup` journey uses only disposable synthetic content. It reads
the downloaded ZIP independently and recreates representative files, configuration,
and remapped policy through existing public APIs. Its private artifact directory
keeps the archive README and selected synthetic records for an independent recovery
review; historical conversations remain reference material. Replacement completion
is observed separately from archive readiness, and retained objects are deleted
before workspace cleanup.

The `tier-restoration` journey isolates the conversation-resume billing boundary:
changing quality must preserve history while replacing the checkpoint's saved
tier, and a later resume must retain that correction. The broader
`virtual-model-tiers` journey also covers entitlement and browser presentation.

Provider alias acceptance joins a browser-saved choice to the nested agent's
managed routing file, concrete execution records, and exact settlement debits.
Its configuration receipt uses the gateway's existing bounded operator file
reader because ordinary Drive paths deliberately exclude `.duet`; active health
and the announced manifest identify the release without claiming an SSH bundle-hash audit.

The [open-model-access journey](src/staging-live-open-model-access.ts) connects
public CLI defaults and MCP media to the same upstream discovery and actual-cost
ledger. Its small paid budget starts before fixture allocation; expiration stops
acceptance while verified cleanup retains its own teardown budget. Provider
choices come from priced upstream capabilities rather than a hard-coded model
roster. Build the public CLI artifact before running it; successful media bytes
without matching terminal accounting remain a failed acceptance claim.

The `model-refresh` journey joins saved provider selections to upgraded requests,
fixed chat settlement, the installed CLI's media output, and generated content
received by fresh subscribers. Its paid probe is single-use and bounded; missing
provider or content evidence fails the journey. The receipt covers the converged
release. Across-release VM transitions and existing-subscriber updates require
their separate rollout evidence.

The [unified-duet journey](src/staging-live-unified-duet.ts) joins human login and
current membership to explicit model billing and real scratch-peer sync. It
checks the fresh managed command through native RPC and durable memory. Its
configured migrated VM is read-only: existing VM and boot identity and original
image provenance must agree with the adoption receipt, while running runtime
identity must match the strict release.

Closeout requires frozen external receipts before allocating its disposable
workspaces. `DUET_E2E_UNIFIED_EVIDENCE` points to the credential-free input whose
contract and checks live in [the evidence owner](src/staging-live-unified-duet-evidence.ts).
The operator binds the original migration to its transition release and each
disposable repair/rollback experiment to its exact target release.
Fault drills run on disposable physical provider VMs with controlled loopback
API/model edges; their receipts name fixture identities rather than inventing
backend workspace identities. They prove native runtime and kernel behavior.
The migrated workspace observations and fresh journey retain the real staging
control-plane proof.

Preservation inventories hash selected durable state and saved credentials, including Drive
sentinels, native checkpoints/memory, Chrome profile identity and Syncthing
identity. They exclude runtime journals, rotating runtime tokens and background
counters. The journey verifies those receipts; local selection/parser tests do
not certify live migration, repair or rollback.

The journey needs a verified `DUET_SYNCTHING_BIN` and staging model gateway in
addition to its existing browser fixture environment. The Docker runner maps
repo-relative input files into its existing `/work` mount; operator absolute
paths must be inside the repository, and the binary must execute on Linux.
Gateway health supplies OS boot identity, so this journey needs no SSH credentials.
It creates only run-tagged
disposable workspaces and scratch homes; it never performs fleet alignment or
provider restart, resize or reprovision operations. Its model receipts prove
selected workspace generation and debit, without claiming upstream header capture
or secondary-request coverage. Those controlled contracts remain owned by the
model-gateway and harness model-client suites.

Agent workflow outcome journeys consume the agent package's immutable fixture archive
and shared oracle. The editable task and its disposable provider dependency have
separate directories; the harness owns verdicts and verifies dependency integrity.
Search acceptance submits real forms in the authenticated app frame and joins their
results to provider requests. Release acceptance checks Git objects and executes the
released files, so a completion message cannot stand in for working behavior.
Model execution evidence requires settled output on the selected tier from one of
its advertised models, so a routing change does not invalidate correct execution.
The journey owner is [staging-live-agent-workflow](src/staging-live-agent-workflow.ts).

[Workflow replacement](src/staging-live-workflow-replacement.ts) keeps worker
results bound to the workflow that started them. Its acceptance evidence joins an
explicit stop to replacement creation in one turn, then follows the replacement
worker’s own output and successful settlement through workflow completion.

Workflow runtime certification first exercises ordinary session delivery in a
disposable session, so the installed command uses the real first-use path.
The subsequent identity checks require the installed complete runtime to match
the deployed manifest before scenario work begins.

Release-sensitive journeys derive the active release from the deployed API and
require Convex, web, and docs to report that same identity. Their generic
preflight also checks backend and web-cache schema generations and requires the
runtime identity reported by the API manifest, live health, and workspace row to
agree before product assertions begin.

Production release probes use designated existing workspaces and short-lived
credentials, never staging login-as, internal mutations, or fixture
provisioning. Any public resource they create is recorded from the first
response and deleted through the public API in the same run. Browser proof
imports only validated cookies from operator-provided storage state; local
storage and diagnostic artifacts never cross into the release command. The
matching cleanup command revokes only those supplied browser sessions through
the product logout seam and proves their old public API bearers return `401`.
That logout is authorized by the matching Convex Auth identity cookies; a Duet
session cookie cannot revoke itself. Copied identity state is deleted after the
release rather than signing the member out of their original browser.
This feature-specific behavior probe is removed after its production release
receipt; the generic release/docs verifier remains.

`src/staging-live-selection.ts` is the registry of selectable journeys and their
fixture profiles. Workspace-backed selections reuse the minimal programmatic
workspace environment instead of loading mail or billing dependencies. Public
HTTP and browser selections create no synthetic product resources. Add a journey
to the registry only after it can run through one such explicit fixture
boundary.

Invited-member journeys share one acquisition boundary: user cleanup is ledgered
before invitation acceptance can mint the identity, and browser contexts remain
owned by that fixture until a fully usable member is returned. This keeps a
failed mailbox, login, or membership-settlement step from handing callers a
half-owned identity or context.

Connected-provider acceptance uses a staging-only OAuth issuer delivered through
the VM provisioning environment. The settings page and provider-list request are
an unconditional smoke boundary; only the OAuth and billing legs depend on that
issuer. Those legs prove subscription traffic bypasses the model-gateway ledger,
while quota fallback returns to metered Duet traffic. OAuth credentials remain
VM-local and the journey rejects token-bearing artifacts before handoff.

Official-agent workspace loading is deliberately below those lifecycle owners.
`src/official-agent-workspace.ts` transfers generated files and registers their
manifest declarations into a caller-supplied authenticated workspace; it never
chooses an identity, waits for a VM, prints a product URL, or cleans up. This is
what lets the durable manual `try` workbench and ephemeral staging journeys share
mechanics without sharing lifecycle policy.

## Pointers

- `src/convex-dev.ts` owns isolated local Convex runtime setup.
- `src/docker-cli-env.ts` owns Docker readiness and script execution for opted-in
  tests.
- `src/exe-vm-pool.ts` owns tagged exe.dev VM checkout, return, and sweep logic.
- `src/mcp-harness.ts` owns in-memory MCP client/server wiring.
- `src/official-agent-workspace.ts` owns generated official-agent reset,
  bounded transfer, and registration inside an already-authenticated workspace.
- `src/staging-live-official-agent-apps.ts` owns the focused deployed proof that
  manifest app owners reconcile and render through private product frames; the
  workspace-browser fixture still owns identity and cleanup.
- `src/demo-60s.ts` owns the cross-service demo probe; `scripts/demo-60s.ts` is
  only the runnable wrapper.
- `src/local-onboarding-e2e.ts` owns the isolated local browser proof from
  passwordless sign-in through onboarding and into the authenticated app shell.
- `src/staging-live.ts` owns deployed acceptance sequencing, its environment
  contract, and the cross-service resource lifecycle; its runnable wrapper only
  prints the redacted timeline.
- `src/staging-live-workspace-env.ts` owns the minimal configuration shared by
  workspace-backed focused journeys.
- `src/staging-live-invited-member.ts` owns invited-member identity ledgering,
  invitation acceptance, browser login, and partial-acquisition cleanup.
- `src/staging-live-workspace-invitations.ts` owns the invitation landing journey:
  an invited workspace is the destination even when a personal workspace still
  needs onboarding, and joining never creates an extra workspace. Independent
  signup must surface incoming invitations before personal setup is complete.
- `src/staging-live-mcp-oauth.ts` owns the focused MCP OAuth journey: deployed
  discovery, DCR client identity, consent, resource use, refresh/revocation
  behavior, audience rejection, and credential-free cleanup evidence.
  `src/staging-live-mcp-file-resources.ts` owns that journey's standards-client
  and bare-download proof so file reads and generated media share one oracle.
- `src/apps-live.ts` owns the independently runnable agent-built app journey.
  It proves the documented API and stream through the public host; browser-pane
  behavior stays with the workspace-browser journeys.
- `src/staging-live-public-journeys.ts` owns the resource-free public HTTP and
  browser fixture profiles.
- `src/staging-live-share.ts` owns the required share-to-self byte-arrival leg
  through the deployed product API and the central cleanup ledger.
- `src/staging-live-apps-files.ts` owns the required fresh-workspace seed and
  app-in-Files lifecycle leg, including its desktop/mobile evidence.
- `src/staging-live-shares.ts` owns the two-account share journey, including the
  recipient's in-frame use and publishing of the shared app.
- `src/staging-live-marketplace.ts` owns the `marketplace` journey: the
  signed-in-only catalog, the server-side publish gate, and listing-keyed
  install/uninstall against a verified listing.
- `src/staging-live-agent-continuity.ts` owns the required real-runner restart
  and durable wake leg, including interrupted-checkpoint projection repair and
  stops that must not restart an absent runner; the gateway remains the only
  wake scheduler. Deliberate reboot sequences begin only after the announced
  runtime release finishes health probation, so session recovery is tested
  without activating the independent crash-loop rollback guard.
- `src/staging-live-agent-sessions.ts` owns reusable snapshot/history polling,
  Job-projection comparison, and cleanup for session-backed staging journeys.
- `src/staging-live-specific-people-sessions.ts` owns the focused strict session
  journey: deployed wire-contract refusals, audience access, SSE revocation,
  and ledger cleanup.
- `src/release-target.ts` owns fail-closed canonical production origins and the
  production Convex deployment discriminator used by release commands.
- `src/staging-live-session-lineage-api.ts` owns the focused deployed lineage
  and recursive-deletion acceptance journey.
- `src/staging-live-foreground-session-waits.ts` owns the focused foreground
  unary proof: root and nested waits, parent follow-up, ask/answer, durable
  observer-abort recovery, contextual history, async compatibility, timings,
  and ledger cleanup. The 720-second pending boundary and transient-outage
  queue remain deterministic local gates because staging exposes no safe
  control seam for either.
- `src/staging-live-agent-browser-windows.ts` owns the cold shared-desktop journey:
  root and named-agent windows, shared profile state, stable owner reuse, exact
  native focus, background discard, credential refusal, and verified workspace
  cleanup stay one end-to-end claim. Time-compressed capacity, expiry, and restart
  races remain deterministic gateway tests rather than production test controls.
- `src/staging-live-drive-deep-links.ts` owns the required emitted-link
  round-trip from a live agent-management session into the exact registered
  anchor folder; the `drive-deep-links` journey runs it independently through
  the workspace-browser fixture. Its deterministic percent-identity selection
  skips model output so transport regressions can be isolated without rerunning
  agent generation.
- `src/staging-live-chat-attachments.ts` owns the composer-to-agent attachment
  journey. It keeps browser upload state, Files attribution, durable transcript
  cards, model path resolution, and locked-agent intake in one real-workspace
  claim because mocks cannot prove the direct VM upload or the agent's read.
- `src/staging-live-connected-providers.ts` owns the staging-only connect,
  plan-covered accounting, fallback, and credential-loss journey;
  `src/fake-oauth-issuer.ts` owns loopback hosting and safety for the
  dependency-free [`@repo/fake-oauth-issuer`](../fake-oauth-issuer/README.md)
  core.
- `src/staging-live-agent-fixture.ts` owns the public mkdir → `AGENTS.md` →
  registration fixture shared by agent journeys, and the public onboarded
  unlock a journey uses when it only needs the agent as a session owner;
  `src/staging-live-train.ts` owns concurrent root/agent training, record
  isolation, and inherited child context proof.
- `src/staging-live-subscriptions.ts` owns the clock-bound Stripe lifecycle.
  Its identity receives only the real signup trial; the general acceptance
  account's deterministic reserve never enters subscription assertions.
- `src/staging-live-storage-tier.ts` owns the required storage resize proof and
  reuses the lifecycle payer.
- `src/staging-live-gateway-liveness.ts` owns the post-cutover liveness proof. It
  provisions a real anchor, drives direct authenticated fast/filtered-slow and
  restore-window reconcile probes, observes raw-path and persistence counters,
  checks entity binding changes and opaque shared file-activity cursors, and proves that every visible
  Files column refreshes independently. Live staging cannot read the external
  PostHog sink; `packages/backend/src/analytics-producers.test.ts` therefore owns
  the companion capture assertion that one counted summary produces one counted
  analytics fact, while the journey proves the matching canonical rollup count.
- `src/staging-live-browser.ts` owns browser diagnostics and deployed route
  evidence; `src/staging-live-browser-response.ts` owns completed browser API
  response proof; `src/staging-live-http.ts` owns staging request policy and
  timing evidence.
- `src/staging-live-forward-progress.ts` owns bounded polling for eventually
  consistent staging projections; each journey defines what counts as progress.
- `src/staging-live-low-credit.ts` owns the focused funding-recovery journey. It keeps subscriber,
  trial, and member evidence under one disposable identity ledger because checkout, role projection,
  and cleanup are one acceptance claim rather than three independent fixtures.

## App-domain acceptance

The focused [app-domain journey](src/staging-live-app-domains.ts) uses the reserved
apex as an exclusive fixture, refusing an existing assignment before allocating a
workspace. Feature APIs own attachment and cleanup; provider access in the harness
is read-only. The existing local operator token proves the actual serving alias's
release identity, while the separately scoped runtime token observes the captured
project assignment. Neither token is fanned out by this journey.

One disposable workspace and a tiny app keep host, privacy, iframe, and cookie
behavior in the same browser claim. Recreating the app distinguishes durable app
identity from a reused slug without provisioning another VM. The resource ledger
records attachment intent before each mutation and removes domain assignments
before app or workspace teardown. Uncertain provider outcomes require operator
repair; the journey cannot acknowledge or silently retry them into success.

Ledger verification outlives workspace and user cleanup. It reads captured app
IDs and the workspace tombstone through existing internal queries, plus remote
assignment/alias absence; it cannot rely on authenticated app URLs. Successful
live detachment separately observes the local slot's absence before deleting the
app. A failed partial journey's external cleanup proof does not claim that an
unobserved orphan row vanished.

## Backend contention

The `billing-contention` journey uses an isolated backend fixture and the normal
workspace/identity cleanup ledger. It exercises deployed scheduler behavior and
mixed accounting/activity traffic without provisioning a VM or buying provider
usage; local tests own poisoning, replay and accounting-boundary cases.

## Synthetic accounts are distinct domains

The signup gate is live inside every test deployment, and it withholds the
trial from the sixth signup a domain makes in an hour — that is what a trial
farm looks like. A test file that minted every account at one shared domain
was that farm: from the sixth account on, each workspace was born paused with
no grant, and the suite failed in ways no single test ever reproduced.
`uniqueEmail` therefore mints a domain per account, not a mailbox on a shared
one. A test that wants the gate to fire builds its own shared domain, as the
signup-abuse tests do; a test that wants a company address re-domains the
result and keeps the unique mailbox.
