import type { GenericDatabaseReader } from 'convex/server'

import { parseActorContext } from '@repo/contract'

import type { DataModel } from '../../_generated/dataModel'

export async function resolveFileActorUsers(
  db: GenericDatabaseReader<DataModel>,
  actorContexts: readonly string[],
): Promise<Map<string, string | undefined>> {
  const entries = await Promise.all(
    [...new Set(actorContexts)].map(async actorContext => {
      const actor = parseActorContext(actorContext)
      if (actor?.kind === 'web') return [actorContext, actor.userId] as const
      if (actor?.kind === 'session') {
        const sessionId = db.normalizeId('agentSessions', actor.sessionId)
        const session = sessionId === null ? null : await db.get(sessionId)
        return [actorContext, session?.userId] as const
      }
      if (actor?.kind === 'api-key') {
        const keyId = db.normalizeId('apiKeys', actor.keyId)
        const key = keyId === null ? null : await db.get(keyId)
        return [actorContext, key?.userId] as const
      }
      if (actor?.kind === 'mirror') {
        const deviceId = db.normalizeId('syncMachines', actor.deviceId)
        const device = deviceId === null ? null : await db.get(deviceId)
        return [actorContext, device?.userId] as const
      }
      return [actorContext, undefined] as const
    }),
  )
  return new Map(entries)
}
