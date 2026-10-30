# api

`api` is Duet's public REST front door. It turns user and VM credentials into
workspace-scoped operations, keeps request validation at the HTTP boundary, and
delegates durable state to Convex plus in-VM work to the gateway running inside a
workspace VM.

## Boundary

This app owns the internet-facing API shape, not the metadata model and not the
in-VM filesystem implementation. Shared request and response grammar belongs in
[`@repo/contract`](../../packages/contract/README.md); Convex state transitions
belong in [`@repo/backend`](../../packages/backend/README.md); VM-local file,
memory, app, sync, and agent process behavior belongs in
[`@repo/gateway`](../../packages/gateway/README.md).

Workspace backups separate bytes from authority. The VM streams its archive
straight to private Blob using renewable grants for one object; the API owns
those grants, download signing, and deletion. Durable backend callbacks drive
[backup control](src/routes/backup-control.ts), so a closed browser or lost
create response cannot abandon dispatch. Completion requires a provider size
check. Deletion keeps its cleanup record until issued upload authority has
expired, preventing a delayed completion from leaving an untracked object.

Operator VM lifecycle requests acknowledge durable admission with `202` and an
`accepted` audit outcome. That receipt does not claim the VM operation finished;
operators inspect the admitted backup for its eventual lifecycle result.

Browser and CLI account operations share the human identity policy in the
[security model](../../SECURITY.md). Routes derive the actor from the authenticated
credential. Browser callbacks and billing/device links use the explicitly
configured product origin—never the request host or the public-site origin.

Incoming workspace invitations are account-level browser operations: discovery
and acceptance derive the recipient from the authenticated person, independent
of the workspace currently open. The backend owns recipient matching and the
acceptance transaction; the public collection never exposes email-link tokens.

Credential identity is classified once before product-specific adapters use it.
Session authorization deliberately coarsens human credentials to a person and
app/VM credentials to the workspace, while attribution adapters may retain the
credential or app identity they need. The actor carried for billing and retries
never upgrades that session principal.

VM-owned collections stay VM-owned when published. The API authenticates,
validates, and cursor-pages their bounded projection; it does not copy hierarchy
or filesystem verdicts into a second metadata owner.

Service proxy responses finish before accounting. Their background callback waits
for durable charge acceptance; the backend's [settlement owner](../../packages/backend/README.md)
then applies it. Callback completion therefore does not promise an updated balance.

Authentication is two Convex calls asked together, not one transaction: a
query resolves who the caller is, and a mutation records the use — the
credential's last-used stamp and one durable, principal-wide API budget spent
before route dispatch. Resolving reads widely and writes nothing, so it never
contends; the recording writes one key row and one counter shard, so the
conflicts a legitimate parallel page load provokes are cheap to retry, which
this app does for Convex write contention only — and when contention outlasts
those retries, the request is served and its tick dropped: the budget is a
ceiling on abuse, not an allowance, so a hot counter refuses (and fails)
nothing. Credential-backed callers are
isolated by key; browser sessions and impersonated visits share the person's
budget. Convex owns the atomic fixed window; this app owns the HTTP refusals,
and a credential that does not resolve is refused (401) before its budget is
consulted (429). VM system credentials and routes that authenticate some other
way stay on their own purpose-built limits.

Product-browser business analytics enters through this authenticated boundary.
The API derives identity and timing, validates any workspace against the live
session view, and delegates transient fanout to Convex; it does not expose that
private route in the third-party developer contract.

The app build constructs one runtime inventory for VM self-update. Its content
identity is an equality token, not a semver ordering signal. The
[release owner](src/runtime/release.ts) verifies the complete baked inventory
once per immutable release directory, coalescing concurrent polls; failed scans
can recover after an incomplete local build. Requested artifacts are verified
again before filesystem streaming. Deployment packaging copies that exact
inventory without rebuilding individual components.

