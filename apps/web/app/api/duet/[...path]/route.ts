import { duetProxy } from '../../../../src/server/duet-proxy-instance'

async function proxy(request: Request): Promise<Response> {
  return await duetProxy.proxy(request)
}

export const dynamic = 'force-dynamic'
export const GET = proxy
export const HEAD = proxy
export const OPTIONS = proxy
export const POST = proxy
export const PUT = proxy
export const PATCH = proxy
export const DELETE = proxy
