Marker: `SUBSCRIPTION-LANDMINE-SWEEP-2026-07-17`

### 1. PAUSE AGES INTO TERMINAL RETIREMENT

**EVIDENCE** — Idle retirement runs hourly, selects every lifecycle-`active` workspace older than seven days without considering `servicingStatus`, then unconditionally marks it `retired` and schedules VM teardown: [crons.ts:14](/Users/synthetic-user/dev/duet/packages/backend/convex/crons.ts:14), [provisioningCore.ts:109](/Users/synthetic-user/dev/duet/packages/backend/convex/domains/workspaces/provisioningCore.ts:109), [provisioningCore.ts:218](/Users/synthetic-user/dev/duet/packages/backend/convex/domains/workspaces/provisioningCore.ts:218). Retired workspaces fail normal liveness and VM attachment: [authorization.ts:17](/Users/synthetic-user/dev/duet/packages/backend/convex/domains/workspaces/authorization.ts:17), [vmAttachModel.ts:42](/Users/synthetic-user/dev/duet/packages/backend/convex/domains/workspaces/vmAttachModel.ts:42).

**WHY IT BITES** — Pausing an already-idle workspace can make the next hourly cron permanently retire and tear it down. A later paid invoice changing only `servicingStatus` cannot restore lifecycle `status: 'retired'`. There is also a TOCTOU window: retirement candidates are read before archiving, while `markRetiredImpl` does not recheck activity, lifecycle status, or servicing state, so renewal/activity racing the action can still lose.

**WHAT IT CHANGES** — D8 / slice 07 must define paused-workspace idle policy and make retirement conditional at commit time. Slice 12 needs pause-past-idle-threshold → renewal → original workspace usable.

### 2. `servicingStatus: paused` DOES NOT CLOSE THE WORKSPACE DATA PLANE

**EVIDENCE** — Slug-based gateway resolution checks lifecycle status and suspension but ignores `servicingStatus`, then returns the VM bearer: [vmToken.ts:26](/Users/synthetic-user/dev/duet/packages/backend/convex/domains/workspaces/vmToken.ts:26), [vmToken.ts:53](/Users/synthetic-user/dev/duet/packages/backend/convex/domains/workspaces/vmToken.ts:53). The API caches successful resolutions for 15 seconds: [client.ts:449](/Users/synthetic-user/dev/duet/apps/api/src/gateway/client.ts:449), [config.ts:77](/Users/synthetic-user/dev/duet/apps/api/src/config.ts:77). That bearer [REDACTED] all gateway routes except `/healthz`: [http.ts:466](/Users/synthetic-user/dev/duet/packages/gateway/src/runtime/http.ts:466), [http.ts:536](/Users/synthetic-user/dev/duet/packages/gateway/src/runtime/http.ts:536).

**WHY IT BITES** — Files, memory, apps, publishes, sync, tunnels, train, and agent gateway calls remain reachable after the database flip. Even after adding the missing serviceability check, cached connections remain usable for up to 15 seconds, contradicting “immediately.”

**WHAT IT CHANGES** — D8 / slice 07 needs a data-plane enforcement seam and cache invalidation or a deliberately accepted bound. Slice 11’s wall alone is not enforcement.

### 3. A MID-RUN PAUSE ORPHANS DUET-AGENT SESSIONS

**EVIDENCE** — The local controller starts and retains runners without any servicing-state input: [process-runner.ts:286](/Users/synthetic-user/dev/duet/packages/gateway/src/runner/process-runner.ts:286). Canonical events are relayed before terminal cleanup occurs: [process-runner.ts:301](/Users/synthetic-user/dev/duet/packages/gateway/src/runner/process-runner.ts:301). Relay authenticates through `gatewayConnectionByVmToken`, whose serviceability check rejects paused workspaces: [agent.ts:407](/Users/synthetic-user/dev/duet/apps/api/src/routes/agent.ts:407), [vmToken.ts:63](/Users/synthetic-user/dev/duet/packages/backend/convex/domains/workspaces/vmToken.ts:63).

**WHY IT BITES** — The local process is not interrupted, but its next canonical/terminal event receives 401. Because terminal cleanup happens after the awaited relay, the backend session can remain `running`/`ask`, the terminal event is not durable, and the local runner map is left stale until later cleanup.

**WHAT IT CHANGES** — D8 / slices 07 and 11 need an explicit session policy—interrupt, freeze, or allow completion—and a paused-safe terminalization path. Slice 12 must pause during model output, tool execution, and `ask`.

### 4. `updates.paused` IS A GLOBAL RELEASE-ROLLOUT SWITCH, NOT WORKSPACE PAUSE

**EVIDENCE** — The repo documents this pause as proactive VM component activation control: [apps/api/README.md:33](/Users/synthetic-user/dev/duet/apps/api/README.md:33). Backend VM sync reads it from the singleton global `vmUpdateControl` row: [vmSync.ts:178](/Users/synthetic-user/dev/duet/packages/backend/convex/domains/workspaces/vmSync.ts:178). Gateway desired state uses it only to suppress agent/duetfs/gateway activation: [desired-state.ts:49](/Users/synthetic-user/dev/duet/packages/gateway/src/desired-state.ts:49), [desired-state.ts:93](/Users/synthetic-user/dev/duet/packages/gateway/src/desired-state.ts:93).

