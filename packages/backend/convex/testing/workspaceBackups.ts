import { v } from 'convex/values'

import type { Id } from '../_generated/dataModel'
import { mutation } from '../_generated/server'
import { createSessionForInitialDelivery } from '../domains/agentSessions/creation'
import { deleteSessionDiscovery } from '../domains/agentSessions/discovery'
import { requireApiInternalKey } from '../domains/apiKeys/model'

/** Inert history deliberately absent from UI discovery exercises the canonical export. */
export const seedMetadata = mutation({
  args: {
    internalKey: v.string(),
    workspaceId: v.id('workspaces'),
    agentId: v.id('agents'),
    imageStorageId: v.id('_storage'),
    imageBytes: v.number(),
    marker: v.string(),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const workspace = await ctx.db.get(args.workspaceId)
    const agent = await ctx.db.get(args.agentId)
    if (!workspace?.ephemeral || agent?.workspaceId !== workspace._id)
      throw new Error('Backup fixtures require an ephemeral workspace and its agent')
    const now = Date.now()
    const common = {
      workspaceId: workspace._id,
      userId: workspace.billingUserId,
      agentId: agent._id,
      audienceKind: 'workspace' as const,
      turnStatus: 'complete' as const,
      bucket: 'done' as const,
      prompt: args.marker,
      titleOrigin: 'manual' as const,
      titleStatus: 'complete' as const,
      searchText: args.marker,
      archiveState: 'archived' as const,
      archivedAt: now,
      visible: false,
      lastRunnerInputSeq: 0,
      runnerInputPending: false,
      lastDeliveredInputSeq: 0,
      createdAt: now,
      updatedAt: now,
    }
    const createHistory = async (
      title: string,
      lastEventSeq: number,
      createdBySessionId?: Id<'agentSessions'>,
    ) => {
      const session = await createSessionForInitialDelivery(
        ctx,
        {
          workspaceId: workspace._id,
          actorId: workspace.billingUserId,
          now,
          audience: { kind: 'workspace' },
          tier: 'balanced',
          createdBySessionId,
          resolvedAgent: { agentId: agent._id, agentName: agent.name ?? agent.slug },
          // Setup mode suppresses title work and usage analytics while this fixture
          // replaces the initial envelope with its deliberately inert history.
          onboarding: true,
          input: {
            kind: 'initial_prompt',
            prompt: args.marker,
            behavior: 'steer',
            sender: { kind: 'user', userId: workspace.billingUserId },
          },
        },
        new Date(now).toISOString(),
      )
      for (const event of await ctx.db
        .query('agentSessionEvents')
        .withIndex('by_session_seq', q => q.eq('sessionId', session._id))
        .collect())
        await ctx.db.delete(event._id)
      await ctx.db.patch(session._id, { ...common, title, lastEventSeq, onboarding: undefined })
      await deleteSessionDiscovery(ctx, session._id)
      return session._id
    }
    const parentId = await createHistory(`Archived ${args.marker}`, 260)
    const childId = await createHistory(`Hidden child ${args.marker}`, 1, parentId)
    await ctx.db.insert('agentSessionImages', {
      workspaceId: workspace._id,
      sessionId: parentId,
      storageId: args.imageStorageId,
      mimeType: 'image/png',
      bytes: args.imageBytes,
    })
    for (let seq = 1; seq <= 260; seq++) {
      await ctx.db.insert('agentSessionEvents', {
        workspaceId: workspace._id,
        sessionId: parentId,
        seq,
        createdAt: now,
        submittingActorId: workspace.billingUserId,
        clientRequestId: 'excluded-backup-fixture-request',
        event:
          seq === 1
            ? {
                type: 'prompt_submitted',
                prompt: args.marker,
                sender: { kind: 'user', userId: workspace.billingUserId },
                images: [
                  { storageId: args.imageStorageId, mimeType: 'image/png', bytes: args.imageBytes },
                ],
              }
            : { type: 'task_output', taskId: 'backup-fixture', chunk: `${args.marker}:${seq}\n` },
      })
    }
    await ctx.db.insert('agentSessionEvents', {
      workspaceId: workspace._id,
      sessionId: childId,
      seq: 1,
      createdAt: now,
      event: { type: 'agent_message', message: `Child ${args.marker}` },
    })
    await ctx.db.insert('integrationAgentPolicies', {
      workspaceId: workspace._id,
      toolkitSlug: 'github',
      allowedAgentIds: [agent._id],
      createdAt: now,
      updatedAt: now,
    })
    const serverId = await ctx.db.insert('mcpServers', {
      workspaceId: workspace._id,
      name: 'backup-fixture',
      label: 'Backup fixture',
      url: 'https://backup-fixture.invalid/mcp',
      authKind: 'static',
      state: 'ready',
      createdAt: now,
      updatedAt: now,
      createdByUserId: workspace.billingUserId,
    })
    await ctx.db.insert('mcpServerCredentials', {
      workspaceId: workspace._id,
      serverId,
      kind: 'static',
      accessToken: 'synthetic-backup-static-token',
      tokenType: 'Bearer',
      generation: 1,
      createdAt: now,
      updatedAt: now,
    })
    // No agent should attempt to connect to the inert fixture endpoint.
    await ctx.db.insert('mcpServerAgentPolicies', {
      workspaceId: workspace._id,
      serverId,
      allowedAgentIds: [],
      createdAt: now,
      updatedAt: now,
    })
    return { parentId, childId, eventCount: 260 }
  },
})
