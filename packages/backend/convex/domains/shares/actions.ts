import { makeFunctionReference } from 'convex/server'
import { type Infer, v } from 'convex/values'

import { action, type ActionCtx } from '../../_generated/server'
import { duetAppHref } from '../../config'
import { requireApiInternalKey } from '../apiKeys/model'
import type { PreparedShareInvitation } from './model'

const shareMode = v.union(v.literal('read'), v.literal('write'))
const createArgs = v.object({
  internalKey: v.string(),
  actorId: v.id('users'),
  fromWorkspaceId: v.id('workspaces'),
  toEmail: v.string(),
  path: v.string(),
  mode: shareMode,
  ignorePatterns: v.optional(v.array(v.string())),
})
const reshareArgs = v.object({
  internalKey: v.string(),
  actorId: v.id('users'),
  parentShareId: v.id('shares'),
  fromWorkspaceId: v.id('workspaces'),
  toEmail: v.string(),
  mode: shareMode,
  ignorePatterns: v.optional(v.array(v.string())),
})
const createFromApi = makeFunctionReference<'mutation'>('domains/shares/mutations:createFromApi')
const reshareFromApi = makeFunctionReference<'mutation'>('domains/shares/mutations:reshareFromApi')
const revokeAfterDeliveryFailure = makeFunctionReference<'mutation'>(
  'domains/shares/mutations:revokeAfterDeliveryFailure',
)
const sendTransactional = makeFunctionReference<'action'>('services/email:sendTransactional')

export const createAndSendFromApi = action({
  args: createArgs.fields,
  handler: async (ctx, args) =>
    await createAndSend(ctx, args, async (invitationToken, now) => {
      return (await ctx.runMutation(createFromApi, {
        ...args,
        invitationToken,
        now,
      })) as PreparedShareInvitation
    }),
})

export const reshareAndSendFromApi = action({
  args: reshareArgs.fields,
  handler: async (ctx, args) =>
    await createAndSend(ctx, args, async (invitationToken, now) => {
      return (await ctx.runMutation(reshareFromApi, {
        ...args,
        invitationToken,
        now,
      })) as PreparedShareInvitation
    }),
})

async function createAndSend(
  ctx: ActionCtx,
  args: Pick<Infer<typeof createArgs>, 'internalKey' | 'actorId'>,
  create: (invitationToken: string, now: number) => Promise<PreparedShareInvitation>,
) {
  requireApiInternalKey(args.internalKey)
  const invitationToken = `duet_share_${randomHex(32)}`
  const created = await create(invitationToken, Date.now())
  try {
    await sendShareInvite(ctx, created, invitationToken)
  } catch (error) {
    await ctx.runMutation(revokeAfterDeliveryFailure, {
      internalKey: args.internalKey,
      actorId: args.actorId,
      shareId: created.share.id,
      now: Date.now(),
    })
    throw error
  }
  return { share: created.share }
}

export async function sendShareInvite(
  ctx: ActionCtx,
  created: PreparedShareInvitation,
  invitationToken: string,
): Promise<void> {
  await ctx.runAction(sendTransactional, {
    to: created.share.toEmail,
    email: {
      kind: 'share_invite',
      actionUrl: duetAppHref(`/share/${invitationToken}`),
      sharerName: created.sharerName,
      folderName: created.folderName,
    },
    idempotencyKey: `share-invite:${created.share.id}`,
  })
}

function randomHex(bytes: number): string {
  const values = new Uint8Array(bytes)
  crypto.getRandomValues(values)
  return [...values].map(value => value.toString(16).padStart(2, '0')).join('')
}
