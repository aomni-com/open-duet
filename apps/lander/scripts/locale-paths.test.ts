import { expect, test } from 'bun:test'

import { localeSwitchPath, localizePath, stripLocaleFromPathname } from '../lib/i18n/locales'

test('locale paths normalize internal prerender routes and public prefixes', () => {
  expect(stripLocaleFromPathname('/en')).toBe('/')
  expect(stripLocaleFromPathname('/en/pricing')).toBe('/pricing')
  expect(stripLocaleFromPathname('/es-419')).toBe('/')
  expect(stripLocaleFromPathname('/es/pricing')).toBe('/pricing')
  expect(stripLocaleFromPathname('/pricing')).toBe('/pricing')

  expect(localizePath('/en', 'es-419')).toBe('/es')
  expect(localizePath('/en/pricing', 'es-419')).toBe('/es/pricing')
  expect(localizePath('/es/pricing', 'en')).toBe('/pricing')
})

test('locale switch falls back to Spanish home when no translated route exists', () => {
  const spanishPaths = new Set(['/es', '/es/pricing'])
  expect(localeSwitchPath('/pricing', 'es-419', spanishPaths)).toBe('/es/pricing')
  // An EN-only page (every `/l/` lander is one) has no Spanish twin to
  // switch to, and the sitewide footer offers the switch on every page.
  expect(localeSwitchPath('/l/platform', 'es-419', spanishPaths)).toBe('/es')
  expect(localeSwitchPath('/es/pricing', 'en', spanishPaths)).toBe('/pricing')
})