**WHY IT BITES** — Reusing this apparently convenient `paused` bit for D8 would either pause updates globally or merely suppress component activation while leaving the workspace running. It cannot represent per-workspace servicing.

**WHAT IT CHANGES** — Slice 00/07 needs a distinctly named per-workspace VM directive if gateway-local behavior must change. Do not overload `VmUpdatesSchema`.

### 5. PAUSED VMs KEEP RECEIVING AND APPLYING NORMAL SYNC STATE

**EVIDENCE** — VM-token sync lookup rejects only deleted/retired workspaces, not paused ones: [vmSync.ts:441](/Users/synthetic-user/dev/duet/packages/backend/convex/domains/workspaces/vmSync.ts:441). The projection still returns anchors, apps, and share sync: [vmSync.ts:165](/Users/synthetic-user/dev/duet/packages/backend/convex/domains/workspaces/vmSync.ts:165). Gateway applies anchors, reconciles apps, and accepts share directives on every response irrespective of servicing: [http.ts:355](/Users/synthetic-user/dev/duet/packages/gateway/src/runtime/http.ts:355).

**WHY IT BITES** — A paused workspace continues app supervision and Syncthing/share convergence. Mid-sync, nothing observable changes locally. **Inference:** if D8’s “subscription required to use Duet” includes syncing shared data or running apps, this is an enforcement bypass.

**WHAT IT CHANGES** — D8 / slice 07 must explicitly decide which local subsystems stop, drain, or continue. Slice 12 needs mid-sync and mid-app-reconcile cases.

### 6. A LAPSED SUBSCRIBER CAN CREATE A FRESH ACTIVE WORKSPACE

**EVIDENCE** — Workspace creation permanently bypasses the one-workspace gate once `firstPaidAt` exists: [birth.ts:36](/Users/synthetic-user/dev/duet/packages/backend/convex/domains/workspaces/birth.ts:36). New rows omit `servicingStatus`, which consumers interpret as active, and immediately schedule VM provisioning: [birth.ts:72](/Users/synthetic-user/dev/duet/packages/backend/convex/domains/workspaces/birth.ts:72), [queries.ts:106](/Users/synthetic-user/dev/duet/packages/backend/convex/domains/workspaces/queries.ts:106).

**WHY IT BITES** — `firstPaidAt` remains set after lapse by design. After the entitlement flip has already been reconciled, a lapsed subscriber can create another workspace that is born serviceable and provisions a VM; no later entitlement event is guaranteed to revisit it.

**WHAT IT CHANGES** — Slice 07 must reconcile at workspace birth or write the computed servicing state atomically during insertion. Add a post-lapse creation case to slice 12.

### 7. BILLING-USER REASSIGNMENT DOES NOT RECOMPUTE SERVICING

**EVIDENCE** — `setBillingUser` validates the new owner and patches only `billingUserId` plus `updatedAt`: [mutations.ts:213](/Users/synthetic-user/dev/duet/packages/backend/convex/domains/workspaces/mutations.ts:213). The schema’s `by_billing_user` index makes payer identity the intended reconciliation key: [schema.ts:203](/Users/synthetic-user/dev/duet/packages/backend/convex/schema.ts:203).

**WHY IT BITES** — Moving a workspace from an active payer to a lapsed payer leaves it active; moving a paused workspace to an entitled payer leaves it paused. It remains wrong until an unrelated entitlement event or sweep happens.

**WHAT IT CHANGES** — Slice 07 must make billing-user reassignment invoke the reconciler in the same mutation and test both directions.

### 8. THE SUBSCRIBE WALL’S PROPOSED ACCOUNT SOURCE IS WRONG FOR SHARED WORKSPACES

**EVIDENCE** — Slice 11 says wall state comes from the current account’s slice-08 billing overview: [11-entitlement-walls.md:52](/Users/synthetic-user/dev/duet/specs/monthly-subscriptions/slices/11-entitlement-walls.md:52). Workspaces can have another owner as billing user, and `listMine` already projects both `billingUserId` and workspace `servicingStatus`: [mutations.ts:224](/Users/synthetic-user/dev/duet/packages/backend/convex/domains/workspaces/mutations.ts:224), [queries.ts:19](/Users/synthetic-user/dev/duet/packages/backend/convex/domains/workspaces/queries.ts:19).

**WHY IT BITES** — An active subscriber viewing a workspace paid by a lapsed co-owner would see no wall over a paused workspace. Conversely, a lapsed member could be walled out of a workspace funded by an active payer.

**WHAT IT CHANGES** — Slice 11’s API seam must derive wall state from the workspace payer or authoritative workspace servicing projection, not solely the viewing user’s overview.

