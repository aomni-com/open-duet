import { authTables } from '@convex-dev/auth/server'
import { defineSchema, defineTable } from 'convex/server'
import { v } from 'convex/values'

import {
  GATEWAY_TRAIN_JOB_PHASES,
  SubscriptionPlanIdSchema,
  SubscriptionStatusSchema,
} from '@repo/contract'

import { deliveryKindValidator } from './deliveryKinds'
import { agentPrincipalValidator } from './domains/agentAccess/policy'
import { settlementOperationValidator } from './domains/credits/settlementTypes'
import {
  domainStatusValidator,
  domainTargetValidator,
  dnsRecordValidator,
  dnsConflictValidator,
  domainOperationValidator,
} from './domains/customDomains/validators'
import {
  backupPurpose,
  backupStatus,
  backupPhase,
  backupProgress,
  backupError,
  backupLifecycle,
  backupRestoration,
  pendingBackupLifecycle,
} from './domains/workspaceBackups/validators'
import {
  agentFollowUpQueueEntryValidator,
  agentSessionStatusValidator,
  agentStateMachineDefinitionValidator,
  agentStateMachineSessionValidator,
  agentTodoValidator,
  creditTransactionMetadataValidator,
  hashedTokenFields,
  recordedAttributionTierIdValidator,
  machineValidator,
  recordedModelSelectionIdValidator,
  runnerDeliveryAttemptValidator,
  messagePreviewValidator,
  sessionActivityMachineValidator,
  sessionBucketValidator,
  upstreamGenerationMetadataValidator,
  usageRollupFields,
  usageRollupGranularityValidator,
} from './validators'

const apiKeyMetadata = {
  userId: v.id('users'),
  hashedKey: v.string(),
  prefix: v.string(),
  name: v.optional(v.string()),
  expiresAt: v.optional(v.number()),
  lastUsedAt: v.optional(v.number()),
  revokedAt: v.optional(v.number()),
  paginationCreatedAt: v.optional(v.number()),
  paginationId: v.optional(v.id('apiKeys')),
}

const anchorSettings = v.union(
  v.object({ kind: v.union(v.literal('file'), v.literal('folder')) }),
  v.object({}),
)

const renameCandidateProvenance = v.object({
  fromPath: v.string(),
  toPath: v.string(),
  confidence: v.number(),
  inodeMatch: v.boolean(),
  markerMatch: v.boolean(),
})

export const auditProvenance = v.object({
  action: v.optional(v.string()),
  activeAgentSessions: v.optional(v.number()),
  activeTrainJobs: v.optional(v.number()),
  actor: v.optional(v.string()),
  acknowledged: v.optional(v.boolean()),
  agentVersion: v.optional(v.string()),
  anchorId: v.optional(v.id('anchors')),
  appId: v.optional(v.id('apps')),
  appSlug: v.optional(v.string()),
  agentId: v.optional(v.id('agents')),
  archiveStorageId: v.optional(v.id('_storage')),
  lifecycleBackupId: v.optional(v.id('workspaceBackups')),
  breaksPublicUrls: v.optional(v.boolean()),
  canonicalEmail: v.optional(v.string()),
  candidates: v.optional(v.array(renameCandidateProvenance)),
  conflictingAnchorId: v.optional(v.id('anchors')),
  conflictingPath: v.optional(v.string()),
  confidence: v.optional(v.number()),
  cpu: v.optional(v.number()),
  /** Polls in a row that found the folder missing before its rows were reaped. */
  consecutiveMissingPolls: v.optional(v.number()),
  /** Which rows a reap took with the folder: 'app', 'agent', or both. */
  deleted: v.optional(v.array(v.string())),
  deviceCode: v.optional(v.id('deviceCodes')),
  deviceId: v.optional(v.id('apiKeys')),
  deviceName: v.optional(v.string()),
  defaultModelId: v.optional(v.string()),
  tier: v.optional(recordedModelSelectionIdValidator),
  expiresAt: v.optional(v.number()),
  fromPath: v.optional(v.string()),
  fromWorkspaceId: v.optional(v.id('workspaces')),
  runtimeVersion: v.optional(v.string()),
  gatewayVersion: v.optional(v.string()),
  generation: v.optional(v.string()),
  imageRef: v.optional(v.string()),
  imageVersion: v.optional(v.string()),
  inodeMatch: v.optional(v.boolean()),
  // Spelled out rather than folded into `mode` below: that one is a share's
  // read/write grant, and one key answering two questions is how a breakdown
  // starts counting `write` installs.
  installMode: v.optional(v.union(v.literal('subscribe'), v.literal('clone_once'))),
  kind: v.optional(
    v.union(
      v.literal('app'),
      v.literal('agent'),
      v.literal('publish'),
      v.literal('share-root'),
      v.literal('share-mount'),
      v.literal('file'),
      v.literal('folder'),
    ),
  ),
  lastHeartbeatAt: v.optional(v.number()),
  listingId: v.optional(v.id('agentListings')),
  /** The publisher's agent slug, which outlives the installer renaming theirs. */
  listingSlug: v.optional(v.string()),
  markerMatch: v.optional(v.boolean()),
  memory: v.optional(v.string()),
  memberUserId: v.optional(v.id('users')),
  name: v.optional(v.string()),
  newBillingUserId: v.optional(v.id('users')),
  mode: v.optional(v.union(v.literal('read'), v.literal('write'))),
  mountPath: v.optional(v.string()),
  newSlug: v.optional(v.string()),
  /** The workspace status a replayed registration found (`active`/`unhealthy`). */
  previousStatus: v.optional(v.string()),
  oldPrefixes: v.optional(v.array(v.string())),
  oldBillingUserId: v.optional(v.id('users')),
  oldSlug: v.optional(v.string()),
  parentShareId: v.optional(v.id('shares')),
  path: v.optional(v.string()),
  prefix: v.optional(v.string()),
  credentialId: v.optional(v.id('apiKeys')),
  purpose: v.optional(v.union(v.literal('managed'), v.literal('exported'))),
  prefixes: v.optional(v.array(v.string())),
  previousVmName: v.optional(v.string()),
  publishId: v.optional(v.id('publishes')),
  reason: v.optional(v.string()),
  revokedShareIds: v.optional(v.array(v.id('shares'))),
  role: v.optional(v.union(v.literal('owner'), v.literal('editor'), v.literal('viewer'))),
  oldRole: v.optional(v.union(v.literal('owner'), v.literal('editor'), v.literal('viewer'))),
  scopes: v.optional(v.array(v.string())),
  // On agent.onboarded: the onboarding conversation the agent completed itself
  // from, distinguishing self-completion from a human's card toggle.
  sessionId: v.optional(v.id('agentSessions')),
  shareId: v.optional(v.id('shares')),
  slug: v.optional(v.string()),
  source: v.optional(v.string()),
  subscriptionId: v.optional(v.id('agentSubscriptions')),
  targetEmail: v.optional(v.string()),
  toPath: v.optional(v.string()),
  toWorkspaceId: v.optional(v.id('workspaces')),
  userCode: v.optional(v.string()),
  visibility: v.optional(v.union(v.literal('folder'), v.literal('public'))),
  vmName: v.optional(v.string()),
})

const subscriptionPlanValidator = v.union(
  v.literal(SubscriptionPlanIdSchema.enum.starter),
  v.literal(SubscriptionPlanIdSchema.enum.pro),
  v.literal(SubscriptionPlanIdSchema.enum.max),
)

const subscriptionStatusValidator = v.union(
  v.literal(SubscriptionStatusSchema.enum.incomplete),
  v.literal(SubscriptionStatusSchema.enum.incomplete_expired),
  v.literal(SubscriptionStatusSchema.enum.trialing),
  v.literal(SubscriptionStatusSchema.enum.active),
  v.literal(SubscriptionStatusSchema.enum.past_due),
  v.literal(SubscriptionStatusSchema.enum.canceled),
  v.literal(SubscriptionStatusSchema.enum.unpaid),
  v.literal(SubscriptionStatusSchema.enum.paused),
)

const appAgentFields = {
  workspaceId: v.id('workspaces'),
  anchorId: v.id('anchors'),
  slug: v.string(),
  name: v.optional(v.string()),
  icon: v.optional(v.string()),
  sourceShareId: v.optional(v.id('shares')),
  listingSubscriptionId: v.optional(v.id('agentSubscriptions')),
  disabledAt: v.optional(v.number()),
  disabledByUserId: v.optional(v.id('users')),
  createdByUserId: v.id('users'),
  createdAt: v.number(),
  updatedAt: v.number(),
}

const agentSessionCommonFields = {
  workspaceId: v.id('workspaces'),
  userId: v.id('users'),
  clientRequestId: v.optional(v.string()),
  clientRequestFingerprint: v.optional(v.string()),
  turnStatus: agentSessionStatusValidator,
  bucket: sessionBucketValidator,
  lastMessage: v.optional(messagePreviewValidator),
  prompt: v.string(),
  title: v.string(),
  titleOrigin: v.union(v.literal('excerpt'), v.literal('auto'), v.literal('manual')),
  titleStatus: v.union(v.literal('generating'), v.literal('complete'), v.literal('failed')),
  titleAttemptId: v.optional(v.string()),
  searchText: v.string(),
  archiveState: v.union(v.literal('active'), v.literal('archived'), v.literal('deleting')),
  visible: v.boolean(),
  archivedAt: v.optional(v.number()),
  cwd: v.optional(v.string()),
  agentId: v.optional(v.id('agents')),
  agentName: v.optional(v.string()),
  onboarding: v.optional(v.boolean()),
  createdBySessionId: v.optional(v.id('agentSessions')),
  lastModelId: v.optional(v.string()),
  lastEventSeq: v.number(),
  lastRunnerInputSeq: v.number(),
  runnerInputPending: v.boolean(),
  lastDeliveredInputSeq: v.number(),
  deliveryAttempt: v.optional(runnerDeliveryAttemptValidator),
  todos: v.optional(v.array(agentTodoValidator)),
  followUpQueue: v.optional(v.array(agentFollowUpQueueEntryValidator)),
  requestedMachine: v.optional(agentStateMachineDefinitionValidator),
  machineState: v.optional(agentStateMachineSessionValidator),
  machine: v.optional(machineValidator),
  createdAt: v.number(),
  updatedAt: v.number(),
}

const strictAgentSessionValidator = v.union(
  v.object({
    ...agentSessionCommonFields,
    audienceKind: v.literal('workspace'),
  }),
  v.object({
    ...agentSessionCommonFields,
    audienceKind: v.literal('specific'),
    specificGrantedParticipantCount: v.number(),
  }),
)

