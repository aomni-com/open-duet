import { cookies } from 'next/headers'

import { bootstrapBrowserUser } from '../../../../src/auth/bootstrap'
import { CAMPAIGN_HANDOFF_COOKIE } from '../../../../src/auth/campaign-handoff'
import { completeBrowserSession } from '../../../../src/auth/complete-browser-session'
import { PENDING_INVITE_COOKIE } from '../../../../src/auth/pending-invite'
import { duetProxy } from '../../../../src/server/duet-proxy-instance'

export const dynamic = 'force-dynamic'

export async function POST(request: Request): Promise<Response> {
  const cookieStore = await cookies()
  const pendingInvite = cookieStore.get(PENDING_INVITE_COOKIE)?.value
  const campaignHandoff = cookieStore.get(CAMPAIGN_HANDOFF_COOKIE)?.value
  return await completeBrowserSession({
    request,
    tokens: {
      ...(pendingInvite === undefined ? {} : { invite: pendingInvite }),
      ...(campaignHandoff === undefined ? {} : { acquisition: campaignHandoff }),
    },
    bootstrap: bootstrapBrowserUser,
    exchange: duetProxy.exchange,
  })
}

export async function DELETE(request: Request): Promise<Response> {
  return await duetProxy.logout(request)
}
