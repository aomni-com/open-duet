import { z } from 'zod'

import { TransactionTypeSchema, UsageReportPeriodSchema } from '../billing/index'
import { RecordedAttributionTierIdSchema } from '../model-tiers/index'

const INTERNAL_ADMIN_DOMAINS = ['aomni.com', 'duet.so'] as const

export function matchesInternalAdminEmail(email: string): boolean {
  const normalized = email.trim().toLowerCase()
  const domain = normalized.match(/^[^@\s]+@([^@\s]+)$/)?.[1]
  return domain !== undefined && INTERNAL_ADMIN_DOMAINS.some(candidate => candidate === domain)
}

/**
 * A refusal the internal-admin backend raises as `ConvexError` data. Production
 * Convex redacts the message of a plain `Error` to "Server Error", so a refusal
 * an operator must be able to tell apart travels as one of these codes; the API
 * maps each to its HTTP status and echoes the code in the body. Anything else
 * the backend throws is a genuine failure and surfaces as
 * `admin_operation_failed`.
 */
export const INTERNAL_ADMIN_REFUSALS = [
  'internal_admin_required',
  'not_found',
  'confirmation_mismatch',
  'admin_dataset_too_large',
  'invalid_request',
  'owner_candidate_required',
  'user_already_exists',
  'self_target',
  'cleanup_blocked',
] as const
export const InternalAdminRefusalSchema = z.object({ error: z.enum(INTERNAL_ADMIN_REFUSALS) })
export type InternalAdminRefusal = z.infer<typeof InternalAdminRefusalSchema>

export const INTERNAL_ADMIN_MAX_FILE_BYTES = 128 * 1024
export const INTERNAL_ADMIN_MAX_COMMAND_OUTPUT_BYTES = 64 * 1024
export const INTERNAL_ADMIN_COMMAND_TIMEOUT_MS = 10_000
const InternalAdminAuditReasonSchema = z.string().trim().min(3).max(500)
export const InternalAdminFeedbackMutationRequestSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('archive'), reason: InternalAdminAuditReasonSchema }),
  z.object({ operation: z.literal('unarchive'), reason: InternalAdminAuditReasonSchema }),
  z.object({
    operation: z.literal('delete'),
    confirmation: z.literal('DELETE'),
    reason: InternalAdminAuditReasonSchema,
  }),
])
export const InternalAdminWorkspaceMutationRequestSchema = z.discriminatedUnion('operation', [
  z.object({
    operation: z.literal('payer'),
    newBillingUserId: z.string().min(1),
    reason: InternalAdminAuditReasonSchema,
  }),
  z.object({
    operation: z.literal('credit'),
    amountMicroUsd: z
      .number()
      .int()
      .safe()
      .refine(value => value !== 0),
    reason: InternalAdminAuditReasonSchema,
  }),
  z.object({
    operation: z.literal('unpause'),
    reason: InternalAdminAuditReasonSchema,
  }),
  z.object({
    operation: z.literal('ban'),
    reason: InternalAdminAuditReasonSchema,
  }),
  z.object({
    operation: z.literal('dispute_clear'),
    reason: InternalAdminAuditReasonSchema,
  }),
  // Duet owns this workspace and pays for it: servicing stops deriving from the
  // billing user, so it is never paused, decommissioned, or archived. A ban
  // still wins. Audited like every other operation here.
  z.object({
    operation: z.literal('servicing_exempt'),
    exempt: z.boolean(),
    reason: InternalAdminAuditReasonSchema,
  }),
  z.object({
    operation: z.literal('message'),
    message: z.string().max(1000),
    reason: InternalAdminAuditReasonSchema,
  }),
  z.object({
    operation: z.literal('suspension'),
    suspended: z.boolean(),
    confirmation: z.string(),
    reason: InternalAdminAuditReasonSchema,
  }),
])
export type InternalAdminWorkspaceMutationRequest = z.infer<
  typeof InternalAdminWorkspaceMutationRequestSchema