`GET /deployment` is the anonymous, uncached release probe. It joins the API's
full immutable revision with the live Convex revision/schema generation and the
baked runtime identity. It carries no workspace state; deployment acceptance
uses it to reject mixed releases before exercising product behavior.

VM credential delivery is an ordering boundary: registration and sync responses
that carry a model credential must land before durable runner input is drained.
The next sync poll performs the drain, so boot and reactivation races delay a
turn instead of starting it with authority the VM has not accepted yet.

VM registration commits identity before it assembles bootstrap desired state.
Only the commit itself may be refused (401); after it, the VM's provisioning
token is spent until its first sync, so every answer carries the minted token.
Projection or response failures — and a commit result whose shape this API
build did not anticipate, since one deploy publishes Convex before it promotes
the API — return the token with an empty paused snapshot; when the commit
selected a restore, that fallback retains its typed handoff because recurring
sync cannot redeliver it. Workspace backups carry a VM-authenticated refresh
URL even when signing is temporarily unavailable; birth seeds retain their
separate tar descriptor. Archive bytes travel directly from storage to the VM. Recurring sync is
the retry rail for desired state. Convex, for its part, accepts a replay of the
same provisioning token until that first sync and re-issues the same token, so
a lost registration response is a retry, not a bricked workspace.

Snapshot assembly observes core first and share state second, and any pause seen
by either projection makes the whole response quiesced rather than mixing
generations. Quiesce governs what the VM may *do*, not whether it may talk to
us: the routes a VM uses to pull its own artifacts (runtime release, skills
bundle) or report its own activity authenticate on liveness alone, because a
paused workspace keeps its VM and must stay updatable.

Connected-provider status is read from the VM at read time and folded into the
stored rows, which then answer every read. The VM owns that truth — its
credential store can change from a workspace terminal — so a copy carried on the
sync rail would be wrong between polls and cost a CLI spawn on every one. A VM
that is paused or unreachable costs freshness, never the page: the stored rows
still answer.

Desktop access is a public `sessions`-scoped VM boundary, but its viewer
credential never enters durable control-plane state. Browser sessions, API
keys, OAuth grants, and installed apps use the same workspace authorization;
the API resolves the registered gateway,
registers only a short-lived credential digest plus the caller's validated exact
embed origin with the VM, and returns the raw credential only inside a direct
exe.dev viewer URL because the edge cannot carry a WebSocket upgrade. The
response exposes only that URL, its admission deadline, phase, and screen.
Status is a separate read so ordinary pane polling never mints replacement
credentials. Both responses are non-retaining and suppress referrers because
the browser-held credential necessarily appears in the URL;
`src/routes/desktop.ts` owns that HTTP policy and `src/gateway/client.ts` owns
minting and VM transport.

Browser-window identity stays VM-local and stable; the product API contributes
only current presentation and intent. Desktop status joins stable agent ids to
the current workspace name and slug, while an agent Desktop focus request resolves
that current slug before asking the gateway to focus an existing window. Grant
minting and viewer reconnect never carry focus as a side effect.

Operator reads on the internal-admin boundary are Convex queries, and the audit
row for a read is a separate small mutation the API writes once the read has
been served. A read that audits itself has to be a mutation, and a mutation
whose read set spans the fleet loses the write conflict to the VM heartbeat on
every retry; a query cannot conflict, and a refused read still leaves no row.
For the same reason a fleet-wide operator effect is an action that runs one
transaction per payer, opening its audit row as `started` and closing it with
the total. A payer whose leg fails is recorded and skipped rather than allowed
to block the payers behind it, and the pass then closes as `failed` naming each
one, so a partial reset is visible as partial and re-runnable.
A refusal the operator must tell apart (not an admin, not found, wrong
confirmation, dataset too large, bad request) travels from Convex as typed error
data, because production Convex redacts plain error messages; the code list is
the contract's, and this app owns the status each code maps to.

