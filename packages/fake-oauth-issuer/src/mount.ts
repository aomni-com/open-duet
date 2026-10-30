/**
 * Where `apps/api` mounts this issuer. The API strips the prefix before the
 * request arrives, so the handler cannot recover it from the URL — but every
 * OAuth document it serves has to advertise absolute URLs that include it.
 *
 * The way out is that the router accepts BOTH forms: it strips the prefix when
 * it is still there, so an issuer hosted at a root (the loopback server in
 * `@repo/test-harness`) answers the very same absolute URLs it advertises.
 */
export const FAKE_OAUTH_ISSUER_MOUNT_PATH = '/v1/test-only/oauth-issuer'

export interface IssuerMount {
  /** Request path with the mount prefix removed, e.g. `/authorize`. */
  path: string
  /** Absolute base URL every advertised endpoint hangs off. */
  baseUrl: string
}

export function resolveMount(url: URL): IssuerMount {
  const mounted =
    url.pathname === FAKE_OAUTH_ISSUER_MOUNT_PATH ||
    url.pathname.startsWith(`${FAKE_OAUTH_ISSUER_MOUNT_PATH}/`)
  return {
    path: mounted ? url.pathname.slice(FAKE_OAUTH_ISSUER_MOUNT_PATH.length) || '/' : url.pathname,
    baseUrl: `${url.origin}${FAKE_OAUTH_ISSUER_MOUNT_PATH}`,
  }
}
