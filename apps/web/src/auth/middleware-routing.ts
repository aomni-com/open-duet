import { isProtectedProductPath } from '../routing/product-routes'

export function usesAuthMiddleware(pathname: string): boolean {
  return (
    // With server state present, Convex Auth delegates magic-code exchange to
    // middleware instead of consuming the query parameter in the client.
    pathname === '/sign-in' ||
    isProtectedProductPath(pathname) ||
    pathname === '/auth' ||
    pathname.startsWith('/auth/') ||
    pathname === '/internal' ||
    pathname.startsWith('/internal/') ||
    pathname === '/api/auth' ||
    pathname.startsWith('/api/auth/') ||
    pathname === '/api/duet' ||
    pathname.startsWith('/api/duet/')
  )
}

export function usesInternalAdminDuetSession(pathname: string, hasSessionCookie: boolean): boolean {
  return pathname === '/internal-admin' && hasSessionCookie
}

export function shouldHandleAuthCode(pathname: string, hasProof: boolean): boolean {
  return pathname === '/sign-in' && hasProof
}
