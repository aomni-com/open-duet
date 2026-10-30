import { expect, test } from 'bun:test'

import { resolveCtaHref } from '@/lib/blog/cta-href'
import { resolveConfiguredProductOrigin } from '@/src/config/origins'

// the origin the resolver itself resolves against, not a second copy of it
const PRODUCT = resolveConfiguredProductOrigin()

// A CTA target names a path, never an origin: the lander owns most of them and
// the product owns a known few, so shipping a lander page to the product host
// (or the reverse) is the failure these pin.
test('a product path resolves against the product origin, query intact', () => {
  expect(resolveCtaHref('/sign-in?from=blog-kimi')).toBe(`${PRODUCT}/sign-in?from=blog-kimi`)
})

test('a lander path stays relative, so it never leaves the site to re-enter it', () => {
  expect(resolveCtaHref('/pricing')).toBe('/pricing')
})

test('an in-page anchor is left alone', () => {
  expect(resolveCtaHref('#what-happens-on-day-30')).toBe('#what-happens-on-day-30')
})
