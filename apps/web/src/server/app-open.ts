import type { createDuetProxy } from './duet-proxy'

export async function openApp(
  request: Request,
  params: { workspaceSlug: string; slug: string },
  proxy: Pick<ReturnType<typeof createDuetProxy>, 'proxy'>,
): Promise<Response> {
  const target = new URL(request.url)
  target.pathname = `/api/duet/ws/${encodeURIComponent(params.workspaceSlug)}/apps/${encodeURIComponent(params.slug)}/launch`
  const response = await proxy.proxy(
    new Request(target, { headers: request.headers, signal: request.signal }),
  )
  response.headers.set('x-robots-tag', 'noindex, nofollow')
  return response
}
