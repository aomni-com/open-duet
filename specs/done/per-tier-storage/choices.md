# Choices ledger — per-tier-storage (consolidated, final)

Every decision the implementing agents made where the spec was silent,
re-audited against the final shipped code. Grouped by verdict; within each
group the least-confident entry comes first. This ledger — not the diff —
is the review surface for what was decided without you.

## Review these first — presented to Example User 2026-07-23

1. The subscribe wall's founder note is gone (needs-user; presented in the
   handback, no objection raised — the provisional removal stands).
2. Storage-full refusals land the session in `interrupted` (Example User reviewed
   the what-the-user-sees walkthrough; confirmed).
3. The upgrade CTA is suppressed when the next tier wouldn't grow retained
   storage (Example User offered "always show" as a simplification; kept after the
   trade-off review — identical behavior outside the downgrade edge case,
   and the edge case's CTA would sell a paid step that grows nothing).

## Needs-user (provisional call applied; reversible)

- **Founder note removed from the wall.** The wall's signed note ("Your
  workspace is a real dedicated VM — that's why it can't stay free.
  Everything you made is saved, right where you left it. — Example User") ended in
  exactly the retention promise D6 kills, and the MAP's taste notes say
  decommission copy stays unceremonious — so the whole blockquote was
  removed, and the plain shutdown sentence stands in red below the wall
  body. The unbuilt alternative keeps the first sentence + signature for
  founder voice. **Provisional:** removed. **Reverse:** re-add the trimmed
  blockquote and two catalog keys (en + es-419). **Confidence:** medium.

## Sound — medium confidence (uninstructed semantics; correct, but yours now)

- **A storage-full refusal terminalizes the session to `interrupted`.**
  Slice 06 delegated "idle vs terminalized after refusal" and recommended
  idle. The whole-spec review found pure idle left the projection wedged: a
  refused input kept the session `running` forever (no runner, no terminal
  event), and a refused scheduled wake kept it `sleep` with its wake
  deleted. Final state: the backend recognizes the typed `storage_full`
  system event (by code, never copy — firewall 2) as terminal-family and
  settles the session to `interrupted` — the established retryable state,
  so the user deletes files and prompts again in-session, which is what
  "idle" was meant to buy. One owner: `terminalStatus` in
  `agentSessionsShared.ts`.
- **The upgrade CTA exists only when it grows storage.** A downgraded payer
  retaining a larger disk (D4) can already have the next tier's usable
  space — e.g. Starter keeping a 58GB disk has 50GB usable, and "Upgrade →
  50 GB" would sell nothing. `projectWorkspaceStorage` suppresses
  `nextPlan`/`nextUsableGb` unless the next tier's storage exceeds current
  usable; the UI stays dumb. Max never shows a CTA (unchanged).
- **The tier ladder for `nextPlan` lives in the backend projection**, not
  contract (slice 08 said "contract"). The binding half — server derives,
  UI never reimplements — holds; contract has no plan-ordering concept and
  a three-line private helper didn't justify a new export. Promote it if a
  second consumer appears.
- **Teardown's residual-state detection widened.** Detection and clearing
  now share one owner (`CLEARED_WORKSPACE_VM_FIELDS`), which makes
  `syncthingDeviceId` (and the new `vmDiskGb`/`vmResizeRunId`) count as
  residual VM state — before, a workspace whose only leftover was a
  syncthing id skipped cleanup. Symmetry is the safer behavior; the two
  hand-kept lists had already drifted exactly this way.
- **`convex codegen` uploads functions.** Running it (the repo's only
  codegen path) against the staging deployment pushed in-flight worktree
  code ahead of merge twice during the build. Additive schema only, staging
  is wiped at cutover, and the next deploy from the staging branch closes
  the drift — but the side effect is real and worth knowing.
- **No "workspace restarted to add storage" timeline line** (README flag
  recommended yes). The session-event seam requires one specific writable
  session; no workspace-level timeline target exists, and inventing one was
  out of scope. The restart is observable via `workspace.vm_disk_resized`
  audit events. Say the word and it becomes a small feature with a real
  seam design.

## Sound — high confidence

- **Probes:** the slice-00 script exits nonzero if *any* verdict goes
  unmeasured (a kill gate that can pass silently isn't a gate); `du` cost
  is timed inside the VM (the first run's SSH setup dwarfed the real scan
  ~2.8s vs ~0.2s and would have inflated the 100GB model several-fold);
  one VM serves all five verdicts and the blip reboot doubles as the
  share-survival reboot (the only reboot the upgrade rail performs);
  health = unauthenticated `GET /healthz` (the gateway's one allowlisted
  route — slice 10's legs reuse the signal); probe VM uses production
  cpu/memory caps; the retained report never serializes the staging
  account's VM inventory (first run leaked all 18 VMs into git).
- **Birth records realized capacity on reattach.** When attach finds an
  existing VM (crash-window), the row records the lobby's
  `disk_capacity_bytes` (GiB), not the desired size — a downgraded payer's
  kept 58GB VM must not be recorded as 28 or the meter denominator lies
  (S3). Growth's counterpart: when the lobby already exceeds the newly
  desired size, the action restarts and records realized GiB.
- **The resize action awaits its restart** — one retried action owns the
  whole crash-window state machine; restart-throw-after-resize still
  records (the disk *is* bigger; monthly retries converge, D8).
  `vmResizeRunId` is VM-lifecycle state and clears with the shared
  fragment.
- **Reserve guard covers every runner-spawn door** — fresh input, scheduled
  wake, and (whole-spec review fix) an answer to a session at an `ask`
  checkpoint, which previously bypassed the guard entirely. A turn that is
  actually running is never refused (D14). (Historical note: this entry
  predates the 2026-07-30 terminal-means-terminal ruling — there are no
  parked runners anymore; answers hydrate through the ordinary no-runner
  door. See `packages/gateway/README.md`.)
- **Drive telemetry:** 5-minute sampler TTL (matches backend admission; the
  walk is ~178ms at 10GB, so shorter buys nothing); a cold read returns
  `undefined` and warms in the background — the first sync sample after
  boot simply lacks the field, which the old-gateway tolerance already
  forces consumers to handle.
- **Archive streams into a 0600 temp artifact behind the byte limiter**
  rather than piping tar straight into the response — a typed 413 must
  happen before any body byte; cost is ≤1GiB transient tmpdir, cleaned on
  success/abort/disconnect.
- **Test fixtures never mutate the shared owner's billing.** Tests needing
  trial/pro/max payers sign in a dedicated user and reuse its auto-created
  workspace (fresh unpaid owners may hold exactly one). Codex's first two
  attempts poisoned whole files through the shared fixture user; the
  pattern is now the template.
- **Storage copy lives in next-intl catalogs** (`duetStorage` namespace),
  helpers take injected translators; D6's sentence is sentence-cased with
  a period as a standalone line ("Your workspace and all its files will
  shut down in 7 days.") in en and es-419, pinned by tests.
- **The edge paused page does NOT carry D6 copy.** The slice's sweep list
  named its playground, but that surface addresses *viewers of a published
  app* — "Your workspace…" is the owner's sentence, and production has no
  retention promise to replace. Mirror stays equal to production.
- **Harness legs:** the upgrade leg tolerates a 30s blip (probe measured
  9.5–9.9s; margin for staging variance); `storage-tier-resize` is
  registered **optional** (Example User confirmed 2026-07-23); the
  downgrade leg asserts zero new resize-audit events over a 30s window plus
  retained 58GiB.

## Trivial discretion (visible in code, no reach)

Probe timeouts and payload shapes; audit-event names; fake-exe 422 copy;
MiB↔bytes conversion helpers; fixture naming; toast layout details; two
billing fan-out tests carry explicit timeouts (they build 50 workspaces and
exceed bun's 5s default under full-suite load).

## Observations banked for later (no action)

- es-419 mixes the dominant "workspace" loanword (33 uses — new strings
  follow it) with two older "espacio de trabajo" outliers; unifying is a
  separate copy pass.
- Pool economics: every VM burns ~7.2GB of the consumption pool by
  existing. Known issue, already on exe.dev's roadmap (Example User, 2026-07-23);
  decommission is the mitigation — no email needed.
