# vm-sync-rail — unified VM sync + self-healing update rail

**Status: shipped to staging 2026-07-15.** This is the rationale record. The
code is the source of truth for *how*; this document is the source of truth for
*why*, and a map into the code. Build history and per-slice plans are gone; the
measured evidence lives in [`assets/proofs.md`](assets/proofs.md).

## What shipped

One recurring request — `POST /v1/vm/sync`, ~5s — is the only VM↔control-plane
channel. Anchors, desired component versions, model credentials, pause state,
and activity acknowledgement all ride that one tick. The three fast-moving
in-VM components (the gateway bundle, `@duetso/agent`, `duetfs`) upgrade — or
roll back — through it with no image rebuild, and a VM can no longer be bricked
by a half-installed release.

The feature exists because of a concrete failure. On 2026-07-15 an old updater
installed a gateway's `index.js` without its `helper.js`; the gateway
crash-looped on EPIPE; the boot guard never fired because the healthy marker
was written on the first heartbeat (before any evidence of health); systemd hit
its start limit and gave up; recovery took a manual ssh. Every structural
decision here is a direct answer to one of those links in the chain.

## Why it works this way

- **The release act is deploying the api, not setting a pin.** The desired
  gateway version is the api deployment's own baked manifest
  (`apps/api/src/gateway/release.ts`, `announcedGatewayRelease()`). There is no
  version pin anywhere — the old `versionPins` table and `pin-gateway-release`
  script are deleted. A pin is a second source of truth that drifts from the
  code that's actually deployed; the 2026-07-15 rollout freeze happened because
  a drifted pin rejected every manifest. Removing the pin removes the drift.

- **Desired CLI versions are exact, and come only from env.**
  `DUET_AGENT_VERSION` / `DUET_DUETFS_VERSION` (typed in `apps/api` config,
  encrypted per environment). Never `latest`, never a range — an env rollback
  must be able to move a fleet *down*, which a semver-forward-only comparison
  silently refuses.

- **The sync response is a complete snapshot, tolerant on read.** Requests are
  strict (`VmSyncRequestSchema`); responses are parsed with unknown fields
  stripped (`VmSyncResponseSchema`), so the server can add payloads — this is
  exactly how shared-apps later added an `apps` array — without a lockstep
  gateway release. `updates` is all-or-nothing: `{paused:true}` or the full
  `{agent, duetfs}` set, never a merge patch, so a paused response cannot leave
  a stale actionable target behind.

- **Persistence is throttled by one pure predicate.**
  `planVmSyncPersistence` (`packages/backend/.../vmSync.ts`) is used by both the
  cacheable read query (write-avoidance) and the mutation (transactional
  recheck), so twelve idle 5s polls per minute produce at most one heartbeat
  write, while activity, version changes, credential needs, and unhealthy
  recovery still persist promptly. The predicate holds even against a buggy
  caller because the mutation re-runs it.

- **The pause default is "not paused."** `vmUpdateControl` is a singleton;
  a missing row means updates flow. The row is an explicit brake a human
  pulls (`scripts/pause-vm-updates.ts`), never an implicit stop. This
  reverses the original fail-closed default (Example User, 2026-07-24): the rail
  is already self-correcting — the release stamp is an equality token, so
  a bad rollout is undone by announcing a fixed release, and a release
  that cannot run is rolled back by the boot health gate — while the
  fail-closed default proved to fail *silently*: neither environment ever
  seeded the row, so both fleets ran with self-updates off and nothing
  surfaced it.

- **Boot health is sustained and release-scoped.** The healthy marker
  (`boot-health.ts`, its only writer) is written once, only after ≥60s uptime
  *and* ≥3 successful syncs, and it blesses only the exact version it names.
  The incident's marker was written on the first heartbeat — a process that
  syncs once and then crashes could reset rollback state forever. Release
  scoping means release A can never bless release B.

- **A crashing release repairs, adopts, or rolls back — it never crash-loops.**
  `gateway-release.ts` owns manifest inspection, verified fetch, atomic
  activation, deterministic `previous`, retention, and quarantine. A stable
  bootstrap (`/opt/duet/bin/gateway-bootstrap.js`, baked into the image, run via
  `ExecStartPre`) validates `current` before systemd executes it and never
  imports current-release code — so a corrupt `index.js` cannot prevent its own
  repair. `StartLimitIntervalSec=0` means systemd never permanently fails the
  unit; the bootstrap's quarantine counter is the circuit breaker instead.

- **One CLI rail, owned by bun.** `runner/npm-rail.ts` stages each exact version
  into its own bun global prefix and swaps an atomic link; agent and duetfs
  share one serialized install queue. The pre-existing agent rail had silently
  no-opped on every VM since launch because the updater mutated npm's global
  tree while the binary lived in bun's — two trees. There is now one.

