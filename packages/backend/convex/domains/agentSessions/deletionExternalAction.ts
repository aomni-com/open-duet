'use node'

import { v } from 'convex/values'

import { SessionDeletionDisposalResultSchema } from '@repo/contract'

import { internalAction } from '../../_generated/server'

export const disposeSessionDeletionWork = internalAction({
  args: { workId: v.id('agentSessionDeletionWork') },
  handler: async (_ctx, args) => {
    const apiUrl = process.env.DUET_API_URL?.trim()
    const internalKey = process.env.DUET_API_INTERNAL_KEY
    if (apiUrl === undefined || apiUrl.length === 0) throw new Error('DUET_API_URL is required')
    if (internalKey === undefined || internalKey.length === 0) {
      throw new Error('DUET_API_INTERNAL_KEY is required')
    }
    const url = new URL(
      `/v1/internal/session-deletions/${encodeURIComponent(args.workId)}/dispose`,
      apiUrl.endsWith('/') ? apiUrl : `${apiUrl}/`,
    )
    const response = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${internalKey}` },
    })
    if (!response.ok)
      throw new Error(`Session disposal callback failed with HTTP ${response.status}`)
    return SessionDeletionDisposalResultSchema.parse(await response.json())
  },
})
