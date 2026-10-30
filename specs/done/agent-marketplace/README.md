# Agent Marketplace — rationale record

Any signed-up workspace can list one of its agents for anyone to install. Duet's
own agents are not special-cased: they are ordinary listings from a workspace
that happens to be **verified**. Publishing is live behind a server-side gate
with the button hidden; installing is live.

[Marketplace multiple agent instances](../marketplace-multiple-instances/README.md)
extends this listing/subscription boundary to several independently named
workspace installs from one listing.

Shipped and closed 2026-07-31. The staging journey `marketplace` passes live.

---

## The problem this solves

The predecessor ("official agents", `specs/done/official-agents/`) distributed
Duet's own agents from a single hub workspace over a publish → zip-poll →
materialize rail. The rail was sound; the *hub* was the limitation. Everything
keyed on one origin and on a bare agent name, so there was no way for a second
publisher to exist, and no way to tell two agents called `research-assistant`
apart.

Generalizing it meant three changes of kind, not degree:

- **A listing is the unit of identity**, not an agent name. Two publishers may
  ship the same name; the name alone can never address one.
- **Every subscription carries its own origin.** There is no hub base URL. A
  URL is derived per subscription from the publisher's own workspace and publish
  slugs.
- **Trust is publisher-scoped.** Verification lives on the workspace, so a
  listing cannot be verified independently of who published it.

---

## Why it works this way

**Install identifies a listing, and a replayed install at the canonical path
`agents/<agentName>` returns the existing subscription rather than a second
one.** An install aimed at a non-default path is not deduplicated — it reports
`path_exists`, because at a chosen path the user asked for that folder, not for
whatever already occupies it. Comparing bare names would
silently adopt a different publisher's subscription the moment two of them share
a name — which is the normal case, not the edge case. Bare names survive in
exactly one place: onboarding and campaigns, which mean "Duet's research agent"
and resolve through the single official-workspace query
(`officialListingIdsByName`). Two resolvers would be the parallel abstraction
this rail exists to avoid.

**An installed agent's slug prefers its install folder over the listing.**
Agent slugs are unique per workspace, so a second `research-assistant` cannot
reuse the name. The folder's last segment wins when it is a legal slug — it is
already proven free by the path-collision check, and it makes the slug agree
with the directory — and the listing's `agentName` is the fallback when it is
not. Either base is then suffixed for uniqueness.

**The catalog never touches a publisher's VM.** Reads are Convex rows only. One
sleeping publisher must not slow the shared browsing path, and a catalog read
must not be a way to probe who is online. The journey pins this
(`originRequestsDuringCatalogRead: 0`).

**Availability is derived, never reported.** A subscriber's pull report moves its
own subscription and nothing else — otherwise one hostile installer could grey
out a rival's listing by reporting failures. A 15-minute cron
(`sweepListingAvailability`) derives it from facts the backend already owns, and
takes the least-recently-checked rows so the window walks the whole catalog
instead of rescanning a fixed prefix forever.

**The VM's URL allow-list is a firewall, not a formality.** The backend is the
only supplier of source URLs, but the gateway re-parses every one it is handed
through `ListingSourceUrlSchema` before fetching, and fetches with
`redirect: 'manual'` so a 30x cannot walk it to an unchecked host. A host carried
beside the URL in the same payload would not be a firewall; a list compiled into
the consumer is.

**Consent is asked only when there is something to consent to: an unverified
publisher shipping apps.** Apps are what carry commands and scopes; a listing
without them has nothing to disclose, and a verified publisher's badge already
answers the question the sheet asks, so verified installs stay zero-friction.
Updates apply automatically by design, so the sheet says so plainly and
enumerates the real commands and scopes rather than summarizing them. The
consent is per install attempt, not a stored fact about the publisher. A local
path-collision correction stays inside that attempt and does not ask again;
cancelling or beginning another install does.

**Tiers never cross the agent boundary.** `duet-agent` implements virtual models
and has no tier concept; a tier reaches it once, as the `--model` spawn flag.
Since the RPC process lives for exactly one turn, spawning *is* the per-turn
switch.

---

## Invariants — what must stay true

- **`agentSubscriptions.listingId` is required.** A subscription with no listing
  is not a supported state. Replay, takedown, install counts, and the VM
  projection all key on it.
