import { classifyProductPath } from './product-routes'

export const PRODUCT_LOCATION_HEADER = 'x-duet-product-location'

export function withProductLocation(source: Headers, pathname: string, search: string): Headers {
  const headers = new Headers(source)
  headers.set(PRODUCT_LOCATION_HEADER, `${pathname}${search}`)
  return headers
}

export function productLocationFromHeaders(headers: Pick<Headers, 'get'>): string {
  const location = headers.get(PRODUCT_LOCATION_HEADER)
  if (location === null) return '/'
  const pathname = location.split(/[?#]/, 1)[0] ?? ''
  return classifyProductPath(pathname) === 'product' ? location : '/'
}
