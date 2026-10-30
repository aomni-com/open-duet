# A workspace IS a VM — rationale record (closed 2026-07-10)

Creating a workspace transparently creates its VM; deleting or retiring it removes the VM.
No caller provisions separately, reasons about VM lifecycle as its own object, or retries
turns issued before boot. Boot stays async: the workspace's `status`
(`provisioning`, `active`, `unhealthy`, `retired`, `deleted`) is the readiness projection a
client watches. The account (a `users` row) owns the money; a workspace carries only a
monthly spend cap (plus its rolling counter and period key). Shipped on `staging` over the
feature range `0561ab4..3c23155` (first feature commit `5685d76`), verified by the
backend/api/model-gateway/mcp/test-harness/contract/gateway suites and a real-exe.dev
smoke (`apps/api/src/provisioning-real-vm.test.ts`).

## Why this shape

- **Id-keyed attach, not slug-keyed.** Slugs are renameable and reusable after deletion;
  binding a VM to a slug was the leak that made "provisioning mints a new workspace" feel
  natural. `ensureWorkspaceVm(workspaceId)` with a VM name derived from the id gives a
  stable 1:1 workspace↔VM relation. Rejected: extending the old slug-adoption branch of
  `beginProvisioning` (deleted outright — nothing was deployed, so no rows to migrate).
- **Birth and attach are separate composable owners.** The old combined create action was
  exactly why signup (row only) and provisioning (row+VM) diverged. Now
  `createWorkspaceRow` births (row + owner membership + audit + trial grant + free-tier
  cap) and `scheduleWorkspaceVm` attaches; signup and the API create both compose them.
- **Eager, on a swappable seam (owner decision F1).** "Exists ⇒ VM exists" is the mental
  model, so birth schedules attach immediately — but every attach goes through the single
  `scheduleWorkspaceVm` helper, so switching to lazy (attach on first VM op) is a
  call-site move, not a redesign. Rejected: lazy-now.
- **Provisioning is a scheduled side-effect of birth, through the action-retrier.** Convex
  mutations cannot call `'use node'` actions inline, and a transient exe.dev blip must
  retry rather than kill the workspace. Bounded backoff, then `unhealthy` + the explicit
  reprovision endpoint as recovery — an attach failure never auto-retires the workspace
  and never retries unboundedly. (Idle retirement is a separate, deliberate cron.)
  Rejected: a separate provision endpoint (the concept being killed), synchronous exe
  calls in mutations, bare `scheduler.runAfter` (fires once, dies on blips).
- **Auth liveness ≠ VM readiness, one field.** Auth/visibility keys off membership +
  liveness (`isLiveWorkspace`: not deleted/retired) so an owner's `provisioning` workspace
  reads as "starting…" instead of 401; API→gateway operations resolved by slug hold on the
  dispatch gate (`gatewayConnectionBySlugImpl`: active + vmName + httpsUrl + nonce, not
  suspended). Rejected: a second `vmStatus` column (more schema churn than loosening the
  filters). Pre-existing parallel connection predicates remain in the vm-token lookup
  (which additionally checks `servicingStatus`) and in the apps/publishes/edge domains —
  a future unification candidate, deliberately not touched here.
- **The API's register/heartbeat handlers own readiness-triggered redispatch.** Agent
  turns issued before boot persist as `dispatched:false` input rows — the queue already
  existed. The register and heartbeat handlers drain it server-side; the client never
  retries. Rejected: a Convex-scheduled drain (turn dispatch and its delivery machinery
  live in `apps/api` with `gatewayClient`; Convex actions reach the gateway only for the
  narrow archive fetch) and client poll-retry (leaky mental model).
- **Account-scoped wallet, two-tier caps (owner decision F2).** Money belongs to the
  human: balance, trial grant, top-ups, Stripe customer, `firstPaidAt` live on `users` —
  the only `creditBalanceMicroUsd` in the schema. Spend authorization is one authority
  checking account floor, account cap, workspace cap, and 402s name the failing tier.
  Rejected: per-workspace wallets (the money would fragment across VMs the user thinks of
  as one account).
- **Workspace capacity belongs to the payer's live plan.** Eager provisioning makes
  every workspace a billable VM, so birth and billing transfer share one payer-indexed
  capacity gate. A missing or lapsed subscription uses Starter capacity; deleted and
  retired workspaces release a slot while archived workspaces retain one.

## Single-owner invariants (violating any of these is a regression)