>
export const INTERNAL_ADMIN_VM_OPERATIONS = [
  'reboot',
  'reprovision',
  'chrome-update',
  'archive',
  'delete',
] as const
export type InternalAdminVmOperation = (typeof INTERNAL_ADMIN_VM_OPERATIONS)[number]
export const InternalAdminFreeCreditsResetRequestSchema = z.object({
  confirmation: z.literal('RESET FREE CREDITS'),
  reason: InternalAdminAuditReasonSchema,
})
/**
 * Listing takedown: irreversible for every installer at once, so the literal
 * confirmation is part of the wire rather than a client-side guard.
 */
export const InternalAdminListingTakedownRequestSchema = z.object({
  confirmation: z.literal('TAKE DOWN LISTING'),
  reason: InternalAdminAuditReasonSchema,
})

export const InternalAdminListingTakedownResultSchema = z.object({
  ok: z.literal(true),
  auditId: z.string().min(1),
  detached: z.number().nonnegative(),
  // True while the self-continuing drain still has subscribers to detach.
  remaining: z.boolean(),
})

export type InternalAdminListingTakedownResult = z.infer<
  typeof InternalAdminListingTakedownResultSchema
>

export const InternalAdminVmOperationRequestSchema = z.object({
  confirmation: z.string(),
  reason: InternalAdminAuditReasonSchema,
})
export const InternalAdminCommandRequestSchema = z.object({
  command: z.string().trim().min(1).max(100),
  reason: InternalAdminAuditReasonSchema,
})

export const InternalAdminWorkspaceSummarySchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  status: z.enum(['provisioning', 'active', 'unhealthy', 'archived', 'retired', 'deleted']),
  servicingStatus: z.enum(['active', 'paused', 'banned']),
  suspended: z.boolean(),
  billingUserId: z.string(),
  billingEmail: z.string(),
  stripeCustomerId: z.string().optional(),
  disputeFlaggedAt: z.number().optional(),
  // Present when Duet owns and pays for this workspace, so an operator can see
  // why its servicing status never follows the billing user.
  servicingExemptAt: z.number().optional(),
  paidCreditBalanceMicroUsd: z.number().int(),
  monthlyCreditBalanceMicroUsd: z.number().int(),
  memberCount: z.number().int().nonnegative(),
  vmName: z.string().optional(),
  sshDest: z.string().optional(),
  runtimeVersion: z.string().optional(),
  imageVersion: z.string().optional(),
  lastHeartbeatAt: z.number().optional(),
  adminMessage: z.string().optional(),
})
export type InternalAdminWorkspaceSummary = z.infer<typeof InternalAdminWorkspaceSummarySchema>

export const InternalAdminSearchResponseSchema = z.object({
  workspaces: z.array(InternalAdminWorkspaceSummarySchema),
  auditId: z.string(),
})
export type InternalAdminSearchResponse = z.infer<typeof InternalAdminSearchResponseSchema>

const InternalAdminMemberUsageSchema = z.object({
  userId: z.string(),
  email: z.string(),
  name: z.string().optional(),
  role: z.enum(['owner', 'editor', 'viewer']),
  spendMicroUsd: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
})
const InternalAdminLedgerEntrySchema = z.object({
  id: z.string(),
  amountMicroUsd: z.number().int(),
  type: TransactionTypeSchema,
  reference: z.string(),
  createdAt: z.number(),
})
export const InternalAdminWorkspaceDetailSchema = z.object({
  workspace: InternalAdminWorkspaceSummarySchema,
  usage: z.object({
    month: z.string(),
    spendMicroUsd: z.number().int().nonnegative(),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    members: z.array(InternalAdminMemberUsageSchema),
  }),
  ledger: z.array(InternalAdminLedgerEntrySchema),
  // Aggregated over the most recent file-sync relay batches (up to 100).
  syncHealth: z.object({
    batches: z.number().int().nonnegative(),
    droppedReads: z.number().int().nonnegative(),
    overflow: z.number().int().nonnegative(),
    lastRecordedAt: z.number().optional(),
  }),
  auditId: z.string(),
})
export type InternalAdminWorkspaceDetail = z.infer<typeof InternalAdminWorkspaceDetailSchema>

