import {
  createFakeOAuthIssuer,
  FAKE_OAUTH_ISSUER_MOUNT_PATH,
  type FakeOAuthIssuer,
} from '@repo/fake-oauth-issuer'

import type { ApiApp } from '../shared'

// The issuer advertises absolute URLs built from this prefix, so the mount and
// the fixture have to agree on it — hence one constant, owned by the fixture.
export const FAKE_OAUTH_ISSUER_PATH_PATTERN = new RegExp(`^${FAKE_OAUTH_ISSUER_MOUNT_PATH}(?:/|$)`)

export function registerFakeOAuthIssuerRoutes(
  app: ApiApp,
  options: {
    enabled: boolean
    issuer?: FakeOAuthIssuer
  },
): void {
  if (!options.enabled) return
  const issuer = options.issuer ?? createFakeOAuthIssuer()

  app.all(`${FAKE_OAUTH_ISSUER_MOUNT_PATH}/*`, c => {
    const request = c.req.raw
    const url = new URL(request.url)
    url.pathname = url.pathname.slice(FAKE_OAUTH_ISSUER_MOUNT_PATH.length)
    return issuer.fetch(new Request(url, request))
  })
}
