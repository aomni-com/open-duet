import { openApp } from '../../../../../../src/server/app-open'
import { duetProxy } from '../../../../../../src/server/duet-proxy-instance'

export const dynamic = 'force-dynamic'

export async function GET(
  request: Request,
  context: { params: Promise<{ workspaceSlug: string; slug: string }> },
): Promise<Response> {
  return openApp(request, await context.params, duetProxy)
}
