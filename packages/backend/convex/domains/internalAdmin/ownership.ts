/**
 * The internal-admin cleanup ownership contract. This is deliberately data,
 * rather than schema introspection: generated auth tables and provider fields
 * are part of the review surface even when Convex does not declare them here.
 */
export const ACTION_KINDS = [
  'delete_workspace',
  'detach_membership',
  'transfer_billing_then_detach',
  'block_billing_transfer',
  'retire_identity',
] as const

export type CleanupActionKind = (typeof ACTION_KINDS)[number]
export type OwnershipOutcome =
  | 'workspace_cascade'
  | 'membership_owner'
  | 'identity_retirement'
  | 'retained_history'
  | 'explicit_blocker'

export type ManifestEntry = {
  table: string
  field: string
  outcome: OwnershipOutcome
  owner: CleanupActionKind | 'retained_history' | 'provider_pending' | 'blocker'
  cap: number
  overflow: 'block' | 'retain'
  reason: string
}

const workspace = (table: string, field: string, reason = 'canonical workspace teardown') => ({
  table,
  field,
  outcome: 'workspace_cascade' as const,
  owner: 'delete_workspace' as const,
  cap: 1000,
  overflow: 'block' as const,
  reason,
})
const membership = (table: string, field: string, reason = 'membership-generation owner') => ({
  table,
  field,
  outcome: 'membership_owner' as const,
  owner: 'detach_membership' as const,
  cap: 500,
  overflow: 'block' as const,
  reason,
})
const identity = (table: string, field: string, reason = 'canonical identity retirement') => ({
  table,
  field,
  outcome: 'identity_retirement' as const,
  owner: 'retire_identity' as const,
  cap: 1000,
  overflow: 'block' as const,
  reason,
})
const retained = (table: string, field: string, reason: string) => ({
  table,
  field,
  outcome: 'retained_history' as const,
  owner: 'retained_history' as const,
  cap: 1000,
  overflow: 'retain' as const,
  reason,
})
const blocker = (
  table: string,
  field: string,
  reason: string,
  owner: 'blocker' | 'block_billing_transfer' = 'blocker',
) => ({
  table,
  field,
  outcome: 'explicit_blocker' as const,
  owner,
  cap: 1000,
  overflow: 'block' as const,
  reason,
})

/** Every direct user reference has exactly one row and one lifecycle outcome. */
export const OWNERSHIP_MANIFEST: readonly ManifestEntry[] = [
  workspace('workspaces', 'createdByUserId'),
  {
    ...workspace('workspaces', 'billingUserId', 'payer may be reassigned before membership detach'),
    owner: 'transfer_billing_then_detach' as const,
  },
  workspace('workspaces', 'suspendedByUserId'),
  membership('workspaceMembers', 'userId'),
  membership('workspaceMemberDirectory', 'userId'),
  membership('memberDirectoryRefreshJobs', 'userId'),
  membership('agentSessionMemberStates', 'membershipId'),
  membership('agentSessionMembershipRemovalJobs', 'membershipId'),
  identity('users', '_id'),
  identity('apiKeys', 'userId'),
  identity('deviceCodes', 'userId'),
  identity('authSignInRequests', 'email'),
  identity('syncMachines', 'userId'),
  identity('oauthAuthorizationRequests', 'userId'),
  identity('oauthAuthorizationCodes', 'userId'),
  identity('oauthGrants', 'userId'),
  identity('oauthRefreshTokens', 'grantId'),
  identity('authSessions', 'userId', 'generated Convex Auth table'),
  identity('authAccounts', 'userId', 'generated Convex Auth table'),
  identity('authVerificationCodes', 'accountId', 'generated Convex Auth table'),
  identity('authRefreshTokens', 'sessionId', 'generated Convex Auth table'),
  identity('authVerifiers', 'sessionId', 'generated Convex Auth table'),
  identity('authRateLimits', 'identifier', 'generated Convex Auth table'),
  retained('auditEvents', 'actorId', 'audit actor foreign keys remain valid'),
  retained('adminAuditEvents', 'actorId', 'admin audit history remains queryable'),
  retained('creditTransactions', 'userId', 'financial ledger is immutable history'),
  retained('creditTransactions', 'actorUserId', 'financial actor history is immutable'),
  retained('usageRollups', 'userId', 'usage history remains reportable'),
  retained('billingSettlements', 'billingUserId', 'settlement history remains intact'),
  retained('billingTopups', 'userId', 'payment history remains intact'),
  retained('gatewayGenerations', 'userId', 'gateway generation history remains intact'),
  retained('campaignAttributions', 'acquiredByUserId', 'attribution history remains intact'),
  retained('conversionInstances', 'attributionId', 'conversion history remains intact'),
  retained('conversionDeliveries', 'userId', 'conversion history remains intact'),
  retained('workspaceInvites', 'inviterUserId', 'historical invite actor is retained'),
  retained('workspaceInvites', 'consumedByUserId', 'historical invite consumer is retained'),
  retained('feedback', 'archivedByUserId', 'moderation history is retained'),
  retained('customDomains', 'createdByUserId', 'workspace soft-delete leaves history'),
  retained('apps', 'createdByUserId', 'workspace soft-delete leaves history'),
  retained('apps', 'disabledByUserId', 'moderation actor is retained'),
  retained('agents', 'createdByUserId', 'workspace soft-delete leaves history'),
  retained('agents', 'disabledByUserId', 'moderation actor is retained'),
  retained('mcpServers', 'createdByUserId', 'workspace soft-delete leaves history'),
  retained('agentListings', 'createdByUserId', 'workspace soft-delete leaves history'),
  retained('agentSubscriptions', 'createdByUserId', 'workspace soft-delete leaves history'),
  retained('publishes', 'createdByUserId', 'workspace soft-delete leaves history'),
  retained('connectedProviders', 'connectedByUserId', 'provider history is retained'),
  retained('connectedProviderConnectIntents', 'initiatedByUserId', 'provider history is retained'),
  retained('shares', 'createdByUserId', 'share history is retained'),
  retained('shares', 'toUserId', 'share history is retained'),
  retained('agentSessions', 'userId', 'session attribution is retained'),
  retained('agentSessionEvents', 'submittingActorId', 'session actor history is retained'),
  retained('sessionReads', 'userId', 'read history is retained'),
  retained('internalAdminCleanupOperations', 'targetUserId', 'operation snapshot is retained'),
  retained('internalAdminCleanupOperations', 'actorId', 'operator audit snapshot is retained'),
  retained('internalAdminCleanupResources', 'newBillingUserId', 'frozen plan snapshot is retained'),
  blocker(
    'officialHub',
    'ownerUserId',
    'official hub has a dedicated owner',
    'block_billing_transfer',
  ),
  blocker('trainJobs', 'userId', 'provider user ids require provider-specific cleanup'),
  blocker('workspaceBackups', 'workspaceId', 'provider backup teardown is asynchronous'),
  blocker(
    'mcpOAuthAuthorizations',
    'workspaceId',
    'provider authorization cleanup requires its owner',
  ),
]

