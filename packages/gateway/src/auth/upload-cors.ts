import type { MiddlewareHandler } from 'hono'

import { isTrainUploadsPath } from './upload-scope'

const ALLOWED_METHODS = 'GET, PUT, DELETE, OPTIONS'
const ALLOWED_HEADERS = 'authorization, content-type, x-duet-actor-context'

export function isBrowserUploadPath(path: string): boolean {
  return isTrainUploadsPath(path) || path.startsWith('/v1/files/')
}

export function createUploadCorsPolicy(allowedOrigins: readonly string[]): MiddlewareHandler {
  const allowed = new Set(allowedOrigins)
  return async (c, next) => {
    if (!isBrowserUploadPath(c.req.path)) return next()

    const origin = c.req.header('origin')
    if (origin === undefined || !allowed.has(origin)) return next()

    stampCorsHeaders(c.header.bind(c), origin)
    if (c.req.method === 'OPTIONS') return c.body(null, 204)
    await next()
  }
}

function stampCorsHeaders(
  setHeader: (name: string, value: string, options?: { append?: boolean }) => void,
  origin: string,
): void {
  setHeader('access-control-allow-origin', origin)
  setHeader('access-control-allow-methods', ALLOWED_METHODS)
  setHeader('access-control-allow-headers', ALLOWED_HEADERS)
  setHeader('access-control-max-age', '600')
  setHeader('vary', 'Origin', { append: true })
}
