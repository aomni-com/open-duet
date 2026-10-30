export const PRODUCT_REWRITE_SOURCES = [
  '/',
  '/w/:path*',
  '/settings/:path*',
  '/internal-admin',
] as const

export type ProductPathClassification =
  | 'product'
  | 'device'
  | 'oauth-consent'
  | 'identity'
  | 'infrastructure'
  | 'static-file'
  | 'other'

const ORDINARY_STATIC_FILE = /(?:^|\/)\.[^/]+$|(?:^|\/)[^/]+\.[^/]+$/

export function classifyProductPath(pathname: string): ProductPathClassification {
  if (!pathname.startsWith('/') || pathname.startsWith('//') || pathname.includes('\\')) {
    return 'other'
  }

  if (
    isPathOrDescendant(pathname, '/sign-in') ||
    isPathOrDescendant(pathname, '/sign-out') ||
    isPathOrDescendant(pathname, '/invite') ||
    isPathOrDescendant(pathname, '/share') ||
    isPathOrDescendant(pathname, '/auth')
  ) {
    return 'identity'
  }

  if (
    isPathOrDescendant(pathname, '/api') ||
    isPathOrDescendant(pathname, '/internal') ||
    isPathOrDescendant(pathname, '/playground') ||
    isPathOrDescendant(pathname, '/_next')
  ) {
    return 'infrastructure'
  }

  // The public publish viewer (`app/publish/*`, outside the `(product)` group)
  // is anonymous by contract: it is never protected and never gated by the auth
  // middleware, even for deep paths that end in a file extension.
  if (isPathOrDescendant(pathname, '/publish')) return 'other'

  if (pathname === '/device') return 'device'
  if (pathname === '/oauth/authorize') return 'oauth-consent'

  if (
    pathname === '/' ||
    pathname === '/onboarding' ||
    isPathOrDescendant(pathname, '/w') ||
    isPathOrDescendant(pathname, '/settings') ||
    pathname === '/internal-admin'
  ) {
    return 'product'
  }

  if (ORDINARY_STATIC_FILE.test(pathname)) return 'static-file'

  return 'other'
}

export function isProtectedProductPath(pathname: string): boolean {
  const classification = classifyProductPath(pathname)
  return (
    classification === 'product' ||
    classification === 'device' ||
    classification === 'oauth-consent'
  )
}

function isPathOrDescendant(pathname: string, root: string): boolean {
  return pathname === root || pathname.startsWith(`${root}/`)
}