export function assertManifestPolicy(manifest: readonly ManifestEntry[]): void {
  if (manifest.length === 0) throw new Error('cleanup ownership manifest is empty')
  const seen = new Set<string>()
  for (const entry of manifest) {
    const key = `${entry.table}.${entry.field}`
    if (seen.has(key)) throw new Error(`duplicate cleanup ownership field: ${key}`)
    seen.add(key)
    if (entry.cap <= 0 || !Number.isSafeInteger(entry.cap))
      throw new Error(`invalid bounded-read cap for ${key}`)
    if (entry.overflow === 'block' && entry.outcome === 'retained_history')
      throw new Error(`retained history cannot block overflow: ${key}`)
  }
  for (const kind of ACTION_KINDS) {
    if (kind === 'retire_identity') {
      if (!manifest.some(entry => entry.owner === kind)) throw new Error(`missing owner: ${kind}`)
    } else if (!manifest.some(entry => entry.owner === kind)) {
      throw new Error(`missing owner: ${kind}`)
    }
  }
}

export type PlannerMember = {
  membershipId: string
  userId: string
  role: 'owner' | 'editor' | 'viewer'
  generationId: string
  live?: boolean
}

export type PlannerWorkspace = {
  workspaceId: string
  status: 'provisioning' | 'active' | 'unhealthy' | 'archived' | 'retired' | 'deleted'
  billingUserId: string
  members: PlannerMember[]
  overflow?: { table: string; cap: number; observed: number }
}

export type CleanupPlannerInput = {
  targetUserId: string
  selfTarget?: boolean
  workspaces: PlannerWorkspace[]
}

export type CleanupAction = {
  kind: Exclude<CleanupActionKind, 'retire_identity'>
  key: string
  workspaceId: string
  membershipGenerationId?: string
  membershipId?: string
  newBillingUserId?: string
  reason?: string
}

export type CleanupPlan = {
  canStart: boolean
  workspaceActions: CleanupAction[]
  identity: { kind: 'retire_identity'; key: string; userId: string }
  retainedHistory: { kind: 'retained_history'; tables: string[] }
  blockers: Array<{
    code: 'self_target' | 'bounded_read_overflow' | 'billing_owner_count'
    workspaceId?: string
    table?: string
    cap?: number
    observed?: number
    ownerCount?: number
  }>
}

export type CleanupPlannerFixture = {
  id: string
  input: CleanupPlannerInput
  expected: CleanupPlan
}
