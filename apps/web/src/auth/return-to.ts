import { isProtectedProductPath } from '../routing/product-routes'

const RETURN_TO_BASE = 'https://duet.invalid'
const DEFAULT_RETURN_TO = '/'

export function safeReturnTo(value: string | undefined): string {
  if (value === undefined) return DEFAULT_RETURN_TO
  try {
    const url = new URL(value, RETURN_TO_BASE)
    if (url.origin !== RETURN_TO_BASE || !isProtectedProductPath(url.pathname)) {
      return DEFAULT_RETURN_TO
    }
    if (url.pathname === '/oauth/authorize') {
      const requestId = url.searchParams.get('request')
      if (!requestId) return DEFAULT_RETURN_TO
      return `/oauth/authorize?${new URLSearchParams({ request: requestId }).toString()}`
    }
    return `${url.pathname}${url.search}${url.hash}`
  } catch {
    return DEFAULT_RETURN_TO
  }
}
