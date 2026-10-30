import type { Id } from '../../_generated/dataModel'
import type { MutationCtx } from '../../_generated/server'
import { requireApiInternalKey } from '../apiKeys/model'
import { requireSessionPointFromDb } from './access'
import { patchSessionAndReconcileDiscovery } from './discovery'
import type { SessionRequestIdentity } from './identity'

export async function setSessionCwdImpl(
  ctx: MutationCtx,
  args: {
    internalKey: string
    workspaceId: Id<'workspaces'>
    sessionId: string
    actorId: Id<'users'>
    identity: SessionRequestIdentity
    expectedCwd?: string
    cwd: string
    now?: number
  },
) {
  requireApiInternalKey(args.internalKey)
  const { session } = await requireSessionPointFromDb(ctx, args)
  if (session.cwd !== args.expectedCwd) throw new Error('Cwd conflict')
  const updatedAt = args.now ?? Date.now()
  await patchSessionAndReconcileDiscovery(ctx, session, { cwd: args.cwd, updatedAt })
  return { id: session._id, cwd: args.cwd }
}