const InternalAdminFeedbackSchema = z.object({
  id: z.string(),
  content: z.string(),
  source: z.string().optional(),
  createdAt: z.number(),
  archivedAt: z.number().optional(),
})
export type InternalAdminFeedback = z.infer<typeof InternalAdminFeedbackSchema>
export const InternalAdminFeedbackListSchema = z.object({
  feedback: z.array(InternalAdminFeedbackSchema),
  auditId: z.string(),
})

const InternalAdminAuditEventSchema = z.object({
  id: z.string(),
  workspaceId: z.string().optional(),
  actorEmail: z.string(),
  action: z.string(),
  target: z.string(),
  reason: z.string(),
  requestId: z.string(),
  status: z.enum(['started', 'accepted', 'completed', 'failed']),
  detail: z.string().optional(),
  at: z.number(),
})
export type InternalAdminAuditEvent = z.infer<typeof InternalAdminAuditEventSchema>
export const InternalAdminAuditListSchema = z.object({
  events: z.array(InternalAdminAuditEventSchema),
  auditId: z.string(),
})

export const InternalAdminFreeCreditsSchema = z.object({
  totalFreeCreditsMicroUsd: z.number().int().nonnegative(),
  unpaidUserCount: z.number().int().nonnegative(),
  usersWithBalanceCount: z.number().int().nonnegative(),
  auditId: z.string(),
})
export type InternalAdminFreeCredits = z.infer<typeof InternalAdminFreeCreditsSchema>
export const InternalAdminOperationResultSchema = z.object({
  ok: z.literal(true),
  auditId: z.string(),
  message: z.string().optional(),
})
export type InternalAdminOperationResult = z.infer<typeof InternalAdminOperationResultSchema>

export const InternalAdminVmOperationResultSchema = z.discriminatedUnion('status', [
  InternalAdminOperationResultSchema.extend({ status: z.literal('completed') }),
  InternalAdminOperationResultSchema.extend({
    status: z.literal('backup_pending'),
    backupId: z.string().min(1),
  }),
  InternalAdminOperationResultSchema.extend({ status: z.literal('provisioning') }),
  InternalAdminOperationResultSchema.extend({
    status: z.literal('deferred'),
    reason: z.literal('active_workspace_work'),
    activeAgentSessions: z.number().int().nonnegative(),
    activeTrainJobs: z.number().int().nonnegative(),
  }),
])
export type InternalAdminVmOperationResult = z.infer<typeof InternalAdminVmOperationResultSchema>

/**
 * The global fleet update brake. A missing control row means updates flow, so
 * `paused: false` with no `updatedAt` is the untouched default; `reason` and
 * `updatedAt` describe the last human flip. Pausing defers activation of the
 * complete runtime release while ordinary workspace work continues.
 */
export const InternalAdminVmUpdatesSchema = z.object({
  paused: z.boolean(),
  reason: z.string().optional(),
  updatedAt: z.number().optional(),
  auditId: z.string(),
})
export type InternalAdminVmUpdates = z.infer<typeof InternalAdminVmUpdatesSchema>
export const InternalAdminVmUpdatesRequestSchema = z.object({
  paused: z.boolean(),
  reason: z.string(),
})
export type InternalAdminVmUpdatesRequest = z.infer<typeof InternalAdminVmUpdatesRequestSchema>

/**
 * How far behind its last heartbeat an active VM may fall before the fleet view
 * calls it stale. The idle sync poll is 300s, so a healthy VM beats at least
 * every ~5 min; 10 min is two missed idle polls — comfortably past jitter, well
 * short of a genuinely wedged gateway. One owner so the server count and the UI
 * highlight draw the same line.
 */
export const INTERNAL_ADMIN_STALE_HEARTBEAT_MS = 10 * 60 * 1000

