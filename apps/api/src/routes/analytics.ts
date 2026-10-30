import type { FunctionReference } from 'convex/server'

import { BrowserAnalyticsEventRequestSchema, type AnalyticsEvent } from '@repo/contract'

import { fn, readJson, requireBrowserSession, type ApiApp } from '../shared'

export interface AnalyticsRouteRuntime {
  convex: {
    mutation(
      reference: FunctionReference<'mutation'>,
      args: { internalKey: string; event: AnalyticsEvent },
    ): Promise<unknown>
  }
  internalKey: string
  now: () => number
}

export function registerAnalyticsRoutes(app: ApiApp, runtime: AnalyticsRouteRuntime): void {
  app.post('/v1/analytics/events', async c => {
    const session = requireBrowserSession(c)
    if ('response' in session) return session.response

    const body = BrowserAnalyticsEventRequestSchema.safeParse(await readJson(c.req.raw))
    if (!body.success) return c.json({ error: 'invalid_request' }, 400)
    if (
      body.data.workspaceId !== undefined &&
      !c.get('auth').workspaces.some(workspace => workspace.id === body.data.workspaceId)
    ) {
      return c.json({ error: 'not_found' }, 404)
    }

    await runtime.convex.mutation(fn('domains/analytics/api:emitFromApi'), {
      internalKey: runtime.internalKey,
      event: {
        ...body.data,
        version: 1,
        at: runtime.now(),
        origin: 'product_browser',
        userId: session.userId,
      },
    })
    return c.json({}, 202)
  })
}
