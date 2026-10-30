import type { Doc, Id } from '../../_generated/dataModel'
import type { MutationCtx } from '../../_generated/server'
import { terminalizeAgentSessions } from '../agentSessions/events'
import { anchorHasLiveConsumer } from '../anchors/consumers'
import { writeAuditEvent } from '../audit/model'
import { detachMarketplaceAgentSubscription } from '../marketplace/ownership'
import { reconcileReplicasForOriginAgent } from './replication'

/**
 * Tear down one agent row: its marketplace subscription, the row, its anchor's
 * consumer claim, its replicas, its sessions, and the audit trail.
 *
 * The anchor is passed in rather than read here — see the note on
 * `deleteAppRow`, which this mirrors.
 */
export async function deleteAgentRow(
  ctx: MutationCtx,
  args: { agent: Doc<'agents'>; anchor: Doc<'anchors'>; actorId: Id<'users'>; now: number },
): Promise<{ affectedRecipientWorkspaceIds: Id<'workspaces'>[] }> {
  const { agent, anchor, actorId, now } = args
  if (agent.listingSubscriptionId !== undefined) {
    const subscription = await ctx.db.get(agent.listingSubscriptionId)
    if (subscription === null) throw new Error('Marketplace agent subscription not found')
    await detachMarketplaceAgentSubscription(ctx, subscription, now)
  }
  // Capture the replicas before reconcile deletes their rows: each carries its own
  // agentId in its own workspace, so its live sessions must be terminalized there too
  // (D16), or a recipient keeps ghost sessions under an agent that left their rail.
  const replicas = await ctx.db
    .query('agents')
    .withIndex('by_source_agent', q => q.eq('sourceAgentId', agent._id))
    .collect()
  await ctx.db.delete(agent._id)
  if (!(await anchorHasLiveConsumer(ctx, agent.anchorId))) {
    await ctx.db.patch(agent.anchorId, { state: 'orphaned', updatedAt: now })
  }
  const fanout = await reconcileReplicasForOriginAgent(ctx, { originAgent: agent, now })
  // Control-plane half of D16: terminalize the deleted agent's (and each replica's)
  // non-terminal sessions. Convergence is async + batched, so the REST response stays
  // {ok:true}; the runner-teardown half rides the API's gateway leg (fail-closed).
  await terminalizeAgentSessions(ctx, { workspaceId: agent.workspaceId, agentId: agent._id, now })
  for (const replica of replicas) {
    await terminalizeAgentSessions(ctx, {
      workspaceId: replica.workspaceId,
      agentId: replica._id,
      now,
    })
  }
  await writeAuditEvent(ctx, {
    workspaceId: agent.workspaceId,
    event: 'agent.deleted',
    actorId,
    at: now,
    provenance: {
      agentId: agent._id,
      anchorId: agent.anchorId,
      path: anchor.path,
      slug: agent.slug,
    },
  })
  return fanout
}
