import { describe, expect, test } from 'bun:test'

import {
  getLanderOrigin,
  getProductOrigin,
  productHref,
  resolveConfiguredLanderOrigin,
  resolveConfiguredProductOrigin,
  resolveDuetEnvironment,
} from './origins'

describe('lander origin ownership', () => {
  test('maps local, staging, and production hosts without request-origin inference', () => {
    expect(getLanderOrigin('local')).toBe('http://localhost:3002')
    expect(getProductOrigin('local')).toBe('http://localhost:3000')
    expect(getLanderOrigin('staging')).toBe('https://lander-staging.duet.so')
    expect(getProductOrigin('staging')).toBe('https://app-staging.duet.so')
    expect(getLanderOrigin('production')).toBe('https://duet.so')
    expect(getProductOrigin('production')).toBe('https://app.duet.so')
  })

  test('resolves Vercel environments explicitly', () => {
    expect(resolveDuetEnvironment('production')).toBe('production')
    expect(resolveDuetEnvironment('preview')).toBe('staging')
    expect(resolveDuetEnvironment('staging')).toBe('staging')
    expect(resolveDuetEnvironment('development')).toBe('local')
    expect(resolveDuetEnvironment(undefined)).toBe('local')
  })

  test('uses the explicit product origin for a separately deployed staging lander', () => {
    expect(
      resolveConfiguredProductOrigin({
        VERCEL_ENV: 'production',
        NEXT_PUBLIC_DUET_APP_URL: 'https://app-staging.duet.so/',
      }),
    ).toBe('https://app-staging.duet.so')
    expect(() =>
      resolveConfiguredProductOrigin({ NEXT_PUBLIC_DUET_APP_URL: 'javascript:alert(1)' }),
    ).toThrow()
    expect(() => resolveConfiguredProductOrigin({ VERCEL: '1' })).toThrow(
      'NEXT_PUBLIC_DUET_APP_URL is required',
    )
    expect(resolveConfiguredProductOrigin({})).toBe('http://localhost:3000')
  })

  test('requires one explicit canonical lander origin in deployed builds', () => {
    expect(
      resolveConfiguredLanderOrigin({
        VERCEL: '1',
        NEXT_PUBLIC_DUET_LANDER_URL: 'https://lander-staging.duet.so/',
      }),
    ).toBe('https://lander-staging.duet.so')
    expect(() => resolveConfiguredLanderOrigin({ VERCEL: '1' })).toThrow(
      'NEXT_PUBLIC_DUET_LANDER_URL is required',
    )
    expect(resolveConfiguredLanderOrigin({})).toBe('http://localhost:3002')
  })

  test('builds cross-origin product links while preserving attribution parameters', () => {
    expect(
      productHref(
        '/sign-in?next=%2Fw%2Facme%2Fsessions&utm_source=hero',
        new URLSearchParams([
          ['utm_campaign', 'launch'],
          ['utm_source', 'cta'],
        ]),
        'staging',
      ),
    ).toBe(
      'https://app-staging.duet.so/sign-in?next=%2Fw%2Facme%2Fsessions&utm_source=hero&utm_campaign=launch&utm_source=cta',
    )
    expect(productHref('/', { ref: 'pricing', tag: ['a', 'b'] }, 'production')).toBe(
      'https://app.duet.so/?ref=pricing&tag=a&tag=b',
    )
  })

  test('rejects caller-provided origins and URL parser attacks', () => {
    for (const value of [
      'https://evil.example/sign-in',
      '//evil.example/sign-in',
      '/\\evil.example/sign-in',
      'sign-in',
      '/sign-in\nhttps://evil.example',
    ]) {
      expect(() => productHref(value, undefined, 'production')).toThrow()
    }
  })
})
