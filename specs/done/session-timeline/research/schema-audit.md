# Convex schema necessity audit

Produced 2026-07-07 (slice 06). Method: traced every table and field to its
actual writers and readers — comments not trusted. Spot-checked (3/3 verdicts
confirmed independently: `aiGenerations.output`, `agentSessions.activeTurnId`,
`by_upstream_generation`). Raw per-table report below; the distilled decision
list comes first.

## QUESTIONS — ANSWERED (Example User, 2026-07-07; folded into slice 07)

1. workspaceVmMetrics → DELETE. 2. feedback → internal-key admin read route.
2. customDomains → DELETE until scheduled. 4. authEmailDeliveries → test
   harness. 5. version triple → KEEP (imageVersion = reprovision-targeting key).
3. users phone/anon → DELETE (email-only; library-compat check in slice).
   Plus: rename aiGenerations → gatewayGenerations.

## Original questions (as posed)

1. **`workspaceVmMetrics`** — cron writes VM telemetry nothing reads. Surface
   it (ops dashboard) or stop collecting?
2. **`feedback` read surface** — write-only by design for launch, or add an
   admin read route?
3. **`customDomains`** — full model + state machine, zero API/edge
   integration (deferred in agent-drive). Keep latent or delete until the
   feature is scheduled?
4. **`authEmailDeliveries`** — test-only magic-link capture table. Move to a
   test-harness concern or keep?
5. **Workspace version fields** (`gatewayVersion/agentVersion/imageVersion`)
   — stored by the update track, no product reader yet. Recommend KEEP:
   they're the fleet-rollout observable (read via Convex dashboard/queries);
   a fleet-status query is the missing cheap reader, not a prune.
6. **`users` phone/anonymous fields + indexes** — Convex Auth compatibility
   surface with no configured provider. Prune or retain for library
   compatibility? (Needs a check against @convex-dev/auth expectations.)

## Confirmed prune/tighten list (slice 07 scope, no sign-off needed)

- DELETE `aiGenerations.output` (orphaned when slice 09 retired
  recordUpstreamSuccess) and `aiGenerations.prompt` write-path remnants
  (optional field nothing populates since the fold).
- DELETE `agentSessions.activeTurnId` (never written; note: the
  session-timeline slices may claim it instead — coordinate).
- DELETE unused indexes: `users.phone`, `users.by_last_seen`,
  `workspaceVmMetrics.by_workspace_sampled`/`by_sampled` (if table survives
  Q1), `customDomains.by_workspace_and_target` (if table survives Q3),
  `publishServedPaths.by_workspace`, rollup user/app indexes
  (`by_workspace_user_day`, `by_workspace_app_day`,
  `by_workspace_user_month`, `by_workspace_app_month`),
  `aiGenerations.by_upstream_generation` (superseded by the compound),
  `agentSessionEvents.by_workspace`, `workspaces.by_stripeCustomerId`.
  (`agentSessions.by_workspace_updated` is CLAIMED by session-timeline
  slice 04 — do not prune.)
- DELETE `publishServedPaths.workspaceId` (inserted, never read).
- DECIDE-in-code `stripeWebhookEvents.type/processedAt`: keep as deliberate
  audit visibility (one-line comment) — recommended — or drop.
- TIGHTEN `v.any()`: `anchors.settings` (shapes are known per consumer),
  `auditEvents.provenance` (union of known writers),
  `aiGenerations.upstreamMetadata` (AI Gateway info shape).
  KEEP permissive: `agentSessionEvents.event` (union owned by contract,
  validated at mutations — README design call) and
  `creditTransactions.metadata` (live, heterogeneous).
