# Reuse Inventory: Convex Backend

## 1. Credits & Transaction Ledger

### Schema Excerpt

```ts
organizations: {
  stripeCustomerId?: string
  servicingStatus?: 'activated' | 'paused' | 'canceled' | 'banned'
  creditBalanceMicroUsd?: number
  billing?: {
    autoTopupEnabled?: boolean
    autoTopupThresholdMicroUsd?: number
    autoTopupAmountMicroUsd?: number
    maxMonthlySpendMicroUsd?: number
    monthlySpendMicroUsd?: number
    monthlySpendPeriodKey?: string
    lastTopupError?: { code: string; message: string; at: number }
    consecutiveTopupFailures?: number
    firstPaidAt?: number
  }
}

creditTransactions: {
  organizationId
  amountMicroUsd
  type: 'grant' | 'topup' | 'usage' | 'refund' | 'adjustment' | 'reservation'
  reference
  userId?
  metadata?
  createdAt
}
```

Refs: `packages/backend/convex/schema.ts:757`, `packages/backend/convex/schema.ts:802`, indexes at `packages/backend/convex/schema.ts:819`.

### Invariants

- Unit is integer micro-USD. Conversion from dollars uses `Math.round(dollars * 1_000_000)`, and Stripe cents use `Math.round(microUsd / 10_000)`: `packages/shared/src/constants/credits.ts:62`.
- Balance is denormalized on `organizations.creditBalanceMicroUsd`; ledger is documented as source of truth, but code gates on the denormalized balance: `docs/billing-and-credits.md:8`, `packages/backend/convex/domains/credits/internal.ts:146`.
- Balance may go negative; hard block is pre-request at `< $1`: `packages/backend/convex/schema.ts:759`, `packages/shared/src/constants/credits.ts:13`.
- Ledger is intended append-only, but not strictly append-only: `reservation` rows are patched on settle/release (`amountMicroUsd` and `metadata.status` change): `packages/backend/convex/domains/credits/internal.ts:469`, `packages/backend/convex/domains/credits/internal.ts:524`.
- Idempotency is by global `reference` lookup through `creditTransactions.by_reference`: `packages/backend/convex/domains/credits/internal.ts:135`. Gotcha: schema defines an index, not a DB uniqueness constraint: `packages/backend/convex/schema.ts:819`. Inference: Convex OCC likely protects repeated same-reference transactions that read the same index range, but the schema itself does not enforce uniqueness.
- Usage rows are negative; grants/topups positive: `packages/backend/convex/schema.ts:805`.
- Usage writes update three things in one mutation: org balance, optional current-period monthly cap counter, ledger row: `packages/backend/convex/domains/credits/internal.ts:146`, `packages/backend/convex/domains/credits/internal.ts:149`, `packages/backend/convex/domains/credits/internal.ts:164`.

### Trial Grants

- Constants: first signup grant is `$10`, additional-server/org grant is `$3.50`: `packages/shared/src/constants/credits.ts:45`.
- Actual grant happens in `startOnboardingAiChat` before sending the seed message: `packages/backend/convex/domains/channels/mutations.ts:350`.
- First-organization grant reference is now canonical-email scoped: `signup_grant:canonical:${canonicalEmail(user.email)}`; additional grants are `signup_grant:${organizationId}`: `packages/backend/convex/domains/channels/mutations.ts:364`.
- Gotcha: `docs/billing-and-credits.md` still says `signup_grant:${orgId}` for signup generally: `docs/billing-and-credits.md:21`. Code is more specific.

### Auto-Topup & Stripe Coupling

