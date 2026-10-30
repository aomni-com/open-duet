'use node'

import { makeFunctionReference } from 'convex/server'
import { v } from 'convex/values'

import { action } from '../_generated/server'
import { duetAppHref } from '../config'
import { requireApiInternalKey } from '../domains/apiKeys/model'

const shareEmailFixture = makeFunctionReference<'query'>('testing/shares:shareEmailFixtureForTest')
const sendTransactional = makeFunctionReference<'action'>('services/email:sendTransactional')

export const resendForTest = action({
  args: { internalKey: v.string(), shareId: v.id('shares') },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const created = (await ctx.runQuery(shareEmailFixture, args)) as {
      share: { id: string; toEmail: string }
      sharerName: string
      folderName: string
    }
    const invitationToken = `duet_share_${'0'.repeat(64)}`
    return await ctx.runAction(sendTransactional, {
      to: created.share.toEmail,
      email: {
        kind: 'share_invite',
        actionUrl: duetAppHref(`/share/${invitationToken}`),
        sharerName: created.sharerName,
        folderName: created.folderName,
      },
      idempotencyKey: `share-invite:${created.share.id}`,
    })
  },
})
