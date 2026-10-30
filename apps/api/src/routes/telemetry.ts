import { VmTelemetryHistoryQuerySchema, VmTelemetryHistoryResponseSchema } from '@repo/contract'

import { fnQuery, requireWorkspaceMember, type ApiApp, type ApiRouteRuntime } from '../shared'

export function registerTelemetryRoutes(app: ApiApp, runtime: ApiRouteRuntime): void {
  app.get('/v1/ws/:workspaceSlug/telemetry', async c => {
    const workspace = requireWorkspaceMember(c)
    if ('response' in workspace) return workspace.response
    const query = VmTelemetryHistoryQuerySchema.safeParse(
      Object.fromEntries(new URL(c.req.url).searchParams),
    )
    if (!query.success) return c.json({ error: 'invalid_request' }, 400)
    const samples = await runtime.convex.query(
      fnQuery('domains/workspaces/vmTelemetry:listTelemetryHistory'),
      {
        internalKey: runtime.internalKey,
        actorId: c.get('auth').user.id,
        workspaceId: workspace.id,
        now: runtime.now(),
        sinceAt: query.data.sinceAt,
      },
    )
    return c.json(VmTelemetryHistoryResponseSchema.parse({ samples }))
  })
}
