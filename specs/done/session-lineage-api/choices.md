# Session Lineage API — Choices Ledger

This is the durable decision audit for the shipped feature. “The gap” records
where the accepted product contract left implementation discretion; it is
historical context, not remaining work.

## Sound

### The deployed physical census is one bounded transaction over known session IDs

- **When:** Deployed acceptance (`e96ede39c`, `ca1502394`).
- **The choice:** The staging journey already knows the four session IDs in the
  subtree it created. It sends those IDs and their workspace ID through an
  internal-key query, which reads each canonical session row, deletion-work row,
  and dependent-row family in one Convex transaction. The query accepts at most
  16 IDs and refuses a surviving canonical or work row assigned to another
  workspace. It never lists a workspace or lets the caller choose cleanup
  effects.
- **The gap:** The plan required a narrow internal acceptance seam and a
  dependent-row census, but did not choose whether staging should compose the
  existing per-table test queries or receive one bounded snapshot.
- **The reach:** Future deletion journeys can inspect a small set of identities
  they created without mistaking public `404` for physical absence. Adding a
  larger export or a deletion-status product should require a new consumer; this
  seam remains test-only and read-only.
- **Verdict:** **Sound.** One transaction prevents a transcript from combining
  unrelated moments, and known IDs avoid creating an internal workspace dump.
- **Confidence:** High.

### Every staging session cleanup now uses the hard-cut shared owner

- **When:** Deployed acceptance (`e96ede39c`).
- **The choice:** Existing journeys had several private cleanup blocks that each
  called session DELETE and accepted the old `202`. They now call the shared
  `deleteStagingSession` helper, which accepts idempotent `404` or an empty
  `204`. No journey keeps its own status compatibility list.
- **The gap:** The task explicitly hard-cut the shared helper but did not say
  whether older journey-local cleanup adapters should remain. Leaving them
  would make the full staging suite reject the new public contract even while
  the named lineage journey passed.
- **The reach:** Future changes to session cleanup have one staging owner, and
  every journey inherits the same response-body assertion. A journey needing a
  genuinely different deletion contract must name why rather than copy the
  transport again.
- **Verdict:** **Sound.** It removes obsolete compatibility and prevents
  deployed acceptance flows from disagreeing about the same public endpoint.
- **Confidence:** High.

### The journey creates real read cursors before claiming dependent-row cleanup

- **When:** Deployed acceptance (`e96ede39c`).
- **The choice:** Before deleting the subtree, the journey calls the public read
  endpoint for every known subtree session and requires the physical census to
  observe those rows. After deletion it requires all of them to be absent. The
  alternative was reporting a zero read-row count both before and after, which
  would show only that the fixture never exercised that cleanup owner.
- **The gap:** The plan required dependent-row proof but did not specify which
  dependent families the API fixture must deliberately populate.
- **The reach:** The live transcript proves at least events and reader cursors
  crossed from present to absent for every tree node. Optional integrations and
  images remain local deterministic cleanup tests rather than staging setup
  dependencies.
- **Verdict:** **Sound.** It turns the census from a zero-to-zero sample into an
  exercised deletion claim without adding a test-only writer.
- **Confidence:** High.

### External deletion retries use short finite runs that replace themselves

- **When:** Durable external cleanup (`c53d0679b`).
- **The choice:** Each Action Retrier run starts with a one-second backoff and
  permits six failures. A failed run is not terminal: its generation-checked
  completion returns the durable row to pending and immediately schedules a
  replacement through the same owner.
- **The gap:** The plan delegated component options and bounded attempt timing
  but required indefinite durable retry across finite component runs.
- **The reach:** A continuously unavailable gateway produces a new finite run
  after one bounded exponential-backoff run exhausts. The work row remains
  sealed and physically present throughout.
- **Verdict:** **Sound.** It gives transient failures quick retries without
  treating one component run's exhaustion as deletion failure.
- **Confidence:** Medium. Production telemetry may justify slower timing later,
  but changing it does not alter the ownership model.

### Lost completion recovery examines fifty oldest ready rows every five minutes

- **When:** Durable external cleanup (`c53d0679b`).
- **The choice:** One deletion-only cron selects at most 50 oldest scan-complete
  rows across pending and running external states every five minutes. Pending
  work re-enters the shared scheduler; running work asks Action Retrier whether
  its stored generation has completed and, if so, replays the same completion
  mutation. If the completed run has aged out after seven days, a mutation
  resets only a row still naming that exact generation before re-entering the
  scheduler.
