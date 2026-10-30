import type { CleanupAction, CleanupPlan, CleanupPlannerInput, PlannerWorkspace } from './ownership'
export type { CleanupPlan, PlannerWorkspace } from './ownership'

const liveMembers = (workspace: PlannerWorkspace) =>
  workspace.members.filter(member => member.live !== false)

export function planUserCleanup(input: CleanupPlannerInput): CleanupPlan {
  const blockers: CleanupPlan['blockers'] = input.selfTarget ? [{ code: 'self_target' }] : []
  const workspaceActions: CleanupAction[] = []

  for (const workspace of [...input.workspaces].sort((a, b) =>
    a.workspaceId.localeCompare(b.workspaceId),
  )) {
    if (workspace.overflow !== undefined) {
      blockers.push({
        code: 'bounded_read_overflow',
        workspaceId: workspace.workspaceId,
        table: workspace.overflow.table,
        cap: workspace.overflow.cap,
        observed: workspace.overflow.observed,
      })
      continue
    }
    if (workspace.status === 'deleted') continue
    const members = liveMembers(workspace)
    const target = members.find(member => member.userId === input.targetUserId)
    if (target === undefined) continue
    const keyBase = `workspace:${workspace.workspaceId}:membership:${target.generationId}`
    if (members.length === 1) {
      workspaceActions.push({
        kind: 'delete_workspace',
        key: `workspace:${workspace.workspaceId}:delete`,
        workspaceId: workspace.workspaceId,
        membershipGenerationId: target.generationId,
        membershipId: target.membershipId,
      })
      continue
    }
    if (workspace.billingUserId !== input.targetUserId) {
      workspaceActions.push({
        kind: 'detach_membership',
        key: keyBase,
        workspaceId: workspace.workspaceId,
        membershipGenerationId: target.generationId,
        membershipId: target.membershipId,
      })
      continue
    }
    const owners = members.filter(
      member => member.role === 'owner' && member.userId !== target.userId,
    )
    if (owners.length !== 1) {
      blockers.push({
        code: 'billing_owner_count',
        workspaceId: workspace.workspaceId,
        ownerCount: owners.length,
      })
      workspaceActions.push({
        kind: 'block_billing_transfer',
        key: keyBase,
        workspaceId: workspace.workspaceId,
        membershipGenerationId: target.generationId,
        membershipId: target.membershipId,
        reason: `expected exactly one remaining owner, found ${owners.length}`,
      })
      continue
    }
    workspaceActions.push({
      kind: 'transfer_billing_then_detach',
      key: keyBase,
      workspaceId: workspace.workspaceId,
      membershipGenerationId: target.generationId,
      membershipId: target.membershipId,
      newBillingUserId: owners[0]!.userId,
    })
  }

  const identity = {
    kind: 'retire_identity' as const,
    key: `identity:${input.targetUserId}`,
    userId: input.targetUserId,
  }
  return {
    canStart: blockers.length === 0,
    workspaceActions,
    identity,
    retainedHistory: {
      kind: 'retained_history',
      tables: [
        'auditEvents',
        'adminAuditEvents',
        'creditTransactions',
        'usageRollups',
        'billingSettlements',
        'billingTopups',
        'gatewayGenerations',
        'campaignAttributions',
        'conversionDeliveries',
      ],
    },
    blockers,
  }
}
