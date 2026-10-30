import type { Id } from '../../_generated/dataModel'
import type { MutationCtx } from '../../_generated/server'
import { deleteWorkspaceMembershipGeneration } from '../agentSessions/membershipRemoval'
import { fenceUserOAuth } from '../oauth/api'
import { browserSessionMintRateLimitKey } from '../shared/rateLimits'
import { cleanDisplayName, normalizeEmail } from './identity'

/**
 * Erases a user's identity: memberships, API keys, auth sessions/verifiers/
 * refresh tokens, auth accounts and their codes, rate limits — then scrubs the
 * user row itself (the row survives, anonymized, so foreign keys like audit
 * actorIds never dangle).
 *
 * Deliberately refuses while the user still belongs to any live workspace:
 * callers own workspace teardown first, because "retire the person" must never
 * quietly imply "delete a workspace someone else may share". Both the staging
 * e2e cleanup (email-guarded, `testing/stagingE2e`) and the ephemeral-identity
 * expiry sweep (`domains/users/ephemeralModel`) funnel here — one owner for
 * what "gone" means.
 */
export async function retireUserIdentity(
  ctx: MutationCtx,
  args: { userId: Id<'users'>; now: number },
): Promise<void> {
  const user = await ctx.db.get(args.userId)
  if (user === null) return
  const email = user.email.trim().toLowerCase()

  const memberships = await ctx.db
    .query('workspaceMembers')
    .withIndex('by_user_and_workspace', q => q.eq('userId', user._id))
    .take(1_001)
  if (memberships.length > 1_000) throw new Error('User has too many memberships to retire')
  for (const membership of memberships) {
    const workspace = await ctx.db.get(membership.workspaceId)
    if (workspace !== null && workspace.status !== 'deleted') {
      throw new Error('User still belongs to a live workspace')
    }
    await deleteWorkspaceMembershipGeneration(ctx, membership, args.now)
  }

  await fenceUserOAuth(ctx, { userId: user._id, now: args.now })

  const deviceCodes = await ctx.db.query('deviceCodes').withIndex('by_userCode').take(1001)
  if (deviceCodes.length > 1000) throw new Error('Too many device codes to retire')
  for (const deviceCode of deviceCodes) {
    if (
      deviceCode.userId === user._id &&
      (deviceCode.status === 'pending' || deviceCode.status === 'approved')
    )
      await ctx.db.patch(deviceCode._id, { status: 'denied' })
  }
  const signIns = await ctx.db
    .query('authSignInRequests')
    .withIndex('by_email', q => q.eq('email', email))
    .take(1001)
  if (signIns.length > 1000) throw new Error('Too many sign-in requests to retire')
  for (const signIn of signIns) {
    if (signIn.consumedAt === undefined && signIn.supersededAt === undefined)
      await ctx.db.patch(signIn._id, { consumedAt: args.now })
  }

  const keys = await ctx.db
    .query('apiKeys')
    .withIndex('by_userId_kind', q => q.eq('userId', user._id))
    .take(1_001)
  if (keys.length > 1_000) throw new Error('User has too many API keys to retire')
  for (const key of keys) {
    if ((key.kind === 'system_vm' || key.kind === 'app') && key.workspaceId !== undefined) {
      const workspace = await ctx.db.get(key.workspaceId)
      if (
        workspace !== null &&
        workspace.status !== 'deleted' &&
        workspace.createdByUserId === user._id
      )
        continue
    }
    await ctx.db.patch(key._id, { revokedAt: key.revokedAt ?? args.now })
  }

  const mintLimit = await ctx.db
    .query('rateLimits')
    .withIndex('by_key', q => q.eq('key', browserSessionMintRateLimitKey(user._id)))
    .unique()
  if (mintLimit !== null) await ctx.db.delete(mintLimit._id)

  const sessions = await ctx.db
    .query('authSessions')
    .withIndex('userId', q => q.eq('userId', user._id))
    .take(1_001)
  if (sessions.length > 1_000) throw new Error('User has too many auth sessions to retire')
  const sessionIds = new Set(sessions.map(session => session._id))
  const verifiers = await ctx.db.query('authVerifiers').take(5_001)
  if (verifiers.length > 5_000) throw new Error('Too many auth verifiers for complete cleanup')
  for (const verifier of verifiers) {
    if (verifier.sessionId !== undefined && sessionIds.has(verifier.sessionId)) {
      await ctx.db.delete(verifier._id)
    }
  }
  for (const session of sessions) {
    const refreshTokens = await ctx.db
      .query('authRefreshTokens')
      .withIndex('sessionId', q => q.eq('sessionId', session._id))
      .take(1_001)
    if (refreshTokens.length > 1_000) throw new Error('Auth session has too many refresh tokens')
    for (const token of refreshTokens) await ctx.db.delete(token._id)
    await ctx.db.delete(session._id)
  }

  const accounts = await ctx.db
    .query('authAccounts')
    .withIndex('userIdAndProvider', q => q.eq('userId', user._id))
    .take(1_001)
  if (accounts.length > 1_000) throw new Error('User has too many auth accounts to retire')
  for (const account of accounts) {
    const codes = await ctx.db
      .query('authVerificationCodes')
      .withIndex('accountId', q => q.eq('accountId', account._id))
      .take(1_001)
    if (codes.length > 1_000) throw new Error('Auth account has too many verification codes')
    for (const code of codes) await ctx.db.delete(code._id)
    await ctx.db.delete(account._id)
  }

  const authRateLimit = await ctx.db
    .query('authRateLimits')
    .withIndex('identifier', q => q.eq('identifier', email))
    .unique()
  if (authRateLimit !== null) await ctx.db.delete(authRateLimit._id)

  const machines = await ctx.db
    .query('syncMachines')
    .withIndex('by_user_removed', q => q.eq('userId', user._id))
    .take(1001)
  if (machines.length > 1000) throw new Error('Too many sync machines to retire')
  for (const machine of machines) {
    if (machine.removedAt === undefined) await ctx.db.patch(machine._id, { removedAt: args.now })
  }

  const directoryJob = await ctx.db
    .query('memberDirectoryRefreshJobs')
    .withIndex('by_user', q => q.eq('userId', user._id))
    .unique()
  if (directoryJob !== null) await ctx.db.delete(directoryJob._id)

  const retiredEmail = normalizeEmail(`retired-${user._id}@duet-test.invalid`)
  const retiredName = cleanDisplayName('Retired user')
  await ctx.db.patch(user._id, {
    email: retiredEmail,
    name: retiredName,
    image: undefined,
    firstName: undefined,
    lastName: undefined,
    memberDirectoryRevision: user.memberDirectoryRevision + 1,
    emailVerificationTime: undefined,
    billing: undefined,
    ephemeralExpiresAt: undefined,
    updatedAt: args.now,
  })
}