| Concept                                                                          | The one owner                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workspace birth (row + membership + audit + grant)                               | `domains/workspaces/birth.ts:createWorkspaceRow` — the repo's only `ctx.db.insert('workspaces')`                                                                                                                                                                                                                                                                                                                                                                                        |
| Workspace creation capacity                                                         | `domains/workspaces/birth.ts` — checks the creator’s live memberships only when creating a workspace                                                                                                                                                                                                                                                                                                                                                                                                |
| VM attach (sole `ExeClient.create`; sole `DUET_VM_IMAGE_REF` reader for creates) | `domains/workspaces/vmAttach.ts:ensureWorkspaceVm` — id-keyed, idempotent, reconciles against `exe.list` before creating                                                                                                                                                                                                                                                                                                                                                                |
| Attach trigger (the eager/lazy seam)                                             | `domains/workspaces/vmSchedule.ts:scheduleWorkspaceVm` — the only `retrier.run(ensureWorkspaceVm)`; callers: signup, API birth, and the teardown-complete hook that chains reprovision                                                                                                                                                                                                                                                                                                  |
| Teardown of a workspace's recorded VM                                            | `domains/workspaces/vmTeardown.ts:removeVmForWorkspace` — shared by delete, retire, idle-retire, reprovision, expired-generation cleanup. Two deliberate removes exist outside it: attach cleans up its own just-created, never-recorded VM when the workspace was deleted mid-attach (`vmAttach.ts`), and snapshot pruning removes snapshot copies (`provisioningActions.ts`) — neither touches a recorded live VM                                                                     |
| Durable one-shot scheduling                                                      | the shared `retrier` (`convex/utils.ts`, `@convex-dev/action-retrier`) — lifecycle actions never use bare `scheduler.runAfter`; fleet-wide sweeps stay crons (`convex/crons.ts`)                                                                                                                                                                                                                                                                                                        |
| Auth liveness predicate                                                          | `domains/workspaces/authorization.ts:isLiveWorkspace`, enforced centrally in `assertRole`/`assertActorRole` (explicit opt-outs: repeat delete, terminal audit reads) and via `apiKeys/model.ts:liveWorkspaceBySlug`. `queries.ts:listMine` deliberately lists `retired` workspaces (restorable) and hides only `deleted`                                                                                                                                                                |
| Dispatch gate for slug-resolved VM ops                                           | `vmToken.ts:gatewayConnectionBySlugImpl`                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Readiness-triggered redispatch                                                   | `apps/api/src/agent-runner.ts:drainWorkspaceOnRegister`, called from the register AND heartbeat handlers (`routes/vm.ts`)                                                                                                                                                                                                                                                                                                                                                               |
| Spend authorization                                                              | `domains/credits/creditsShared.ts:authorizeSpend` — account floor + account cap + workspace cap; reservations/settlement debit the workspace's designated payer (`workspace.billingUserId`, resolved by `billingUserForWorkspace` — added post-close, `fe73fb4`) and roll both monthly counters; the acting user is recorded as `actorUserId` for attribution                                                                                                                           |
| Account wallet + trial grant                                                     | `users` row via `domains/credits` (`grants.ts` — once per canonical email, globally idempotent)                                                                                                                                                                                                                                                                                                                                                                                         |
| Bun on PATH for the gateway service                                              | the `Environment=PATH=` line in `packages/vm-image/systemd/duet-gateway.service` — systemd inherits neither Docker ENV nor `/etc/profile.d`, so the unit must set it or gateway-spawned tools (`duet`, npm self-heal) vanish on a fresh VM. Pinned with a Dockerfile-drift test in `packages/vm-image/src/vm-image.test.ts`. (A code-level `childEnv` shim shipped first, then was removed as redundant once the unit line existed — pre-launch, the image is the only deployment unit) |

Further invariants:

- **VM tokens rotate per VM generation.** The nonce is minted at attach (retry-idempotent),
  register derives the token from it, and teardown clears it — a new attach means a new
  token. Rotation across reprovision is pinned in `apps/api/src/index.test.ts` (reprovision
  flow); nonce clearing is pinned in `packages/backend/src/vm-teardown.test.ts`.
- **Attach and teardown are crash/retry-safe.** Attach reconciles the deterministic VM name
  against `exe.list` before creating (no orphan on crash-between-create-and-record) and
  removes the VM it just created if the workspace was deleted mid-attach; teardown skips
  removing an already-gone VM and always clears the row (generation-guarded). A 5-minute
  cron (`sweepLeakedWorkspaceVmTeardowns`) reschedules teardown for deleted/retired rows
  still carrying a `vmName`, so retrier exhaustion during an exe outage cannot leak a VM
  permanently.
- **Hold-everything while `provisioning`.** Agent turns queue (`dispatched:false`) and
  drain on readiness; train returns `409 workspace_provisioning` before creating a job;
  shares are metadata-only and unaffected. The dispatch gate enforces the hold — no
  per-route special-casing.
- **Firewalls preserved over the feature range** (verifiable:
  `git diff 0561ab4..3c23155` shows no wire-shape change): the register/heartbeat/vmToken
  exchange (`routes/vm.ts`, `domains/workspaces/provisioning.ts`, gateway
  `vm/phone-home.ts`), the delivery/seq machinery (`attemptId`/`throughSeq`, `seq`, the
  `dispatched:false` 201 contract, the 10-delivery drain limit in `agent-runner.ts`), and
  snapshot behavior.
- **Deploy precondition:** `DUET_VM_IMAGE_REF`, `DUET_API_URL`, `EXE_TOKEN` must be set on
  the Convex deployment — attach resolves them Convex-side, not from an API request, and
  `ensureWorkspaceVm` throws loudly when unset. All three are routed to Convex by
  `scripts/secrets-push.mjs` (`convex: true`); a push must precede relying on them.

