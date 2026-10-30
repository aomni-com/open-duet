import { z } from 'zod'

import { AgentNameSchema, MAX_AGENT_NAME_LENGTH } from '../agents/index'
// Deliberately the leaf file rather than `../auth/index`: that module's sign-in
// schemas import this one, and importing it back here is a runtime cycle.
import { ApiCredentialKindSchema } from '../auth/credential-kind'
import { MicroUsdAmountSchema } from '../ledger/index'
import { ModelSelectionIdSchema, RecordedModelSelectionIdSchema } from '../model-tiers/index'
import { CollectionPageQuerySchema, collectionPageSchema } from '../pagination/index'
import { SubscriptionPlanIdSchema } from '../plans/index'
import { AppSlugSchema, WorkspaceSlugSchema } from '../slug/index'
import { WORKSPACE_MEMBER_LIMIT } from './limits'
import { WorkspaceNameSchema } from './name'

export { WORKSPACE_MEMBER_LIMIT } from './limits'
export * from './name'

const WorkspaceStatusSchema = z.enum([
  'provisioning',
  'active',
  'unhealthy',
  'archived',
  'retired',
  'deleted',
])
export type WorkspaceStatus = z.infer<typeof WorkspaceStatusSchema>

export const WorkspaceRoleSchema = z.enum(['owner', 'editor', 'viewer'])
export type WorkspaceRole = z.infer<typeof WorkspaceRoleSchema>

const WorkspaceServicingStatusSchema = z.enum(['active', 'paused', 'banned'])

const WorkspaceInviteRoleSchema = z.enum(['editor', 'viewer'])

// The drive root's name is an agent's name — it lives on the workspace only
// because the root has no agent row to carry it — so it obeys the one rule
// rather than a second that could drift from it.
export const WORKSPACE_DUET_NAME_MAX_LENGTH = MAX_AGENT_NAME_LENGTH
export const WorkspaceDuetNameSchema = AgentNameSchema
export type WorkspaceDuetName = z.infer<typeof WorkspaceDuetNameSchema>

// One opaque paragraph composed client-side from the user's own tapped words;
// the platform transports and stores it, never parses it.
export const WORKSPACE_PURPOSE_MAX_LENGTH = 1000
export const WorkspacePurposeSchema = z.string().trim().min(1).max(WORKSPACE_PURPOSE_MAX_LENGTH)
export type WorkspacePurpose = z.infer<typeof WorkspacePurposeSchema>

export const WorkspaceInviteCreateRequestSchema = z.object({
  email: z.email(),
  role: WorkspaceInviteRoleSchema.optional().describe('Defaults to editor.'),
})

export const WorkspaceInviteSchema = z.object({
  id: z.string(),
  email: z.email(),
  role: WorkspaceInviteRoleSchema,
  expiresAt: z.number().int().positive(),
  revokedAt: z.number().int().positive().optional(),
  consumedAt: z.number().int().positive().optional(),
})
export type WorkspaceInvite = z.infer<typeof WorkspaceInviteSchema>

export const WorkspaceInviteListQuerySchema = CollectionPageQuerySchema
export const WorkspaceInvitePageSchema = collectionPageSchema(WorkspaceInviteSchema)
export const WorkspaceInviteRevokedSchema = z.object({ revokedAt: z.number().int().positive() })

export const IncomingWorkspaceInviteSchema = z.object({
  id: z.string(),
  workspace: z.object({ id: z.string(), name: z.string(), slug: z.string() }),
  inviter: z.object({ name: z.string().optional(), email: z.email() }).nullable(),
  role: WorkspaceInviteRoleSchema,
  expiresAt: z.number().int().positive(),
})
export type IncomingWorkspaceInvite = z.infer<typeof IncomingWorkspaceInviteSchema>
export const IncomingWorkspaceInviteListQuerySchema = CollectionPageQuerySchema
export const IncomingWorkspaceInvitePageSchema = collectionPageSchema(IncomingWorkspaceInviteSchema)
export const WorkspaceInviteAcceptedSchema = z.object({
  workspaceId: z.string(),
  workspaceSlug: z.string(),
})

/**
 * How long a workspace survives once it stops being serviced.
 *
 * One number, read by the sweep that destroys the workspace and by the wall
 * that warns about it. It lived in the backend while only the sweep used it;
 * a countdown the user can act on has to be computed from the same constant
 * the reaper obeys, or the promise on screen is a different promise. Nothing
 * may restate it — every test, fixture and staging journey that needs the
 * deadline derives it from here, so changing the policy is changing this line.
 *
 * Two days, down from seven (David, 2026-08-27). The window is pure carrying
 * cost: a paused workspace holds a full VM — provider-billed CPU, RAM and
 * disk — for a payer who has stopped paying, and at the observed rate of trial
 * expiries the seven-day rule was converging on roughly 200 idle VMs. Nothing
 * is preserved by waiting, either: an archive is pulled only for a payer who
 * has actually subscribed, so a lapsed trial's files are destroyed on the last
 * day of the window exactly as they would be on the first.
 */