const InternalAdminCountEntrySchema = z.object({ label: z.string(), count: z.number().int() })
export type InternalAdminCountEntry = z.infer<typeof InternalAdminCountEntrySchema>

/**
 * One active VM's line in the fleet view. Versions/heartbeat come from the
 * workspace row (the control plane); the usage fields come from the newest
 * `vmTelemetrySamples` row the hourly sampler stored, so `sampleAgeMs` is how
 * stale that reading is — absent when no sample exists yet. `cpuCores` is the
 * absolute figure an operator reasons about ("~1 core = a busy loop"); `cpuPct`
 * normalizes it against the VM's nominal cores.
 */
export const InternalAdminFleetVmSchema = z.object({
  workspaceId: z.string(),
  slug: z.string(),
  vmName: z.string().optional(),
  status: z.string(),
  servicingStatus: z.string().optional(),
  runtimeVersion: z.string().optional(),
  heartbeatAgeMs: z.number().optional(),
  cpuCores: z.number().optional(),
  cpuPct: z.number().optional(),
  memUsedMb: z.number().optional(),
  memTotalMb: z.number().optional(),
  sampleAgeMs: z.number().optional(),
})
export type InternalAdminFleetVm = z.infer<typeof InternalAdminFleetVmSchema>

/**
 * The live-fleet control-plane snapshot behind the admin fleet-health view.
 * "Live" is the metered status set (the VMs the sampler bills), read through the
 * status index rather than a whole-table scan, so every figure covers exactly
 * that population. `versions` tallies the distinct builds among those VMs — more
 * than one entry for a component is a rollout in flight or a stuck VM; the UI
 * reads a single entry as converged. `truncated` says one status bucket outgrew
 * the read cap and the figures cover only what was read (not expected below a
 * five-figure live fleet). `generatedAt` is the request time the caller stamped,
 * so age-derived fields recompute per request rather than off a cached query.
 */
export const InternalAdminFleetHealthSchema = z.object({
  generatedAt: z.number(),
  activeCount: z.number().int(),
  truncated: z.boolean(),
  versions: z.object({
    runtime: z.array(InternalAdminCountEntrySchema),
  }),
  staleHeartbeatCount: z.number().int(),
  updates: z.object({ paused: z.boolean(), reason: z.string().optional() }),
  telemetry: z.object({
    withSample: z.number().int(),
    missing: z.number().int(),
    newestSampleAgeMs: z.number().optional(),
    oldestSampleAgeMs: z.number().optional(),
  }),
  vms: z.array(InternalAdminFleetVmSchema),
  auditId: z.string(),
})
export type InternalAdminFleetHealth = z.infer<typeof InternalAdminFleetHealthSchema>

/** `through` is epoch milliseconds: the window ends at the period holding it. */
export const InternalAdminInferenceMarginQuerySchema = z.object({
  granularity: UsageReportPeriodSchema,
  through: z
    .string()
    .regex(/^\d{1,15}$/)
    .optional(),
})

const InternalAdminInferenceAmountsSchema = z.object({
  calls: z.number().int(),
  // What the provider reported the calls cost us.
  upstreamCostMicroUsd: z.number(),
  // What the calls debited from customer credits (tier rate, or cost when untiered).
  billedCostMicroUsd: z.number(),
})

/**
 * Model spend across every workspace: upstream cost against what was billed,
 * over one window of 30 days, 12 ISO weeks, or 12 months (UTC, by call time).
 * `window` names its first and last period keys; `olderThrough`/`newerThrough`
 * are anchors for the neighbouring windows (no newer one past the current
 * period). Counts settled calls only, folded every few minutes, so `updatedAt`
 * is when the rollup last changed. Untiered calls (media, legacy) omit `tier`.
 */
