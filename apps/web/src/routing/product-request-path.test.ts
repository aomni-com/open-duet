import { describe, expect, test } from 'bun:test'

import {
  PRODUCT_LOCATION_HEADER,
  productLocationFromHeaders,
  withProductLocation,
} from './product-request-path'

describe('product request location handoff', () => {
  test('forwards the browser-visible route and presentation query without trusting a supplied header', () => {
    const headers = withProductLocation(
      new Headers({ [PRODUCT_LOCATION_HEADER]: '/w/spoofed/jobs' }),
      '/w/acme/files/reports',
      '?mode=work',
    )

    expect(productLocationFromHeaders(headers)).toBe('/w/acme/files/reports?mode=work')
  })

  test('falls back to the product root for malformed or non-product values', () => {
    expect(productLocationFromHeaders(new Headers())).toBe('/')
    expect(
      productLocationFromHeaders(new Headers({ [PRODUCT_LOCATION_HEADER]: 'not-a-path' })),
    ).toBe('/')
    expect(productLocationFromHeaders(new Headers({ [PRODUCT_LOCATION_HEADER]: '/sign-in' }))).toBe(
      '/',
    )
  })
})
