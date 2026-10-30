import { cookies, headers } from 'next/headers'

import { DuetSpa } from '../../spa/root'
import { productLocationFromHeaders } from '../../src/routing/product-request-path'
import { duetProxy } from '../../src/server/duet-proxy-instance'
import { loadInitialDuetIdentity } from '../../src/server/initial-duet-identity'

export const dynamic = 'force-dynamic'

export default async function Page() {
  const initialPath = productLocationFromHeaders(await headers())
  const session = (await cookies()).get('duet_session')
  const cookieHeader = session === undefined ? undefined : `duet_session=${session.value}`
  const identity = await loadInitialDuetIdentity(cookieHeader, request =>
    duetProxy.proxy(request, ['whoami']),
  )
  /* The signed-in reader's own id, straight off the identity this document was
     already rendered with: it scopes the persisted query cache, so a browser
     someone else signs into on the same machine discards it rather than
     drawing it. No identity means no cache to keep. */
  return (
    <DuetSpa
      serverPath={initialPath}
      fixtureIdentity={identity}
      cachePersistence={identity === undefined ? undefined : { userId: identity.user.id }}
    />
  )
}