## Invariants that must keep holding

- `POST /v1/vm/sync` is the **only** recurring control-plane request from a VM.
  A static test asserts no second recurring URL exists in the gateway. The
  gateway already serves an unrelated Syncthing `/v1/sync`; VM-sync modules are
  `vm/sync-client.ts` — never add a plain `sync.ts` to the gateway.
- Register and poll feed the **same** parser and the same directive sink
  (`SyncDirectiveSink` in `runtime/http.ts`): they cannot drift.
- No desired component version lives in Convex. The api owns them (baked
  manifest + env); Convex owns only pause state and observations.
- Anchor identity / marker / inode / move-candidate semantics are unchanged by
  this work — only their transport moved off a dedicated poll onto the sync
  tick. The reconciler (`routes/anchors.ts`, `createAnchorReconciler`) owns no
  fetch or timer.
- `versions.image` is an **identity ref, not a semver** — the provisioner sends
  the ghcr digest verbatim as `DUET_IMAGE_VERSION`. Pinning it to a semver
  regex 400s every sync. (See dead ends.)

## Dead ends and divergences

- **`versions.image` as `ExactSemverSchema`.** The original wire contract typed
  every version field, image included, as exact semver. But the image "version"
  is the ghcr digest ref the provisioner injects, not a semver — so at cutover
  *every* sync 400'd, persistence starved, and the staleness cron flipped fresh
  workspaces unhealthy within two minutes. Fixed to `z.string().min(1)`. This
  is the sharpest lesson of the build: the failure was invisible to every unit
  test (which used semver fixtures) and only the post-cut live e2e caught it.
- **Fail-closed 503 when the baked manifest is unreadable.** Rejected: it would
  couple anchor reconciliation and credential delivery to release-dir health. A
  sync degrades instead — anchors/credentials keep flowing, the updates section
  is empty, and the condition is logged loudly. All-or-nothing update shapes
  prevent partial announcements at the schema level, so 503 bought nothing.
- **Pause hides everything.** Rejected: boot *repair* is availability recovery,
  not an elective rollout, so `gatewayRelease` is announced even while paused.
  Hiding it would turn corruption-during-a-pause into an ssh-only outage.
- **npm as the CLI installer / a second install tree.** Rejected after
  measurement proved bun's global layout supports staged-dir + atomic-link-swap
  on Linux. Two trees were the original defect, not a fallback.

## The cutover, and what it cost

The staging cutover ran fully autonomously (owner-authorized: the fleet was
empty, so there was no blackout and no destructive-cron freeze to stage). It
surfaced and fixed four real bugs the offline gates could not: the
`versions.image` semver pin above; a dropped `stagingLiveLegsPassed` re-export
in the e2e runner; a stale docs-sitemap pin; and a `readlink -f` in the image
verifier that followed the symlink chain past the candidate dir. All four are
fixed in-tree.

Every incident-class failure was then replayed on a live staging VM and
self-healed with no human action: helper deletion (repaired), helper kill
(gateway survived, helper respawned), a fresh crashing release (rolled back +
quarantined), manual version drift (reconciled back up), and drift-under-pause
(held, then converged on unpause). Commands and outputs are in
[`assets/proofs.md`](assets/proofs.md).

## Map into the code

| Concern | Owner |
|---|---|
| Wire shapes | `packages/contract/src/vm/` |
| Desired gateway version | `apps/api/src/gateway/release.ts` |
| Sync composer / endpoint | `apps/api/src/routes/vm.ts` (`composeVmSyncResponse`) |
| Projection + throttle + pause | `packages/backend/convex/domains/workspaces/vmSync.ts`; `vmUpdateControl`; audited operator surface in internal admin (`/v1/internal-admin/vm-updates`); `scripts/pause-vm-updates.ts` as the break-glass when the API is down |
| Sync loop + directive sink | `packages/gateway/src/vm/sync-client.ts`, `runtime/http.ts` |
| Anchor reconciler | `packages/gateway/src/routes/anchors.ts` |
| Release manager + bootstrap | `packages/gateway/src/gateway-release.ts`, `gateway-bootstrap.ts` |
| Boot health marker | `packages/gateway/src/boot-health.ts` |
| CLI rail | `packages/gateway/src/runner/npm-rail.ts`, `cli-update.ts` |
| Boot wiring | `packages/vm-image/` (systemd `StartLimitIntervalSec=0`, baked bootstrap + releases + CLIs) |

Related: shared-apps replica convergence rides this rail's poll — see
[`specs/done/shared-apps`](../shared-apps/MAP.md).