export const InternalAdminInferenceMarginSchema = z.object({
  granularity: UsageReportPeriodSchema,
  window: z.object({ start: z.string(), end: z.string() }),
  olderThrough: z.number(),
  newerThrough: z.number().optional(),
  totals: InternalAdminInferenceAmountsSchema,
  periods: z.array(
    InternalAdminInferenceAmountsSchema.extend({
      period: z.string(),
      tiers: z.array(
        InternalAdminInferenceAmountsSchema.extend({
          tier: RecordedAttributionTierIdSchema.optional(),
        }),
      ),
    }),
  ),
  models: z.array(
    InternalAdminInferenceAmountsSchema.extend({
      tier: RecordedAttributionTierIdSchema.optional(),
      model: z.string(),
      provider: z.string().optional(),
      routeSource: z.enum(['vercel', 'configured_upstream']).optional(),
    }),
  ),
  truncated: z.boolean(),
  updatedAt: z.number().optional(),
  auditId: z.string(),
})
export type InternalAdminInferenceMargin = z.infer<typeof InternalAdminInferenceMarginSchema>

/**
 * A sync always ran, so there is no state to report — only what it changed.
 * `written` is the operator's answer to "did that do anything?"; an empty list
 * means the hub already matched the deployed code.
 */
export const InternalAdminOfficialHubSyncSchema = z.object({
  workspaceSlug: z.string(),
  written: z.array(z.string()),
  // What the sync reaped because the repo no longer claims it. Surfaced rather
  // than counted: a rename shows up here as the old paths, and an operator who
  // clicks Sync deserves to see what it removed from the hub.
  deleted: z.array(z.string()),
  // Agents the manifest stopped declaring: rows deleted, listings unlisted,
  // folders removed — by the sync itself, never by a hand-run data operation.
  retiredAgents: z.array(z.object({ slug: z.string(), path: z.string() })),
})
export type InternalAdminOfficialHubSync = z.infer<typeof InternalAdminOfficialHubSyncSchema>

export const InternalAdminOfficialHubAccessSchema = z.object({
  token: z.string(),
  prefix: z.string(),
  expiresAt: z.number(),
  userId: z.string(),
  workspaceSlug: z.string(),
  created: z.boolean(),
})
export type InternalAdminOfficialHubAccess = z.infer<typeof InternalAdminOfficialHubAccessSchema>

export const InternalAdminVmStatusSchema = z.object({
  workspaceId: z.string(),
  vmName: z.string().optional(),
  controlStatus: z.string().nullable(),
  gateway: z
    .object({
      reachable: z.boolean(),
      instanceId: z.string().min(1).optional(),
      imageVersion: z.string().optional(),
      runtimeVersion: z.string().optional(),
      uptimeSeconds: z.number().nonnegative().optional(),
      error: z.string().optional(),
    })
    .optional(),
  auditId: z.string(),
})
export type InternalAdminVmStatus = z.infer<typeof InternalAdminVmStatusSchema>

export const InternalAdminDirectorySchema = z.object({
  path: z.string(),
  entries: z.array(
    z.object({
      name: z.string(),
      path: z.string(),
      kind: z.enum(['file', 'directory']),
      size: z.number().int().nonnegative().optional(),
    }),
  ),
  truncated: z.boolean(),
  auditId: z.string(),
})
export type InternalAdminDirectory = z.infer<typeof InternalAdminDirectorySchema>
export const InternalAdminFileSchema = z.object({
  path: z.string(),
  content: z.string(),
  byteLength: z.number().int().nonnegative(),
  truncated: z.boolean(),
  auditId: z.string(),
})
export type InternalAdminFile = z.infer<typeof InternalAdminFileSchema>
// Operator log read. Deliberately an enumerated source rather than a path into
// the state dir: that directory also holds `model-credentials.json` and the app
// credential store, and these responses are not redacted, so a path-addressed
// reader would hand out live credentials.
export const InternalAdminLogSourceSchema = z.enum(['gateway', 'agent'])
export type InternalAdminLogSource = z.infer<typeof InternalAdminLogSourceSchema>

