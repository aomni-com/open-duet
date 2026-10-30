import { cookies } from 'next/headers'

import { consumePendingShareCookie, PENDING_SHARE_COOKIE } from '../../../../src/auth/pending-share'
import { duetProxy } from '../../../../src/server/duet-proxy-instance'

export const dynamic = 'force-dynamic'

export async function GET(request: Request): Promise<Response> {
  const cookieStore = await cookies()
  return await pendingShareResponse(
    request,
    cookieStore.get(PENDING_SHARE_COOKIE)?.value,
    (pendingRequest, path) => duetProxy.proxy(pendingRequest, path),
  )
}

export async function pendingShareResponse(
  request: Request,
  token: string | undefined,
  resolve: (request: Request, path: string[]) => Promise<Response>,
): Promise<Response> {
  return await consumePendingShareCookie({
    token,
    resolve: async validToken => await resolve(request, ['share-requests', validToken]),
  })
}
