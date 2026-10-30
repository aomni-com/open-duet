'use node'

import { v } from 'convex/values'

import { internal } from '../_generated/api'
import { internalAction } from '../_generated/server'
import { resendUsersSegmentId } from '../config'
import { syncResendContact } from './resendTransport'

export const syncUser = internalAction({
  args: { userId: v.id('users') },
  handler: async (ctx, args) => {
    const contact = await ctx.runQuery(internal.domains.users.queries.resendContact, args)
    if (contact !== null) await syncResendContact(contact, resendUsersSegmentId())
  },
})
