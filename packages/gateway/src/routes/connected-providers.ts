import { Hono, type Context } from 'hono'

import { ConnectStartRequestSchema } from '@repo/contract'

import {
  ConnectCommandError,
  ConnectOperationConflictError,
  ConnectSessionNotFoundError,
  type ConnectSessionManager,
} from '../connected-providers/connect-session'

export function createConnectedProvidersRoutes(manager: ConnectSessionManager): Hono {
  const routes = new Hono()

  routes.post('/connect', async c => {
    const request = ConnectStartRequestSchema.safeParse(await readJson(c.req.raw))
    if (!request.success) return c.json({ error: 'invalid_request' }, 400)
    try {
      return c.json(await manager.start(request.data.provider))
    } catch (error) {
      return operationError(c, error)
    }
  })

  routes.get('/connect/:sessionId', async c => {
    try {
      return c.json(await manager.poll(c.req.param('sessionId')))
    } catch (error) {
      if (error instanceof ConnectSessionNotFoundError) {
        return c.json({ error: 'session_not_found' }, 404)
      }
      throw error
    }
  })

  routes.post('/disconnect', async c => {
    const request = ConnectStartRequestSchema.safeParse(await readJson(c.req.raw))
    if (!request.success) return c.json({ error: 'invalid_request' }, 400)
    try {
      await manager.disconnect(request.data.provider)
      return c.json({ ok: true as const })
    } catch (error) {
      return operationError(c, error)
    }
  })

  routes.get('/', async c => {
    try {
      return c.json(await manager.status())
    } catch (error) {
      if (error instanceof ConnectCommandError) {
        return c.json({ error: 'provider_command_failed' }, 502)
      }
      throw error
    }
  })

  return routes
}

function operationError(c: Context, error: unknown) {
  if (error instanceof ConnectOperationConflictError) {
    return c.json({ error: 'provider_operation_in_progress' }, 409)
  }
  if (error instanceof ConnectCommandError) {
    return c.json({ error: 'provider_command_failed' }, 502)
  }
  throw error
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json()
  } catch {
    return null
  }
}
