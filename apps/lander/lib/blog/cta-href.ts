import { productHref } from '@/src/config/origins'

/**
 * The paths a CTA may point at that the lander does not own. Everything else
 * an author writes is expected to be a lander route, and
 * `verify-public-content` fails the build when it is not — so this list plus
 * the route manifest is a closed world, and a typo cannot quietly resolve
 * against the wrong host.
 */
export const PRODUCT_CTA_PATHS = ['/sign-in'] as const

export function isProductCtaPath(href: string): boolean {
  const [path] = href.split(/[?#]/)
  return PRODUCT_CTA_PATHS.some(productPath => path === productPath)
}

/**
 * Turns an authored CTA target into a real href. A CTA names a path; which
 * origin serves it is a fact about the site, not a choice the author should
 * have to restate at every call site.
 */
export function resolveCtaHref(href: string): string {
  if (href.startsWith('#')) return href
  if (isProductCtaPath(href)) return productHref(href)
  return href
}