export const SERVICING_ARCHIVE_AFTER_MS = 2 * 24 * 60 * 60 * 1000

/** Whole days left before an unserviced workspace is destroyed, floored at 0. */
export function servicingDaysUntilDecommission(
  servicingStatusChangedAt: number | undefined,
  now: number,
): number | undefined {
  if (servicingStatusChangedAt === undefined) return undefined
  const remaining = servicingStatusChangedAt + SERVICING_ARCHIVE_AFTER_MS - now
  return remaining <= 0 ? 0 : Math.ceil(remaining / (24 * 60 * 60 * 1000))
}

/**
 * Whether the person who funds THIS workspace is entitled.
 *
 * Per workspace, beside the `billingUserId` it describes, because a top-level
 * block would report the *signed-in user's* plan: a member of a workspace
 * someone else pays for reads `plan: null, active: false` while everything
 * works, and an agent reading that asks its human to buy what is already
 * bought.
 *
 * It does not overlap `servicingStatus`, which answers "is this workspace
 * being serviced" — a workspace can be exempt (Duet pays) with an unentitled
 * payer, or banned with a subscribed one. A member needs both answers.
 *
 * `plan` is nullable rather than optional so its presence is unconditional and
 * a reader never has to tell "no plan" apart from "an older server".
 */
const WorkspaceFundingSchema = z.object({
  /** The payer's plan while their subscription is live; `null` on a trial or a lapse. */
  plan: SubscriptionPlanIdSchema.nullable(),
  /** Subscribed, or inside a funded trial. The same verdict servicing pauses on. */
  active: z.boolean(),
  /** Present only while an unconverted trial is still running. */
  trialEndsAt: z.number().int().positive().optional(),
})
export type WorkspaceFunding = z.infer<typeof WorkspaceFundingSchema>

export const WorkspaceCreditRecoverySchema = z.enum(['subscribe', 'topup']).nullable()
export type WorkspaceCreditRecovery = z.infer<typeof WorkspaceCreditRecoverySchema>

const WorkspaceSummarySchema = z.object({
  id: z.string(),
  slug: WorkspaceSlugSchema,
  name: z.string(),
  status: WorkspaceStatusSchema,
  servicingStatus: WorkspaceServicingStatusSchema,
  /**
   * When the workspace entered its current servicing state.
   *
   * On the wire because the deadline is the reader's business: a paused
   * workspace is destroyed `SERVICING_ARCHIVE_AFTER_MS` after this instant,
   * and a wall that cannot say WHEN can only say "soon" — which is what it
   * said, in the same words, on the first day and the last.
   */
  servicingStatusChangedAt: z.number().int().positive().optional(),
  role: WorkspaceRoleSchema,
  billingUserId: z.string(),
  funding: WorkspaceFundingSchema,
  creditRecovery: WorkspaceCreditRecoverySchema,
  defaultTier: z.object({
    configured: ModelSelectionIdSchema.optional(),
    effective: ModelSelectionIdSchema,
  }),
  duetName: WorkspaceDuetNameSchema.optional(),
  purpose: WorkspacePurposeSchema.optional(),
  onboardedAt: z.number().int().positive().optional(),
  onboarding: z
    .object({
      starterAgents: z.array(AppSlugSchema),
    })
    .optional(),
  adminMessage: z.string().optional(),
})
export type WorkspaceSummary = z.infer<typeof WorkspaceSummarySchema>

export const WhoamiResponseSchema = z.object({
  user: z.object({
    id: z.string(),
    email: z.email(),
    name: z.string().optional(),
  }),
  workspaces: z.array(WorkspaceSummarySchema),
  scopes: z.array(z.string()),
  versions: z.object({ api: z.literal(1) }),
  internalAdmin: z.boolean(),
  credential: z
    .object({
      kind: ApiCredentialKindSchema,
      audience: z.url().optional(),
    })
    .optional(),
})
export type WhoamiResponse = z.infer<typeof WhoamiResponseSchema>

const WorkspaceMemberSchema = z.object({
  id: z.string(),
  email: z.email(),
  name: z.string().optional(),
  role: WorkspaceRoleSchema,
  isBillingUser: z.boolean(),
})
export type WorkspaceMember = z.infer<typeof WorkspaceMemberSchema>