- Defaults: threshold `$5`, amount `$20`, min topup `$5`, idempotency bucket 5 minutes: `packages/shared/src/constants/credits.ts:48`, `packages/shared/src/constants/credits.ts:57`.
- `runPreflight` schedules auto-topup before gating, if enabled, Stripe customer exists, balance below threshold, and consecutive failures `< 3`: `packages/backend/convex/domains/credits/internal.ts:228`.
- Auto-topup idempotency key: `topup:${organizationId}:${bucket}`: `packages/backend/convex/domains/credits/internal.ts:241`.
- `attemptTopup` charges Stripe but does not write credits directly; `invoice.paid` webhook writes the `topup` ledger row: `packages/backend/convex/domains/credits/actions.ts:89`, `packages/backend/convex/services/stripe.ts:479`.
- Webhook credits `invoice.total * 10_000` micro-USD and stamps `billing.firstPaidAt`: `packages/backend/convex/services/stripe.ts:499`, `packages/backend/convex/services/stripe.ts:511`.
- Payment failures record `lastTopupError` and count invoice failures; current code says it no longer auto-pauses on payment failure: `packages/backend/convex/domains/credits/internal.ts:580`, `packages/backend/convex/services/stripe.ts:529`.
- Gotcha: schema comment still says consecutive failures pause orgs: `packages/backend/convex/schema.ts:783`. Code/docs say no auto-pause on payment failure.

### Hard-Block Logic

- Normal AI/service preflight blocks if balance `< HARD_BLOCK_FLOOR_MICRO_USD`, or if current-period spend has reached max monthly spend: `packages/backend/convex/domains/credits/internal.ts:250`, `packages/backend/convex/domains/credits/internal.ts:259`.
- `servicingStatus === undefined` is trial, not blocked by credits code: `docs/billing-and-credits.md:81`.
- Route-level gateway blocks `paused`, `canceled`, `banned` before credit preflight: `apps/web/app/api/v1/ai-gateway/[...path]/route.ts:60`.

### Media Reservation Path

- Media hold estimate is `$2`: `packages/shared/src/constants/credits.ts:38`.
- Media calls must have balance enough to cover hold and still remain above hard floor: `packages/backend/convex/domains/credits/internal.ts:379`.
- Hold atomically patches balance/monthly spend and inserts a `reservation` transaction: `packages/backend/convex/domains/credits/internal.ts:389`.
- Settlement adjusts net balance/monthly spend to actual cost and patches the reservation row: `packages/backend/convex/domains/credits/internal.ts:446`.
- Release refunds the estimate and marks status `released`: `packages/backend/convex/domains/credits/internal.ts:506`.

### Every Caller Found

- Trial grant: `channels.startOnboardingAiChat` calls `applyLedgerEntryWithDb`: `packages/backend/convex/domains/channels/mutations.ts:373`.
- Admin free-credit reset calls `applyLedgerEntryWithDb`: `packages/backend/convex/domains/internalAdmin/internal.ts:127`.
- Stripe topup webhook calls `applyLedgerEntry`: `packages/backend/convex/services/stripe.ts:499`.
- AI generation reconciliation calls `applyLedgerEntry` for non-media usage: `packages/backend/convex/domains/credits/actions.ts:263`.
- Service proxy usage calls `applyLedgerEntry` through `chargeServiceCall`: `packages/backend/convex/domains/publicApi/actions.ts:246`.
- Internal admin adjustment calls `applyLedgerEntry`: `packages/backend/convex/domains/internalAdmin/actions.ts:415`.
- Chat chime preflight calls `runPreflight`: `packages/backend/convex/workflows/chat/chime.ts:150`.
- Sandbox wake and cron task setup call `runPreflight`: `packages/backend/convex/domains/sandboxes/actions.ts:853`, `packages/backend/convex/domains/sandboxes/actions.ts:917`.
- Public API AI gateway calls `runPreflight` through `aiGatewayPreflight`: `packages/backend/convex/domains/publicApi/actions.ts:81`.
- Media reserve/release called through public API actions: `packages/backend/convex/domains/publicApi/actions.ts:167`, `packages/backend/convex/domains/publicApi/actions.ts:194`.