- **`deriveListingSourceUrl` is the only constructor of a source URL**, and
  `EDGE_HOSTS` the only allow-list behind it. Nothing else concatenates an edge
  URL. Two readers ask different questions of that one constant — `isEdgeHost`
  for an exact match, `parseEdgeRoute` for exact-or-subdomain, since it needs
  the matched host to parse the rest — but neither carries its own list.
- **`edgeHost()` fails closed and is called lazily**, inside the projection loop.
  Hoisting it breaks `vmSync` fleet-wide on any deployment whose env has not
  received the value; lazily, that deployment is merely unable to serve listings.
- **Verification lives on `workspaces.verifiedPublisherAt`.** Listings derive
  `verifiedPublisher`; they never store it. The badge renders only when it is
  true — rendering it unconditionally asserts Duet reviewed a stranger's agent.
- **A listing stores `publishId`, never a copied publish slug.** `updateSlug`
  patches the publish row independently.
- **One containment walk.** `containedAppsForListing` is it; the consent
  projection, the declaration revision, and what actually gets copied all derive
  from it. Its `take(MAX_APPS_PER_WORKSPACE + 1)` reads the publisher's whole
  workspace plus an overflow probe — the workspace cap is enforced at app
  creation, so it cannot truncate a contained app — and the listing cap is
  applied after the containment filter, never before.
- **Two clocks, and the second one must have a live writer.** `appliedEtag`
  covers files; `appliedAppRevision` covers app declarations, which the
  stat-derived ETag cannot see. `sweepListingAvailability` is the sole writer of
  `appDeclarationRevision`, alongside `availability` — both are derived from the
  publisher's rows, so both need the same scheduled owner. A recompute helper
  called only from tests moves the fingerprint and never the stored column: the
  clock reads dead in production while its unit test passes, which is exactly
  how it first shipped.
- **The materializer journals on the DRIVE's filesystem.** It installs by
  hardlinking and quarantines by renaming — both same-filesystem operations, and
  the drive is a separate volume on a real VM.
- **`resolveListingMetadata` owns `override ?? derived`.** Only the publisher's
  own re-registration sets the override columns, and it sets them from the
  request — including to `undefined`, so clearing a title actually clears it.
  Nothing else writes them.
- **Publishing is gated in the mutation**, not the button. A hidden control is
  not a gate; `canPublishListings` is presentation only.

---

## Pointers into the code

**Contract** — `packages/contract/src/marketplace/index.ts`:
`deriveListingSourceUrl`, `ListingSourceUrlSchema`,
`MarketplaceListingSummarySchema` / `…DetailSchema`,
`VmDesiredMarketplaceAgentsSchema`, `MarketplaceAgentPullReportSchema`.
Host allow-list in `packages/contract/src/edge/index.ts`.

**Backend** — `packages/backend/convex/domains/marketplace/`:
`listings.ts` (listing model, `resolveListingOrigin`, `registerListingFromAgent`,
`containedAppsForListing`, `computeAppDeclarationRevision`,
`sweepListingAvailability`, `takedownListingImpl`, `officialListingIdsByName`),
`model.ts` (`install` / `clone` / `uninstall` / `acknowledge`,
`createSubscription`, `applyPullReportsImpl`,
`projectMarketplaceAgentsForWorkspace`), `ownership.ts`.
Origin eligibility is shared with the edge via `publishOriginRefusal` in
`domains/publishes/model.ts`. Config gates in `convex/config.ts`; tables in
`convex/schema.ts` (`agentListings`, `agentSubscriptions`); the sweep is
registered in `convex/crons.ts`.

**Gateway** — `packages/gateway/src/marketplace/`: `puller.ts` (poll, ETag,
backoff, `upstreamUrl` re-validation), `materializer.ts` (three-way repair,
quarantine journal), `subscription-store.ts`, `inspector.ts`. Routes
`/v1/marketplace/pull` and `/v1/marketplace/inspect` in `src/runtime/http.ts`.

**API** — `apps/api/src/routes/marketplace.ts` (catalog, detail, listing
registration, subscriptions). Operator takedown lives in
`apps/api/src/routes/internal-admin.ts`.

**Web** — `apps/web/spa/marketplace/` and `apps/web/spa/routes/marketplace.tsx`.
Listings are addressed by `(publisherSlug, agentName)`; installed state matches
on `listingId`.

