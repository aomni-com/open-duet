'use node'

import { makeFunctionReference } from 'convex/server'
import { v } from 'convex/values'

import { action, type ActionCtx } from '../../_generated/server'
import { duetAppHref } from '../../config'
import { requireApiInternalKey } from '../apiKeys/model'

const inviteRole = v.union(v.literal('editor'), v.literal('viewer'))
const createInviteFromApi = makeFunctionReference<'mutation'>(
  'domains/invitations/mutations:createFromApi',
)
const revokeInviteFromApi = makeFunctionReference<'mutation'>(
  'domains/invitations/mutations:revokeFromApi',
)
const sendTransactional = makeFunctionReference<'action'>('services/email:sendTransactional')

export const createAndSendFromApi = action({
  args: {
    internalKey: v.string(),
    actorId: v.id('users'),
    workspaceId: v.id('workspaces'),
    email: v.string(),
    role: inviteRole,
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const token = `${crypto.randomUUID().replaceAll('-', '')}${crypto.randomUUID().replaceAll('-', '')}`
    const invite = await ctx.runMutation(createInviteFromApi, {
      ...args,
      token,
      now: Date.now(),
    })
    try {
      await sendInviteEmail(ctx, invite, token)
    } catch (error) {
      await ctx.runMutation(revokeInviteFromApi, {
        internalKey: args.internalKey,
        actorId: args.actorId,
        inviteId: invite._id,
        now: Date.now(),
      })
      throw error
    }
    return visibleInvite(invite)
  },
})

async function sendInviteEmail(
  ctx: ActionCtx,
  invite: { _id: string; email: string; role: 'editor' | 'viewer' },
  token: string,
) {
  await ctx.runAction(sendTransactional, {
    to: invite.email,
    email: {
      kind: 'workspace_invite',
      actionUrl: duetAppHref(`/invite/${token}`),
      role: invite.role,
    },
    idempotencyKey: `workspace-invite:${invite._id}`,
  })
}

function visibleInvite(invite: {
  _id: string
  email: string
  role: 'editor' | 'viewer'
  expiresAt: number
}) {
  return { id: invite._id, email: invite.email, role: invite.role, expiresAt: invite.expiresAt }
}