- **The gap:** The measured Action Retrier 0.3.1 edge required a bounded repair
  cadence and census size, but the plan delegated their exact values.
- **The reach:** A swallowed completion hook may wait up to one cron interval,
  plus bounded backlog, before repair. The sweep owns neither HTTP attempts nor
  backoff and cannot create a competing run for active work.
- **Verdict:** **Sound.** The composite index excludes unfinished frontier rows,
  and oldest-first selection prevents new work from continually overtaking an
  orphan.
- **Confidence:** Medium. Fleet volume should inform whether 50/five minutes
  needs tuning; the boundary and invariants should not change.

### Frontier readiness is an injectable effect with one production owner

- **When:** Durable external cleanup (`c53d0679b`).
- **The choice:** Subtree traversal calls one `scheduleReadyWork` effect when a
  node's child scan finishes. Production binds that effect to
  `scheduleReadySessionDeletionWork`; frontier tests inject a no-op rather than
  booting the Action Retrier component. External completion calls the same
  production function directly.
- **The gap:** Adding external scheduling made traversal unit tests depend on a
  component they do not own. Recursive deletion also needs one readiness edge
  callable from either possible second transition.
- **The reach:** Physical cleanup is attached inside the shared ready function
  and retains its own mutation guard. Frontier and external-completion modules
  call that decision rather than owning separate cleanup readiness logic.
- **Verdict:** **Sound.** This preserves one production orchestration decision
  while keeping the traversal owner independently testable.
- **Confidence:** High.

### An inconsistent deletion-work row cannot remove unrelated state

- **When:** Recursive DELETE cutover (`05d949a88`).
- **The choice:** Physical cleanup returns `done: false` without effects when a
  deletion-work row names a missing canonical session or one in another
  workspace. It does not guess that cleanup succeeded and delete the work row.
- **The gap:** The plan required a hard readiness guard and transactional
  canonical/work-row removal, but did not prescribe recovery for this otherwise
  unreachable inconsistent state.
- **The reach:** Under the production invariant, only the cleanup owner removes
  a canonical session, and it removes that session and its work row in the same
  Convex transaction. Therefore this state cannot be produced by a committed
  production transition. If corruption or a future writer violates the
  invariant, the durable row remains visible for diagnosis rather than being
  silently erased or used to authorize another delete.
- **Verdict:** **Sound.** Failing closed preserves the hard physical-cleanup
  guard and does not invent a second recovery owner without a demonstrated
  producer.
- **Confidence:** High.

### Public and private deletion routes share one focused route module

- **When:** Recursive DELETE cutover (`05d949a88`).
- **The choice:** The permanent-deletion module registers both the public
  acceptance endpoint and the private work-ID callback. The broad agent route
  no longer owns either deletion flow.
- **The gap:** The plan delegated exact route-module placement while requiring
  one deletion owner and removal of the old adapter.
- **The reach:** HTTP deletion contracts are discoverable together, while the
  backend remains the durable workflow owner. The private callback is still
  excluded from public endpoint metadata and authenticated by its existing
  internal boundary.
- **Verdict:** **Sound.** Co-location removes lifecycle-route sediment without
  merging public authentication with private callback authentication.
- **Confidence:** High.

### Sibling disposal uses the platform scheduler's natural concurrency

- **When:** Recursive DELETE cutover (`05d949a88`).
- **The choice:** Each scan-complete session work row independently enters the
  existing Action Retrier scheduler. The cutover adds neither a serial subtree
  queue nor a feature-specific concurrency semaphore.
- **The gap:** The plan explicitly delegated whether sibling attempts are
  serial or bounded-concurrent, and the repository has no measured fleet limit
  that justifies another durable coordinator.
- **The reach:** Wide subtrees may have multiple sibling disposal runs ready at
  once, subject to the platform scheduler and retrier's execution limits. Each
  remains independently idempotent and generation-checked.
- **Verdict:** **Sound.** It preserves one retry owner and avoids speculative
  orchestration state; operational evidence can justify a shared cap later.
- **Confidence:** Medium. Production volume and gateway pressure are not yet
  measured for this new subtree shape.

### The first deletion claim keeps the shared node's root identity

