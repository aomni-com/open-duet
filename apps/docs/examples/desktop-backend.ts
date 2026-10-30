import type { DesktopFetch } from './desktop-contract'

export interface DesktopBackendOptions {
  duetApiUrl: string
  apiKey: string
  workspaceSlug: string
  authorize(request: Request): boolean | Promise<boolean>
  fetch?: DesktopFetch
}

/** Mount this Web-standard handler at /api/desktop/* in your server framework. */
export function createDesktopBackend(options: DesktopBackendOptions) {
  const duetFetch = options.fetch ?? fetch
  const workspace = encodeURIComponent(options.workspaceSlug)

  return async function handleDesktopRequest(request: Request): Promise<Response> {
    if (!(await options.authorize(request))) {
      return Response.json({ error: 'unauthorized' }, { status: 401 })
    }

    const { pathname } = new URL(request.url)
    if (request.method === 'POST' && pathname === '/api/desktop/session') {
      const body = await readObject(request)
      if (typeof body?.embedOrigin !== 'string') return invalidRequest()
      return await duet(`/v1/ws/${workspace}/desktop/session`, {
        method: 'POST',
        body: JSON.stringify({ embedOrigin: body.embedOrigin }),
      })
    }

    if (request.method === 'GET' && pathname === '/api/desktop/status') {
      return await duet(`/v1/ws/${workspace}/desktop/status`)
    }

    if (request.method === 'POST' && pathname === '/api/desktop/focus') {
      const body = await readObject(request)
      if (typeof body?.agentSlug !== 'string' || typeof body.requestId !== 'string') {
        return invalidRequest()
      }
      return await duet(
        `/v1/ws/${workspace}/agents/${encodeURIComponent(body.agentSlug)}/desktop/focus`,
        { method: 'POST', body: JSON.stringify({ requestId: body.requestId }) },
      )
    }

    return Response.json({ error: 'not_found' }, { status: 404 })
  }

  async function duet(path: string, init: RequestInit = {}): Promise<Response> {
    const response = await duetFetch(`${options.duetApiUrl.replace(/\/$/, '')}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${options.apiKey}`,
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
    })
    const headers = new Headers({
      'cache-control': 'no-store',
      'content-type': response.headers.get('content-type') ?? 'application/json',
    })
    const retryAfter = response.headers.get('retry-after')
    if (retryAfter !== null) headers.set('retry-after', retryAfter)
    return new Response(response.body, { status: response.status, headers })
  }
}

async function readObject(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await request.json()
    return typeof body === 'object' && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function invalidRequest(): Response {
  return Response.json({ error: 'invalid_request' }, { status: 400 })
}
