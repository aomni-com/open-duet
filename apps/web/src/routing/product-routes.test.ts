import { describe, expect, test } from 'bun:test'

import {
  classifyProductPath,
  isProtectedProductPath,
  PRODUCT_REWRITE_SOURCES,
} from './product-routes'

describe('final product route classification', () => {
  test('classifies every product root without claiming adjacent paths', () => {
    expect(
      [
        '/',
        '/w',
        '/w/acme',
        '/w/acme/sessions/session-1',
        '/settings',
        '/settings/billing',
        '/onboarding',
        '/internal-admin',
      ].map(pathname => [pathname, classifyProductPath(pathname)]),
    ).toEqual([
      ['/', 'product'],
      ['/w', 'product'],
      ['/w/acme', 'product'],
      ['/w/acme/sessions/session-1', 'product'],
      ['/settings', 'product'],
      ['/settings/billing', 'product'],
      ['/onboarding', 'product'],
      ['/internal-admin', 'product'],
    ])
    expect(classifyProductPath('/workspace')).toBe('other')
    expect(classifyProductPath('/settings-billing')).toBe('other')
    expect(classifyProductPath('/internal-admin/workspace')).toBe('other')
    expect(classifyProductPath('/onboarding/extra')).toBe('other')
    expect(classifyProductPath('/app')).toBe('other')
    expect(classifyProductPath('/app/w/acme')).toBe('other')
  })

  test('keeps protected device approval outside the SPA rewrite set', () => {
    expect(classifyProductPath('/device')).toBe('device')
    expect(isProtectedProductPath('/device')).toBe(true)
    expect(PRODUCT_REWRITE_SOURCES).not.toContain('/device')
    expect(classifyProductPath('/device/history')).toBe('other')
  })

  test('protects only the exact OAuth consent route outside the SPA rewrite set', () => {
    expect(classifyProductPath('/oauth/authorize')).toBe('oauth-consent')
    expect(isProtectedProductPath('/oauth/authorize')).toBe(true)
    expect(PRODUCT_REWRITE_SOURCES).not.toContain('/oauth/authorize')
    expect(classifyProductPath('/oauth/authorize/history')).toBe('other')
  })

  test('excludes identity, infrastructure, framework, and metadata routes', () => {
    const cases = [
      ['/sign-in', 'identity'],
      ['/sign-in/', 'identity'],
      ['/sign-out', 'identity'],
      ['/invite', 'identity'],
      ['/invite/token', 'identity'],
      ['/share', 'identity'],
      ['/share/token', 'identity'],
      ['/auth/magic-link/callback', 'identity'],
      ['/api', 'infrastructure'],
      ['/api/duet/session', 'infrastructure'],
      ['/internal/programmatic-login', 'infrastructure'],
      ['/playground', 'infrastructure'],
      ['/playground/spa-shell', 'infrastructure'],
      ['/_next/static/chunk.js', 'infrastructure'],
      ['/_next/image', 'infrastructure'],
      ['/manifest.json', 'static-file'],
      ['/robots.txt', 'static-file'],
      ['/sitemap.xml', 'static-file'],
      ['/sitemap/blog-en.xml', 'static-file'],
      ['/favicon.ico', 'static-file'],
      ['/install.txt', 'static-file'],
      ['/llms.txt', 'static-file'],
    ] as const

    for (const [pathname, expected] of cases) {
      expect(classifyProductPath(pathname)).toBe(expected)
      expect(isProtectedProductPath(pathname)).toBe(false)
    }
  })

  test('ordinary files never fall through to a product prefix', () => {
    for (const pathname of ['/icon.svg', '/assets/font.woff2', '/.well-known']) {
      expect(classifyProductPath(pathname)).toBe('static-file')
      expect(isProtectedProductPath(pathname)).toBe(false)
    }

    for (const pathname of [
      '/w/acme/files/folder/report.txt',
      '/w/acme/export.csv',
      '/settings/preferences.json',
    ]) {
      expect(classifyProductPath(pathname)).toBe('product')
      expect(isProtectedProductPath(pathname)).toBe(true)
    }
  })

  test('protects only final product and device paths', () => {
    for (const pathname of ['/', '/w/acme/sessions', '/settings/profile', '/internal-admin']) {
      expect(isProtectedProductPath(pathname)).toBe(true)
    }
    for (const pathname of [
      '',
      'settings',
      '//w/acme',
      '/w\\evil',
      '/pricing',
      '/es',
      '/unknown',
    ]) {
      expect(classifyProductPath(pathname)).toBe('other')
      expect(isProtectedProductPath(pathname)).toBe(false)
    }
  })

  test('public publish viewer routes are unauthenticated and unprotected', () => {
    for (const pathname of [
      '/publish/acme/q2',
      '/publish/acme/q2/',
      '/publish/acme/site/a/b/c',
      '/publish/acme/site/style.css',
      '/publish/acme/site/index.html',
    ]) {
      expect(classifyProductPath(pathname)).toBe('other')
      expect(isProtectedProductPath(pathname)).toBe(false)
    }
    expect(PRODUCT_REWRITE_SOURCES).not.toContain('/publish')
  })
})