export const InternalAdminLogRefSchema = z.object({
  source: InternalAdminLogSourceSchema,
  // Absent for the gateway log and for the drive-root agent.
  anchorId: z.string().optional(),
  byteLength: z.number().int().nonnegative(),
})
export type InternalAdminLogRef = z.infer<typeof InternalAdminLogRefSchema>

export const InternalAdminLogSchema = z.object({
  source: InternalAdminLogSourceSchema,
  anchorId: z.string().optional(),
  path: z.string(),
  // The NEWEST bytes. Logs are size-capped from the front, so the head is the
  // least useful end of the file.
  content: z.string(),
  byteLength: z.number().int().nonnegative(),
  truncated: z.boolean(),
  // Every log this VM can serve, so an operator never has to guess an anchorId.
  available: z.array(InternalAdminLogRefSchema),
  auditId: z.string(),
})
export type InternalAdminLog = z.infer<typeof InternalAdminLogSchema>

export const InternalAdminCommandSchema = z.object({
  command: z.string(),
  stdout: z.string(),
  stderr: z.string(),
  exitCode: z.number().int(),
  durationMs: z.number().nonnegative(),
  truncated: z.boolean(),
  auditId: z.string(),
})
export type InternalAdminCommand = z.infer<typeof InternalAdminCommandSchema>

export const InternalAdminCreateUserRequestSchema = z.object({
  email: z.string().trim().toLowerCase().max(320).email(),
})
export const InternalAdminCreateUserResultSchema = z.object({
  userId: z.string(),
  email: z.string(),
  workspaceId: z.string(),
  workspaceSlug: z.string(),
})
export type InternalAdminCreateUserRequest = z.infer<typeof InternalAdminCreateUserRequestSchema>
export type InternalAdminCreateUserResult = z.infer<typeof InternalAdminCreateUserResultSchema>

/**
 * User cleanup has its own wire contract.  It is intentionally separate from
 * the generic admin operation result: a cleanup is durable, can have one
 * outcome per resource, and may still be waiting on an external provider after
 * its workspace row has been marked deleted.
 */
export const InternalAdminUserLookupQuerySchema = z.object({
  q: z.string().trim().min(1).max(320),
})
export type InternalAdminUserLookupQuery = z.infer<typeof InternalAdminUserLookupQuerySchema>

export const InternalAdminCleanupReasonSchema = InternalAdminAuditReasonSchema
export const InternalAdminCleanupStartRequestSchema = z.object({
  reason: InternalAdminCleanupReasonSchema,
})
export const InternalAdminCleanupRetryRequestSchema = z.object({
  reason: InternalAdminCleanupReasonSchema,
})

export const INTERNAL_ADMIN_CLEANUP_WORKSPACE_CLASSIFICATIONS = [
  'sole_member_delete',
  'shared_membership_detach',
  'shared_payer_transfer_then_detach',
  'blocked_billing_transfer',
] as const
export const InternalAdminCleanupWorkspaceClassificationSchema = z.enum(
  INTERNAL_ADMIN_CLEANUP_WORKSPACE_CLASSIFICATIONS,
)

export const InternalAdminCleanupWorkspaceSchema = z.object({
  workspaceId: z.string().min(1),
  slug: z.string().optional(),
  classification: InternalAdminCleanupWorkspaceClassificationSchema,
  memberCount: z.number().int().nonnegative(),
  targetMembershipId: z.string().optional(),
  targetMembershipGenerationId: z.string().optional(),
  billingUserId: z.string().optional(),
  newBillingUserId: z.string().optional(),
})
export type InternalAdminCleanupWorkspace = z.infer<typeof InternalAdminCleanupWorkspaceSchema>

