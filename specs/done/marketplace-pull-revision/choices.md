# Choices ledger — final

Decisions made where the spec was silent, re-audited against the shipped code.
Ranked least-confident first. The README owns the invariants and the pointers;
this file owns only what someone *chose*.

## Needs your opinion

**Is hand-editing the hub drive normal practice, or an exception?** The whole
deferral of publisher-reported revisions rests on the answer. The hub's bytes
change through one door — the admin sync press — which is why the revision is
stamped inside a Convex mutation for four lines instead of building a reporting
rail. The cost of that shortcut: a file edited directly on the hub drive moves
no revision, so its subscribers wait the safety interval instead of thirty
minutes. If that is routine, the deferred work moves to the front.

**`GATED_REVALIDATE_INTERVAL_MS` is 12 hours** — the one number here picked
without evidence (`packages/backend/convex/domains/marketplace/model.ts`). It
bounds how stale a hub agent may be when its bytes moved without a press. It is
projected rather than compiled into the VM so retuning it is a deploy — but only
within `[30 min, 24 h]`: outside that the VM clamps silently, and widening the
range *is* a gateway release.

**`REVISION_PULL_SPREAD_MS` is 10 minutes**
(`packages/gateway/src/marketplace/puller.ts`). After a press, every subscriber
of a *changed* agent fetches a fresh archive, and those cannot short-circuit to a
304. Ten minutes puts ~1000 subscribers at roughly 1.7 archive builds a second on
the hub VM. Shorter is a hotter hub; longer delays updates. Sized from the fleet
count, not measured.

**Should `revalidation.ts` be split out of `puller.ts` next?** The file is ~985
lines and owns seven things, while the feature's own thesis is "two jobs,
`snapshot.zip` is the boundary" — and only the local job got a file. It is not
the pure move it looks like: every helper that would move throws `PullFailure`,
and `pullOne`'s stage tracking and backoff classification are built on catching
it, so doing it properly means the new module returns a discriminated result the
way `convergence.ts` does. Real improvement, real risk, on the module that
governs whether the fleet updates. Scheduling it is your call.

## Sound, but worth your eye

**The backend does not compute whether a subscriber is in sync — it cannot.** An
earlier draft had it compare `listing.contentRevision` to
`subscription.appliedEtag`. Once the revision became an opaque token those are
different value spaces, and the only value the token may be compared against
(`pulledRevision`) lives on the VM. So the VM owns the predicate and the control
plane owns the number.

**The gateway holds no gated interval of its own.** It briefly had a 12h fallback
for "revision projected, interval absent" — a state the backend cannot produce,
and a long local default would have quietly broken the rule that absence means
today's behaviour.

**`listingSourceUrl` became `resolveListingOrigin` and returns a pair.** Deciding
whether a revision is trustworthy needs the publish row for `pausedAt`, which
that function already loads; a second read would have been a fleet-wide cost on
the 5s sync. Three call sites and one archived spec's pointer were updated.

**The stamp is a second `ctx.db.patch` after `registerListingImpl`, not a
parameter on it.** That helper is shared with the ordinary publisher path, which
must not stamp a revision.

**The `installs` scaling was dropped.** Scaling the interval by subscriber count
assumed the subscriber-taught fan-in this spec rejected, where detection is
`T / subscribers`. With the revision stamped at the source a subscriber that
notices a change tells nobody, so detection is `T` for everyone and scaling by
popularity would only make crowded listings staler.

**The revision is stamped on every press, not per changed agent.** Whether an
individual agent's bytes moved is not knowable in that mutation, and being wrong
costs one conditional request per subscriber, once.

## Found while building, not planned

**Two cost leaks in the two-timer split.** Both timers shared a jitter salt and
came due at the same millisecond, so a healthy subscription would have converged
twice per cycle — doubling agent-folder hashing fleet-wide. And a never-installed
subscription would have taken a converge timer, found no snapshot, and forced an
unconditional fetch that undid the six-hour dead-origin backoff. The plan claimed
the split was cost-neutral "by construction"; it was not, until these closed.

**A `revision → absent` banking race**, found by the closeout review. Pausing the
publish between the pre-request read and the response landed frozen bytes
credited to the live-tree revision, which would have gated the subscriber onto a
tree it had never seen once unpaused. The revision is now re-checked after the
response and banked only if it still stands.

**A test that waited on the wrong thing.** The snapshot-repair test polled for the
repair *request* and then asserted on the repaired *file* — green on an idle
machine, red under load, because the fetch is issued before the unzip completes.
It now waits on the file it asserts.