Verdict for v2 credits: **ADAPT**. Core ledger/preflight/Stripe design is sound, but replace `organizationId` with `workspaceId`, move trial grant out of channel onboarding, add user-scoped attribution/API key ownership, and decide whether reservation rows should stay mutable or become append-only events.

## 2. Daily & Monthly Usage Reporting

### `creditDailyUsage`

Schema: per org per UTC day, `YYYY-MM-DD`, `spendMicroUsd`, indexed by `(organizationId, day)`: `packages/backend/convex/schema.ts:822`.

- Day key uses UTC getters: `packages/backend/convex/domains/credits/internal.ts:49`.
- Rows are updated from credit ledger usage writes, not cron: `packages/backend/convex/domains/credits/internal.ts:174`.
- Rollup write is scheduled with up to 5s jitter to avoid OCC conflicts on shared day rows: `packages/backend/convex/domains/credits/internal.ts:26`, `packages/backend/convex/domains/credits/internal.ts:181`.
- Media reservations add daily spend on settlement using reservation `createdAt` day: `packages/backend/convex/domains/credits/internal.ts:480`.
- Query reads at most month days from `creditDailyUsage`, not all transactions: `packages/backend/convex/domains/credits/queries.ts:89`.
- Backfill migration exists as reference; it admits a small double-count race during deploy/backfill: `packages/backend/convex/migrations.ts:30`.

Retention: **NOT FOUND**. No TTL/delete path found for `creditDailyUsage`.

### `monthlyUsage`

Schema: one row per `(organizationId, userId?, month)` with dollar cost and token counters; `userId: undefined` is org rollup: `packages/backend/convex/schema.ts:1166`.

- Month key is UTC `YYYY-MM`: `packages/backend/convex/domains/sandboxes/internal.ts:1004`.
- Written from completed AI messages, not ledger writes: `completeAgentMessage` schedules `incrementMonthlyUsageMutation` with jitter: `packages/backend/convex/domains/messages/mutations.ts:267`.
- Aggregation resolves sandbox session -> sandbox -> organization, then upserts org rollup and optional per-user row by parent user message author: `packages/backend/convex/domains/sandboxes/internal.ts:1034`, `packages/backend/convex/domains/sandboxes/internal.ts:1088`.
- Cost is “free-aware” display cost via `billableCostUsd`, not billing source of truth: `packages/backend/convex/domains/sandboxes/internal.ts:1043`, `packages/backend/convex/model/usage.ts:31`.
- Queried by app settings and public API usage via `getOrgMonthlyUsageByUser`: `packages/backend/convex/domains/organizations/queries.ts:325`, `packages/backend/convex/domains/publicApi/queries.ts:34`.
- Separate from `organizations.billing.monthlySpendMicroUsd`, which is the hard monthly cap counter: `packages/backend/convex/schema.ts:768`.

Retention: **NOT FOUND**. No delete/TTL path found for `monthlyUsage`.

Verdict for v2 usage: **ADAPT**. Keep bucket logic and jittered upserts, but unify around workspace ownership and decide whether user attribution comes from per-user API keys rather than reply-to chat messages.

## 3. Public API Preflight & Credit Gating