export function normalizeWorkspaceMemberSearch(value: string | undefined): string {
  return (value ?? '').normalize('NFKC').trim().toLocaleLowerCase('en-US').slice(0, 32)
}

export const WorkspaceMembersQuerySchema = CollectionPageQuerySchema.extend({
  search: z.string().trim().min(1).max(32).optional(),
}).strict()
export const WorkspaceMembersPageSchema = collectionPageSchema(WorkspaceMemberSchema)

export const WorkspaceMemberRoleRequestSchema = z.object({ role: WorkspaceRoleSchema })
export const WorkspaceMemberRoleResponseSchema = z.object({ member: WorkspaceMemberSchema })
export const WorkspaceMemberRemovedSchema = z.object({ removed: z.boolean() })

export const WorkspaceBillingUserRequestSchema = z.object({ userId: z.string().min(1) })
export const WorkspaceBillingUserResponseSchema = z.object({
  billingUserId: z.string(),
  member: WorkspaceMemberSchema,
})

export const WorkspaceBillingCapRequestSchema = z.object({
  monthlyCapMicroUsd: MicroUsdAmountSchema.nonnegative().nullable(),
})
export const WorkspaceBillingCapResponseSchema = WorkspaceBillingCapRequestSchema

export const WorkspaceDefaultModelRequestSchema = z.object({
  tier: ModelSelectionIdSchema,
})
export const WorkspaceDefaultModelResponseSchema = WorkspaceDefaultModelRequestSchema

const RenameCandidateProvenanceSchema = z.object({
  fromPath: z.string(),
  toPath: z.string(),
  confidence: z.number(),
  inodeMatch: z.boolean(),
  markerMatch: z.boolean(),
})

export const MAX_AUDIT_PROVENANCE_JSON_BYTES = 32 * 1024

const WorkspaceRoleProvenanceSchema = z.enum(['owner', 'editor', 'viewer'])

// Mirror of the backend's `auditProvenance` Convex validator (the write-time
// authority). A compile-time bridge in packages/backend asserts the two shapes
// stay key- and type-compatible; extend both together.
export const WorkspaceAuditProvenanceSchema = z.object({
  action: z.string().optional(),
  activeAgentSessions: z.number().optional(),
  activeTrainJobs: z.number().optional(),
  actor: z.string().optional(),
  acknowledged: z.boolean().optional(),
  agentVersion: z.string().optional(),
  anchorId: z.string().optional(),
  appId: z.string().optional(),
  appSlug: z.string().optional(),
  agentId: z.string().optional(),
  archiveStorageId: z.string().optional(),
  lifecycleBackupId: z.string().optional(),
  breaksPublicUrls: z.boolean().optional(),
  canonicalEmail: z.string().optional(),
  candidates: z.array(RenameCandidateProvenanceSchema).optional(),
  conflictingAnchorId: z.string().optional(),
  conflictingPath: z.string().optional(),
  confidence: z.number().optional(),
  cpu: z.number().optional(),
  /** Polls in a row that found the folder missing before its rows were reaped. */
  consecutiveMissingPolls: z.number().optional(),
  /** Which rows a reap took with the folder: 'app', 'agent', or both. */
  deleted: z.array(z.string()).optional(),
  deviceCode: z.string().optional(),
  deviceId: z.string().optional(),
  deviceName: z.string().optional(),
  defaultModelId: z.string().optional(),
  tier: RecordedModelSelectionIdSchema.optional(),
  expiresAt: z.number().optional(),
  fromPath: z.string().optional(),
  fromWorkspaceId: z.string().optional(),
  runtimeVersion: z.string().optional(),
  gatewayVersion: z.string().optional(),
  generation: z.string().optional(),
  imageRef: z.string().optional(),
  imageVersion: z.string().optional(),
  inodeMatch: z.boolean().optional(),
  installMode: z.enum(['subscribe', 'clone_once']).optional(),
  kind: z
    .enum(['app', 'agent', 'publish', 'share-root', 'share-mount', 'file', 'folder'])
    .optional(),
  lastHeartbeatAt: z.number().optional(),
  listingId: z.string().optional(),
  listingSlug: z.string().optional(),
  markerMatch: z.boolean().optional(),
  memory: z.string().optional(),
  memberUserId: z.string().optional(),
  name: z.string().optional(),
  newBillingUserId: z.string().optional(),
  mode: z.enum(['read', 'write']).optional(),
  mountPath: z.string().optional(),
  newSlug: z.string().optional(),
  /** The workspace status a replayed registration found (`active`/`unhealthy`). */
  previousStatus: z.string().optional(),
  oldPrefixes: z.array(z.string()).optional(),
  oldBillingUserId: z.string().optional(),
  oldSlug: z.string().optional(),
  parentShareId: z.string().optional(),
  path: z.string().optional(),
  prefix: z.string().optional(),
  credentialId: z.string().optional(),
  purpose: z.enum(['managed', 'exported']).optional(),
  prefixes: z.array(z.string()).optional(),
  previousVmName: z.string().optional(),
  publishId: z.string().optional(),
  reason: z.string().optional(),
  revokedShareIds: z.array(z.string()).optional(),
  role: WorkspaceRoleProvenanceSchema.optional(),
  oldRole: WorkspaceRoleProvenanceSchema.optional(),
  scopes: z.array(z.string()).optional(),
  // On agent.onboarded: the onboarding conversation the agent completed itself
  // from, distinguishing self-completion from a human's card toggle.
  sessionId: z.string().optional(),
  shareId: z.string().optional(),
  slug: z.string().optional(),
  source: z.string().optional(),
  subscriptionId: z.string().optional(),
  targetEmail: z.string().optional(),
  toPath: z.string().optional(),
  toWorkspaceId: z.string().optional(),
  userCode: z.string().optional(),
  visibility: z.enum(['folder', 'public']).optional(),
  vmName: z.string().optional(),
})
export type WorkspaceAuditProvenance = z.infer<typeof WorkspaceAuditProvenanceSchema>