Operator Chrome patching is a named effect on the same internal-admin boundary,
not a generic command. The API preserves confirmation-by-workspace and audit
provenance while the gateway owns whether the shared browser can safely stop;
a live agent therefore reaches the operator as the typed `desktop_busy`
refusal rather than an interrupted turn.

The API also decides how long each VM waits before syncing again, and a quiet
workspace waits longer. Nothing a person waits on rides that interval — sessions,
app installs, anchor moves and provider connects are pushed to the gateway
directly — so the poll is background reconciliation, and re-running it twenty
times a minute on an idle VM is CPU the workspace is billed for. Anything in
flight, in either direction, restores the fast cadence — and only an exchange
counts, never a state. A paused or banned workspace is quiesced, which the
gateway re-applies idempotently on every poll with nothing pending; treating
that as activity once held 42% of the fleet's polls on the fast clock, all of
them workspaces that were not paying. The same workspaces are refused
credentials, so their VMs ask for them on every poll — and a request whose
answer is always no is not an exchange either; the day quiesce stopped
counting, that ask took its place until it was suppressed too. Because a pending
component update is itself one of those signals, a VM discovers a release on the
slow clock and immediately returns to the fast one to apply it: idling can delay
an update but cannot strand one. The ceiling on the slow clock is not a CPU
judgement at all — the sync poll doubles as the VM's heartbeat, and a workspace
whose heartbeat goes stale is swept to `unhealthy`, so the interval is derived
from that window rather than chosen. `src/vm-poll-interval.ts` owns the decision
and `@repo/contract` owns the window both it and the sweep answer to.

What one poll costs in Convex function calls is a fleet-wide bill, because every
VM pays it every few seconds forever, and it is the largest single line on that
bill. So the route calls only what this poll can use: the train reconcile runs
only when the VM reported a job, and the runner drain runs only when the
projection says input is parked — never on a cue like "the heartbeat persisted",
which is a query per poll that finds nothing. The product of cadence and
calls-per-poll is pinned by a budget test in `src/vm.test.ts` that drives the
route the way the gateway's loop does, on a fake clock; the budget is a ratchet,
lowered as calls are folded away and never raised to make room. Every poll that
stays on the fast cadence logs the one clause that kept it there, and that
distribution — not intuition about who is "active" — is how to read whether the
fleet's cost is in the cadence or in the calls.

Foreground session waiting is an API observation concern, not another durable
queue. Convex remains the terminal authority; gateway SSE only nudges an
immediate recheck. A healthy stream waits until activity or the request deadline;
reconnect backoff begins only after stream closure or VM unavailability. Request
abort tears down those transient readers and timers without changing the
already-durable input. Retrying the identical request resumes observation through
its durable idempotency identity.

Public session streams follow the same split. The API admits the principal
once, then advances the accepted stream only through bounded Convex continuation
pages. VM-authenticated gateway frames are disposable wake hints; losing or
evicting one changes latency, never the durable result. A hint connect that
fails, or a hint body that ends, costs one fallback interval and is then
retried — the stream usually opens before the runner has spawned, and a stream
that wrote hints off at that moment would leave the whole turn to the fallback
poll. Only a frame the stream cannot trust turns hints off for good. A
reconnect is the next authorization boundary, and resumes only through the
standard `Last-Event-ID` header. The [stream owner](src/session-event-stream.ts)
coalesces hint bursts into bounded durable refreshes. Token deltas pass through
immediately within a block; a durable hint must be drained before forwarding
the next block's deltas, because the browser anchors them to its last durable
cursor. Fallback polling remains independent of hint activity, and a hint that
arrives during a fallback read stays pending until consumed.

Foreground and background session inputs share one side-effect pipeline: image
storage, durable preparation, integration synchronization, and gateway dispatch
have one owner. Both modes use the same gateway input path; only foreground mode
observes the correlated terminal before responding. Route adapters own only their
operation-specific payload and response shape. For a message or answer into an
existing session, the spend preflight rides inside the durable preparation —
one transaction decides and prepares, and a refusal comes back from it with
nothing written — and that transaction also reports whether the integration
provider already reflects the turn's permissions, so synchronization runs only
when there is something to synchronize. Each of those was a serial round trip
on the path to the first token. Session creation preflights on its own: it
decides audience and identity that preparation does not.

