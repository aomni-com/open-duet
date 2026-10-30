# @repo/backend

Service credentials and shared-pool ownership live under
[`convex/domains/serviceVault`](convex/domains/serviceVault/); the API service
proxy reads them through internal-key-gated functions.

`@repo/backend` is Duet's Convex metadata backend. It owns durable workspace
state, auth-linked users, API keys, shares, publishes, anchors, billing ledger
rows, VM registration, and the internal decisions that public apps consume.

Credential storage enforces the [human identity policy](../../SECURITY.md#human-keys-identify-a-person-workspace-access-follows-membership).
The [cutover rationale](../../specs/done/unified-duet/assets/human-identity-cutover/README.md)
owns the migration boundary between historical grants and strict identity rows.

## Marketing contacts

Authenticated signup finalization enrolls users in the configured Resend users
segment, before payment. It shares the signup marker with acquisition tracking,
so requesting a magic link or signing in again cannot re-enroll a contact removed
from the marketing list. The existing action retrier owns delivery failures;
Resend availability does not block signup. Existing unsubscribe choices are
preserved, and disposable test accounts are excluded. The signup owner is
[bootstrap](convex/domains/invitations/model.ts); the provider boundary is
[Resend contact sync](convex/services/resendContacts.ts).

## Payment recovery

Stripe subscription status owns subscription access. Monthly credit expiry
only expires that credit grant; it must not pause an active subscriber while
Stripe finalizes and collects the next renewal invoice. Subscription lifecycle
webhooks determine when subscription access stops or resumes, independently of
credit grants. Trial deadlines and payment/dispute blocks retain their own rules.

Top-up failures are a temporary payment block, not a permanent loss of entitlement.
A Stripe default-card replacement, successful payment, or admin unpause clears that
block; normal servicing reconciliation still preserves subscription eligibility,
bans, and disputes. Recovery records the source event time so delayed failure
notifications cannot undo a newer recovery. A bounded window of failure times
keeps pre-recovery declines out of the counter even when events arrive out of order;
recovery wins ties at Stripe’s second-level timestamp precision. Stripe webhook delivery must include
customer updates, because portal card changes do not carry Duet checkout metadata.

## Portable workspace capture

[Backup capture](convex/domains/workspaceBackups/capture.ts) is an explicit
portable projection, independent of browser discovery and membership audiences.
Canonical collections have a creation cutoff; each session fixes its own event
ceiling and attachment capture time. Those bounds make a live export finite,
not atomic. Missing sources and oversized records produce partial-capture
warnings while advancing the cursor. Static MCP credentials intentionally travel
with their definitions; platform credentials and OAuth authority do not.

## Boundary

Convex is the authority for metadata and policy; it is not the VM filesystem and
it is not the public REST router. HTTP apps call into this package for state
transitions, and VMs report sync observations back here, but bytes inside the
drive live behind [`@repo/gateway`](../gateway/README.md).

Agent-session access is principal-based: current membership generation and role
decide human access, while a workspace principal uses the workspace-wide trust
lane. Attribution is carried separately and is never consulted by the access
policy. Denials collapse to one unavailable result so callers cannot distinguish
a missing session from one outside their audience.

Session discovery is an indexed projection of that policy, not a second access
model. Workspace, owner, exact membership-generation, and personal-archive lanes
copy only ordering/filter dimensions; canonical sessions and member state remain
authoritative. Deleted generations become unreachable immediately and their
eventual cleanup removes only those exact historical lanes, so ordinary activity
never inherits unbounded membership churn.

Session creation preserves that separation durably: every new row carries an
explicit audience. For a specific audience, the API inserts the authenticated
human caller; after creation that person is an ordinary removable participant.
The session's `userId` remains attribution only and is never projected as a
creator. Search identity is durable and locale-independent, derived only from
title plus the initial prompt.

Workspace creation counts the creator's memberships in live workspaces against
that person's plan allowance, regardless of role or payer. The limit controls
new VM creation; invitations and payer changes remain unrestricted by plan
capacity. Existing memberships survive downgrades. The creation path owns this
check, with no separate payer quota or stored capacity counter.

Workspace owners and internal admins share one payer transition. The new payer
must be a current owner; their billing eligibility determines servicing, even
when an admin makes the change. Admin access lets support repair a payer while
the workspace is paused without bypassing billing or the audit trail.

Workspace membership admission has one transactional writer and a hard ceiling
of 100 current members. Existing-member replay remains idempotent at the
ceiling; competing admissions for the final slot serialize through the same
indexed read. Invitations reserve no capacity before acceptance.

Workspace membership deletion likewise has one transactional writer. Deleting
the membership generation revokes session access immediately and enqueues a
generation-keyed, checkpointed reconciliation; that later cleanup may archive a
specific session whose final participant left, but it never deletes the user's
read position or targets a replacement membership created by rejoining.

The generation-bound session member row owns two independent facts: a grant can
authorize only a specific-audience session, while personal archive records an
admitted human's preference for workspace sessions, specific participants, and
owner override. Removing the membership generation clears both; toggling an
audience grant within the same generation preserves the preference.

Session lifecycle uses the same principal-aware point admission as content.
Personal archive changes only that generation-bound preference; global archive
changes shared session state; neither moves a default-chat pointer. Permanent
delete checks global lifecycle authority once while the selected root is still
readable, then atomically seals that root and durably accepts recursive work.
Descendants inherit that accepted root decision as a bounded indexed frontier;
they are never independently reauthorized. API-owned gateway disposal must
report authoritative runner absence before the existing bounded metadata owner
may remove a canonical session and its deletion-work row. A lost response or an
unavailable runner therefore leaves hidden durable work to retry rather than
restoring visibility or deleting metadata early.

An admitted session stream freezes that point decision for the lifetime of the
connection. Its internal continuation reads the canonical event log in bounded
ascending pages without reauthorizing membership; removal takes effect when the
client reconnects. Replay and history share a byte budget that reserves reads
before fetching documents and bounds serialized responses. The last delivered
sequence resumes a stream even when byte pressure ends a page before its row
limit. Convex remains the sole durable tail, including notes and control-plane
events that never pass through a workspace VM.

Authenticated API traffic also converges here for one atomic, principal-wide
fixed window. Credential rows identify programmatic callers; a user row joins
browser and impersonated visits. The API remains the HTTP owner, and VM or
pre-authentication rails retain their purpose-built gates.

Browser-session rotation is single-winner. The web proxy rotates on every
request inside the rotation window and a page load fans out across lambdas
that share no memory, so the backend is the only place that burst can be
collapsed: the first rotation of a previous key stamps it, siblings inside the
handoff window write nothing and hand back nothing, and the proxy carries on
with the previous credential — which the winner leaves valid for the grace
period — while the winner's cookie lands. A rotation was never made cheap
enough to survive N-way contention; it was made to happen once.

A browser arriving with no cookie at all gets the opposite treatment, because
the same trick is unavailable: there is no previous key to stamp, so nothing
identifies the siblings of one cold start to each other and every request in
that fan-out has to mint a credential of its own. What cannot be made to happen
once is instead made cheap enough to survive N-way contention. Housekeeping
reads only sessions that have already lapsed, a range a sibling's insert lands
a full TTL outside of, so siblings stop invalidating each other; and the mint
budget is sized and sharded for the width of a page load rather than for a
single mint, so an ordinary cold start neither exhausts the budget nor lands
on one counter row. Revocation collapses a session's expiry to the revocation
instant, which is how a revoked session still reaches that lapsed range.

Replacing a workspace's VM model key is not the same act as distrusting it.
Only the hash of a live key is stored, so a VM asking to be re-handed its
credential can only be answered with a new one — and the VM asks a refresh
window early precisely so the handover overlaps. Because a runner takes its key
from the environment at spawn and holds it for the whole turn, every still-live
key is left to expire on its own clock rather than revoked on delivery; a lost
refresh response means the VM may still hold an older one. A rotation, which
does treat the old credentials as untrusted, still kills them immediately. The
unrevoked bucket has a hard ceiling; at that ceiling refresh delivery waits for
natural expiry instead of guessing which plausible key is safe to revoke. The
workspace stores the earliest capacity-changing expiry as a retry boundary.
Sync still commits heartbeat and reconciliation progress while full, but skips
credential issuance until that boundary; the VM follows its heartbeat cadence
and accelerates only when expiry can free capacity. Rotation, revocation,
reprovisioning, or a changed scope contract invalidates the stored boundary.

Train job rows are a generation-idempotent projection of the gateway-owned job
state. Completion notifications derive from the first durable terminal transition,
not from the public API start path. The projection re-validates the complete
bounded report batch at its insertion owner; sanitizing a diagnostic does not
substitute for bounding its stored and listed representation.

Agent-session terminal causality joins two authorities without guessing from
timeline order: the gateway snapshots the accepted input boundary when it
records a terminal, and Convex stores that boundary as internal event metadata.
Foreground observers read the earliest durable covering terminal through a
terminal-only index; public history continues to expose only the ordinary
`{ seq, createdAt, event }` marker. Runner delivery finds the inputs still
waiting the same way, through an input-only index, so the output of a long
turn never sizes the read that delivers the next message. The reader's
transcript is a third such slice: the writer stamps every row a reader sees
(the contract's `isTranscriptEvent` — everything but the task rail and
child-backed steps) and the history route's `view=transcript` pages through
that index, so a subagent-heavy turn never sizes a page that renders to
nothing. The default view stays the full timeline, and a cursor is bound to
the view that minted it. Sizing a page is itself bounded work: the scan takes
rows a batch at a time, and the response budget weighs each row once and
accumulates. A page that re-measures itself to admit each new row costs the
square of what it carries, and Convex kills a query at one second — so a
conversation whose events are individually large stops being readable at all.

Foreground retry identity is durable input metadata, not current routing state.
The backend can recover the original input by actor, request UUID, and
fingerprint; the default-alias lookup is bounded and fails closed if a caller
has ambiguously reused a UUID.

Durable input authorship is identity-only: the API derives each input's typed
`sender`, but Convex is the authority that a session sender names a live
same-workspace session, checked inside the same transaction that appends the
event. Backend delivery owns the only model-envelope renderer
(`domains/agentSessions/runnerEnvelope.ts`), resolving current names at
composition time; the gateway forwards those bytes untouched and must never
grow a second renderer.

Workspace VM bearers derive from the attach generation nonce. Every edge
resolution branch returns that bearer so the gateway remains the authorization
boundary even though the VM's outer HTTP proxy is public.

New VM admission selects the configured image unless an operator explicitly
chooses another. `nextVmImageRef` carries that destination through teardown and
attach retries; `imageRef` records the VM actually attached. A later configuration
change affects the next operation, never an already admitted retry. Completion or
terminal failure releases the destination pin.

[Workspace backups](#workspace-backups) connect durable capture jobs to VM
lifecycle admission and recovery settlement.

Generated Convex files are build output. Domain code should live under
`convex/domains`, shared validators and schema in the top-level Convex files, and
external service adapters under `convex/services`.

## App domain ownership

[Custom app domains](convex/domains/customDomains) reserve a hostname until every
admitted provider write has settled and the captured project/branch assignment
has been removed. Removing an app changes serving eligibility immediately; its
provider cleanup survives the app and workspace. A failed cleanup retains the
same work identity for internal operator repair rather than releasing an alias
that delayed work could still recreate. Authoritative address metadata stays small;
DNS diagnostics are a joined record so recurring app/VM projections do not read
large provider payloads. Visible domain pages use their own indexed lane, which
orphan cleanup cannot fill.
Transport aborts and ambiguous alias-write responses require explicit operator
confirmation of remote settlement before cleanup resumes. Public retries retain
that quarantine; local promise rejection and a provider 404 cannot clear it.

Domain detail derives its optional `checking` signal from existing queued/running
provider work. Rechecking an active binding keeps its serving status and address
while clients observe completion; a failed binding can show the same progress
without implying recovery. Pending DNS setup retains its lifecycle status. App
address summaries carry serving eligibility rather than this observation signal.

## Runtime identity

Workspace VM observations record one complete application `runtimeVersion`,
separately from image identity and the actual provisioning `imageRef`. Application
adoption does not rewrite image provenance. Component package versions do not
control installed VM updates. The bounded [runtime identity cutover](../../specs/done/unified-duet/assets/strict-source-cutover/README.md)
uses the existing migration owner before schema tightening.

## Data migrations

Persistent row rewrites use the resumable `@convex-dev/migrations` component.
During a required-field rollout, the first deployment may temporarily admit
only the legacy fields that the migration owns; product writers and TypeScript
contracts continue emitting the final canonical shape. Each migration exports
its row handler so behavior tests exercise the same code that runs live.

Deploy that additive phase normally, run and verify the named migration in each
environment, then restore the strict schema in the following deployment. A
migration is a bounded rollout tool, not an ongoing compatibility reader or a
second owner of product behavior.

Workspace bootstrap is internal, and `domains/signupAbuse` owns its only public
entry. A signed-in browser holds a Convex auth token, so a public mutation that
mints a workspace, a trial grant, and a VM would be callable from the devtools
console — any abuse verdict passed in as an argument would be forgeable. The
verdict is therefore computed on the action side of that seam, and the mutation
is unreachable from a client.

An invitation admits a person to the workspace it names; acceptance never
creates a personal workspace or changes their other memberships. Ordinary
signup may create a personal workspace even when invitations are pending.
`domains/invitations` owns the recipient inbox and the shared acceptance
transaction for email links and authenticated in-app actions. Invitation
records are authoritative; there is no separate pending state on the user.

The signup gate rests on invariants that are cheap to break by accident:

- **One verdict, from one pure function.** Fingerprint, the email blocklists,
  and the device count all feed `decideSignup`; none owns its own `blocked`
  boolean, because two sources of "is this signup ok" is how a gate ends up
  disagreeing with itself.
- **Fail open is a lever, not an oversight.** Unresolvable device evidence
  allows the signup, and each reason is recorded distinctly so a missing key
  stays distinguishable from a blocked script. Failing closed would deny real
  users on a network hiccup.
- **The device count is over distinct canonical mailboxes, never user rows.**
  Auth keeps `+tag` on non-gmail domains, so aliases of one inbox are separate
  users that already share a grant key; counting rows would withhold on
  someone's third alias of a single mailbox, which was never the vector.
- **The trial withhold lives on the user.** `grantTrialCreditsForAccount`
  honours it, so both grant sites — workspace birth and VM registration — are
  covered by construction rather than by remembering to guard each caller.
- **One classification decides exemption.** A configured test identity skips
  verification, the email rules, and the count together, so the live-acceptance
  journeys cannot be broken by a change to any one of them.
- **The only rate rule is ours, and it is per controlled domain.** A vanity
  domain that has minted more than a handful of accounts inside a day has
  its next one refused; shared providers such as Gmail are exempt because a
  rate on their domain says nothing about any one party. It exists because a
  farm once passed every per-account rule 163 times in a row — the rate was
  the only thing that could have said no. Vendor suspect scores stay out.

Device and other uncertain email objections still create the account with its
trial withheld. Blocked email domains and excessive controlled-domain signup
volume are refused before workspace bootstrap. Invitation acceptance and
existing members bypass those self-serve refusals.

Anchors are durable per-path identities, not entity-owned rows. Removing the last
consumer — app, agent, publish row, or a pending/active share — leaves an orphaned
anchor so a later registration at that path can recover the same identity (including
agent memory) and re-kind it; only active anchors participate in VM reconciliation and
rename detection, so orphaned ones stay out of those scans.

The VM anchor protocol is a complete replacement, not a page stream. All active
and broken anchors therefore share one 500-row workspace ceiling enforced by
the sole insert and orphan-revival owner. Topology, rename, and current-anchor
lists read that complete indexed set and refuse an invariant breach; orphan
tombstones remain outside the budget and cannot turn churn into a truncated
prefix. The whole recurring snapshot also fixes apps at 100 and active shares
at 50 total across incoming and outgoing lanes; share admission checks both
participants before writing the mount or any replica.
Core topology/catalog state and share state are separate bounded Convex reads;
the API is their sole composer and still returns one unchanged VM response.
Provider VM identity, endpoint, image-reference, snapshot-name, and reported
version strings are bounded before any workspace write.

File activity stores an explicit read/non-read discriminator on every event.
Workspace, exact-entry, and subtree feeds select that lane in their indexes, so
thousands of attention markers cannot hide an older write. Ascending subtree
reads also bind the projection's completed sequence directly into both scope and
restore index ranges; unfinished backlog is never scanned and filtered afterward.
This strict required-field schema cannot deploy over legacy activity rows. The
documented cutover command must first produce the authorized destructive receipt;
code review and an offline census are not a deployment receipt.
The same pre-deploy census must also confirm no live workspace exceeds the new
500-anchor, 100-app, or 50-active-share ceilings; there is no grandfathering
or prefix-reading compatibility path.

The seed-drive registry is content-addressed metadata: one row per archive hash and
exactly one current row. Publication uploads bytes to Convex storage, then atomically
activates the canonical row. Storage IDs stay in that registry rather than in
environment variables. Workspace birth pins that moment's current bundle and
registers its manifest apps in the same transaction; VM registration prefers a
workspace restore, advertises an undelivered birth seed once, and never infers
re-seeding from provisioning status.

App runtime status is a projection of VM-owned reconciliation, including apps
registered during workspace birth. The VM reports the exact desired config it
attempted on the recurring sync rail; the backend applies success or failure
only while that config still matches the current app and anchor, so an
in-flight stale report cannot overwrite a newer deployment.

Official-agent subscriptions are a separate lifecycle from ordinary agent CRUD.
The backend owns subscription metadata and contained app-row convergence; the VM
owns file materialization. Two clocks join those halves, in opposite directions:
the VM's applied ETag report says what it has, and the backend's projected
content revision says what there is. The backend also owns HOW LONG a subscriber
may wait between revalidations once it believes it is in sync — one fleet-wide
number, projected rather than compiled into the VM precisely so that retuning it
is a deploy and not a gateway release. What it really bounds is how stale a hub
agent may be when its bytes moved without a sync press. Hub location is
environment state in the singleton `officialHub` row, never caller-supplied
configuration.

Installing, listing, and marketplace listing registration share one definition
of a live subscription: the three indexed `installing`, `active`, and `error`
states. Detached history is a tombstone and is never scanned to answer current
ownership, even after thousands of uninstall cycles. Listing takedown drains
those same state lanes in deterministic order through the listing-and-state
index, so detached history cannot stall emergency removal.

A listing carries an opaque content revision so a subscriber can be told "you
already have this" instead of asking the origin every half hour. It is written
by the sync that CHANGES the bytes and never by a subscriber's pull report —
the same firewall availability keeps, and for a sharper reason: the revision is
projected to every OTHER subscriber, so a report that could move it would let
one hostile installer aim the whole fleet's pullers at a rival publisher's
origin. A paused publish projects no revision at all: it serves frozen bytes
while the revision describes the live tree, and "unknown" costs one ordinary
revalidation where a wrong answer costs a subscriber bytes it never saw.

A listing whose source is gone projects nothing — no URL reaches the VM, so a
subscriber keeps every file it already materialized and simply stops polling.
The proof of a live source is the AGENT row, not the publish: the official hub
is one folder-level publish shared by every official agent, each listing
addressed by its subpath below it, so a publish that outlives the agent under it
is the ordinary case rather than corruption. Without that, a retired agent's
listing would keep naming bytes that no longer exist and its subscribers would
re-probe the edge forever.

OAuth client registrations live in the `oauthClients` table with one normalized
public-client shape. Authorization
requests copy the selected identity and redirect before consent; later grant
lifecycle code reads that immutable copy rather than consulting mutable client
metadata.

OAuth authorization `state` is opaque client data, but not unbounded data: the
authorize request, durable handoff row, success response, and protocol-error
reflection share one 4 KiB UTF-8 schema. Invalid oversized state is never stored
or reflected into a redirect.

Credit ledger metadata keeps reservation lifecycle state in typed fields and
caller/provider audit details in an explicit context bag. Usage rollups consume a
typed dimension projection from settlement rather than interpreting that durable
audit copy, so the ledger and reporting pipeline have one owner each.
The operator's inference-margin rollup (upstream cost against billed, fleet-wide)
stays off the money path entirely: a cron folds settled generations the rollup has
not yet stamped. It never follows a time watermark, because a generation's
`settledAt` is when settlement was queued, and a retried settlement lands long after it.
The ledger insertion seam also owns its finite-JSON byte ceiling and workspace
display snapshot. Billing pages read only bounded transaction rows; they never
load one full workspace document per item or truncate stored metadata at read time.

Background service charges and model costs acknowledge durable acceptance before
settlement. The [settlement owner](convex/domains/credits/settlementQueue.ts) uses
Convex Batch Worker to serialize bounded batches by billing account, since sibling
workspaces share a wallet. The ledger and reservation transaction still own money;
preflight observes committed balances, and reservation admission remains atomic.
An item's failed transaction rolls back independently and remains inspectable for
repair through `retryFailed`; it cannot block later charges. The component owns
wakeup and crash recovery, so no parallel application retry loop exists. The
[contention rationale](../../specs/done/convex-critical-contention/README.md) records
why settlement follows the payer and the remaining rollout boundaries.

Workspace configuration does not carry a counter rewritten by every charge.
[Workspace spending](convex/domains/credits/workspaceSpend.ts) is exact, separate
state used by the cap check. Delayed settlement retains its event time without
resetting a newer spending period. During rollout, run `backfillWorkspaceSpending`
through the migrations runner before removing the legacy fields and fallback.
The authenticated counter layout likewise deducts the old layout's already-spent
allowance during its deployment window; that compatibility read can be removed
after the wider layout has been live for a complete rate-limit window.
Ordinary API usage and model preflight share the credential timestamp throttle:
either path writing every request would invalidate the other's counter reads.

API-key kinds share one insertion seam that canonicalizes and bounds persisted
scopes. OAuth grants are immutable authorization snapshots, including bounded
client and workspace display identity, so connected-app pages do not depend on
later client or workspace reads. Audit provenance has the same shape: every
domain writes through one audit owner, which rejects non-finite or oversized
provenance before the event is inserted.

Profile identity is canonical on the user row immediately; workspace member
ordering/search is a bounded projection. Identity writers coalesce one
revision-keyed refresh job per user, and that job advances through stable
membership-ID checkpoints so joining many workspaces never turns a profile edit
into one unbounded transaction. Each projection row carries the searchable name
and email corpus; Convex owns relevance ordering and cursor pagination instead of
materializing application-defined prefix order. Membership/access does not wait
for presentation rows to converge.

Gateway generation settlement keeps the customer bill separate from upstream
provider cost: the shared contract owns tier pricing, the ledger debits only the
billed amount, and the member projection reveals the tier without exposing the
private model/provider margin context. A subscription plan switch sweeps stored
session and workspace tiers up to the new plan's default but never down — a
quality choice deliberately set above the default survives every plan change.
Provider aliases are explicit choices outside that ranked ladder and remain unchanged.

Browser-facing links are built from the explicit product-app origin. Convex Auth
also requires its fixed vendor environment key for that same value; application
code must use the Duet-named origin instead of treating the vendor key as shared
configuration. Browser-initiated auth callbacks are the multi-origin exception:
the web app supplies its own origin, non-production auth accepts the email
callback and Google return path on `http://localhost:3000`, and production
accepts only the configured product origin. The host-scoped browser-intent
cookie still binds each email link to the browser and origin that requested it;
Google uses Convex Auth's verifier cookie.

VM desired state is one projection in one query. A Convex query is a consistent
snapshot, so the roster and the active shares are always read under the same
servicing state — a pause cannot land between them. That is also why it is one
function call per poll: the sync poll runs for every VM every few seconds, and
each call it makes is a line on the fleet's bill.

## Development

Everything runnable is a `package.json` script — run it with `bun run <name>`;
read that file for the full list. The workflow, in order of when you reach for it:

- `bun run setup` — **one-time per checkout.** Links this working copy to the
  existing Convex project (`duet-v2`, team `david-2dce6`) and writes the local
  deployment. New machines run this before `dev` works. **After setup, point at
  staging** with `bun run select-staging`.
- `bun run select-dev` / `bun run select-staging` — switch the active deployment
  between the `dev` and `staging` environments. In Convex, `dev` is your own
  **personal** deployment — isolated to your machine, safe to break — while
  `staging` is the **shared** deployment everyone points at. Default to
  `staging`; only select `dev` when you deliberately want a private sandbox.
- `bun run dev` — the Convex dev server: watches functions, pushes them, and
  regenerates `convex/_generated` on save.
- `bun run codegen` — regenerate `convex/_generated` on its own, without the dev
  server (e.g. after pulling schema/function changes).
- `bun run deploy:staging` — push functions + schema to the shared **staging**
  deployment and exit. Staging is a Convex _dev-type_ deployment, so `convex deploy`
  without a deployment key targets production; this local path instead selects staging
  and runs `convex dev --once` (a single push that exits instead of watching — no hang).
- `bun run deploy:ci` — non-interactive deployment for the API-owned Vercel rail. A
  deployment-scoped `CONVEX_DEPLOY_KEY` is the authority and destination, including for
  the dev-type staging deployment, so this path never mutates a checkout's interactive
  selection. The root [Deployment (Vercel)](../../README.md#deployment-vercel) section
  owns the rail ordering and environment mapping. Before functions land, that
  rail bakes the immutable release revision into their source; the permanent
  `deployment:identity` query exposes it with the current schema generation.
- `bun run deploy` — deploy functions to a Convex **prod** deployment (unused today;
  staging uses `deploy:staging`).
- `bun run file-activity-cutover:<environment>` — inspect the declared file-activity
  tables through a pre-schema snapshot, or empty them only with the command's exact
  deployment, quiesce, and sealed-retry acknowledgements. The tool deliberately uses
  Convex's table import boundary so legacy rows can be removed before a strict schema
  is deployed.
- `bun run workspace-capacity-census` — stream a Convex export snapshot and refuse
  promotion when any workspace exceeds a complete VM replacement capacity.
- `bun run check-types` — type-checks both `src` and the Convex function
  environment (`convex/tsconfig.json`); `bun run test` runs the suite.

## Pointers

- `convex/schema.ts` owns the database shape.
- `convex/http.ts` owns Convex HTTP actions such as edge resolution and webhooks.
- `convex/auth.ts` owns Convex Auth provider wiring.
- `convex/domains/` owns the metadata model by product domain.
- `convex/domains/syncMachines/` owns non-secret device identity independently of
  user credentials. A machine survives key replacement; removal stops its mirrors
  while retaining the user behind historical file attribution.
- `convex/domains/fileActivity/namespace.ts` owns stable file/folder identities and
  versioned parent/name bindings. Operational transitions resolve active bindings
  only; user selection may use a direct ended binding in the current restore epoch.
  Moving a folder changes its own binding and never rewrites descendants.
- [`convex/domains/analytics/`](convex/domains/analytics/README.md) explains the
  shared analytics, attribution, conversion, and server-destination vocabulary.
- `convex/domains/officialAgents/` owns official subscription lifecycle and VM projection.
- `convex/domains/onboarding/` owns the starting-team recommender: a `'use node'`
  action that calls the AI gateway on the platform's key and validates every pick
  against the verified marketplace catalog. It has no failure mode — timeouts,
  gateway errors, and fabricated agent names all return an empty list, because
  onboarding must never block on it.
- `convex/services/` owns adapters for external services used by domain code.

## Workspace backups

[Backup jobs](convex/domains/workspaceBackups/jobs.ts) own capture attempts,
progress, and lifecycle references. A scheduler callback follows each job
through dispatch and storage cleanup; unrelated jobs cannot block each other.
Upload-grant expiry is recorded before authority is issued, so deletion can
refuse new writes while retaining enough state to collect a late object.
Attempt identity and the current VM generation fence worker reports; deletion
wins over completion. An authenticated worker can retire its local journal even
if its job was deleted while the VM was unreachable. Repeated heartbeats without
growing counters do not keep a stalled job alive.
The API owns Blob authority and the VM owns archive bytes; neither histories
nor signed URLs belong in a job row.

Lifecycle capture is an admission decision, not permission to tear down a VM.
Only a complete backup advances operator archive or replacement, and current
servicing policy is checked again before destructive continuation. Refusal keeps
the source VM intact. Unpaid decommission retains its grace deadline even when
capture or external control is unavailable.

Accepted recovery pins its backup until installation is acknowledged and normal
sync resumes. A stopped restore may report failure and release that pin; a
stalled restore instead requires teardown of the matching VM generation before
release. Registration carries a typed recovery reference and the API signs its
download without proxying archive bytes. Deleting a settled recovery backup
clears the workspace reference in the same transaction. Workspace deletion fans
out independent object cleanup so one failed deletion cannot block the rest.

A replacement that never installed recovery retries the retained complete
backup; its incomplete Drive cannot supersede that source. An installed restore
acknowledgement identifies when that VM's current Drive becomes the source for
the next reprovision. Accepting a replacement revokes the prior VM credentials
in the same transaction that pins recovery.
## Service vault

`convex/domains/serviceVault/` owns the environment-scoped vendor credential
rows and shared-pool resource ownership used by the API service proxy. The
model keeps the internal-key check and table invariants; the sibling `api.ts`
module is the intentionally narrow public Convex boundary for API HTTP calls.
Pool expiry schedules vendor cleanup and marks metadata terminal, while the
service catalog remains the owner of route admission and pricing. New pool rows
persist the catalog's cleanup route and auth scheme so scheduled expiry is
provider-generic; legacy ElevenLabs rows retain their pre-metadata cleanup
path during the rollout.