- Every `/api/v1/*` route using `withAuth` extracts bearer / `x-api-key` / query `apiKey`, then calls `preflightSandboxApi`: `apps/web/app/api/v1/utils.ts:26`, `apps/web/app/api/v1/utils.ts:73`.
- `preflightSandboxApi` only authenticates sandbox API key and enforces sandbox rate limits; it does **not** meter credits: `packages/backend/convex/domains/publicApi/preflight.ts:7`.
- Auth is currently gateway-token based: valid keys must start `duet_gt_` and match `sandboxes.gatewayToken`: `packages/backend/convex/domains/publicApi/auth.ts:31`.
- Rate limit bucket key is `sandboxId`; paid orgs get 600/min, free get 60/min: `packages/backend/convex/domains/publicApi/rateLimit.ts:19`, `packages/backend/convex/domains/publicApi/rateLimit.ts:52`.
- AI gateway route then separately blocks servicing status and calls `aiGatewayPreflight`: `apps/web/app/api/v1/ai-gateway/[...path]/route.ts:60`, `apps/web/app/api/v1/ai-gateway/[...path]/route.ts:85`.
- AI gateway billing is post-response reconciliation using upstream generation id; media models take an upfront reservation hold: `apps/web/app/api/v1/ai-gateway/[...path]/route.ts:288`, `apps/web/app/api/v1/ai-gateway/[...path]/route.ts:375`.
- Service proxy route gates before forwarding only when service has pricing config, then charges after successful upstream response: `apps/web/app/api/v1/services/[service]/[...path]/route.ts:45`, `apps/web/app/api/v1/services/[service]/[...path]/route.ts:161`.
- Non-billing public API routes like channels, users, usage, upload, embed are rate-limited/authenticated but not credit-metered in this path: example embed route calls `publicApi.actions.embed` with no credit preflight: `apps/web/app/api/v1/embed/route.ts:15`.

Verdict for v2 public API: **ADAPT heavily**. Replace sandbox gateway-token auth with per-user scoped API keys; rate-limit by key/user/workspace; keep explicit credit gates for billable AI/service routes.

## 4. Domain & Table Verdicts

| Domain                    | Tables                                                                                                |      Verdict | Reason                                                                             |
| ------------------------- | ----------------------------------------------------------------------------------------------------- | -----------: | ---------------------------------------------------------------------------------- |
| `activities`              | reads channel/message tables                                                                          |         DROP | Unread/chat activity surface; v2 has no channels/chat.                             |
| `admin`                   | sandboxes, organizations                                                                              |        ADAPT | Internal sandbox ops can survive, but org -> workspace.                            |
| `backup`                  | organizations, sandboxSessions                                                                        |        ADAPT | Useful for sandbox backups; workspace-owned sandboxes change selectors.            |
| `channelTimelineItems`    | `channelTimelineItems`                                                                                |         DROP | Channel timeline only.                                                             |
| `channelUsers`            | `channelUsers`                                                                                        |         DROP | Channel membership/unread only.                                                    |
| `channels`                | `channels`, `channelUsers`, messages, org onboarding grant                                            | DROP/EXTRACT | Drop chat; extract trial-grant logic into workspace onboarding.                    |
| `cliLogin`                | `cliLoginCodes`                                                                                       |        ADAPT | Currently returns org sandbox gateway token; v2 needs per-user API keys.           |
| `connections`             | `connections`, messages                                                                               |        ADAPT | Split reusable MCP/webhook connection core from Telegram/email channel coupling.   |
| `credits`                 | `creditTransactions`, `creditDailyUsage`, organizations billing fields                                |        ADAPT | Strong core; change owner id and user attribution.                                 |
| `customDomains`           | `customDomains`, `sandboxApps`                                                                        |        ADAPT | Still useful for workspace apps; gateway token auth must change.                   |
| `emailInbox`              | `connections`, `externalChannelMetadata`, channels/messages                                           |         DROP | Email-to-channel ingestion is v1 chat-specific.                                    |
| `emailOptOuts`            | `emailOptOuts`, `scheduledLifecycleEmails`                                                            |         COPY | Generic lifecycle email unsubscribe storage.                                       |
| `externalChannelMetadata` | `externalChannelMetadata`, channels/messages                                                          |         DROP | External-provider channel mapping only.                                            |
| `feedback`                | `feedback`                                                                                            |        ADAPT | Useful, but org context becomes workspace; CLI anonymous path can stay.            |
| `fingerprints`            | `signupSignals`                                                                                       |         COPY | Signup anti-abuse ledger independent of chat/org model.                            |
| `internalAdmin`           | organizations, credits, sandboxes                                                                     |        ADAPT | Keep admin powers; rewrite org/workspace and sandbox auth assumptions.             |
| `kanban`                  | channels                                                                                              |         DROP | Channel-backed board/state-machine UI out of v2 scope.                             |
| `memories`                | `memories`                                                                                            |         COPY | User-scoped text memory is independent.                                            |
| `messages`                | `messages`, `messageReactions`, `messageMentions`, `monthlyUsage` writer                              | DROP/EXTRACT | Drop chat messages; extract usage aggregation if agent runs still emit usage.      |
| `onboarding`              | organizations, sandboxes                                                                              |        ADAPT | Reusable setup/scrape pieces, but writes org/channel/sandbox assumptions.          |
| `organizations`           | `organizations`, `organizationUsers`, `hireSlugReservations`, `monthlyUsage` query                    |        ADAPT | WorkOS/Stripe stay; rename/re-scope to workspaces.                                 |
| `publicApi`               | sandboxes, users, organizations, channels/messages, credits                                           |        ADAPT | Keep API shell and billing gates; replace gateway-token auth, drop chat endpoints. |
| `reactivation`            | `reactivationEmails`, users/org/channel activity                                                      |         DROP | Lifecycle sequences rely on v1 activity/channel/invite model.                      |
| `sandboxes`               | `sandboxes`, `sandboxApps`, `sandboxSnapshots`, `sandboxSessions`, `sandboxWakePlans`, `monthlyUsage` |        ADAPT | Core v2 asset, but workspace-owned sandboxes and per-user keys change model.       |
| `storage`                 | Convex storage / blob helpers                                                                         |         COPY | Generic upload/delete/blob utility.                                                |
| `telegram`                | `telegramUsers`, `telegramSetupSessions`, `telegramOnboardingHandoffs`, `connections`                 |         DROP | Telegram-to-channel/chat integration.                                              |
| `threads`                 | channels/messages                                                                                     |         DROP | Chat thread abstraction.                                                           |
| `topics`                  | `topics`, `topicMessages`                                                                             |         DROP | Message topic tagging.                                                             |
| `train`                   | sandbox files, no owned table found                                                                   |        ADAPT | Useful if v2 keeps train corpus in sandboxes; auth/paths need review.              |
| `unread`                  | channelUsers/messages                                                                                 |         DROP | Chat unread state.                                                                 |
| `userDevices`             | `userDevices`                                                                                         |        ADAPT | Generic push-token table, but notification use cases may change.                   |
| `userInvites`             | `userInvites`                                                                                         |        ADAPT | WorkOS invite core reusable; organization field becomes workspace.                 |
| `users`                   | `users`                                                                                               |         COPY | WorkOS user sync stays; review v1 onboarding/profile extras.                       |