- **When:** Bounded subtree sealing (`29ac37bc0`).
- **The choice:** Suppose a child deletion starts first, creating durable work
  that says “this child is my root.” If an ancestor deletion reaches that same
  child later, both cascades reuse the child's existing work row and its
  original root identity. Rewriting the field to the ancestor would make
  already-created descendant work disagree about which operation it belongs
  to, while adding a list of roots would violate the one-row-per-session model.
- **The gap:** The plan required one `rootSessionId` and overlapping-delete
  coalescing, but did not say which root wins when work already exists.
- **The reach:** Later observability and external-cleanup code must treat
  `rootSessionId` as the stable first claim, not as the highest ancestor ever
  discovered.
- **Verdict:** **Sound.** It preserves idempotence and one durable owner without
  affecting subtree coverage.
- **Confidence:** Medium.

### The child read reuses the point-access owner even though that repeats one bounded membership lookup

- **When:** Indexed lineage reads (`901e03151`).
- **The choice:** Before returning children, the backend asks the existing
  point-access function whether the caller may read the parent. The shared page
  engine then loads the caller's membership again to derive the indexed
  discovery lanes used for each child. For a human request this can read the
  same membership twice, but each lookup is a bounded point read. The
  alternative was to teach the collection engine to partially reproduce point
  authorization or to widen the access API around a preloaded membership,
  creating another security-shaped seam solely to save one read.
- **The gap:** The plan required parent point admission and reuse of the page
  engine, but did not say whether their reader setup must share one loaded
  membership object.
- **The reach:** Child-list requests pay a small constant read overhead. Future
  performance work should consolidate it only by extending the existing access
  owner, never by re-implementing parent admission in collection code.
- **Verdict:** **Sound.** One repeated bounded read is cheaper and safer than a
  second authorization owner.
- **Confidence:** Medium.

### The API-facing start seam is an internal-key-gated Convex mutation

- **When:** Bounded subtree sealing (`29ac37bc0`).
- **The choice:** The REST DELETE handler calls a normal Convex mutation
  carrying the server's internal key, matching the existing API-to-
  backend boundary. Scheduled frontier continuation is a separate internal
  mutation that callers outside Convex cannot invoke. Making the start mutation
  internal too would force the API app through a new transport path solely for
  this feature.
- **The gap:** The plan delegated exact function placement and names but did not
  choose the Convex visibility of the start seam.
- **The reach:** The public route uses this mutation through the existing Convex
  client; another private HTTP or action wrapper would duplicate the boundary.
- **Verdict:** **Sound.** It follows the repository's authenticated server-to-
  server convention while keeping background continuation private.
- **Confidence:** High.

### Existing unrestricted discovery callers receive an explicit `any` relationship at their boundary

- **When:** Indexed lineage reads (`901e03151`).
- **The choice:** The low-level indexed selector requires one of three explicit
  relationship variants: unrestricted (`any`), roots (`topLevel`), or one
  parent's direct children (`children`). The older convenience reader, whose
  contract has always meant unrestricted discovery, supplies `any` itself. The
  alternative was an optional relationship field whose absence silently meant
  unrestricted, making `undefined` do two jobs beside the real top-level value
  of an undefined parent ID.
- **The gap:** The plan required a discriminated union but did not specify how
  pre-existing unrestricted helper callers should spell their unchanged intent.
- **The reach:** New selector consumers must choose a relationship deliberately.
  Existing generic discovery tests and maintenance helpers remain simple
  without weakening the selector contract.
- **Verdict:** **Sound.** It preserves one explicit relationship owner and
  removes truthiness/omission ambiguity.
- **Confidence:** High.

### The session access census assigns the new collection to the established collection-read generation

- **When:** Indexed lineage reads (`901e03151`).
- **The choice:** `sessions.children` is recorded under access/wire generation 16,
  beside `sessions.list` and session history. A caller first uses the already-
  established parent point policy, then the existing collection discovery
  policy; this feature adds no new authorization rule. The alternative was
  inventing a new access generation for an endpoint composed entirely from
  established policies.
- **The gap:** The plan required a census entry but did not specify its
  historical census number.
- **The reach:** Future access audits treat direct-child reads as another
  collection projection, not as a new permission family.
- **Verdict:** **Sound.** The census number follows the owners that actually
  authorize and shape the read.
- **Confidence:** High.
