# Marketplace pull revision

The VM fleet no longer pays a Convex HTTP action every half hour to be told
nothing changed.

Every public request through `apps/edge` costs exactly one `/v1/edge/resolve`
HTTP action, and in production essentially all of that traffic was the
marketplace puller revalidating subscribed agents against the official hub —
measured at 0.5–0.8 requests/second — 43–69k actions/day — almost all `304 Not
Modified`. The puller now runs as two jobs instead of one, and the half that
needs the network is gated on a content revision the control plane already
knows, so a subscriber of an official-hub agent asks the origin once every
twelve hours in steady state rather than every thirty minutes — while local
repair keeps running on its own clock, unchanged. A third-party publisher's
listing carries no revision and still polls every thirty minutes; closing that
is the deferred work below.

Read [`choices.md`](choices.md) next: it is the decision ledger, and it carries
the two numbers still open to opinion.

Verified live against staging (`bun run e2e:staging -- --journey marketplace`,
run `staging-e2e-synthetic`, staging at `f17015959`): the
journey provisions a fresh VM, and a fresh VM boots with the announced gateway
artifact (see `apps/api/README.md` → *Gateway release rollout*), so the new
puller ran on a real workspace — installs and a second instance converged, both
hub-sync presses wrote nothing with a stable publish ETag, a publisher deletion
propagated while the subscriber kept its files, and cleanup left no orphans. The
gate's *timing* is pinned by the fake-clock tests, which is where timing belongs.

## The reason

The poll was doing **two jobs on one timer**, and only one of them needed the
internet:

- **Deliver** — `GET <sourceUrl>?zip` with `If-None-Match`, to learn whether the
  publisher's bytes moved.
- **Converge** — re-apply the cached `snapshot.zip` over the drive, restoring a
  file the user deleted and reaping derived content out of a directory the
  publisher emptied. It reads a snapshot already on disk and has never needed a
  network at all.

Because both hung off one timer, every local repair cost a request. That is the
whole shape of the problem, and it is why the two obvious levers are dead ends
(below): **any lever that leaves the two jobs fused can only trade cost against
latency.** Separating them is what makes both axes improve at once.

## Principles & invariants

**The revision is an opaque token.** The subscriber compares it only against the
token it last pulled at — never against an ETag, a hash, or a clock. This is
load-bearing: `zipTreeEtag` (`packages/gateway/src/routes/files.ts`) hashes
`path + size + mtimeNs`, so an identical-bytes rewrite moves it, and frozen
publish roots, quoting, and readdir order are all in the same hazard class. A
token only ever compared against itself is immune to every one of them, and it
is what lets a future writer mint a different kind of value into the same column
with no wire change.

**One writer per listing revision, and it is never a subscriber.** The revision
is projected to every *other* subscriber, so a pull report that could move it
would let one hostile installer aim the whole fleet's pullers at a rival
publisher's origin. Same firewall `availability` already keeps. Pinned by *"a
pull report moves the subscriber's own row and never the listing's content
revision"* in `packages/backend/src/marketplace.test.ts`.

**The gate chooses between two intervals, never between polling and not**, and
the VM clamps whatever interval it is handed into `[30 min, 24 h]` before the
±10% jitter every interval carries. A gate that
could reach zero would make one wrong stored revision permanently blinding; one
that only stretches heals itself on the next safety poll. So the worst case for
a wrong value is today's traffic at one end or one day of staleness at the
other — never a fleet that stops revalidating.

**Absence means today's behaviour, at every layer.** No revision, or a revision
with no interval, and the subscriber revalidates exactly as it did before. The
gateway deliberately holds no gated-interval default of its own: the control
plane owns that number, and a long local default would have broken this rule
quietly.

**The directed pull is edge-triggered, once per distinct value, and spread.**
The projection is a *level* that arrives every five seconds forever. Re-acting on
every delivery starves rather than storms — because the trigger schedules rather
than enqueues, it would push the pull five seconds further out every five
seconds and never fire. The spread is a *uniform* offset over its window, never
`stablePollInterval`'s ±10% jitter, which would concentrate a herd into a band a
fifth as wide.

**A paused publish projects no revision, and a revision is banked only if it
still stands after the response lands.** A paused publish serves frozen bytes
while the revision describes the live tree; together these two stop a subscriber
being gated onto a tree it has never seen.

**`pulledRevision` is cleared with the ETag whenever the snapshot boundary
breaks.** Both mean "I hold known-good bytes", and a gate standing over an
unreadable snapshot would stretch the one fetch that could repair it.

**Both deploy orders are safe.** `apps/api` re-parses the projection through a
schema that strips unknown keys, so Convex-first leaves an older API dropping the
fields (inert, self-healing) and API-first projects nothing. Only the gateway
needs a release to reach the fleet — and deploying the API *is* that release.

## Pointers into the code

| Concern | Owner |
|---|---|
| The revision column and its one writer | `agentListings.contentRevision` in `packages/backend/convex/schema.ts`; stamped in `domains/internalAdmin/officialHub.ts:completeSync` |
| Projection, and the paused-publish withholding | `resolveListingOrigin` in `domains/marketplace/listings.ts`, consumed by `projectMarketplaceAgentsForWorkspace` in `domains/marketplace/model.ts` |
| The fleet-wide interval | `GATED_REVALIDATE_INTERVAL_MS` in `domains/marketplace/model.ts` |
| Wire shape | `VmDesiredMarketplaceAgentsSchema` in `packages/contract/src/marketplace/index.ts` |
| The gate, the trigger, the spread | `revalidateIntervalFor`, `acceptDesired`, `spreadOffset` in `packages/gateway/src/marketplace/puller.ts` |
| The network-free half | `packages/gateway/src/marketplace/convergence.ts` |
| Persisted per-subscription state | `packages/gateway/src/marketplace/subscription-store.ts` |

