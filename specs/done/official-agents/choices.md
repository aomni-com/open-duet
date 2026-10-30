# Choices ledger — official-agents (consolidated)

Every decision made where the spec was silent, re-audited against the
final shipped code. Ranked least-confident first: the entries at the top
are yours to confirm or overturn; the Sound section is the record of calls
already settled by evidence.

## Provisional — yours to confirm

- **Seed agent editorial content** — the golden workspace ships three
  provisional agents (Research Assistant, Data Analyst, Writing Editor;
  changelogs start at "Initial release"), authored by Codex in
  `packages/official-agents-seed/`. The spec reserves editorial approval
  for you (open question 2). Review before the prod seed.
- **Share-pause authority** — either ACTIVE participant can flip the one
  shared pause bit (drafts' consensus; Syncthing folder pause is
  folder-global). The spec notes you may narrow this to origin-only (open
  question 3); the seam is one authz check in `setSharePaused`.
- **Onboarding partial failure defers to the hub** — a rare install
  collision during onboarding (fresh workspace) flags the card and points
  at the Agent hub instead of offering the rename prompt inline. Chosen on
  rarity + the hub affordance existing; revisit if telemetry shows
  collisions.
- **Snapshot-leak residual** — a publish paused then resumed within the
  60s resume grace, and never paused again, keeps one orphaned snapshot
  (≤512 MiB) in gateway state. All ordinary pause/resume/delete cycles
  reap fully; closing the residual would need a scheduler no rail
  currently owns.
- **Lander visual family excluded from the strict gate** — the lander
  suite (and, under full-suite load, the web scene loop) has a
  pre-existing nondeterministic render flake in this Docker environment:
  0–2 rotating pages fail per `--all` run at ≤0.03 diff ratio. Lander
  baselines stay at staging's canonical state; scoped family checks (all
  deterministically green) are the enforced gate. The flake predates this
  spec and deserves its own investigation.

## Sound — settled by evidence

Contract & naming
- Golden owner is `user@example.invalid` in every environment (Example User,
  2026-07-22) — now the `config.ts` default, so staging and prod both get
  it with no env work; `DUET_OFFICIAL_HUB_OWNER_EMAIL` remains the per-env
  override. The seed still refuses to run until that account exists in
  the target deployment.
- `formatSyncConflictName(path, at, device, collision?)` owns the entire
  conflict-name grammar in the contract (pure strings — the contract must
  load in the Convex isolate); the enforcer and materializer both consume
  it, filesystem probing stays with callers.
- `OfficialAgentNameSchema` reuses `AppSlugSchema` — one slug grammar.
- Pull reports and mutation errors are strict discriminated unions;
  impossible states are unrepresentable on the wire.
- Install accepts an optional rename-on-collision path (contract → api →
  backend); omitted still means canonical `agents/<name>`. A renamed
  install remains a subscription — clone is not the rename escape hatch.
- The puller's archive bounds alias the contract's
  `MAX_RECURSIVE_FILE_*` serving bounds — one limit owner for both rails.