An exhausted runner queue is a successful `alreadyDelivered` result. Ordinary
Convex errors are redacted in production, so the drain must never recognize
normal completion by matching exception text.

Immediate VM dispatch is a latency optimization, not the session commit
boundary. Input is durable before the gateway call; a live runner gets one
bounded foreground opportunity to acknowledge it, while a cold or stalled
runner returns `queued` and the existing drain owns eventual delivery. This
keeps the VM's deliberately long cold-start allowance outside the serverless
request lifetime without creating a second queue. The bound is sized to an
agent's first-ever turn (it creates its own memory database before it can
acknowledge), not to a warm one: a bound at that edge turns routine first
turns into `queued`, which holds the composer for the whole window anyway and
then redelivers an input the gateway already took.

Stopping a turn joins two authorities: the gateway knows whether a runner
exists and owns pending local work; Convex owns the session shown to humans.
An absent runner is stopped durably without hydration, and its report can only
consume input through the cursor it actually covers. The API still terminalizes
a stop that cannot reach the gateway, including its queued input, so a later
delivery drain cannot undo the user's stop.

Checkpoint reconciliation is observation-only. A VM can repair a stale running
projection using an interrupted checkpoint only when the backend input cursor
and event sequence still match its observation. Pending input and archived work
are excluded. Matching both matters because a timer can start a newer turn
without accepting a new user message; restarting completed work is never a
valid way to repair the list.

The API is the sole owner of input authorship (`src/session-sender.ts`): every
durable input's sender is derived from the authenticated credential or the
nested route's parent path, never submitted by the caller. The one
caller-visible attribution field is `sourceSessionId`, accepted uniformly from
any `sessions`-scoped credential and validated authoritatively by Convex inside
the appending transaction.

Permanent session deletion is an acceptance boundary, not a synchronous VM
teardown. The API asks Convex to authorize and seal the visible root while
durably claiming its subtree, then returns an empty `204`. Private callbacks own
retryable gateway and provider transport; Convex owns bounded traversal and
physical cleanup. A lost response or unavailable VM therefore delays cleanup
without reviving a sealed session or creating a second deletion path.

An initial request retry also resolves its durable idempotency identity before
consulting mutable parent or default-alias state. This is a read-only
recovery path: a response lost after commit can resume the original observer,
but an unmatched request still reaches the ordinary mutation preflight.

The staging acceptance environment can explicitly mount the shared fake OAuth
issuer beneath the test-only API subtree. That route is absent unless
`DUET_ENABLE_FAKE_OAUTH_ISSUER` is exactly `1`; production defaults therefore
retain no issuer surface.

OAuth discovery, registration, authorization, and token exchange are pre-auth
protocol surfaces outside `/v1`; browser consent actions remain authenticated
product operations under `/v1`. The issuer and protected-resource identifiers
come only from typed deployment configuration, never request headers. Client
metadata is validated and stored by `src/oauth/client-metadata.ts` (the server
never fetches a URL to resolve a client); an authorization request stores an
immutable copy so consent and completion URLs never depend on later client
state or browser-supplied metadata. The canonical threat model lives in
[`SECURITY.md`](../../SECURITY.md#oauth-credentials-resource-bound-expiring-grant-families);
this README only identifies the runtime owner.

MCP tool traffic has exactly one byte path (`src/mcp/proxy.ts`), whatever the
source behind it. Sources differ in everything about their lifecycles and agree
on one thing: a runner's request arrives, an Authorization-shaped header is
injected, the transport headers are forwarded, and the upstream's encoding
headers are stripped. A source contributes only its target and, if it has one, a
rule for when a failed status is worth re-resolving.

The one answer that path may give without asking upstream is `tools/list`.
Every runner spawn opens each server with `initialize` then `tools/list`,
serially, and that handshake was the largest slice of a turn's time to first
token — while the list itself only changes when the upstream's identity or
permissions do. A target says what it already knows and where to put what it
learns; a target that says nothing sends every list upstream. Nothing here is
remembered in process memory: on this deployment consecutive requests do not
share an instance, so a memory that only one request ever sees is not a
cache. The Composio route remembers on the session's Convex row — the
provider session's MCP endpoint (its credential is the org key the API
already holds) and the tool list that endpoint last returned under the
permissions it reflected — so a handshake costs the reads the route already
does and nothing else, and the provider is consulted only when the row
predates the endpoint or the endpoint refused.