## Divergences from the plan (recorded so nobody re-derives them)

- **The trial grant did not move to the account in Slice 2** as the plan said: the account
  wallet didn't exist yet and preflight still read the workspace balance, so moving the
  grant early would have 402'd every fresh signup. It moved atomically with the wallet in
  Slice 7 (`ce5ea96`). The grant's idempotency is per canonical email, globally — which
  in practice bounds it per account and also across duplicate accounts sharing an email.
- **Register reuses the attach-minted nonce** instead of minting fresh per register (the
  old behavior). The plan said "attach mints the nonce"; the consequence — teardown MUST
  clear it or tokens never rotate — was discovered in review and is now the rotation
  invariant above.
- **The drain trigger needed the heartbeat, not just register.** The gateway installs its
  vmToken only after reading the register response, so a register-time drain 401s on first
  boot. The heartbeat handler retriggers the same idempotent drain once the token is live.
- **One retirement sweep archives many workspaces.** Pre-spec only explicitly provisioned
  workspaces had VMs; eager birth gave the signup workspace one too, exposing that the
  exe archive key label was unique only per sweep timestamp (account-wide 422 collision).
  Labels are per-VM now (`3c23155`). Found by the real-VM smoke, not the unit suites.
- **Fixture blast radius:** deleting the public `create` mutation and the slug-adoption
  path required migrating every test fixture in backend/api/model-gateway/mcp to
  internal-key-gated testing mutations that exercise the real birth path
  (`convex/testing/workspaces.ts`). Neither the mcp nor the model-gateway app suite was in
  any slice's verification loop: model-gateway's stale fixture surfaced at the Slice 7
  merge (`ef0c066`), mcp's only at the closing full-diff review (`b8a96d9`).

## Accepted risks (deliberate — none introduced as new policy by this feature)

- Post-response billing authorizes without reserving, so concurrent requests can pass the
  same caps before their settlements debit; settlement itself does not reauthorize — the
  next preflight observes the lowered balance and blocks. Inherent to post-response mode.
- Reservation settlement true-up above the estimate doesn't reauthorize the excess (the
  documented reconcile path, pinned in `packages/backend/src/model-gateway.test.ts`).
- Reprovision (`POST /v1/ws/:slug/reprovision`, exposed to workspace owners with the admin
  scope) checks active sessions/jobs in its plan but not again after its archive step —
  work started during the archive can be torn down.
- The register/heartbeat drain respects the existing 10-delivery cap; an 11th pre-boot
  turn waits for the next heartbeat drain or user action (pinned in
  `apps/api/src/index.test.ts`).

## Defect found by the smoke, fixed separately (outside this feature's surface)

The closing real-VM smoke exposed that files uploaded through the files API read back
`416 / Content-Range: bytes */0` after a VM restart, while ssh-written files survived.
Root cause (pre-existing, not this feature): uploads were staged in the state dir and
renamed into the drive with no fsync — on a hard VM reset, ext4 delayed allocation leaves
the renamed file zero-length, which no process-restart test can reproduce. Fixed in
`ec61c8b`: staging moved to the drive's reserved `.duet/uploads` (same filesystem,
invisible to the files API), and PUT fsyncs the file, renames atomically, and fsyncs the
directory chain before acknowledging. Verified on a real VM: the previously red
after-restart leg of `apps/api/src/provisioning-real-vm.test.ts` now returns 206 with
exact bytes.

## Where the behavior is pinned

- Unit/integration: `packages/backend/src/vm-attach.test.ts` (idempotency, image-ref
  contract, crash reconcile, rename-proofness, delete-mid-attach cleanup),
  `src/vm-teardown.test.ts` (idempotent teardown, double delivery, nonce clearing),
  `src/provisioning.test.ts` (teardown leak sweep), `src/action-retrier.test.ts`
  (retry + exhaustion semantics), `src/auth-workspaces.test.ts` (birth values, free-tier
  cap, liveness), `src/api-keys.test.ts` (provisioning resolves, terminal statuses don't,
  dispatch split), `src/credits.test.ts` + `src/billing.test.ts` +
  `apps/model-gateway/src/index.test.ts` (account wallet, two-tier 402s, resets),
  `apps/api/src/index.test.ts` + `apps/api/src/workspace-create-failure.test.ts`
  (fire-and-forget create, drain on register/heartbeat, delivery cap, reprovision nonce
  rotation, exhaustion → unhealthy).
- Real world: `apps/api/src/provisioning-real-vm.test.ts` (env-gated: `EXE_TOKEN` +
  `DUET_REAL_VM_IMAGE_REF`). The closing smoke run observed (logged, not asserted):
  create returned 15s, `active` 25s, unhealthy detection, restart recovery 47s, idle
  retirement marked the workspace retired at 120s; exe-side VM removal is pinned by the
  teardown owner's unit tests (the e2e run's pool cleanup masks it).
  `packages/test-harness/src/demo-60s.ts` drives the transparent create→run flow.
