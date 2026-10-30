import { paginationOptsValidator } from 'convex/server'
import { v } from 'convex/values'

import { query } from '../../_generated/server'
import { requireApiInternalKey } from '../apiKeys/model'
import { listIncomingInvites, listInvitesForActor } from './model'

export const listFromApi = query({
  args: {
    internalKey: v.string(),
    actorId: v.id('users'),
    workspaceId: v.id('workspaces'),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    return await listInvitesForActor(ctx, args.workspaceId, args.actorId, args.paginationOpts)
  },
})

export const incomingFromApi = query({
  args: {
    internalKey: v.string(),
    actorId: v.id('users'),
    asOf: v.number(),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    return await listIncomingInvites(ctx, args.actorId, args.asOf, args.paginationOpts)
  },
})