- REVIEW workspace write-only fields: `sshDest` (real-VM tests only),
  `vmTokenPrefix` (returned at registration, never re-read),
  `suspendedByUserId`/`suspensionReason` (admin bookkeeping — recommend keep,
  they're provenance).

## Example User's named suspects — direct answers

- **`trainJobs`: LIVE end-to-end.** API creates (`index.ts:324-360`), train
  action + VM gateway drive state/progress (`train/actions.ts:72-171`,
  `train/model.ts:28-92`), API polls (`index.ts:363-372`), reprovision drain
  reads queued/running (`provisioning.ts:479-488`). Keep whole.
- **`aiGenerations`: LIVE core, two dead fields.** The model-gateway metering
  row — preflight creates it, reconcile settles it, ledger references it.
  Dead: `output` (no writer/reader), `prompt` (nothing populates it since
  the bespoke-route fold). App-attribution trio is live-by-copy into ledger
  metadata, which rollups read.

---

Audited `packages/backend/convex/schema.ts` by tracing code, not comments. Paths below are relative to `/Users/synthetic-user/dev/duet`. I did not run tests; this was a read-only schema audit.

**Scope Note**
`...authTables` expands library-owned Convex Auth tables from `@convex-dev/auth`: `authSessions`, `authAccounts`, `authRefreshTokens`, `authVerificationCodes`, `authVerifiers`, `authRateLimits`. App code uses them through `auth.addHttpRoutes` and Convex Auth callbacks in `packages/backend/convex/auth.ts:17,40-45,74`; I did not classify their internal fields as prune candidates because they are external contract tables. The local `users` override is audited below.

**Per-Table Report**
`users`
Verdict: MIXED.
LIVE fields: `email`, `name`, `image`, `emailVerificationTime`, `createdAt`, `updatedAt` written by auth callback `domains/users/model.ts:62-85`; read by current user query `domains/users/queries.ts:8-10`, API key auth payloads `domains/apiKeys/model.ts:199-234,247-273`, email lookup index `domains/users/model.ts:51-54`.
TIGHTEN/WRITE-ONLY: `firstName`, `lastName`, `lastActivity`, `lastSeen` written `domains/users/model.ts:66-72,79-84`; no direct product reader except full-doc `current`. `by_last_seen` unused.
VESTIGIAL/TIGHTEN: `phone`, `phoneVerificationTime`, `isAnonymous`, `phone` index have no local writer/reader; likely Convex Auth compatibility only, but no phone/anonymous provider is configured.

`authEmailDeliveries`
Verdict: WRITE-ONLY / test-only.
Fields `email`, `url`, `token`, `createdAt` written by test magic-link sender `domains/users/internal.ts:12-17` via `auth.ts:10-22`; no reader found. `by_email` unused.

`workspaces`
Verdict: MIXED, mostly LIVE.
LIVE fields: `slug`, `name`, `status`, `createdAt`, `updatedAt`, `createdByUserId`, `lastHeartbeatAt`, `lastActivityAt`, `provisionedAt`, `retiredAt`, `servicingStatus`, `archiveStorageId`, `imageRef`, `vmName`, `httpsUrl`, `edgeProxyToken`, `provisioningTokenHash`, `provisioningTokenExpiresAt`, `provisioningTokenUsedAt`, `vmTokenNonce`, `vmTokenHash`, `stripeCustomerId`, `lastSnapshotAt`, `snapshotVmNames`, `creditBalanceMicroUsd`, `billing.*` written across `workspaces/mutations.ts:23-31,77-80,117,148-167,192,216`, `workspaces/provisioning.ts:59-74,100-114,129-140,168-173,188-194,239-255,321-327,390,410-416,513-524,554-568,637-640`, `edge/model.ts:19-22`, `credits/internal.ts:81-88,247-287,472-527,901-904,1179-1187,1198-1207`; read by auth/workspace queries `workspaces/queries.ts:11-20,45-47`, gateway provisioning `workspaces/provisioning.ts:313-349,383-457,475-499,652-687,690-717,720-734,775-810`, edge/app/publish resolution `edge/model.ts:33-53`, `apps/model.ts:282-328`, `publishes/model.ts:190-229`, billing `credits/internal.ts:305-307,637-640,922-966,1150-1164`, API routes `apps/api/src/index.ts:375-423,945-999,1068-1135`.
WRITE-ONLY: `gatewayVersion`, `agentVersion`, `imageVersion` are stored from VM register/heartbeat `workspaces/provisioning.ts:252,321-327,854-861` but no product reader found.
WRITE-ONLY: `sshDest` is stored `workspaces/provisioning.ts:168-171,249-251` but no product runtime reader found; real-VM tests read it.
WRITE-ONLY: `vmTokenPrefix` stored/returned during registration `workspaces/provisioning.ts:238-249,287-290`; no later DB reader.
WRITE-ONLY: `suspendedByUserId`, `suspensionReason` written `workspaces/mutations.ts:148-166`; no product reader found.
TIGHTEN: `by_stripeCustomerId` index unused; `stripeCustomerId` itself is live for billing.

`workspaceMembers`
Verdict: LIVE.
All fields `workspaceId`, `userId`, `role` written `users/model.ts:128-132`, `workspaces/mutations.ts:32-36,237-249`, `workspaces/provisioning.ts:141-145`; read by authz and listings `workspaces/authorization.ts:25-32,41-48`, `workspaces/queries.ts:11-20`, API key scope checks `apiKeys/model.ts:111-119,209-227`, apps access `apps/model.ts:524-528`.

`auditEvents`
Verdict: WRITE-ONLY on product API; query exists but no live API/web route.
All fields `workspaceId`, `event`, `actorId`, `provenance`, `at` written by central helper `audit/model.ts:12-19` from workspace/app/publish/share/api-key/provisioning paths. Read by Convex query `workspaces/queries.ts:25-35`, but web real payload says audit route missing `apps/web/src/server-data.ts:290-291`; API has no audit route. `provenance: v.any()` is TIGHTEN.

`workspaceVmMetrics`
Verdict: WRITE-ONLY telemetry.
All fields written by cron/action path `crons.ts:23-30`, `workspaces/provisioningActions.ts:268-318`, `workspaces/provisioning.ts:737-763`; only reader is raw test query `workspaces/provisioning.ts:767-772`. Indexes `by_workspace_sampled`, `by_sampled` unused.

`versionPins`
Verdict: LIVE.
Fields `scope`, `workspaceId`, `desiredGatewayVersion`, `desiredAgentVersion`, `updatedAt` written by operator mutations `workspaces/versionPins.ts:12-34,37-63`; read during VM register/heartbeat `workspaces/provisioning.ts:286-293,344-349` through `versionPins.ts:77-103`. Indexes live.

`deviceRateLimits`
Verdict: LIVE.
All fields `key`, `endpoint`, `windowStart`, `count`, `updatedAt` written/read by fixed-window mutation `apiKeys/api.ts:108-156`; API uses it for `/v1/device/code`, `/v1/device/token`, `/v1/feedback` in `apps/api/src/index.ts:889-918,931-942,1163-1183`. Distinct from workspace rate limits because this is pre-auth/device/IP scoped.

`feedback`
Verdict: WRITE-ONLY product.
Fields `content`, `source`, `createdAt` written by public API `apps/api/src/index.ts:931-942` via `feedback/model.ts:6-20`; only reader is `listForTest` `feedback/model.ts:23-30`. `by_createdAt` test-only.

`workspaceRateLimits`
Verdict: LIVE.
All fields `key`, `workspaceId`, `endpoint`, `windowStart`, `count`, `updatedAt` read/written in model gateway preflight `modelGateway/model.ts:92-100` and `modelGateway/rateLimit.ts:53-104`. Separate from device limits because this is post-auth workspace/API-key scoped.

`anchors`
Verdict: LIVE with TIGHTEN.
LIVE fields: `workspaceId`, `path`, `kind`, `state`, `markerNonce`, `createdAt`, `updatedAt` written `anchors/model.ts:57-66,153,171,189,220,253`; read by API/VM/app/publish/share paths `anchors/model.ts:273-294,308-326,393-410`, `apps/model.ts:260-267,299-327`, `publishes/model.ts:207-228`, `shares/model.ts:308-317`.
TIGHTEN: `settings: v.any()` is written/read `anchors/model.ts:26,61,80,87,399`; actual shapes are `{slug}` for apps `apps/model.ts:394-399`, `{kind}` for publishes `publishes/model.ts:321-326`, `{}` for shares `shares/model.ts:356-360`.

`apps`
Verdict: LIVE.
All fields `workspaceId`, `anchorId`, `command`, `port`, `slug`, `visibility`, `createdByUserId`, `createdAt`, `updatedAt` written `apps/model.ts:66-84,125-128,167,203`; read by API routes `apps/api/src/index.ts:535-567,653-714`, gateway reconcile `apps/api/src/index.ts:1410-1459`, edge resolution `apps/model.ts:273-328`, listing `apps/model.ts:215-244,247-270`. Indexes live.

`publishes`
Verdict: LIVE.
All fields `workspaceId`, `anchorId`, `slug`, `kind`, `createdByUserId`, `createdAt`, `updatedAt` written `publishes/model.ts:59-67,99,133`; read by API routes `apps/api/src/index.ts:716-781`, edge resolution/served path `publishes/model.ts:182-275`, listing/get helpers `publishes/model.ts:150-179,378-400`. Indexes live.

`shares`
Verdict: LIVE.
All fields `anchorId`, `originWorkspaceId`, `fromWorkspaceId`, `toWorkspaceId`, `mode`, `mountPath`, `ignorePatterns`, `parentShareId`, `state`, `sync.*`, `createdByUserId`, `createdAt`, `acceptedAt`, `revokedAt` written `shares/model.ts:47-57,97-108,150,205-211,378`; read by API routes `apps/api/src/index.ts:569-651`, share listings/get/sync `shares/model.ts:173-185,248-289,293-318,381-406,447-540`. Indexes live.

`publishServedPaths`
Verdict: MIXED.
LIVE fields: `publishId`, `path`, `firstServedAt` used for edge “new file served” dedupe `http.ts:91-105`, `publishes/model.ts:233-275`.
TIGHTEN/WRITE-ONLY: `workspaceId` is inserted `publishes/model.ts:256-261` but not read; `by_workspace` index unused.

`customDomains`
Verdict: LATENT / product-inactive.
All fields are written/read by Convex model functions `customDomains/model.ts:13-137,150-157`, but no API/web route calls them. `by_domain` and `by_workspace` are used; `by_workspace_and_target` unused. `targetKind`/`targetId` are stored and audited but not used for edge resolution.

`apiKeys`
Verdict: LIVE.
All fields `userId`, `kind`, `hashedKey`, `prefix`, `scopes`, `workspaceIds`, `expiresAt`, `lastUsedAt`, `revokedAt` written/read by issue/auth/device/system-VM paths `apiKeys/mutations.ts:41-48,59-100,104-138`, `apiKeys/api.ts:17-45,47-105,159-199`, `apiKeys/model.ts:280-379,426-435`, model gateway preflight `modelGateway/model.ts:59-78`. Indexes live.

`deviceCodes`
Verdict: LIVE.
All fields `code`, `userCode`, `status`, `scopes`, `workspaceIds`, `userId`, `expiresAt`, `intervalSeconds`, `lastPolledAt` written/read by device flow `apiKeys/mutations.ts:140-185,196-234`, token polling `apiKeys/api.ts:47-105,169-217`, API routes `apps/api/src/index.ts:889-929`. Indexes live.

`creditTransactions`
Verdict: LIVE with TIGHTEN.
All fields `workspaceId`, `amountMicroUsd`, `type`, `reference`, `userId`, `metadata`, `createdAt` written/read by ledger/reservation/billing `credits/internal.ts:57-110,217-231,692-705,740-771,800-855,876-887,1253-1264`; model gateway settlement writes metadata `modelGateway/model.ts:433-469`. `metadata: v.any()` is TIGHTEN but actively used.

`creditDailyUsage`
Verdict: LIVE rollup.
All fields `workspaceId`, `day`, `spendMicroUsd`, `userId`, `appId`, `appSlug`, `visitorUserId`, `updatedAt` written/read by rollup/report/prune `credits/internal.ts:311-347,386-405,977-1057,1103-1147`; API billing usage reads it `apps/api/src/index.ts:406-423`.
TIGHTEN: `by_workspace_user_day`, `by_workspace_app_day` unused; reports use `by_workspace_day` then filter in memory.

`monthlyUsage`
Verdict: LIVE rollup.
All fields `workspaceId`, `month`, `spendMicroUsd`, `inputTokens`, `outputTokens`, `userId`, `appId`, `appSlug`, `visitorUserId`, `updatedAt` written/read by rollup/report `credits/internal.ts:311-347,977-1023,1060-1147`; API billing usage reads it `apps/api/src/index.ts:406-423`.
TIGHTEN: `by_workspace_user_month`, `by_workspace_app_month` unused.

`billingTopups`
Verdict: LIVE.
All fields `workspaceId`, `idempotencyKey`, `amountMicroUsd`, `status`, `stripeInvoiceId`, `stripePaymentIntentId`, `failureCode`, `failureMessage`, `createdAt`, `updatedAt` written/read by auto-topup action and internal mutations `credits/actions.ts:17-101`, `credits/internal.ts:408-469,608-620`. Indexes live.

`stripeWebhookEvents`
Verdict: LIVE table, partial WRITE-ONLY fields.
LIVE field: `eventId` read/written for idempotency `http.ts:19-43`, `credits/internal.ts:535-604,1210-1215`.
WRITE-ONLY: `type`, `processedAt` inserted `credits/internal.ts:1215` but not read.

`aiGenerations`
Verdict: MIXED.
LIVE fields: `workspaceId`, `userId`, `modality`, `model`, `billingMode`, `status`, `upstreamGenerationId`, `reservationId`, `appId`, `appSlug`, `appVisitorUserId`, `actualCostMicroUsd`, `upstreamMetadata`, `error`, `createdAt`, `updatedAt`, `settledAt` written/read by gateway preflight/reconcile/settlement `modelGateway/model.ts:34-167,191-388,416-581`, action reconcile `modelGateway/actions.ts:22-63`, model-gateway app `apps/model-gateway/src/index.ts:92-176,237-365`.
WRITE-ONLY/VESTIGIAL: `prompt` is accepted and inserted `modelGateway/model.ts:176,570` but no product writer currently passes it and no reader uses it except raw test generation listing.
VESTIGIAL: `output` has no writer or reader.
TIGHTEN: `upstreamMetadata: v.any()` could be a concrete AI Gateway info validator. `by_upstream_generation` index unused; `by_workspace_created`, `by_workspace_upstream_generation`, `by_status` are used.
App attribution: `appId/appSlug/appVisitorUserId` are read from generation rows only to copy into ledger metadata `modelGateway/model.ts:441-445`, then usage rollups read metadata `credits/internal.ts:997-1003`; no direct `aiGenerations` product query by app attribution.

`agentSessions`
Verdict: MIXED.
LIVE fields: `workspaceId`, `userId`, `status`, `prompt`, `cwd`, `lastEventSeq`, `createdAt`, `updatedAt`, `interruptRequestedAt` written/read by session API/model `apps/api/src/index.ts:425-532,1038-1059,1641-1672`, `agentSessions/model.ts:23-190,225-288`, reprovision blocking `workspaces/provisioning.ts:475-488`.
VESTIGIAL: `activeTurnId` is returned by `getSession` `agentSessions/model.ts:178,284` but never written.
TIGHTEN: `by_workspace_updated` unused; `by_workspace` is used for reprovision active-work check.

`agentSessionEvents`
Verdict: LIVE with TIGHTEN.
LIVE fields `workspaceId`, `sessionId`, `seq`, `event`, `createdAt` written `agentSessions/model.ts:238-244`; read by SSE/list events `agentSessions/model.ts:192-222`, `apps/api/src/index.ts:1641-1672`.
TIGHTEN: `event: v.any()` could use the existing `AgentTurnEventSchema` validator shape; `by_workspace` index unused; `by_session_seq` live.

`trainJobs`
Verdict: LIVE.
End-to-end exists. API creates job `apps/api/src/index.ts:324-360`, train action/gateway marks running/progress/done/failed `train/actions.ts:72-112,141-171`, model writes state/progress/timestamps/errors `train/model.ts:28-35,65-72,89-92`, API polls `apps/api/src/index.ts:363-372`, and operator reprovision reads queued/running jobs `workspaces/provisioning.ts:479-488`.
All fields `workspaceId`, `jobId`, `state`, `progress`, `error`, `createdAt`, `updatedAt`, `startedAt`, `completedAt` are live. Indexes live.

**Ranked Prune/Tighten Candidates**

1. Remove or implement `aiGenerations.output`; no writer/reader. Tests likely: `packages/backend/src/model-gateway.test.ts`, `apps/model-gateway/src/index.test.ts`.
2. Remove unused indexes: `users.phone`, `users.by_last_seen`, `workspaceVmMetrics.by_workspace_sampled/by_sampled`, `customDomains.by_workspace_and_target`, `publishServedPaths.by_workspace`, usage rollup user/app indexes, `aiGenerations.by_upstream_generation`, `agentSessions.by_workspace_updated`, `agentSessionEvents.by_workspace`. Tests mostly type/schema only; affected behavioral tests by area.
3. Decide fate of `authEmailDeliveries`: test-only capture table with no reader. Tests: all auth-signin fixtures, especially `packages/backend/src/auth-workspaces.test.ts`.
4. Add a real feedback admin/read surface or drop stored feedback. Current product is write-only. Test: `apps/api/src/index.test.ts`.
5. Either surface or remove `workspaceVmMetrics`; cron writes telemetry no product reads. Tests: `packages/backend/src/provisioning.test.ts`.
6. Remove/write `agentSessions.activeTurnId`; currently returned but never populated. Tests: `packages/backend/src/agent-sessions.test.ts`, `apps/api/src/index.test.ts`.
7. Tighten `v.any()` fields: `auditEvents.provenance`, `anchors.settings`, `creditTransactions.metadata`, `aiGenerations.upstreamMetadata`, `agentSessionEvents.event`.
8. Clarify `customDomains`: model exists but no API/edge integration. Either wire routes/edge resolution or remove table/model. Tests: `packages/backend/src/custom-domains.test.ts`.
9. For `workspaces`, consider pruning or surfacing write-only telemetry fields: `gatewayVersion`, `agentVersion`, `imageVersion`, `sshDest`, `vmTokenPrefix`, `suspendedByUserId`, `suspensionReason`. Tests: `packages/backend/src/provisioning.test.ts`, `apps/api/src/index.test.ts`, `apps/api/src/provisioning-real-vm.test.ts`.
10. For `stripeWebhookEvents`, keep `eventId`; make `type/processedAt` intentionally audit-visible or remove them. Tests: `packages/backend/src/billing.test.ts`.
