import { v } from 'convex/values'

import { WorkspaceSlugSchema } from '@repo/contract'

import { internalQuery } from '../../_generated/server'
import { deriveVmToken } from '../workspaces/vmToken'

export const resolvePublicOrigin = internalQuery({
  args: {
    workspaceSlug: v.string(),
  },
  handler: async (ctx, args) => {
    const slug = WorkspaceSlugSchema.parse(args.workspaceSlug)
    const workspace = await ctx.db
      .query('workspaces')
      .withIndex('by_slug_status', q => q.eq('slug', slug).eq('status', 'active'))
      .first()
    if (
      workspace === null ||
      workspace.suspendedAt !== undefined ||
      workspace.httpsUrl === undefined ||
      workspace.vmName === undefined ||
      workspace.vmTokenNonce === undefined
    ) {
      return null
    }
    return {
      workspaceId: workspace._id,
      workspaceSlug: workspace.slug,
      httpsUrl: workspace.httpsUrl,
      vmName: workspace.vmName,
      gatewayAuthToken: await deriveVmToken(workspace._id, workspace.vmTokenNonce),
    }
  },
})