const WorkspaceAuditEventSchema = z.object({
  id: z.string(),
  event: z.string(),
  actorId: z.string(),
  at: z.number().int().positive(),
  provenance: WorkspaceAuditProvenanceSchema.optional(),
})

export const WorkspaceAuditPageSchema = collectionPageSchema(WorkspaceAuditEventSchema)
export type WorkspaceAuditPage = z.infer<typeof WorkspaceAuditPageSchema>

export const WorkspaceCreateResultSchema = z.object({
  workspaceId: z.string(),
  slug: WorkspaceSlugSchema,
  status: z.literal('provisioning'),
})
export type WorkspaceCreateResult = z.infer<typeof WorkspaceCreateResultSchema>

export const WorkspaceCreateRequestSchema = z.object({
  slug: WorkspaceSlugSchema,
  name: WorkspaceNameSchema,
})

/**
 * Why a birth can be refused, in a word the caller can act on.
 *
 * The reason travels as data rather than a message so the surface asking for
 * the drive can explain the applicable billing rule and offer a way forward.
 */
export const WorkspaceCreateRefusalSchema = z.object({
  error: z.literal('workspace_limit_reached'),
  plan: SubscriptionPlanIdSchema,
  limit: z.number().int().positive(),
})
export type WorkspaceCreateRefusal = z.infer<typeof WorkspaceCreateRefusalSchema>

/** A valid admission lost the workspace's final available member slot. */
export const WorkspaceMemberAdmissionRefusalSchema = z.object({
  error: z.literal('workspace_member_limit_reached'),
  limit: z.literal(WORKSPACE_MEMBER_LIMIT),
})
export type WorkspaceMemberAdmissionRefusal = z.infer<typeof WorkspaceMemberAdmissionRefusalSchema>

export const WorkspaceReprovisionResponseSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('backup_pending'),
    workspaceId: z.string(),
    backupId: z.string(),
  }),
  z.object({
    status: z.literal('provisioning'),
    workspaceId: z.string(),
    scheduled: z.boolean(),
    oldVmName: z.string().optional(),
    imageRef: z.string().optional(),
  }),
  z.object({
    status: z.literal('deferred'),
    reason: z.literal('active_workspace_work'),
    activeAgentSessions: z.number().int().nonnegative(),
    activeTrainJobs: z.number().int().nonnegative(),
  }),
])

export const WorkspaceRenameRequestSchema = z.object({
  slug: WorkspaceSlugSchema,
  name: WorkspaceNameSchema.optional(),
  publicUrlBreakAcknowledged: z.literal(true),
})
export const WorkspaceRenameResponseSchema = z.object({
  ok: z.literal(true),
  breaksPublicUrls: z.literal(true),
})

export const WorkspaceSuspensionRequestSchema = z.object({
  suspended: z.boolean(),
  reason: z.string().optional(),
})
export const WorkspaceSuspensionResponseSchema = z.discriminatedUnion('suspended', [
  z.object({
    suspended: z.literal(true),
    suspendedAt: z.number(),
    suspensionReason: z.string().optional(),
  }),
  z.object({ suspended: z.literal(false) }),
])

export const WorkspaceAuditQuerySchema = CollectionPageQuerySchema