export default defineSchema({
  ...authTables,
  billingSettlements: defineTable({
    billingUserId: v.id('users'),
    operation: settlementOperationValidator,
    status: v.union(v.literal('pending'), v.literal('failed')),
    error: v.optional(v.string()),
  })
    .index('by_account_status', ['billingUserId', 'status'])
    .index('by_generation', ['operation.generationId']),
  workspaceSpending: defineTable({
    workspaceId: v.id('workspaces'),
    monthlySpendPeriodKey: v.string(),
    monthlySpendMicroUsd: v.number(),
  }).index('by_workspace', ['workspaceId']),
  users: defineTable({
    email: v.string(),
    name: v.optional(v.string()),
    image: v.optional(v.string()),
    firstName: v.optional(v.string()),
    lastName: v.optional(v.string()),
    memberDirectoryRevision: v.number(),
    emailVerificationTime: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
    paidCreditBalanceMicroUsd: v.number(),
    monthlyCreditBalanceMicroUsd: v.number(),
    acquisitionAttributionId: v.optional(v.id('campaignAttributions')),
    signupProcessedAt: v.optional(v.number()),
    // Set only when the login-as caller EXPLICITLY asked for a disposable
    // identity (never inferred from how the user was created): the moment the
    // expiry sweep may erase this user and every workspace they own. Initially
    // capped at 24h from mint; after expiry, a failed retirement moves it to
    // the next retry time. Also what marks their workspaces `ephemeral`, which
    // tags the VMs `duet-ephemeral` for the provider-side sweep.
    ephemeralExpiresAt: v.optional(v.number()),
    // Signup abuse: the device this account was created on, and the canonical
    // mailbox behind its address. Both are fixed at first verified signup and
    // never rewritten — a later sign-in from a second device must not migrate
    // an account off the device that minted it, or the count resets for free.
    //
    // `canonicalEmail` is denormalized here on purpose: the count is over
    // distinct MAILBOXES on a device, not distinct user rows, and `+tag`
    // aliases of one mailbox are separate rows that share a canonical form.
    visitorId: v.optional(v.string()),
    canonicalEmail: v.optional(v.string()),
    // Set when the device already held its allowance of distinct mailboxes.
    // Lives on the user rather than on the workspace-birth call so that BOTH
    // grant sites — birth and VM registration — are covered by construction.
    trialGrantWithheldAt: v.optional(v.number()),
    billing: v.optional(
      v.object({
        autoTopupEnabled: v.optional(v.boolean()),
        autoTopupThresholdMicroUsd: v.optional(v.number()),
        autoTopupAmountMicroUsd: v.optional(v.number()),
        maxMonthlySpendMicroUsd: v.optional(v.number()),
        monthlySpendMicroUsd: v.optional(v.number()),
        monthlySpendPeriodKey: v.optional(v.string()),
        stripeCustomerId: v.optional(v.string()),
        paymentMethodReadyAt: v.optional(v.number()),
        onboardingPaymentAttemptId: v.optional(v.string()),
        onboardingPaymentIntentId: v.optional(v.string()),
        onboardingPaymentStatus: v.optional(v.string()),
        paymentRecoveredAt: v.optional(v.number()),
        topupFailureAts: v.optional(v.array(v.number())),
        lastTopupError: v.optional(
          v.object({ code: v.string(), message: v.string(), at: v.number() }),
        ),
        consecutiveTopupFailures: v.optional(v.number()),
        firstPaidAt: v.optional(v.number()),
        trialExpiresAt: v.optional(v.number()),
        monthlyCreditEpoch: v.optional(v.string()),
        monthlyCreditExpiresAt: v.optional(v.number()),
        subscriptionEverActivatedAt: v.optional(v.number()),
        // Dormant diagnostic: Stripe email and projected subscription status
        // own the user-facing failure signal.
        subscriptionPaymentError: v.optional(
          v.object({ code: v.string(), message: v.string(), at: v.number() }),
        ),
        latestSubscriptionPaymentEvent: v.optional(
          v.object({
            periodEnd: v.number(),
            invoiceCreatedAt: v.number(),
            invoiceId: v.string(),
            eventCreatedAt: v.number(),
            eventId: v.string(),
          }),
        ),
        disputeFlaggedAt: v.optional(v.number()),
        subscription: v.optional(
          v.object({
            stripeSubscriptionId: v.string(),
            stripePriceId: v.string(),
            plan: subscriptionPlanValidator,
            status: subscriptionStatusValidator,
            currentPeriodStart: v.number(),
            currentPeriodEnd: v.number(),
            cancelAtPeriodEnd: v.boolean(),
            pendingPlan: v.optional(subscriptionPlanValidator),
            latestLifecycleEventCreatedAt: v.number(),
            latestLifecycleEventId: v.string(),
          }),
        ),
      }),
    ),
  })
    .index('by_email', ['email'])
    .index('by_stripe_customer', ['billing.stripeCustomerId'])
    .index('by_monthly_credit_expiry', ['billing.monthlyCreditExpiresAt'])
    .index('by_trial_expiry', ['billing.trialExpiresAt'])
    .index('by_ephemeral_expiry', ['ephemeralExpiresAt'])
    .index('by_visitor', ['visitorId']),

  // Why a signup lost its trial. Deliberately small — three fields and no
  // smart-signal payload — because this exists so a human can answer "why did
  // this account start paused" from the Convex dashboard, not to tune a policy.
  //
  // Every row means the same thing, so there is no decision column: allowed
  // signups are simply not recorded.
  signupSignals: defineTable({
    visitorId: v.optional(v.string()),
    email: v.string(),
    reason: v.string(),
  })
    /* No `by_visitor` here. `users.by_visitor` is the live one — this table's
       copy had zero callers anywhere, product or test. */
    .index('by_email', ['email']),

  subscriptionLapseSweepState: defineTable({
    scope: v.union(v.literal('monthly'), v.literal('trial')),
    cursor: v.optional(v.string()),
    // The upper bound the in-flight pass opened with. A Convex cursor belongs
    // to the exact query that produced it, and this scan's bound is the clock,
    // so a cursor is only resumable next to the boundary it was taken under.
    boundary: v.optional(v.number()),
    updatedAt: v.number(),
  }).index('by_scope', ['scope']),

  workspaceBackups: defineTable({
    workspaceId: v.id('workspaces'),
    requestId: v.string(),
    purpose: backupPurpose,
    status: backupStatus,
    phase: v.optional(backupPhase),
    attemptId: v.string(),
    sourceVmGeneration: v.optional(v.string()),
    objectPath: v.string(),
    objectCleanupPending: v.boolean(),
    uploadGrantExpiresAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
    lastProgressAt: v.number(),
    startedAt: v.optional(v.number()),
    completedAt: v.optional(v.number()),
    progress: backupProgress,
    completeness: v.optional(v.union(v.literal('complete'), v.literal('partial'))),
    bytes: v.optional(v.number()),
    sha256: v.optional(v.string()),
    error: v.optional(backupError),
    pendingLifecycleOperation: v.optional(v.string()),
    lifecycle: v.optional(backupLifecycle),
    restoration: v.optional(backupRestoration),
    emptyDriveOnNextStart: v.optional(v.boolean()),
  })
    .index('by_workspace', ['workspaceId'])
    .index('by_request', ['workspaceId', 'requestId'])
    .index('by_workspace_status', ['workspaceId', 'status']),

  workspaces: defineTable({
    slug: v.string(),
    name: v.string(),
    status: v.union(
      v.literal('provisioning'),
      v.literal('active'),
      v.literal('unhealthy'),
      v.literal('archived'),
      v.literal('retired'),
      v.literal('deleted'),
    ),
    createdAt: v.number(),
    updatedAt: v.optional(v.number()),
    createdByUserId: v.optional(v.id('users')),
    billingUserId: v.id('users'),
    duetName: v.optional(v.string()),
    // The user's stated purpose, composed at onboarding and written once by
    // `completeWorkspaceOnboarding` — opaque text, never sent to analytics.
    purpose: v.optional(v.string()),
    onboardedAt: v.optional(v.number()),
    defaultModelId: v.optional(v.string()),
    rootDefaultSessionId: v.optional(v.id('agentSessions')),
    lastHeartbeatAt: v.optional(v.number()),
    // A failed stale-health transition leaves the first-attempt prefix until
    // this time; the next persisted heartbeat clears it.
    healthSweepRetryAt: v.optional(v.number()),
    // Credential-cap retries stay parked until the first live key can expire;
    // heartbeat syncs continue without rescanning the bounded key set.
    vmModelCredentialRetryAt: v.optional(v.number()),
    vmModelCredentialRetryScopeKey: v.optional(v.string()),
    servicingStatus: v.optional(
      v.union(v.literal('active'), v.literal('paused'), v.literal('banned')),
    ),
    servicingStatusChangedAt: v.optional(v.number()),
    adminMessage: v.optional(v.string()),
    lifecycleBackupId: v.optional(v.id('workspaceBackups')),
    pendingBackupLifecycle: v.optional(pendingBackupLifecycle),
    birthSeedStorageId: v.optional(v.id('_storage')),
    birthSeedSha256: v.optional(v.string()),
    birthSeedDeliveredAt: v.optional(v.number()),
    runtimeVersion: v.optional(v.string()),
    // Verification is PUBLISHER-scoped, not per listing: consent grants ongoing
    // trust to whoever published, so a publisher cannot be simultaneously
    // verified and not. Catalog rows derive their badge from this.
    verifiedPublisherAt: v.optional(v.number()),
    // Set when login-as EXPLICITLY asked for a disposable identity (the
    // `ephemeral` option — never inferred from how the user was created, so
    // login-as can also mint real customers). Drives the `duet-ephemeral` VM
    // tag so a sweep can delete throwaway VMs without deciding what each
    // `duet-ws-<hash>` was; the owner's `users.ephemeralExpiresAt` drives the
    // 15-minute expiry cron that erases the whole identity.
    ephemeral: v.optional(v.boolean()),
    imageVersion: v.optional(v.string()),
    syncthingDeviceId: v.optional(v.string()),
    imageRef: v.optional(v.string()),
    nextVmImageRef: v.optional(v.string()),
    vmAttachRunId: v.optional(v.string()),
    vmResizeRunId: v.optional(v.string()),
    vmTeardownRunId: v.optional(v.string()),
    vmCleanupPending: v.optional(v.boolean()),
    vmCleanupRetryAt: v.optional(v.number()),
    attachAfterVmTeardown: v.optional(v.boolean()),
    vmName: v.optional(v.string()),
    vmDiskGb: v.optional(v.number()),
    sshDest: v.optional(v.string()),
    httpsUrl: v.optional(v.string()),
    provisioningTokenHash: v.optional(v.string()),
    provisioningTokenExpiresAt: v.optional(v.number()),
    provisioningTokenUsedAt: v.optional(v.number()),
    vmTokenNonce: v.optional(v.string()),
    vmTokenHash: v.optional(v.string()),
    suspendedAt: v.optional(v.number()),
    suspendedByUserId: v.optional(v.id('users')),
    suspensionReason: v.optional(v.string()),
    lastSnapshotAt: v.optional(v.number()),
    snapshotVmNames: v.optional(v.array(v.string())),
    // Duet owns this workspace and pays for it: servicing never derives from the
    // billing user, so it is never paused, decommissioned, or archived. Set by an
    // audited internal-admin operation; read only through `servicingStatusFor`,
    // which is the one place a servicing verdict is computed. A ban still wins.
    servicingExemptAt: v.optional(v.number()),
    billing: v.optional(
      v.object({
        maxMonthlySpendMicroUsd: v.optional(v.number()),
        monthlySpendMicroUsd: v.optional(v.number()),
        monthlySpendPeriodKey: v.optional(v.string()),
      }),
    ),
  })
    .searchIndex('search_name', { searchField: 'name' })
    .index('by_slug_status', ['slug', 'status'])
    .index('by_vmAttachRunId', ['vmAttachRunId'])
    .index('by_vmResizeRunId', ['vmResizeRunId'])
    .index('by_vmTeardownRunId', ['vmTeardownRunId'])
    .index('by_status_vmCleanupPending_vmTeardownRunId_retryAt', [
      'status',
      'vmCleanupPending',
      'vmTeardownRunId',
      'vmCleanupRetryAt',
    ])
    .index('by_vmTokenHash', ['vmTokenHash'])
    .index('by_billing_user', ['billingUserId'])
    .index('by_status_lastHeartbeat', ['status', 'lastHeartbeatAt'])
    .index('by_status_vmName', ['status', 'vmName'])
    .index('by_status_healthSweepRetryAt_lastHeartbeat', [
      'status',
      'healthSweepRetryAt',
      'lastHeartbeatAt',
    ])
    .index('by_status_provisioningTokenExpires', ['status', 'provisioningTokenExpiresAt']),

  /* Provider facts, stored raw. The chart's percentages and MiB, and the
     storage bar's image-adjusted bytes, are projections computed on read —
     storing either would bake a presentation decision into the record and give
     the fee a second, softer version of the same number. `at` is the provider's
     own timestamp, which makes (workspaceId, at) the dedup key: `stat --range=24h`
     re-returns the same points on every sweep. */
  vmTelemetrySamples: defineTable({
    workspaceId: v.id('workspaces'),
    at: v.number(),
    cpuCores: v.optional(v.number()),
    cpuNominalCores: v.optional(v.number()),
    memUsedBytes: v.optional(v.number()),
    memTotalBytes: v.optional(v.number()),
    fsUsedGb: v.optional(v.number()),
    fsTotalGb: v.optional(v.number()),
  })
    .index('by_workspace_at', ['workspaceId', 'at'])
    .index('by_at', ['at']),

  seedDriveBundles: defineTable({
    sha256: v.string(),
    storageId: v.id('_storage'),
    createdAt: v.number(),
    current: v.boolean(),
  })
    .index('by_sha256', ['sha256'])
    .index('by_current', ['current']),

  shareSyncRealizations: defineTable({
    workspaceId: v.id('workspaces'),
    shareId: v.string(),
    generation: v.string(),
    state: v.union(
      v.literal('applying'),
      v.literal('ready'),
      v.literal('paused'),
      v.literal('error'),
    ),
    errorCode: v.optional(v.string()),
    updatedAt: v.number(),
  })
    .index('by_workspace_share', ['workspaceId', 'shareId'])
    .index('by_share', ['shareId']),

  workspaceMembers: defineTable({
    workspaceId: v.id('workspaces'),
    userId: v.id('users'),
    role: v.union(v.literal('owner'), v.literal('editor'), v.literal('viewer')),
  })
    .index('by_workspace_and_user', ['workspaceId', 'userId'])
    .index('by_user_and_workspace', ['userId', 'workspaceId'])
    .index('by_workspace_role', ['workspaceId', 'role']),

  workspaceMemberDirectory: defineTable({
    workspaceId: v.id('workspaces'),
    membershipId: v.id('workspaceMembers'),
    userId: v.id('users'),
    role: v.union(v.literal('owner'), v.literal('editor'), v.literal('viewer')),
    roleRank: v.number(),
    normalizedName: v.string(),
    normalizedEmail: v.string(),
    searchText: v.string(),
    email: v.string(),
    name: v.optional(v.string()),
  })
    .searchIndex('search_text', {
      searchField: 'searchText',
      filterFields: ['workspaceId'],
    })
    .index('by_membership', ['membershipId'])
    .index('by_workspace_and_user', ['workspaceId', 'userId'])
    .index('by_user_and_membership', ['userId', 'membershipId'])
    .index('by_workspace_order', [
      'workspaceId',
      'roleRank',
      'normalizedName',
      'normalizedEmail',
      'membershipId',
    ]),

  memberDirectoryRefreshJobs: defineTable({
    userId: v.id('users'),
    revision: v.number(),
    afterMembershipId: v.optional(v.id('workspaceMembers')),
    updatedAt: v.number(),
  }).index('by_user', ['userId']),

  workspaceInvites: defineTable({
    workspaceId: v.id('workspaces'),
    email: v.string(),
    role: v.union(v.literal('editor'), v.literal('viewer')),
    ...hashedTokenFields,
    inviterUserId: v.id('users'),
    expiresAt: v.number(),
    createdAt: v.number(),
    paginationId: v.optional(v.id('workspaceInvites')),
    revokedAt: v.optional(v.number()),
    consumedAt: v.optional(v.number()),
    consumedByUserId: v.optional(v.id('users')),
  })
    .index('by_tokenHash', ['tokenHash'])
    .index('by_activeKey', ['activeKey'])
    // Recipient lookup for pending workspace invitations.
    .index('by_email', ['email'])
    .index('by_pending_email', ['email', 'consumedAt', 'revokedAt', 'expiresAt'])
    .index('by_workspace_createdAt', ['workspaceId', 'createdAt'])
    .index('by_workspace_createdAt_id', ['workspaceId', 'createdAt', 'paginationId']),

  emailDeliveries: defineTable({
    kind: deliveryKindValidator,
    to: v.string(),
    subject: v.string(),
    idempotencyKey: v.string(),
    status: v.union(v.literal('sending'), v.literal('sent'), v.literal('failed')),
    attempts: v.number(),
    // Retained for delivery audit only; provider errors and timestamps do not
    // drive retry or idempotency control flow.
    providerId: v.optional(v.string()),
    error: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_idempotencyKey', ['idempotencyKey'])
    .index('by_to', ['to']),

  auditEvents: defineTable({
    workspaceId: v.id('workspaces'),
    event: v.string(),
    actorId: v.id('users'),
    provenance: v.optional(auditProvenance),
    at: v.number(),
    sortId: v.string(),
  }).index('by_workspace_at', ['workspaceId', 'at', 'sortId']),

  vmUpdateControl: defineTable({
    scope: v.literal('global'),
    // The row is an explicit brake; a missing row lets updates flow.
    paused: v.boolean(),
    reason: v.optional(v.string()),
    updatedAt: v.number(),
  }).index('by_scope', ['scope']),

  rateLimits: defineTable({
    key: v.string(),
    windowStart: v.number(),
    count: v.number(),
    updatedAt: v.number(),
  }).index('by_key', ['key']),

  feedback: defineTable({
    content: v.string(),
    source: v.optional(v.string()),
    createdAt: v.number(),
    archivedAt: v.optional(v.number()),
    archivedByUserId: v.optional(v.id('users')),
  }).index('by_archived_createdAt', ['archivedAt']),

  campaignAttributions: defineTable({
    campaignSlug: v.string(),
    action: v.string(),
    acquiredByUserId: v.optional(v.id('users')),
    signals: v.any(),
    createdAt: v.number(),
    expiresAt: v.number(),
  }),

  campaignLeads: defineTable({
    campaignSlug: v.string(),
    data: v.any(),
    createdAt: v.number(),
  }),

  conversionInstances: defineTable({
    attributionId: v.id('campaignAttributions'),
    campaignSlug: v.string(),
    state: v.any(),
    activeRunId: v.optional(v.string()),
    activeInputId: v.optional(v.id('conversionInputs')),
    wakeAt: v.optional(v.number()),
    doneAt: v.optional(v.number()),
    lastError: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_attribution_campaign', ['attributionId', 'campaignSlug'])
    .index('by_active_run', ['activeRunId']),

  conversionInputs: defineTable({
    instanceId: v.id('conversionInstances'),
    inputKey: v.string(),
    trigger: v.any(),
    enqueuedAt: v.number(),
  })
    .index('by_instance_key', ['instanceId', 'inputKey'])
    .index('by_instance_enqueued', ['instanceId', 'enqueuedAt']),

  conversionCheckpoints: defineTable({
    instanceId: v.id('conversionInstances'),
    name: v.string(),
    value: v.any(),
    createdAt: v.number(),
  }).index('by_instance_name', ['instanceId', 'name']),

  conversionDeliveries: defineTable({
    instanceId: v.id('conversionInstances'),
    attributionId: v.id('campaignAttributions'),
    campaignSlug: v.string(),
    destination: v.union(
      v.literal('meta'),
      v.literal('google'),
      v.literal('reddit'),
      v.literal('openai'),
    ),
    conversionId: v.string(),
    occurredAt: v.number(),
    userId: v.optional(v.id('users')),
    result: v.any(),
    activeRunId: v.optional(v.string()),
    sentAt: v.optional(v.number()),
    skippedAt: v.optional(v.number()),
    lastError: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_instance', ['instanceId'])
    .index('by_active_run', ['activeRunId'])
    .index('by_instance_destination_conversion', ['instanceId', 'destination', 'conversionId']),

  // One globally active model-routing policy. A missing row means no configured
  // routes and keeps every request on the normal Vercel path. Rules are stored
  // in author order so replacement is one atomic Convex write.
  modelRouterPolicies: defineTable({
    scope: v.literal('global'),
    version: v.literal(1),
    rules: v.array(
      v.object({
        id: v.string(),
        enabled: v.boolean(),
        modelGlob: v.string(),
        baseUrl: v.string(),
        headers: v.array(v.object({ name: v.string(), value: v.string() })),
      }),
    ),
    updatedAt: v.number(),
  }).index('by_scope', ['scope']),

  internalAdminCleanupOperations: defineTable({
    targetUserId: v.id('users'),
    actorId: v.id('users'),
    actorEmail: v.string(),
    reason: v.string(),
    requestId: v.string(),
    status: v.union(
      v.literal('scheduled'),
      v.literal('running'),
      v.literal('blocked'),
      v.literal('failed'),
      v.literal('completed'),
    ),
    plan: v.any(),
    createdAt: v.number(),
    updatedAt: v.number(),
    lastError: v.optional(v.string()),
  })
    .index('by_target', ['targetUserId', 'createdAt'])
    .index('by_status', ['status', 'updatedAt']),

  internalAdminCleanupResources: defineTable({
    operationId: v.id('internalAdminCleanupOperations'),
    resourceKey: v.string(),
    action: v.string(),
    status: v.union(
      v.literal('scheduled'),
      v.literal('running'),
      v.literal('completed'),
      v.literal('blocked'),
      v.literal('failed'),
      v.literal('provider_pending'),
    ),
    workspaceId: v.optional(v.id('workspaces')),
    membershipId: v.optional(v.id('workspaceMembers')),
    membershipGenerationId: v.optional(v.string()),
    newBillingUserId: v.optional(v.id('users')),
    attempts: v.number(),
    lastError: v.optional(v.string()),
    updatedAt: v.number(),
  })
    .index('by_operation', ['operationId', 'resourceKey'])
    .index('by_operation_status', ['operationId', 'status']),

  adminAuditEvents: defineTable({
    workspaceId: v.optional(v.id('workspaces')),
    actorId: v.id('users'),
    actorEmail: v.string(),
    action: v.string(),
    target: v.string(),
    reason: v.string(),
    requestId: v.string(),
    status: v.union(
      v.literal('started'),
      v.literal('accepted'),
      v.literal('completed'),
      v.literal('failed'),
    ),
    detail: v.optional(v.string()),
    at: v.number(),
  }).index('by_workspace', ['workspaceId', 'at']),

  anchors: defineTable({
    workspaceId: v.id('workspaces'),
    path: v.string(),
    kind: v.union(
      v.literal('app'),
      v.literal('agent'),
      v.literal('publish'),
      v.literal('share-root'),
      v.literal('share-mount'),
    ),
    settings: anchorSettings,
    state: v.union(v.literal('active'), v.literal('broken'), v.literal('orphaned')),
    markerNonce: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_workspace_state', ['workspaceId', 'state'])
    .index('by_workspace_and_path', ['workspaceId', 'path']),

  customDomainDiagnostics: defineTable({
    records: v.array(dnsRecordValidator),
    conflicts: v.array(dnsConflictValidator),
  }),

  customDomains: defineTable({
    workspaceId: v.id('workspaces'),
    appId: v.id('apps'),
    hostname: v.string(),
    listed: v.boolean(),
    status: domainStatusValidator,
    diagnosticsId: v.id('customDomainDiagnostics'),
    lastError: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
    lastCheckedAt: v.optional(v.number()),
    verifiedAt: v.optional(v.number()),
    repairReason: v.optional(v.union(v.literal('exhausted'), v.literal('uncertain'))),
    target: domainTargetValidator,
    revision: v.number(),
    providerAssigned: v.boolean(),
    createdByUserId: v.id('users'),
    nextWorkAt: v.optional(v.number()),
    workRunning: v.boolean(),
    runId: v.optional(v.string()),
    runOperation: v.optional(domainOperationValidator),
    runRevision: v.optional(v.number()),
    effectState: v.optional(
      v.union(
        v.literal('admitted'),
        v.literal('executing'),
        v.literal('writing'),
        v.literal('settled'),
      ),
    ),
    cleanupAttempts: v.number(),
  })
    .index('by_app', ['appId'])
    .index('by_hostname', ['hostname'])
    .index('by_workspace', ['workspaceId'])
    .index('by_workspace_listed', ['workspaceId', 'listed'])
    .index('by_due', ['workRunning', 'nextWorkAt'])
    .index('by_running', ['workRunning'])
    .index('by_run', ['runId'])
    .index('by_cleanup_failure', ['status', 'repairReason']),

  apps: defineTable({
    ...appAgentFields,
    sourceAppId: v.optional(v.id('apps')),
    command: v.string(),
    apiScopes: v.array(v.string()),
    installCommand: v.optional(v.string()),
    port: v.optional(v.number()),
    visibility: v.union(v.literal('folder'), v.literal('public')),
    runtimeStatus: v.union(
      v.literal('reconciling'),
      v.literal('reconciled'),
      v.literal('reconcile_failed'),
    ),
    reconciliationError: v.optional(v.string()),
    contentGeneration: v.optional(v.string()),
  })
    .index('by_workspace', ['workspaceId'])
    .index('by_workspace_and_port', ['workspaceId', 'port'])
    .index('by_workspace_and_slug', ['workspaceId', 'slug'])
    .index('by_workspace_and_anchor', ['workspaceId', 'anchorId'])
    .index('by_source_app', ['sourceAppId'])
    .index('by_source_share', ['sourceShareId'])
    .index('by_listing_subscription', ['listingSubscriptionId']),

  agents: defineTable({
    ...appAgentFields,
    sourceAgentId: v.optional(v.id('agents')),
    defaultSessionId: v.optional(v.id('agentSessions')),
    // Onboarding completion for THIS workspace's copy of the agent. It lives
    // here rather than in `appAgentFields` because apps do not onboard, and it
    // is deliberately never replicated: a share recipient onboards their own
    // replica, and the origin's completion says nothing about theirs.
    onboardedAt: v.optional(v.number()),
  })
    .index('by_workspace', ['workspaceId'])
    .index('by_workspace_and_slug', ['workspaceId', 'slug'])
    .index('by_anchor', ['anchorId'])
    .index('by_source_agent', ['sourceAgentId'])
    .index('by_source_share', ['sourceShareId']),

  integrationAgentPolicies: defineTable({
    workspaceId: v.id('workspaces'),
    toolkitSlug: v.string(),
    allowedAgentIds: v.array(agentPrincipalValidator),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_workspace', ['workspaceId'])
    .index('by_workspace_and_toolkit', ['workspaceId', 'toolkitSlug']),

  composioToolRouterSessions: defineTable({
    workspaceId: v.id('workspaces'),
    duetSessionId: v.id('agentSessions'),
    permissionFingerprint: v.string(),
    disabledToolkitSlugs: v.array(v.string()),
    providerSessionId: v.optional(v.string()),
    appliedPermissionFingerprint: v.optional(v.string()),
    // What a runner's MCP handshake needs, kept on the row so the proxy can
    // answer it from the read it already does: the provider session's MCP
    // endpoint (its credential is the org key the API holds), and the tool
    // list that endpoint last returned under the permissions it reflected.
    // The list is a serialized JSON-RPC result, not a nested document: tool
    // schemas carry `$schema` keys, and a field name may not start with `$`.
    mcpUrl: v.optional(v.string()),
    toolsList: v.optional(
      v.object({
        providerSessionId: v.string(),
        permissionFingerprint: v.string(),
        resultJson: v.string(),
        learnedAt: v.number(),
      }),
    ),
    createdAt: v.number(),
  }).index('by_duet_session', ['duetSessionId']),

  // Remote MCP servers a workspace attaches for itself. A sibling of the
  // Composio catalog above, never a merge with it: these rows have no provider
  // session, no vendor catalog, and no readiness gate, so a shared table would
  // be one shape with half its fields undefined on either side.
  //
  // The credential split below is STRUCTURAL, not cosmetic: Convex queries
  // return whole documents, so a token stored here would have to be
  // hand-stripped by every list, health, and projection query. In its own table
  // it cannot be leaked by forgetting.
  mcpServers: defineTable({
    workspaceId: v.id('workspaces'),
    // D8 grammar, enforced by the contract's `McpServerNameSchema`. This is the
    // row's identity, not a display field: it is the runner's tool-name prefix,
    // the proxy path segment, and the launch marker's only content.
    name: v.string(),
    label: v.string(),
    url: v.string(),
    authKind: v.union(v.literal('none'), v.literal('oauth'), v.literal('static')),
    state: v.union(
      v.literal('needs_auth'),
      v.literal('ready'),
      // Terminal credential failure, reached from either auth kind: an expired
      // static paste and an `invalid_grant` refresh are one state, two roads in.
      v.literal('reauth_required'),
      v.literal('disconnecting'),
    ),
    // D10. Codes, never bodies — an upstream body can carry the credential the
    // separate credential table exists to protect.
    lastSuccessAt: v.optional(v.number()),
    lastErrorAt: v.optional(v.number()),
    lastErrorCode: v.optional(v.string()),
    // D6, measured once at the probe. Never recomputed by a turn: the turn path
    // does no network I/O, and a cost estimate that moved every turn would be
    // noise rather than a number the user can act on.
    toolCount: v.optional(v.number()),
    estimatedPromptBytes: v.optional(v.number()),
    droppedToolNames: v.optional(v.array(v.string())), // D8's >128-char casualties
    createdAt: v.number(),
    createdByUserId: v.id('users'),
    updatedAt: v.number(),
  })
    .index('by_workspace', ['workspaceId'])
    .index('by_workspace_and_name', ['workspaceId', 'name']),

  mcpServerCredentials: defineTable({
    serverId: v.id('mcpServers'),
    workspaceId: v.id('workspaces'), // denormalized so the reap is one index scan
    kind: v.union(v.literal('oauth'), v.literal('static')),
    accessToken: v.string(), // D12: plain; the deployment is the boundary
    tokenType: v.string(),
    refreshToken: v.optional(v.string()),
    scope: v.optional(v.string()),
    // Derived from `expires_in` at mint: the SDK's `OAuthTokensSchema` carries
    // no absolute expiry (`shared/auth.js:120-129`), so we compute it here or
    // it does not exist anywhere.
    accessExpiresAt: v.optional(v.number()),
    registrationId: v.optional(v.id('mcpClientRegistrations')),
    resource: v.optional(v.string()), // RFC 8707 audience used at mint
    authorizationServer: v.optional(v.string()),
    // The lease lives on THIS row, not a sibling: the lease and the token must
    // be read and written in one transaction or the generation check means
    // nothing.
    leaseOwner: v.optional(v.string()),
    leaseUntil: v.optional(v.number()),
    generation: v.number(), // monotonic; the CAS key for every credential write
    // Terminal failure. The row SURVIVES: disconnect still needs the
    // registration link, and the UI needs something to hang "Reconnect" on.
    invalidAt: v.optional(v.number()),
    invalidReason: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_server', ['serverId'])
    .index('by_workspace', ['workspaceId'])
    .index('by_registration', ['registrationId']),

  serviceCredentials: defineTable({
    serviceId: v.string(),
    name: v.string(),
    value: v.string(),
    fingerprint: v.string(),
    generation: v.number(),
    updatedAt: v.number(),
  }).index('by_service_and_name', ['serviceId', 'name']),

  servicePoolResources: defineTable({
    serviceId: v.string(),
    pool: v.string(),
    resourceId: v.string(),
    workspaceId: v.id('workspaces'),
    createdAt: v.number(),
    expiresAt: v.number(),
    state: v.union(v.literal('live'), v.literal('expired'), v.literal('deleted')),
    expiry: v.optional(v.object({
      baseUrl: v.string(),
      method: v.string(),
      path: v.string(),
      body: v.optional(v.any()),
      authKind: v.string(),
      authName: v.optional(v.string()),
    })),
  })
    .index('by_resource', ['serviceId', 'pool', 'resourceId'])
    .index('by_workspace', ['workspaceId', 'serviceId', 'pool']),

  // D18: one client registration per (workspace, authorization server), shared
  // by every server behind that authorization server. No refcount column — a
  // stored count drifts; disconnect asks the truth through `by_registration`.
  mcpClientRegistrations: defineTable({
    workspaceId: v.id('workspaces'),
    // Normalized authorization-server identity: origin + pathname, no trailing
    // slash, no query, no fragment. This normalization IS the sharing rule —
    // get it wrong and two servers behind one authorization server each mint
    // their own registration.
    authorizationServer: v.string(),
    clientId: v.string(),
    clientSecret: v.optional(v.string()),
    tokenEndpointAuthMethod: v.optional(v.string()),
    clientSecretExpiresAt: v.optional(v.number()),
    // RFC 7592 — the ONLY way to delete this registration later. The SDK strips
    // both fields (`shared/auth.js:164,175`), which is why Duet owns the DCR
    // POST rather than calling `registerClient()`.
    registrationClientUri: v.optional(v.string()),
    registrationAccessToken: v.optional(v.string()),
    deleteFailedAt: v.optional(v.number()),
    deleteFailedReason: v.optional(v.string()),
    // AS rejected the client; next connect re-registers deliberately, once,
    // rather than letting the SDK re-register on every rejection. The row
    // survives the mark — it holds the only credentials that can delete the
    // client upstream.
    invalidAt: v.optional(v.number()),
    invalidReason: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index('by_workspace_and_as', ['workspaceId', 'authorizationServer'])
    .index('by_workspace', ['workspaceId']),

  // Transient. Deleted on callback; expired siblings swept on the next insert.
  mcpOAuthAuthorizations: defineTable({
    serverId: v.id('mcpServers'),
    workspaceId: v.id('workspaces'),
    // Store only the hash, exactly like `oauthAuthorizationCodes.hashedCode`.
    // The plaintext rides in the OAuth `state` parameter, which lands in the
    // authorization server's logs and in the browser's history.
    hashedState: v.string(),
    codeVerifier: v.string(),
    authorizationServer: v.string(),
    // D23: recorded from validated AS metadata BEFORE redirecting, compared on
    // callback per RFC 9207 before the code reaches any token endpoint.
    expectedIssuer: v.string(),
    resource: v.optional(v.string()),
    redirectTo: v.string(),
    expiresAt: v.number(),
  })
    .index('by_hashed_state', ['hashedState'])
    // The sweep and the delete cascade both work one server at a time. A
    // table-wide scan would make every workspace's in-flight consent a read
    // dependency of every other workspace's connect.
    .index('by_server', ['serverId']),

  // D5's three-state per-agent rule for a custom server. A second table rather
  // than rows in `integrationAgentPolicies`: that table's every row is folded
  // into `disabledToolkitSlugs` and pushed to Composio, so a custom server's
  // row would be sent to Composio as a disabled toolkit.
  mcpServerAgentPolicies: defineTable({
    workspaceId: v.id('workspaces'),
    // Row identity, not name, so a delete cascades cleanly and a rename cannot
    // strand a policy.
    serverId: v.id('mcpServers'),
    allowedAgentIds: v.array(agentPrincipalValidator),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index('by_workspace_and_server', ['workspaceId', 'serverId']),

  agentSubscriptions: defineTable({
    workspaceId: v.id('workspaces'),
    agentId: v.optional(v.id('agents')),
    anchorId: v.optional(v.id('anchors')),
    // The listing this subscription installs. Identity, not a hint: replay,
    // takedown drain and the VM projection all key on it.
    listingId: v.id('agentListings'),
    // Display/path cache of the listed agent's slug. The listing row owns the
    // truth; this exists so a subscription can be rendered and pathed without
    // a join, and is refreshed from the listing whenever one is read.
    agentName: v.string(),
    path: v.string(),
    mode: v.union(v.literal('subscribe'), v.literal('clone_once')),
    state: v.union(
      v.literal('installing'),
      v.literal('active'),
      v.literal('error'),
      v.literal('detached'),
    ),
    appliedEtag: v.optional(v.string()),
    acknowledgedEtag: v.optional(v.string()),
    lastAppliedAt: v.optional(v.number()),
    lastErrorCode: v.optional(v.string()),
    // What this subscriber has applied of the publisher's APP DECLARATIONS,
    // clocked separately from `appliedEtag`. The ETag is stat-derived over
    // files and cannot see a Convex row edit, so a publisher changing only a
    // command or a scope would otherwise never reach installers.
    appliedAppRevision: v.optional(v.string()),
    createdByUserId: v.id('users'),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_workspace', ['workspaceId'])
    .index('by_workspace_and_state', ['workspaceId', 'state'])
    .index('by_workspace_and_path', ['workspaceId', 'path'])
    // Takedown drains only live lanes; detached history must never size the scan.
    .index('by_listing_and_state', ['listingId', 'state']),

  // A marketplace listing: one publisher's agent, offered for anyone to
  // install. Identity is (workspaceId, agentName) — the pair the publish URL
  // already encodes — so two publishers may both ship `research-assistant`.
  agentListings: defineTable({
    // The publisher. `agentName` is the agent's slug within it.
    workspaceId: v.id('workspaces'),
    agentId: v.id('agents'),
    anchorId: v.id('anchors'),
    // The publish is referenced by id, never by a copied slug: `updateSlug`
    // patches the publish row independently, so a cached slug would be a
    // second owner that goes stale the moment a publisher renames.
    publishId: v.id('publishes'),
    agentName: v.string(),
    // The listing's path below its publish anchor: '' when the publish is
    // anchored on the agent folder itself (every listing), or the agent's
    // directory name when it sits under a parent-folder publish (the official
    // hub's layout). See contract `deriveListingSourceUrl`.
    agentSubpath: v.string(),
    state: v.union(v.literal('listed'), v.literal('unlisted'), v.literal('removed')),
    // Written ONLY by the server-side origin refresh. A subscriber's pull
    // report moves its own subscription, never a listing — otherwise one
    // hostile installer could grey out a rival's listing by reporting failures.
    availability: v.union(v.literal('available'), v.literal('unavailable')),
    unavailableSince: v.optional(v.number()),
    // When the sweep last reached this listing. The sweep orders by it and takes
    // the least-recently-checked, so the whole catalog is covered no matter how
    // large it grows — a fixed prefix would leave later listings with no verdict
    // at all, forever.
    availabilityCheckedAt: v.optional(v.number()),
    // The declaration fingerprint rotates on a stamp of its OWN. Sharing
    // availability's stamp would make a budgeted pass always cut at the same
    // relative position and starve the tail of the catalog forever.
    appDeclarationCheckedAt: v.optional(v.number()),
    // Publisher-supplied overrides. AGENTS.md is a system prompt, not
    // marketing copy, so the API accepts explicit values at registration;
    // resolution is `override ?? derived` and refresh never writes these.
    titleOverride: v.optional(v.string()),
    summaryOverride: v.optional(v.string()),
    derived: v.optional(
      v.object({
        title: v.string(),
        summary: v.string(),
        skills: v.array(v.string()),
        changelog: v.string(),
        // Already normalized to the vocabulary by `deriveListingMetadata`.
        // Optional because rows written before tags existed have none, and a
        // listing with no tags is a listing, not an error.
        tags: v.optional(v.array(v.string())),
      }),
    ),
    // Clocks the publisher's app declarations, which the file ETag cannot see
    // (slice 08). Distinct from `derived`, which clocks file content.
    appDeclarationRevision: v.optional(v.string()),
    // An opaque token for what the publisher's FILES are at, so a subscriber
    // can be told "you already have this" instead of asking the origin every
    // half hour. Sibling clock to `appDeclarationRevision`: that one moves on
    // Convex rows, this one on bytes, and the two move independently.
    //
    // Written by the sync that CHANGES the bytes, never by a subscriber's pull
    // report — same firewall as `availability` above. A report that could move
    // a listing-level fact would let one hostile installer aim every other
    // subscriber's puller at a rival publisher's origin.
    contentRevision: v.optional(v.string()),
    // Display names of the listing's contained apps, stamped by the same
    // declaration sweep. The catalog reads this column so the whole-catalog
    // path stays O(listings) — it must never walk publisher apps itself.
    appNames: v.optional(v.array(v.string())),
    metadataRefreshedAt: v.optional(v.number()),
    installs: v.number(),
    createdByUserId: v.id('users'),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_publisher_and_agent', ['workspaceId', 'agentName'])
    .index('by_state_and_installs', ['state', 'installs'])
    .index('by_state_and_availability_checked', ['state', 'availabilityCheckedAt'])
    .index('by_state_and_declaration_checked', ['state', 'appDeclarationCheckedAt'])
    .index('by_anchor', ['anchorId']),

  connectedProviders: defineTable({
    workspaceId: v.id('workspaces'),
    provider: v.union(v.literal('openai-codex'), v.literal('github-copilot')),
    state: v.union(
      v.literal('connected'),
      v.literal('plan_ineligible'),
      v.literal('reconnect_needed'),
      // Internal tombstone: hidden from product lists and removed once the VM
      // reports the provider absent. It keeps a stale observation from
      // resurrecting a backend-initiated disconnect.
      v.literal('disconnect_requested'),
    ),
    connectedByUserId: v.id('users'),
    connectedAt: v.number(),
    eligibilityCheckedAt: v.optional(v.number()),
  })
    .index('by_workspace', ['workspaceId'])
    .index('by_workspace_and_provider', ['workspaceId', 'provider']),

  connectedProviderConnectIntents: defineTable({
    workspaceId: v.id('workspaces'),
    provider: v.union(v.literal('openai-codex'), v.literal('github-copilot')),
    initiatedByUserId: v.id('users'),
    startedAt: v.number(),
  }).index('by_workspace_and_provider', ['workspaceId', 'provider']),

  // WHERE THE OFFICIAL HUB IS — one row, read with `.unique()`. Not a log:
  // syncing is repeatable, so there is nothing to record about individual runs,
  // only the durable identity of the workspace the repo converges.
  officialHub: defineTable({
    workspaceId: v.id('workspaces'),
    workspaceSlug: v.string(),
    ownerUserId: v.id('users'),
  }),

  publishes: defineTable({
    workspaceId: v.id('workspaces'),
    anchorId: v.id('anchors'),
    slug: v.string(),
    kind: v.union(v.literal('file'), v.literal('folder')),
    pausedAt: v.optional(v.number()),
    pauseGeneration: v.optional(v.string()),
    createdByUserId: v.id('users'),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_workspace', ['workspaceId'])
    .index('by_workspace_and_slug', ['workspaceId', 'slug'])
    .index('by_anchor', ['anchorId']),

  shares: defineTable({
    anchorId: v.id('anchors'),
    originWorkspaceId: v.id('workspaces'),
    fromWorkspaceId: v.id('workspaces'),
    toEmail: v.string(),
    toUserId: v.optional(v.id('users')),
    toWorkspaceId: v.optional(v.id('workspaces')),
    ...hashedTokenFields,
    expiresAt: v.number(),
    mode: v.union(v.literal('read'), v.literal('write')),
    // Maintained cache of mountAnchor.path; anchor relocation patches both.
    mountPath: v.optional(v.string()),
    mountAnchorId: v.optional(v.id('anchors')),
    ignorePatterns: v.array(v.string()),
    parentShareId: v.optional(v.id('shares')),
    state: v.union(
      v.literal('pending'),
      v.literal('active'),
      v.literal('revoked'),
      v.literal('unlinked'),
    ),
    sync: v.optional(
      v.object({
        sourceToTargetAcceptId: v.string(),
        targetToSourceAcceptId: v.string(),
        sourceToTargetNonce: v.string(),
        targetToSourceNonce: v.string(),
        tokenSecret: v.string(),
        tokenExpiresAt: v.number(),
        preparedAt: v.number(),
      }),
    ),
    createdByUserId: v.id('users'),
    createdAt: v.number(),
    paginationId: v.optional(v.id('shares')),
    acceptedAt: v.optional(v.number()),
    pausedAt: v.optional(v.number()),
    declinedAt: v.optional(v.number()),
    revokedAt: v.optional(v.number()),
    unlinkedAt: v.optional(v.number()),
  })
    .index('by_anchor', ['anchorId'])
    .index('by_origin_workspace_state', ['originWorkspaceId', 'state'])
    .index('by_to_workspace_state', ['toWorkspaceId', 'state'])
    .index('by_to_email_state_declinedAt_expiresAt', [
      'toEmail',
      'state',
      'declinedAt',
      'expiresAt',
      'paginationId',
    ])
    .index('by_from_workspace_state_declinedAt_expiresAt', [
      'fromWorkspaceId',
      'state',
      'declinedAt',
      'expiresAt',
    ])
    .index('by_tokenHash', ['tokenHash'])
    .index('by_activeKey', ['activeKey'])
    .index('by_parent', ['parentShareId']),

  workspaceShareDirectory: defineTable({
    workspaceId: v.id('workspaces'),
    shareId: v.id('shares'),
    direction: v.union(v.literal('incoming'), v.literal('outgoing')),
    createdAt: v.number(),
  })
    .index('by_workspace_order', ['workspaceId', 'createdAt', 'shareId', 'direction'])
    .index('by_workspace_share_direction', ['workspaceId', 'shareId', 'direction']),

  publishServedPaths: defineTable({
    // Dedup ledger only: the minimal path/kind payload prevents repeated
    // served-path audit events without becoming an analytics table.
    publishId: v.id('publishes'),
    path: v.string(),
    kind: v.optional(v.union(v.literal('raw'), v.literal('zip'))),
    firstServedAt: v.number(),
  }).index('by_publish_and_path', ['publishId', 'path']),

  oauthClients: defineTable({
    clientId: v.string(),
    clientName: v.string(),
    redirectUris: v.array(v.string()),
    tokenEndpointAuthMethod: v.literal('none'),
    source: v.literal('dcr'),
    createdAt: v.number(),
  }).index('by_clientId', ['clientId']),

  oauthAuthorizationRequests: defineTable({
    clientId: v.string(),
    clientName: v.string(),
    redirectUri: v.string(),
    state: v.optional(v.string()),
    capabilities: v.array(v.string()),
    resource: v.string(),
    codeChallenge: v.string(),
    status: v.union(v.literal('pending'), v.literal('approved'), v.literal('denied')),
    expiresAt: v.number(),
    createdAt: v.number(),
    userId: v.optional(v.id('users')),
    workspaceId: v.optional(v.id('workspaces')),
  }),

  oauthAuthorizationCodes: defineTable({
    hashedCode: v.string(),
    requestId: v.id('oauthAuthorizationRequests'),
    userId: v.id('users'),
    workspaceId: v.id('workspaces'),
    scopes: v.array(v.string()),
    clientId: v.string(),
    redirectUri: v.string(),
    resource: v.string(),
    challenge: v.string(),
    expiresAt: v.number(),
    consumedAt: v.optional(v.number()),
  }).index('by_hashedCode', ['hashedCode']),

  oauthGrants: defineTable({
    userId: v.id('users'),
    workspaceId: v.id('workspaces'),
    clientId: v.string(),
    clientName: v.string(),
    // The hostname the grant was authorized to redirect to — shown in the
    // Connected-apps settings card (and its localhost warning). Derived from
    // the authorization request's exact redirect URI at exchange.
    redirectHost: v.string(),
    capabilities: v.array(v.string()),
    scopes: v.array(v.string()),
    audience: v.string(),
    workspaceSlug: v.string(),
    workspaceName: v.string(),
    generation: v.number(),
    createdAt: v.number(),
    paginationId: v.optional(v.id('oauthGrants')),
    revokedAt: v.optional(v.number()),
  })
    .index('by_userId', ['userId'])
    .index('by_user_created', ['userId', 'createdAt'])
    .index('by_user_created_id', ['userId', 'createdAt', 'paginationId']),

  oauthRefreshTokens: defineTable({
    hashedToken: v.string(),
    grantId: v.id('oauthGrants'),
    accessKeyId: v.id('apiKeys'),
    generation: v.number(),
    expiresAt: v.number(),
    supersededAt: v.optional(v.number()),
    graceUntil: v.optional(v.number()),
  })
    .index('by_hashedToken', ['hashedToken'])
    .index('by_grantId', ['grantId'])
    .index('by_grantId_supersededAt', ['grantId', 'supersededAt']),

  syncMachines: defineTable({
    userId: v.id('users'),
    name: v.string(),
    syncthingDeviceId: v.string(),
    createdAt: v.number(),
    lastUsedAt: v.number(),
    removedAt: v.optional(v.number()),
  })
    .index('by_user_peer', ['userId', 'syncthingDeviceId'])
    .index('by_user_created', ['userId', 'createdAt'])
    .index('by_user_removed', ['userId', 'removedAt']),

  apiKeys: defineTable(
    v.union(
      v.object({
        ...apiKeyMetadata,
        kind: v.literal('user'),
      }),
      v.object({
        ...apiKeyMetadata,
        kind: v.union(
          v.literal('system_vm'),
          v.literal('app'),
          v.literal('impersonation'),
          v.literal('browser_session'),
          v.literal('oauth'),
        ),
        scopes: v.array(v.string()),
        workspaceIds: v.array(v.id('workspaces')),
        workspaceId: v.optional(v.id('workspaces')),
        appId: v.optional(v.id('apps')),
        appKeyPurpose: v.optional(v.literal('exported')),
        oauthGrantId: v.optional(v.id('oauthGrants')),
        audience: v.optional(v.string()),
        // Browser session rotation handoff (see apiKeys/mutations).
        rotatedAt: v.optional(v.number()),
      }),
    ),
  )
    .index('by_hashedKey', ['hashedKey'])
    .index('by_prefix', ['prefix'])
    .index('by_kind_workspace_revokedAt', ['kind', 'workspaceId', 'revokedAt'])
    .index('by_kind_app_purpose_revokedAt_expiresAt', [
      'kind',
      'appId',
      'appKeyPurpose',
      'revokedAt',
      'expiresAt',
    ])
    .index('by_oauthGrantId', ['oauthGrantId'])
    .index('by_userId_kind', ['userId', 'kind'])
    // Housekeeping scans only what has already lapsed. Keeping expiry in the
    // index is what lets a browser-session prune read a range that a
    // concurrent mint's insert lands outside of (apiKeys/mutations).
    .index('by_userId_kind_expiresAt', ['userId', 'kind', 'expiresAt'])
    .index('by_userId_kind_created_id', ['userId', 'kind', 'paginationCreatedAt', 'paginationId']),

  deviceCodes: defineTable({
    code: v.string(),
    userCode: v.string(),
    status: v.union(
      v.literal('pending'),
      v.literal('approved'),
      v.literal('denied'),
      v.literal('consumed'),
      // Lazy cache only; expiresAt remains the authority.
      v.literal('expired'),
    ),
    clientName: v.optional(v.string()),
    userId: v.optional(v.id('users')),
    expiresAt: v.number(),
    intervalSeconds: v.number(),
    lastPolledAt: v.optional(v.number()),
  })
    .index('by_code', ['code'])
    .index('by_userCode', ['userCode']),

  /**
   * A sign-in someone started — the Duet-owned half of an email sign-in.
   *
   * `@convex-dev/auth` owns the credential proof (`authVerificationCodes`) and
   * nothing here forks it. This row owns everything the library discards: the
   * self-asserted name, the client that asked, and the attempt counter that is
   * the code's ONLY brute-force guard (the library skips its rate limiter when
   * a sign-in call carries a code but no email). The two meet at one number —
   * `SIGN_IN_CODE_TTL_SECONDS` — and one string, the code.
   *
   * No cron prunes it, matching `deviceCodes` above: rows are small, expire in
   * minutes, and every reader re-checks `expiresAt` rather than trusting a
   * status column.
   */
  authSignInRequests: defineTable({
    requestId: v.string(),
    // Canonical, lowercased. Also the join key to the emailed code, because
    // the identifier the library hands back to `sendVerificationRequest` is
    // exactly this address.
    email: v.string(),
    /**
     * Optional only because the code does not exist yet when the row is
     * written: `auth:signIn` mints it afterwards and reveals it once, to the
     * send callback, which binds it here. An unbound row can never verify, so
     * a `start` that failed before its email left is inert rather than
     * dangerous.
     */
    codeHash: v.optional(v.string()),
    clientName: v.optional(v.string()),
    attemptsRemaining: v.number(),
    expiresAt: v.number(),
    consumedAt: v.optional(v.number()),
    // A later `start` for the same address closed this one. Distinct from
    // `consumedAt` so the two endings stay readable apart in an incident.
    supersededAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index('by_requestId', ['requestId'])
    .index('by_email', ['email']),

  creditTransactions: defineTable({
    workspaceId: v.optional(v.id('workspaces')),
    workspaceName: v.optional(v.string()),
    userId: v.id('users'),
    actorUserId: v.id('users'),
    amountMicroUsd: v.number(),
    monthlyAmountMicroUsd: v.number(),
    paidAmountMicroUsd: v.number(),
    type: v.union(
      v.literal('grant'),
      v.literal('topup'),
      v.literal('usage'),
      v.literal('adjustment'),
      v.literal('reservation'),
      v.literal('subscription_grant'),
      v.literal('subscription_expiry'),
    ),
    reference: v.string(),
    metadata: v.optional(creditTransactionMetadataValidator),
    createdAt: v.number(),
    paginationId: v.optional(v.id('creditTransactions')),
  })
    .index('by_reference', ['reference'])
    .index('by_user_reference', ['userId', 'reference'])
    .index('by_user_created', ['userId', 'createdAt'])
    .index('by_user_created_id', ['userId', 'createdAt', 'paginationId'])
    .index('by_workspace_reference', ['workspaceId', 'reference'])
    .index('by_workspace_created', ['workspaceId', 'createdAt'])
    .index('by_workspace_created_id', ['workspaceId', 'createdAt', 'paginationId']),

  usageRollups: defineTable(usageRollupFields)
    .index('by_workspace_granularity_period', ['workspaceId', 'granularity', 'periodKey'])
    .index('by_workspace_granularity_period_dimension', [
      'workspaceId',
      'granularity',
      'periodKey',
      'userId',
      'appId',
      'appSlug',
    ])
    .index('by_granularity_period', ['granularity', 'periodKey']),

  billingTopups: defineTable({
    workspaceId: v.id('workspaces'),
    userId: v.id('users'),
    idempotencyKey: v.string(),
    amountMicroUsd: v.number(),
    status: v.union(v.literal('created'), v.literal('paid'), v.literal('failed')),
    stripeInvoiceId: v.optional(v.string()),
    failureCode: v.optional(v.string()),
    failureMessage: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_user_idempotencyKey', ['userId', 'idempotencyKey'])
    .index('by_workspace_created', ['workspaceId', 'createdAt']),

  stripeWebhookEvents: defineTable({
    eventId: v.string(),
    // Kept for Stripe audit visibility even though idempotency reads only eventId.
    type: v.string(),
    processedAt: v.number(),
  }).index('by_eventId', ['eventId']),

  gatewayGenerations: defineTable({
    workspaceId: v.id('workspaces'),
    userId: v.id('users'),
    modality: v.union(
      v.literal('text'),
      v.literal('image'),
      v.literal('video'),
      v.literal('audio'),
    ),
    model: v.string(),
    tier: v.optional(recordedAttributionTierIdValidator),
    billingMode: v.union(v.literal('post_response'), v.literal('reservation')),
    chargeToWorkspace: v.boolean(),
    status: v.union(
      v.literal('forwarding'),
      v.literal('reconciling'),
      v.literal('upstream_failed'),
      v.literal('charge_failed'),
      v.literal('settled'),
      v.literal('released'),
    ),
    upstreamGenerationId: v.optional(v.string()),
    reservationId: v.optional(v.string()),
    appId: v.optional(v.id('apps')),
    appSlug: v.optional(v.string()),
    // Deferred until a trustworthy visitor-identity rail exists.
    billedCostMicroUsd: v.optional(v.number()),
    upstreamCostMicroUsd: v.optional(v.number()),
    upstreamMetadata: v.optional(upstreamGenerationMetadataValidator),
    error: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
    settledAt: v.optional(v.number()),
    // When this settled row was counted into `inferenceMarginRollups`. The
    // rollup's to-do list is the unset half of the index below, not a time
    // watermark: `settledAt` is when settlement was queued, so a retried
    // settlement lands long after its own timestamp.
    marginRolledUpAt: v.optional(v.number()),
  })
    .index('by_workspace_created', ['workspaceId', 'createdAt'])
    .index('by_status', ['status'])
    .index('by_status_updated', ['status', 'updatedAt'])
    .index('by_status_margin_rolled_up', ['status', 'marginRolledUpAt']),

  // What model calls cost upstream against what they billed, fleet-wide, per
  // UTC period (keyed by the call's `createdAt`) and per tier/model/provider.
  // One writer: the fold cron. Operator-only reading via internal admin.
  inferenceMarginRollups: defineTable({
    granularity: usageRollupGranularityValidator,
    periodKey: v.string(),
    tier: v.optional(recordedAttributionTierIdValidator),
    model: v.string(),
    provider: v.optional(v.string()),
    routeSource: v.optional(v.union(v.literal('vercel'), v.literal('configured_upstream'))),
    calls: v.number(),
    upstreamCostMicroUsd: v.number(),
    billedCostMicroUsd: v.number(),
    // Compatibility: staging rows folded before token counts were dropped still
    // carry these. Nothing writes or reads them; delete both once those rows are
    // stripped (a required-to-absent drop fails schema validation on push).
    inputTokens: v.optional(v.number()),
    outputTokens: v.optional(v.number()),
    updatedAt: v.number(),
  }).index('by_granularity_period_dimension', [
    'granularity',
    'periodKey',
    'tier',
    'model',
    'provider',
    'routeSource',
  ]),

  agentSessions: defineTable(strictAgentSessionValidator)
    .index('by_workspace', ['workspaceId'])
    .index('by_workspace_user_client_request', ['workspaceId', 'userId', 'clientRequestId'])
    .index('by_workspace_parent', ['workspaceId', 'createdBySessionId'])
    .index('by_workspace_bucket', ['workspaceId', 'bucket'])
    .index('by_workspace_visible_pending_updated', [
      'workspaceId',
      'visible',
      'runnerInputPending',
      'updatedAt',
    ])
    // The list families. One dimension per question a reader can ask — which
    // agent, archived or not, which bucket — and `updatedAt` last so every read
    // is a paginated range scan in recency order.
    //
    // `agentId` is an equality prefix immediately after `onboarding`, so root
    // sessions read via `q.eq('agentId', undefined)` and attributed ones via
    // `q.eq('agentId', <id>)`. The scoped and unscoped variants cannot share an
    // index — an equality prefix cannot be skipped — which is the only reason
    // this is four families rather than two.
    .index('by_workspace_archive_updated', [
      'workspaceId',
      'onboarding',
      'archiveState',
      'updatedAt',
    ])
    .index('by_workspace_archive_bucket_updated', [
      'workspaceId',
      'onboarding',
      'archiveState',
      'bucket',
      'updatedAt',
    ])
    .index('by_workspace_agent_archive_updated', [
      'workspaceId',
      'onboarding',
      'agentId',
      'archiveState',
      'updatedAt',
    ])
    .index('by_workspace_agent_archive_bucket_updated', [
      'workspaceId',
      'onboarding',
      'agentId',
      'archiveState',
      'bucket',
      'updatedAt',
    ])
    .searchIndex('search_sessions', {
      searchField: 'searchText',
      filterFields: ['workspaceId', 'archiveState', 'bucket', 'agentId', 'onboarding'],
    }),

  agentSessionDeletionWork: defineTable({
    workspaceId: v.id('workspaces'),
    sessionId: v.id('agentSessions'),
    rootSessionId: v.id('agentSessions'),
    childScanCursor: v.optional(v.string()),
    childScanComplete: v.boolean(),
    providerSessionId: v.optional(v.string()),
    externalState: v.union(v.literal('pending'), v.literal('running'), v.literal('complete')),
    externalRunId: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_session', ['sessionId'])
    .index('by_external_run', ['externalRunId'])
    .index('by_external_state_child_scan_updated', [
      'externalState',
      'childScanComplete',
      'updatedAt',
    ]),

  agentSessionEvents: defineTable({
    workspaceId: v.id('workspaces'),
    sessionId: v.id('agentSessions'),
    seq: v.number(),
    event: v.any(),
    // Credential actor that submitted an idempotent input. This is separate
    // from the event sender, which may be another session.
    submittingActorId: v.optional(v.id('users')),
    clientRequestId: v.optional(v.string()),
    clientRequestFingerprint: v.optional(v.string()),
    resolvedModelId: v.optional(v.string()),
    terminal: v.optional(v.literal(true)),
    terminalAcceptedThroughSeq: v.optional(v.number()),
    // Rows a runner is handed — prompts, notes, answers, the agent's first
    // message — so delivery can find what is waiting without reading the
    // work that happened around it. Stamped by `appendEvent`.
    input: v.optional(v.literal(true)),
    // Rows a reader sees — everything but the task rail and child-backed steps
    // (`isTranscriptEvent`). The transcript view pages by this index so a
    // subagent-heavy turn does not hand the reader pages that render to
    // nothing. Stamped by `appendEvent`; older rows are backfilled.
    transcript: v.optional(v.literal(true)),
    // Terminal rows only: the session's cwd when the terminal was appended,
    // so a covering-terminal read reports the frame that authored the result
    // even after the session cds elsewhere.
    cwd: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index('by_session_seq', ['sessionId', 'seq'])
    .index('by_session_terminal_seq', ['sessionId', 'terminal', 'seq'])
    .index('by_workspace_submitting_actor_client_request', [
      'workspaceId',
      'submittingActorId',
      'clientRequestId',
    ])
    .index('by_session_input_seq', ['sessionId', 'input', 'seq'])
    .index('by_session_transcript_seq', ['sessionId', 'transcript', 'seq'])
    .index('by_workspace_client_request', ['workspaceId', 'clientRequestId'])
    .index('by_session_client_request', ['sessionId', 'clientRequestId']),

  agentSessionRelayReceipts: defineTable({
    workspaceId: v.id('workspaces'),
    sessionId: v.id('agentSessions'),
    relayId: v.string(),
    // Idempotency echoes preserve the original relay response; only seq is
    // consumed when the runner continues.
    eventFingerprint: v.string(),
    status: agentSessionStatusValidator,
    lastEventSeq: v.number(),
    accepted: v.boolean(),
    seq: v.union(v.number(), v.null()),
    createdAt: v.number(),
  }).index('by_session_relay', ['sessionId', 'relayId']),

  // One row follows one workspace-membership generation. A grant authorizes
  // only a specific-audience session; personal archive is an independent
  // preference for any admitted human, including workspace participants and
  // owners using override.
  agentSessionMemberStates: defineTable({
    workspaceId: v.id('workspaces'),
    sessionId: v.id('agentSessions'),
    membershipId: v.id('workspaceMembers'),
    audienceGranted: v.boolean(),
    personalArchivedAt: v.optional(v.number()),
  })
    .index('by_session_membership', ['sessionId', 'membershipId'])
    .index('by_membership_session', ['membershipId', 'sessionId']),

  agentSessionMembershipRemovalJobs: defineTable({
    workspaceId: v.id('workspaces'),
    membershipId: v.id('workspaceMembers'),
    afterSessionId: v.optional(v.id('agentSessions')),
    updatedAt: v.number(),
  }).index('by_membership', ['membershipId']),

  // One bounded row per authorized discovery lane. Canonical sessions and
  // generation-bound member state remain authoritative; discovery copies only
  // indexed equality/order dimensions and is reconciled in the same mutation.
  agentSessionDiscovery: defineTable({
    workspaceId: v.id('workspaces'),
    laneKey: v.string(),
    sessionId: v.id('agentSessions'),
    archiveState: v.union(v.literal('active'), v.literal('archived')),
    onboarding: v.optional(v.boolean()),
    agentId: v.optional(v.id('agents')),
    createdBySessionId: v.optional(v.id('agentSessions')),
    bucket: sessionBucketValidator,
    orderKey: v.string(),
    title: v.string(),
    updatedAt: v.number(),
    lastEventSeq: v.number(),
    machine: v.optional(sessionActivityMachineValidator),
    preview: v.optional(messagePreviewValidator),
  })
    .index('by_lane_archive_order', [
      'workspaceId',
      'laneKey',
      'onboarding',
      'archiveState',
      'orderKey',
    ])
    .index('by_lane_archive_bucket_order', [
      'workspaceId',
      'laneKey',
      'onboarding',
      'archiveState',
      'bucket',
      'orderKey',
    ])
    .index('by_lane_parent_archive_order', [
      'workspaceId',
      'laneKey',
      'onboarding',
      'createdBySessionId',
      'archiveState',
      'orderKey',
    ])
    .index('by_lane_parent_archive_bucket_order', [
      'workspaceId',
      'laneKey',
      'onboarding',
      'createdBySessionId',
      'archiveState',
      'bucket',
      'orderKey',
    ])
    .index('by_lane_agent_archive_order', [
      'workspaceId',
      'laneKey',
      'onboarding',
      'agentId',
      'archiveState',
      'orderKey',
    ])
    .index('by_lane_agent_archive_bucket_order', [
      'workspaceId',
      'laneKey',
      'onboarding',
      'agentId',
      'archiveState',
      'bucket',
      'orderKey',
    ])
    .index('by_lane_agent_parent_archive_order', [
      'workspaceId',
      'laneKey',
      'onboarding',
      'agentId',
      'createdBySessionId',
      'archiveState',
      'orderKey',
    ])
    .index('by_lane_agent_parent_archive_bucket_order', [
      'workspaceId',
      'laneKey',
      'onboarding',
      'agentId',
      'createdBySessionId',
      'archiveState',
      'bucket',
      'orderKey',
    ])
    .index('by_session_lane', ['sessionId', 'laneKey']),

  /**
   * How far one member has read one session.
   *
   * Per workspace member, not per session: several people read the same agent's
   * work, and "unread" is a fact about a reader rather than about the row. This
   * is the first `(workspaceId, userId, X)` table in the schema, so the second
   * index carries its own justification rather than pointing at a neighbour.
   */
  sessionReads: defineTable({
    workspaceId: v.id('workspaces'),
    userId: v.id('users'),
    sessionId: v.id('agentSessions'),
    /* A monotonic maximum. The write is idempotent and a dropped intermediate is
       lossless, which is what makes the client's coalescing window safe. */
    lastReadSeq: v.number(),
    updatedAt: v.number(),
  })
    .index('by_workspace_user_session', ['workspaceId', 'userId', 'sessionId'])
    /* Not optional, and not a convenience. The upsert key above cannot be
       scanned by `sessionId`, so without this the delete cascade cannot find the
       rows belonging to a session being removed — and the failure is silent
       leakage rather than an error: every member's cursor for that session stays
       behind forever, keyed to an id nothing will ever resolve again. */
    .index('by_session', ['sessionId']),

  agentSessionImages: defineTable({
    workspaceId: v.id('workspaces'),
    sessionId: v.id('agentSessions'),
    storageId: v.id('_storage'),
    mimeType: v.union(
      v.literal('image/png'),
      v.literal('image/jpeg'),
      v.literal('image/webp'),
      v.literal('image/gif'),
    ),
    bytes: v.number(),
  })
    .index('by_session', ['sessionId'])
    .index('by_session_storage', ['sessionId', 'storageId']),

  // File-attribution backbone (specs/done/file-attribution). Append-only event log;
  // `seq` is the PUBLIC per-workspace cursor (REST pagination, SSE resume,
  // sync-daemon resume points) — monotonic per workspace is a pinned invariant.
  fileEvents: defineTable({
    workspaceId: v.id('workspaces'),
    seq: v.number(),
    kind: v.union(
      v.literal('write'),
      v.literal('create'),
      v.literal('delete'),
      v.literal('rename'),
      v.literal('read'),
      v.literal('changed-summary'),
      v.literal('viewed-summary'),
      v.literal('restore'),
    ),
    // Absent only on restore rows: restore is one workspace-wide event that
    // covers every path, so it carries none (MAP L6).
    path: v.optional(v.string()),
    fromPath: v.optional(v.string()),
    entityId: v.optional(v.id('fileActivityEntities')),
    entryKind: v.optional(v.union(v.literal('file'), v.literal('folder'))),
    count: v.optional(v.number()),
    actorContext: v.string(),
    // The bucket this row dedupes within: contract readBucketStart(at).
    bucketStart: v.optional(v.number()),
    at: v.number(),
    // Discriminates the two kinds of fact that share a bucket key. Without it
    // the dedupe lookup below cannot tell a read marker from a change, and a
    // change row silently answers the read-marker query (MAP L-A). Mirrors
    // fileEventScopes.isRead, which exists for the same reason one level down.
    isRead: v.boolean(),
    // The most recent event folded into this row. `at` stays at the FIRST event
    // (MAP L-D) so the feed's seq and timestamp orders agree; coalescing needs
    // the last one to tell a continuing save from a new one, and it must
    // survive across deliveries because a large file's syscall stream spans
    // several batches.
    lastAt: v.optional(v.number()),
  })
    .index('by_workspace_seq', ['workspaceId', 'seq'])
    .index('by_workspace_read_seq', ['workspaceId', 'isRead', 'seq'])
    .index('by_workspace_kind_seq', ['workspaceId', 'kind', 'seq'])
    .index('by_workspace_entity_seq', ['workspaceId', 'entityId', 'seq'])
    .index('by_workspace_entity_read_seq', ['workspaceId', 'entityId', 'isRead', 'seq'])
    // Retention sweeps every workspace at once, so the cutoff scan is global.
    .index('by_at', ['at'])
    // Bucket dedupe: one row per stable entry, actor, bucket, and side.
    .index('by_workspace_entity_actor_bucket_read', [
      'workspaceId',
      'entityId',
      'actorContext',
      'bucketStart',
      'isRead',
    ]),

  // One row per folder ancestor touched by an event. A subtree feed needs to
  // remain seq-ordered and bounded; a path-prefix filter on fileEvents cannot
  // provide both guarantees because path sorts before seq in its index.
  fileEventScopes: defineTable({
    workspaceId: v.id('workspaces'),
    scopeEntityId: v.id('fileActivityEntities'),
    seq: v.number(),
    isRead: v.boolean(),
    eventId: v.id('fileEvents'),
  })
    .index('by_workspace_scope_seq', ['workspaceId', 'scopeEntityId', 'seq'])
    .index('by_workspace_scope_read_seq', ['workspaceId', 'scopeEntityId', 'isRead', 'seq'])
    .index('by_event_scope', ['eventId', 'scopeEntityId']),

  fileEventProjectionState: defineTable({
    workspaceId: v.id('workspaces'),
    completedSeq: v.number(),
    oldestPendingAt: v.optional(v.number()),
    lastSkippedSeq: v.optional(v.number()),
    cursor: v.optional(
      v.object({
        eventSeq: v.number(),
        phase: v.union(v.literal('normal'), v.literal('rename-old'), v.literal('rename-new')),
        currentEntityId: v.optional(v.id('fileActivityEntities')),
        remainingAncestors: v.number(),
      }),
    ),
  }).index('by_workspace', ['workspaceId']),

  // Per-(stable entry, actorContext) rollup powering seen-by without event scans.
  fileAccess: defineTable({
    workspaceId: v.id('workspaces'),
    entityId: v.id('fileActivityEntities'),
    actorContext: v.string(),
    firstAt: v.number(),
    lastAt: v.number(),
    // Negative timestamp makes ascending index order equal newest-first.
    seenByAt: v.number(),
    lastWriteAt: v.optional(v.number()),
    readCount: v.number(),
    writeCount: v.number(),
  })
    // Trailing actorContext serves the upsert; prefix (workspaceId, entityId)
    // serves seen-by and test-only workspace scans.
    .index('by_workspace_entity', ['workspaceId', 'entityId', 'actorContext'])
    .index('by_workspace_entity_seen_by', ['workspaceId', 'entityId', 'seenByAt', 'actorContext']),

  // Batch idempotency: relay retries carry a stable batchId, so "never drop
  // writes" cannot become "duplicate writes".
  fileEventBatches: defineTable({
    workspaceId: v.id('workspaces'),
    batchId: v.string(),
    recordedAt: v.number(),
    droppedReads: v.number(),
    overflow: v.number(),
  })
    .index('by_workspace_batch', ['workspaceId', 'batchId'])
    .index('by_workspace_recorded', ['workspaceId', 'recordedAt'])
    // Retention sweeps every workspace at once, so the cutoff scan is global.
    .index('by_recorded', ['recordedAt']),

  // Stable logical namespace for file activity. Paths are reconstructed through
  // direct parent/name bindings; an entity never points at a previous path.
  fileActivityNamespaces: defineTable({
    workspaceId: v.id('workspaces'),
    currentEpoch: v.number(),
    rootEntityId: v.id('fileActivityEntities'),
    lineageMisses: v.number(),
    nextSequence: v.number(),
  }).index('by_workspace', ['workspaceId']),

  fileActivityEntities: defineTable({
    workspaceId: v.id('workspaces'),
    epoch: v.number(),
    kind: v.union(v.literal('file'), v.literal('folder')),
    createdSequence: v.number(),
    retiredSequence: v.optional(v.number()),
  }).index('by_workspace_epoch', ['workspaceId', 'epoch']),

  fileActivityBindings: defineTable({
    workspaceId: v.id('workspaces'),
    epoch: v.number(),
    parentEntityId: v.id('fileActivityEntities'),
    name: v.string(),
    childEntityId: v.id('fileActivityEntities'),
    startSequence: v.number(),
    endSequence: v.optional(v.number()),
    state: v.union(v.literal('active'), v.literal('ended')),
    // Only one of these is populated. Separate indexed keys make current and
    // historical lookups exact without filtering or walking alias chains.
    activeName: v.optional(v.string()),
    endedName: v.optional(v.string()),
  })
    .index('by_active_slot', ['workspaceId', 'epoch', 'parentEntityId', 'activeName'])
    .index('by_ended_slot', ['workspaceId', 'epoch', 'parentEntityId', 'endedName', 'endSequence'])
    .index('by_child_start', ['workspaceId', 'epoch', 'childEntityId', 'startSequence']),

  trainJobs: defineTable({
    workspaceId: v.id('workspaces'),
    agentId: v.optional(v.id('agents')),
    agentSlug: v.optional(v.string()),
    jobId: v.string(),
    userId: v.string(),
    state: v.union(
      v.literal('queued'),
      v.literal('running'),
      v.literal('done'),
      v.literal('failed'),
    ),
    generation: v.optional(v.string()),
    phase: v.union(
      v.literal(GATEWAY_TRAIN_JOB_PHASES[0]),
      v.literal(GATEWAY_TRAIN_JOB_PHASES[1]),
      v.literal(GATEWAY_TRAIN_JOB_PHASES[2]),
      v.literal(GATEWAY_TRAIN_JOB_PHASES[3]),
      v.literal(GATEWAY_TRAIN_JOB_PHASES[4]),
      v.literal(GATEWAY_TRAIN_JOB_PHASES[5]),
      v.literal(GATEWAY_TRAIN_JOB_PHASES[6]),
    ),
    error: v.optional(v.string()),
    sourceFailures: v.optional(
      v.array(
        v.object({
          source: v.string(),
          code: v.literal('source_fetch_failed'),
          message: v.string(),
        }),
      ),
    ),
    createdAt: v.number(),
    updatedAt: v.number(),
    // Contract timestamps are persisted for future duration display.
    startedAt: v.optional(v.number()),
    completedAt: v.optional(v.number()),
  })
    .index('by_workspace', ['workspaceId'])
    .index('by_workspace_agent', ['workspaceId', 'agentId'])
    .index('by_workspace_agent_created_job', ['workspaceId', 'agentId', 'createdAt', 'jobId'])
    .index('by_workspace_state', ['workspaceId', 'state'])
    .index('by_workspace_and_job', ['workspaceId', 'jobId']),
})
