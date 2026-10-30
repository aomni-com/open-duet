'use node'

import { makeFunctionReference } from 'convex/server'
import { v } from 'convex/values'

import { internalAction } from '../../_generated/server'

const tickRef = makeFunctionReference<'action'>('domains/workspaceBackups/dispatch:tick')

// The scheduler, not an HTTP request or browser, owns dispatch and cleanup retries.
export const tick = internalAction({
  args: { backupId: v.id('workspaceBackups') },
  handler: async (ctx, args) => {
    let retryAfterMs: number | null = 30_000
    try {
      const apiUrl = process.env.DUET_API_URL
      const key = process.env.DUET_API_INTERNAL_KEY
      // Durable stall detection cannot depend on the external control callback.
      // The API reuses this transition before acting on its current job snapshot.
      await ctx.runMutation(
        makeFunctionReference<'mutation'>('domains/workspaceBackups/jobs:reconcile'),
        { internalKey: key ?? '', ...args },
      )
      if (!apiUrl || !key) throw new Error('Backup callback configuration missing')
      const response = await fetch(new URL(`/v1/internal/backups/${args.backupId}/run`, apiUrl), {
        method: 'POST',
        headers: { authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(60_000),
      })
      if (!response.ok) throw new Error(`Backup callback HTTP ${response.status}`)
      const result = (await response.json()) as { retryAfterMs?: unknown }
      if (result.retryAfterMs === null) retryAfterMs = null
      else if (typeof result.retryAfterMs === 'number' && Number.isFinite(result.retryAfterMs))
        retryAfterMs = Math.max(5_000, Math.min(result.retryAfterMs, 900_000))
    } catch (error) {
      console.error('[backup] Retryable control callback failure', args.backupId, String(error))
    }
    try {
      // A lifecycle deadline must still advance while the API is unavailable.
      // Run after a successful callback too: it may have just observed completion.
      await ctx.runMutation(
        makeFunctionReference<'mutation'>('domains/workspaces/lifecycle:advance'),
        args,
      )
    } catch (error) {
      console.error('[backup] Lifecycle continuation will retry', args.backupId, String(error))
      retryAfterMs = 30_000
    }
    if (retryAfterMs !== null) await ctx.scheduler.runAfter(retryAfterMs, tickRef, args)
  },
})