Behaviour is pinned by `packages/gateway/src/marketplace/puller.test.ts` (the
gate, the clamp at both ends, the anti-starvation trigger, convergence with no
network, a stale revision still converging through the safety poll) and
`packages/backend/src/{vm-sync,marketplace,official-hub-seed}.test.ts` (the
projection, the paused withholding, the firewall, and the stamping).

## Dead ends

**Raising the CDN TTL does nothing for the steady state** — the most tempting
lever, and it was killed empirically against production. A conditional request never *populates* Vercel's
cache: three `if-none-match` requests five seconds apart all returned
`x-vercel-cache: MISS`, and only an unconditional GET repopulated the entry,
after which the next conditional request HIT. A steady-state subscriber always
holds a snapshot, so it always sends `if-none-match` and can never fill the cache
it would need to hit. `PUBLISH_CACHE_CONTROL` in `apps/edge/src/index.ts` is not
a knob for this problem.

**Raising the poll interval works but pays twice.** It cuts traffic linearly, and
it stretches *both* jobs — a user who deletes a file inside a subscribed agent
would wait the new interval for it to come back. Rejected as the primary lever
for that reason, not because it was ineffective.

**Subscribers teaching the backend the revision was rejected outright.** It looked
free — every subscriber already reports its applied ETag, and all subscribers of
a listing converge on the same value, so the first VM to poll after a change
could teach the backend and fan out to everyone else. It is an amplifier: one
hostile VM reporting a fake ETag on its own five-second sync becomes ~1000 pulls
aimed at another publisher's origin. It is also the wrong owner — a listing with
zero subscribers still has bytes. Not adopted even as a transitional seam,
because a working second writer is exactly the one that never gets removed.

**Scaling the interval by `installs` was dropped.** It assumed the fan-in above,
where detection latency is `T / subscribers`. With the revision stamped at the
source a subscriber that notices a change tells nobody, so detection is `T` for
everyone and scaling by popularity would only make crowded listings staler.

**The backend cannot compute whether a subscriber is in sync.** An early draft had
it compare `listing.contentRevision` to `subscription.appliedEtag`; once the
revision became opaque those are different value spaces and the comparison would
always report disagreement. The VM owns the predicate, the control plane owns the
number.

## Divergences from the plan

- **Slice 04's backend half landed before slice 03**, not after. It is inert
  without a gateway that reads it, and landing it early meant the gate and the
  cadence reached the fleet in **one** gateway release instead of two — the risky
  half of this work. Its gateway half then fell out of slice 03 for free, so the
  commit labelled 04 carries only tests and docs.
- **Slice 00 was never needed.** It existed only to give `zipTreeEtag` one owner
  before a publisher-side reporter could drift from it; the publisher-reported
  rung is deferred, so nothing computes that ETag outside the publish route.
- **The two-job split was not cost-neutral "by construction"**, as its slice
  claimed. Building it surfaced two leaks: both timers shared a jitter salt and
  came due at the same millisecond (converging twice per cycle), and a
  never-installed subscription would take a converge timer, find no snapshot, and
  force an unconditional fetch that undid the six-hour dead-origin backoff.
- **A `revision → absent` banking race** was found by the closeout review, not the
  plan: pausing the publish between the pre-request read and the response landed
  frozen bytes credited to the live-tree revision.

## What is deliberately not built

**Publisher-reported revisions.** The hub's bytes change through exactly one door
— the admin sync press — so the backend already knows when they move, which is
why the revision is stamped inside a Convex mutation rather than reported up a
new rail. The cost of that shortcut: a file hand-edited directly on the hub drive
moves no revision, so its subscribers wait the safety interval instead of thirty
minutes. The publisher-side reporter earns its
build once non-hub listings are a material share of edge traffic, or once
hand-editing the hub drive stops being an exception.

The design, recorded so it is not re-derived: the publisher's own gateway walks
each listed anchor with the same `collectPublishSubtree` + `zipTreeEtag` the zip
route uses, on its OWN ~60s ticker (never the 5s sync tick — each listing is a
stat walk bounded by `MAX_RECURSIVE_FILE_ENTRIES`), and carries the result on
its sync request. The API forwards it to a mutation that refuses any report
whose `listing.workspaceId` is not the reporting workspace — **that ownership
check is what makes a publisher's word authoritative where a subscriber's is
not** — writing the same `contentRevision` column under the same one-writer
rule. The desired state gains the listings a workspace publishes, carrying the
publish anchor path and the agent subpath **un-joined**, because the publish
route builds its served root by joining them and a pre-joined path would be a
second path-resolution rule and therefore a second skew source. The response
must echo what it accepted: the sync client acknowledges its outbox on any 2xx
while the API applies reports through a shielded mutation, so without an echo a
failed apply silently drops the report — pull reports survive that only because
they are rebuilt from disk each boot, and a publication report has no such
backstop.

Two things must hold if it is built. The value it reports has to be
byte-identical to what `?zip` serves, quotes included, so `zipTreeEtag` needs one
owner shared with the route before a second caller exists — drift there fails
safe (everyone polls at the floor forever) which is exactly why it needs a test
rather than vigilance. And a walk that fails must report **nothing**: absence
means "no verdict", and a wrong revision is strictly worse than none.

**Splitting `revalidation.ts` out of `puller.ts`.** The feature's thesis is "two
jobs, `snapshot.zip` is the boundary", and only the local job got a file. The
symmetric split is worth doing and is *not* the pure move it looks like — see
`choices.md`.