### 9. EDGE RESOLUTION ERASES THE REASON NEEDED TO RENDER A PAUSED PAGE

**EVIDENCE** — The success contract contains only workspace/origin descriptors and no paused discriminant: [edge/index.ts:70](/Users/synthetic-user/dev/duet/packages/contract/src/edge/index.ts:70). Convex currently emits suspension as HTTP 403: [http.ts:57](/Users/synthetic-user/dev/duet/packages/backend/convex/http.ts:57). Edge maps every resolver 403 to generic `forbidden` without reading its body; tests pin this loss: [index.ts:138](/Users/synthetic-user/dev/duet/apps/edge/src/index.ts:138), [index.test.ts:518](/Users/synthetic-user/dev/duet/apps/edge/src/index.test.ts:518).

**WHY IT BITES** — Merely returning `{error: "paused"}` with 403 from Convex will not render the branded page; edge cannot distinguish pause from access denial or suspension.

**WHAT IT CHANGES** — Slice 11 needs an explicit typed paused resolution result on the existing resolve call, with suspension/authorization semantics kept distinct.

### 10. PUBLISHED CONTENT CAN OUTLIVE THE “IMMEDIATE” PAUSE IN CACHE

**EVIDENCE** — Every successful publish response is marked `public, max-age=30, s-maxage=30`: [index.ts:212](/Users/synthetic-user/dev/duet/apps/edge/src/index.ts:212). The test explicitly pins that header: [index.test.ts:331](/Users/synthetic-user/dev/duet/apps/edge/src/index.test.ts:331).

**WHY IT BITES** — Browser/CDN caches can serve the old published app for 30 seconds without invoking edge resolution, even after the workspace is paused.

**WHAT IT CHANGES** — D8 / slice 11 must change cache policy, add purge/versioning, or explicitly relax “immediate.” The staging E2E must test a warmed publish cache.

### 11. MANUAL ADMIN PAUSE HAS NO PROVENANCE AND WILL BE UNDONE BY RENEWAL

**EVIDENCE** — `servicingStatus` stores only `active | paused | banned`, with no reason/owner: [schema.ts:150](/Users/synthetic-user/dev/duet/packages/backend/convex/schema.ts:150). Internal admin can directly set any of those values: [internalAdmin/model.ts:339](/Users/synthetic-user/dev/duet/packages/backend/convex/domains/internalAdmin/model.ts:339). Slice 07’s reconciler preserves only `banned`: [07-period-lapse.md:33](/Users/synthetic-user/dev/duet/specs/monthly-subscriptions/slices/07-period-lapse.md:33).

**WHY IT BITES** — An operator’s manual `paused` state is indistinguishable from billing pause. A paid invoice or trial entitlement will silently reactivate it.

**WHAT IT CHANGES** — D8 / slice 07 must either remove manual `paused`, preserve an independent admin-pause flag/reason, or define that admin pause is intentionally non-durable.

### 12. PAUSE DURING PROVISIONING DOES NOT STOP VM CREATION OR CREDENTIAL DELIVERY

**EVIDENCE** — VM attach planning rejects only deleted/retired rows and does not inspect servicing: [vmAttachModel.ts:42](/Users/synthetic-user/dev/duet/packages/backend/convex/domains/workspaces/vmAttachModel.ts:42). Registration likewise checks provisioning state/token, then marks lifecycle active and may mint model credentials: [registration.ts:23](/Users/synthetic-user/dev/duet/packages/backend/convex/domains/workspaces/registration.ts:23), [registration.ts:87](/Users/synthetic-user/dev/duet/packages/backend/convex/domains/workspaces/registration.ts:87). Model-key minting checks only lifecycle liveness: [apiKeys/model.ts:535](/Users/synthetic-user/dev/duet/packages/backend/convex/domains/apiKeys/model.ts:535).

**WHY IT BITES** — A lapse/dispute landing mid-provision still spins up the dedicated VM, completes registration, and issues a VM model key. The model gateway later blocks use, but provisioning cost and local execution continue.

**WHAT IT CHANGES** — Slice 07 must define whether provisioning finishes paused or is cancelled/held, and test lapse before attach, between attach and registration, and during registration.

Clean areas: explicit `suspendedAt` remains orthogonal to servicing, and teardown’s VM identity compare protects a newer VM from stale cleanup ([vmTeardownModel.ts:49](/Users/synthetic-user/dev/duet/packages/backend/convex/domains/workspaces/vmTeardownModel.ts:49)); history showed no half-built/reverted subscription-pause implementation—the existing “pause” attempt is solely the documented VM update-rollout rail.

Coverage: swept all 22 files under `packages/backend/convex/domains/workspaces/`, workspace schema/crons and servicing consumers, agent-session backend/API/gateway rails, all `apps/edge/` files plus backend/contract edge resolvers, relevant `apps/api` gateway/auth routes, `packages/gateway` VM sync/desired-state/runtime/agent runner surfaces, subscription slices 07/11, and relevant git history.