Materializer & puller
- Quarantine + journal live under gateway `stateDir` (same-filesystem
  checked); live inodes are never unlinked — rename-into-quarantine,
  hash-checked sweep to conflict copies, grace-period reap with a final
  pre-unlink re-hash (documented microsecond residual, no weaker than
  Syncthing's own replace race). Five concurrency probes pin losslessness.
- `reapBefore` externalizes the reap grace (the puller passes its previous
  success time); no wall-clock reads inside the engine.
- 304 with a missing cached snapshot is typed `cached_snapshot_missing`;
  the materializer's conservative manifest-loss default covers divergent
  local content. A pull superseded by uninstall/reinstall aborts typed.
- Delegated knobs: SHA-derived ±10% hourly jitter, 5s→5min backoff,
  `official-agent-subscriptions.json` + per-subscription `snapshot.zip`.

Backend
- Contained app rows exist from install but stay disabled until the first
  applied-ETag report ("no rows pretending files exist" at the process
  boundary); the reseed re-enables them on every applied advance —
  official rows converge to golden rows by design, including over a
  user's manual disable of a still-subscribed app.
- Stale pull reports reject per item (`rejectedStaleSubscriptionIds`) —
  no head-of-line blocking of the sync rail.
- The `officialAgents` vm-sync field is omitted until the `officialHub`
  row exists; the synchronous install push carries the same projection
  via the vmTokenHash-authenticated `desiredForVm` query (whole-spec
  review caught the empty-body push; the fixture gateway now enforces the
  real parse).
- Onboarding eligibility defaults on in `bootstrapUser` and is suppressed
  at every programmatic/impersonation call site; owner-only idempotent
  clear; per-name typed failures; one gateway push only when an install
  succeeded.
- Official ownership has one detach transition shared by explicit uninstall
  and generic agent deletion. The transition releases agent/app ownership and
  revokes app credentials in the same Convex transaction, so deleting from the
  normal agent rail cannot strand a live subscription.

Publish freeze & share pause
- Snapshot-before-visible ordering is unbypassable: `setPublishPaused` is
  internal-key-only and pins the exact snapshotted publish id (a
  delete/recreate race refuses). Missing/corrupt shadow while paused →
  503 `publish_snapshot_unavailable`, never live bytes.
- One JSON `x-duet-publish-freeze` header carries publish id +
  generation; snapshots keep the anchor's drive-relative namespace so
  `serveDriveGet`/`serveDriveZip` stay the policy owners for frozen
  content; zip and snapshot share the one extracted subtree walker.
- Resume/delete GC: `keepGeneration` optional — absent reaps every
  generation past the 60s edge-cache bound (review finding P2).
- Pause/resume and freeze/resume write audit events on transitions only;
  retries preserve the original timestamps.
- A share reports `paused` only after Syncthing config read-back; a
  mismatch is a typed error, never the intended state. The SPA projects
  `paused` only when BOTH VMs report it for current generations.
- Inactive shares refuse pause with 409 `share_not_active`.

Zip audit
- `recordServedPath` rejects all serving-floor paths; zip rows carry an
  additive `kind` and a distinct `publish.new_zip_served` event; same-path
  dedup ignores kind (the audit answers "was this path ever served").

Golden workspace
- Seed orchestration is beginSeed → gateway file writes → completeSeed
  with a singleton run ledger: re-runs converge, races pick one winner,
  mid-run failures resume. The deterministic-bundle primitive moved to
  one owner (seed-drive delegates; byte-stability oracle unchanged).
- Admin access mints through the existing `mintImpersonationKey` (1h TTL)
  behind existing internal-admin gating; the web proxy installs the
  session cookie only on a 200 from that exact route.

Web
- The spec's Overlaps section was stale — agents-ui had shipped; the SPA
  transport extends the live agents query namespace (one query owner).
  A successful install response crosses the existing report boundary before
  returning: the gateway reports what it materialized, the API applies that
  report through the backend's one state owner, and the SPA then awaits both
  subscription and roster refresh. Failed commands refresh the same durable
  projections. Autonomous pulls continue to use the VM report outbox; the
  browser never becomes a second settlement owner through interval polling. A
  generic agent delete refreshes both projections because it may also detach
  official ownership.
  Acknowledge/uninstall refresh subscription state only. Clone-to-own remains
  on the external API, not in the gallery UI.
- An active subscription with an unread update reads `update-ready` —
  the status text and the badge can never contradict (critique finding,
  folded into the projector with the durable ETag rule).
- `workspace-tabs.ts` is the one tab-strip owner (critique root cause:
  the bootstrap shell carried a stale four-tab list that also leaked into
  scene captures); the pre-hydration five-tab contract is test-pinned.
- The drive-root section is a narrow installed-official summary behind
  its own query boundary with its own status projector; failures degrade
  the section, never the files surface.
- Onboarding install reservations survive VM provisioning; Continue stays
  enabled while installs run (the durable-reservation design).

Test infrastructure (rode along, repo-wide)
- `service-proxy.test.ts` clock tracks real time (the subscription-expiry
  cron expired the epoch-based fixture — pre-existing staging red).
- `markWorkspaceLiveForTest` stores the derived `vmTokenHash` like real
  registration, so hash-authenticated internal queries work in tests.
- Docs example registry gained `SetPublishPausedRequestSchema` (the docs
  content gate was red without it).
