import { describe, expect, it } from 'bun:test'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { persistDuetLocale } from '../lib/i18n/persist-locale'

const WEB_ROOT = path.resolve(import.meta.dir, '..')

describe('product language boundary', () => {
  it('writes the shared locale cookie synchronously for browser handoffs', () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'document')
    const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window')
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: { cookie: '' },
    })
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { location: { hostname: 'localhost' } },
    })

    try {
      persistDuetLocale('es-419')
      expect(document.cookie).toBe('DUET_LOCALE=es-419; Path=/; Max-Age=31536000; SameSite=Lax')
    } finally {
      if (descriptor) Object.defineProperty(globalThis, 'document', descriptor)
      else Reflect.deleteProperty(globalThis, 'document')
      if (windowDescriptor) Object.defineProperty(globalThis, 'window', windowDescriptor)
      else Reflect.deleteProperty(globalThis, 'window')
    }
  })

  it('the product request-config source reads the locale cookie and omits marketing messages', async () => {
    const source = await readFile(path.resolve(WEB_ROOT, 'i18n/request.ts'), 'utf8')
    expect(source).toContain('get(DUET_LOCALE_COOKIE)')
    expect(source).not.toContain('marketing.json')
  })

  it('server, runtime and playground sources declare UTC formatting', async () => {
    const [requestConfig, runtimeProvider, spaPlayground] = await Promise.all([
      readFile(path.resolve(WEB_ROOT, 'i18n/request.ts'), 'utf8'),
      readFile(path.resolve(WEB_ROOT, 'components/providers/runtime-intl-provider.tsx'), 'utf8'),
      readFile(path.resolve(WEB_ROOT, 'components/playground/spa-shell-playground.tsx'), 'utf8'),
    ])

    expect(requestConfig).toContain("timeZone: 'UTC'")
    expect(runtimeProvider).toContain('timeZone="UTC"')
    expect(spaPlayground).toContain('timeZone="UTC"')
  })

  it('root source omits direct header imports and product/sign-in sources include the cookie-reading provider', async () => {
    const [rootLayout, appLayout, signInLayout, runtimeProvider] = await Promise.all([
      readFile(path.resolve(WEB_ROOT, 'app/layout.tsx'), 'utf8'),
      readFile(path.resolve(WEB_ROOT, 'app/(product)/layout.tsx'), 'utf8'),
      readFile(path.resolve(WEB_ROOT, 'app/sign-in/layout.tsx'), 'utf8'),
      readFile(path.resolve(WEB_ROOT, 'components/providers/runtime-intl-provider.tsx'), 'utf8'),
    ])

    expect(rootLayout).not.toContain("from 'next/headers'")
    expect(appLayout).toContain('RuntimeIntlProvider')
    expect(signInLayout).toContain('RuntimeIntlProvider')
    expect(runtimeProvider).toContain('get(DUET_LOCALE_COOKIE)')
  })
})