## 5. Top 10 Transplant Risks

1. `organizationId` is embedded everywhere in billing, usage, API, sandbox, and Stripe metadata; workspace migration must be systematic.
2. Trial grant currently lives in `channels.startOnboardingAiChat`; v2 without chat needs a new single owner.
3. First signup grant idempotency is canonical-email scoped, not workspace scoped; decide if that anti-farming rule still applies.
4. `creditTransactions.by_reference` is an index, not a uniqueness constraint; duplicate-reference safety depends on transaction behavior, not schema.
5. Reservation rows mutate, so any v2 “append-only ledger” spec must either preserve this exception or redesign as hold/settle/release events.
6. Monthly cap enforcement uses `organizations.billing.monthlySpendMicroUsd`, while UI usage uses `monthlyUsage`; transplanting only one breaks either enforcement or reporting.
7. `monthlyUsage` user attribution currently depends on reply-to chat messages; per-user API keys should become the attribution source.
8. Public API auth is sandbox gateway-token based and rate-limited by sandbox id; v2 needs scoped user API keys and probably key-level audit.
9. Service proxy charges happen after upstream success; failed post-response `after()` charge logs but does not block response, so missed charges are possible.
10. Retention was **NOT FOUND** for credit and usage aggregates; v2 should explicitly choose retention/backfill/reconciliation policy.