Which workspace owns a connected account is the provider's answer to a
workspace-scoped query, never a value Duet derives and re-checks. Listing,
connecting, and disconnecting all ask the same question, so a connection the
page can show is always one it can also remove. Deriving ownership instead —
from a label written at connect time, say — silently excludes every connection
made any other way: the provider's own connect flow, reachable by an agent, sets
no such label, and neither does anything that predates it. Those rows still
list, because listing asks the provider; they refuse to disconnect, because
disconnecting asked something else. One predicate, or the two drift.

That path is also the only place a tool result is capped
(`src/mcp/result-cap.ts`). Nothing else in the product bounds one before it
enters a model's context — the gateway's relay budget protects the timeline
copy, not the turn — and one real call has been measured returning 1.3 MB, an
answer no context window survives and no Convex document can hold. The cap parses
the JSON-RPC frame and rewrites `result`; it never cuts bytes, because a
truncated frame is unparseable JSON and turns an oversized-but-useful answer into
a hard tool failure. It drops `structuredContent` before it touches prose, which
routinely halves a result at no information cost because servers duplicate the
same data into both halves. The limit's durable rule is an ordering rather than a
value: it must stay at or below the gateway's relay budget, so anything the model
was allowed to see the timeline can still show in full.

That path also bounds what the proxy will hold and how long it will wait, which
the cap by itself does not. A JSON-RPC frame can only be capped once it is
whole, so the buffer holding a partial one is bounded by nothing else; a frame
past a generous multiple of the cap fails the request rather than growing inside
the invocation. And an upstream gets seconds, not the SDK's minute, to start
answering — the runner connects its servers serially with a sixty-second
per-request default, so one silent server otherwise taxes every turn start
twice over, once to connect and once to list. The deadline is time-to-first-byte
only, because a healthy streaming channel is supposed to stay open.

The public API surface is documented for external developers in
[`apps/docs`](../docs/README.md). Any change to that surface — routes, request
or response shapes, auth or scope requirements — must land with a matching docs
update; the docs app's guard scripts check endpoint coverage, but they can't
write the prose for you.

## Runtime release rollout

Deploying the API and asking VMs to run its application are one release operation.
The deployment's baked manifest is the desired runtime release: once that
deployment owns the environment's API domain, its sync responses announce the
same content-stamped artifact it serves. There is no separate pinning step or
mutable desired version in Convex.

The Vercel function carries that inventory beside its bundled module. Relative
release configuration resolves from the executing module, because the platform
launcher may start in a different working directory. Absolute local paths still
select their explicit inventory.

Hosted files are transport bytes: verification checks the complete manifest,
identity, file type, length and digest. Vercel may normalize mounted permissions.
The manifest's modes describe installation on the VM; packaging verifies them
before upload, and the image and gateway enforce them on installed files.

Use [`../../scripts/pause-vm-updates.ts`](../../scripts/pause-vm-updates.ts) to
stop or resume proactive activation without changing the announced release.
Pause is runtime control, while deploying the API is the release act.

## Marketplace deployment input