**Tests that pin the behavior** — `packages/backend/src/marketplace.test.ts`,
`marketplace-listings.test.ts`;
`packages/gateway/src/marketplace/puller.test.ts` and `inspector.test.ts`;
`apps/api/src/marketplace.test.ts`;
`apps/web/spa/routes/marketplace.test.tsx`;
`packages/contract/src/marketplace/index.test.ts`. The live gate is
`packages/test-harness/src/staging-e2e-synthetic`, registered as
`marketplace`.

---

## Where the build diverged from the plan

**The publish anchor decides whether the agent name is in the URL.** The plan's
original formula appended the agent name unconditionally, which 404s for a
listing published on its own agent folder. `agentSubpath` exists for exactly this
and is `''` for every ordinary listing. The proof table is
[`assets/00-source-topology.md`](assets/00-source-topology.md) — generated from
the contract. Its URL grammar and its refusal list are pinned by
`packages/contract/src/marketplace/index.test.ts`; the filesystem half (what
resolves beneath a root versus a parent publish anchor) is pinned by
`packages/gateway/src/routes/publishes.test.ts`. It is the provenance for why the
URL grammar has a subpath at all, and it lists the handed URLs a VM must refuse.

**Renaming a field that lives in `appAgentFields` cannot be deployed by its own
strip mutation.** The Convex push validates the schema before the new code —
which contains the strip — can run. Resolved by `convex export` +
`import --replace`. The plan's cutover ordering did not anticipate it, and any
future rename in that shared field block hits the same wall.

**Install by listing had to land as one vertical cutover**, not an incremental
slice: the moment the wire required `sourceUrl`, every consumer went red at once.
The first attempt was thrown away outright; the second was parked on
`slice07-wire-cutover-wip` until the fixtures were rebuilt, then finished and
merged from there.

**Two seams shipped dead behind green tests, and the close-out audit is what
caught them.** Both had the same shape: a test that exercised the unit directly
while nothing in production reached it.

- `appDeclarationRevision` was written only by `refreshListingAppDeclarations`,
  a mutation with zero callers. Its test called that mutation, so the
  fingerprint function was proven and the stored column never moved — the
  second clock did not tick at all. Folded into `sweepListingAvailability`,
  which the cron already runs, and the mutation deleted.
- The `official` → `marketplace` URL-segment rename missed two consumers that
  match on the segment by hand: `loading/loading-route.ts`, which dropped
  marketplace detail to the generic loading frame, and `drive/agent-roster-rail.tsx`,
  which lost Agents Home's active state on every listing page. The
  loading-route test had been repointed at the *old* path, so it stayed green
  against a URL the router no longer produced.

The lesson both times: assert through the scheduled or mounted entry point, not
the helper it calls.

**The first live install revealed the rail had never materialized a file on a
real VM.** `EXDEV: cross-device link not permitted` — the journal was rooted at
the gateway's state dir while the target is on the drive, a separate volume.
Every unit test pointed both at one tmpdir, so a cross-device journal passed the
entire suite. This is also why the predecessor never achieved a live pass.

---

## Dead ends

- **A live-crawl catalog service** that read the hub's published tree on each
  request. Deleted: it made browsing depend on a publisher's VM being awake, and
  with many publishers it becomes a fan-out.
- **A per-listing `verified` flag.** Rejected: it lets the same publisher be
  simultaneously verified and not.
- **Copying an app manifest onto the listing.** Rejected: the publisher's `apps`
  rows stay the single declaration owner; a copy is a second owner that rots.
- **A `tier` field on the agent's prompt command.** Added, shipped, and deleted
  — `duet-agent` never declared it and silently dropped it. It could only have
  meant mid-turn switching, which is neither wanted nor supported.
- **Reporting availability from subscriber pull results.** Rejected as an abuse
  vector before it was built; the cron derives instead.
- **Legacy `official-agents` URL redirects.** Written, then deleted: the product
  has not launched, and a bare agent name cannot address a listing anyway.

---

## Open at close

- Publishing is gated off and prod is not promoted — both deliberate, and both
  one-line changes owned by Example User.
- The VM-sync wire field is `marketplacePullReports`, renamed from
  `officialAgentPullReports` at close with no compat. The field is optional and
  the API parses with a tolerant schema, so a VM still running the older gateway
  does not error — its marketplace pull reports are dropped until it picks up
  the new gateway, then settle normally.
- Decisions made without the user, re-audited against shipped code, are in
  [`choices.md`](choices.md). The quadrant walk that set the givens is
  [`MAP.md`](MAP.md).