export const INTERNAL_ADMIN_CLEANUP_BLOCKER_CODES = [
  'self_target',
  'already_retired',
  'bounded_read_overflow',
  'billing_owner_count',
  'membership_changed',
  'workspace_changed',
  'provider_pending',
  'identity_retirement_failed',
  'unknown',
] as const
export const InternalAdminCleanupBlockerSchema = z.object({
  code: z.enum(INTERNAL_ADMIN_CLEANUP_BLOCKER_CODES),
  workspaceId: z.string().optional(),
  table: z.string().optional(),
  cap: z.number().int().nonnegative().optional(),
  observed: z.number().int().nonnegative().optional(),
  ownerCount: z.number().int().nonnegative().optional(),
  detail: z.string().optional(),
})
export type InternalAdminCleanupBlocker = z.infer<typeof InternalAdminCleanupBlockerSchema>

export const InternalAdminCleanupUserSchema = z.object({
  userId: z.string().min(1),
  email: z.string().min(1),
  name: z.string().optional(),
  retiredAt: z.number().optional(),
})

export const InternalAdminCleanupPreviewSchema = z.object({
  user: InternalAdminCleanupUserSchema,
  selfTarget: z.boolean(),
  alreadyRetired: z.boolean(),
  canStart: z.boolean(),
  workspaces: z.array(InternalAdminCleanupWorkspaceSchema),
  blockers: z.array(InternalAdminCleanupBlockerSchema),
  identity: z.object({ kind: z.literal('retire_identity'), userId: z.string().min(1) }),
  retainedHistory: z.object({
    kind: z.literal('retained_history'),
    tables: z.array(z.string().min(1)),
  }),
  activeOperationId: z.string().optional(),
  terminalOperationId: z.string().optional(),
  auditId: z.string(),
})
export type InternalAdminCleanupPreview = z.infer<typeof InternalAdminCleanupPreviewSchema>

export const INTERNAL_ADMIN_CLEANUP_OPERATION_STATUSES = [
  'scheduled',
  'running',
  'completed',
  'blocked',
  'failed',
] as const
export const InternalAdminCleanupOperationStatusSchema = z.enum(
  INTERNAL_ADMIN_CLEANUP_OPERATION_STATUSES,
)

export const INTERNAL_ADMIN_CLEANUP_RESOURCE_STATUSES = [
  'scheduled',
  'running',
  'completed',
  'provider_pending',
  'blocked',
  'failed',
] as const
export const InternalAdminCleanupResourceStatusSchema = z.enum(
  INTERNAL_ADMIN_CLEANUP_RESOURCE_STATUSES,
)
export const INTERNAL_ADMIN_CLEANUP_RESOURCE_OUTCOMES = [
  'workspace_cleanup_scheduled',
  'provider_cleanup_pending',
  'membership_detached',
  'billing_transferred',
  'identity_retired',
  'retained_history',
  'blocked',
  'failed',
] as const
export const InternalAdminCleanupResourceOutcomeSchema = z.enum(
  INTERNAL_ADMIN_CLEANUP_RESOURCE_OUTCOMES,
)

export const InternalAdminCleanupResourceSchema = z.object({
  key: z.string().min(1),
  kind: z.string().min(1),
  status: InternalAdminCleanupResourceStatusSchema,
  outcome: InternalAdminCleanupResourceOutcomeSchema.optional(),
  workspaceId: z.string().optional(),
  membershipGenerationId: z.string().optional(),
  attempts: z.number().int().nonnegative(),
  detail: z.string().optional(),
  lastError: z.string().optional(),
  updatedAt: z.number().optional(),
})
export type InternalAdminCleanupResource = z.infer<typeof InternalAdminCleanupResourceSchema>

export const InternalAdminCleanupOperationSchema = z.object({
  operationId: z.string().min(1),
  targetUserId: z.string().min(1),
  status: InternalAdminCleanupOperationStatusSchema,
  canRetry: z.boolean(),
  replayed: z.boolean().optional(),
  resources: z.array(InternalAdminCleanupResourceSchema),
  startedAt: z.number().optional(),
  completedAt: z.number().optional(),
  lastError: z.string().optional(),
  auditId: z.string().optional(),
})
export type InternalAdminCleanupOperation = z.infer<typeof InternalAdminCleanupOperationSchema>