Duet's own agents are published by a workspace that is an ordinary publisher which happens to be
**verified**; verification lives on the workspace (`workspaces.verifiedPublisherAt`), never per
listing, because consent is granted to a publisher. That workspace is owned by an existing account
chosen per environment: `DUET_OFFICIAL_HUB_OWNER_EMAIL` supplies the identity to the audited seed
route, and its checked-in default is the deliberately unusable placeholder
`official-agents-owner@placeholder.invalid`, so deployment must choose the account explicitly.

Every listing's source URL is derived per subscription from `DUET_EDGE_HOST` plus the publisher's
own workspace and publish slugs — there is no single hub origin. `edgeHost()` fails closed, and is
called lazily inside the projection loop, so a deployment that has not received `DUET_EDGE_HOST`
cannot serve listings but also cannot break VM sync for every workspace.

Publishing is gated server-side (`marketplacePublishingEnabled()`); the SPA renders its publish
control only from the server-projected `canPublishListings`, and the mutation refuses
independently.

## Tests

These tests are not unit tests: most of them stand a real Convex backend up per
file and talk to it over HTTP. Bun's default five-second budget is a margin, not
a limit, and a machine doing anything else eats it — the backend answers late,
the assertion times out, and every later test in the file inherits a dead
connection and fails too. Measured on one busy machine: 254 of 423 passing at
five seconds, 416 of 423 at thirty, same commit, same load. The suite therefore
sets its own budget, and a timeout here means the round trip genuinely hung
rather than that something else was compiling at the time.

## Pointers

- `src/index.ts` owns the Hono app, authentication gates, workspace capability
  checks, gateway proxying, VM registration, device auth, and runtime release
  serving.
- `src/oauth/` owns external OAuth client metadata resolution and the
  normalization seam shared by dynamic and URL-identified clients.
- `scripts/build-runtime-release.mjs` owns the complete runtime artifact
  constructor. API and image consumers use one constructed inventory.
- `src/runtime/` owns inventory verification, announcement, and filesystem
  streaming; transport URLs do not contribute to release identity.
- Deployment details live in the root
  [Deployment (Vercel)](../../README.md#deployment-vercel) section.

## Test suite shape

The api v1 suite is split across topic slice files (`src/auth.test.ts`,
`src/vm.test.ts`, `src/apps.test.ts`, `src/sessions.test.ts`,
`src/train.test.ts`, `src/billing.test.ts`), which share one suite kit
(`src/index-suite.ts`, named for the `index.ts` app it boots): the kit owns
the deployment boot,
the shared fixtures, and every helper, and each slice file boots its own
deployment through it — test files are separate processes, so the kit's
module-level state is naturally per-slice. The slicing is what lets the suite
parallelize: one file is one process and one serial chain, which would set the
whole package's wall time by itself; topic slices run concurrently with no
shared state between deployments.

Slices are topics — each file's header comment says what belongs in it (auth
and devices, VM sync and registration, apps and shares, agent sessions, train
and files and integrations, billing and workspace administration). A new api
v1 test goes in the slice whose topic it belongs to; if a slice grows into the
package's longest chain, split it by topic again rather than rebalancing by
name. Two couplings to avoid: a test must never depend on rows another slice
created (slices run against separate deployments), and within a slice a test
must not assert exact global state — e.g. the owner's full workspace list —
that earlier tests in the same file legitimately grow.
## Service catalog proxy

The service catalog owns the allowlist, vendor-unit pricing, and discovery
metadata. `GET /v1/services` lists services and `GET /v1/services/:id` explains
their admitted routes; calls under `/v1/services/:service/*` use the vault's
environment-specific vendor credential and settle through the existing credit
ledger. The adapter strips caller credentials and `x-duet-workspace` before
forwarding, and returns a bodyless 404 for an unlisted route. Read
`packages/service-catalog/README.md` before changing a definition.

The service-vault Convex domain stores vendor credentials and shared-pool
ownership. API HTTP calls use the narrow public functions in
`packages/backend/convex/domains/serviceVault/api.ts`; those adapters retain
the internal-key gate while the model functions remain internal to Convex.
