import { describe, expect, test } from 'bun:test'

import {
  createPostHogClientOptions,
  createPostHogPersistenceOptions,
  readDuetLocaleCookie,
  serializeDuetLocaleCookie,
} from './index'

describe('Duet locale cookie', () => {
  test.each([
    ['DUET_LOCALE=en', 'en'],
    ['session=abc; DUET_LOCALE=es-419; theme=dark', 'es-419'],
    ['DUET_LOCALE = en ; other=value', 'en'],
    ['DUET_LOCALE=es-419=ignored', null],
    ['', null],
    [null, null],
    [undefined, null],
    ['NEXT_LOCALE=es-419', null],
    ['duet_locale=en', null],
    ['DUET_LOCALE=es', null],
    ['DUET_LOCALE=EN', null],
    ['DUET_LOCALE=', null],
    ['DUET_LOCALE', null],
  ] as const)('parses %p as %p', (header, expected) => {
    expect(readDuetLocaleCookie(header)).toBe(expected)
  })

  test('uses the first valid matching cookie and ignores malformed duplicates', () => {
    expect(readDuetLocaleCookie('DUET_LOCALE=en; DUET_LOCALE=es-419')).toBe('en')
    expect(readDuetLocaleCookie('DUET_LOCALE=invalid; DUET_LOCALE=es-419')).toBe('es-419')
  })

  test.each([
    'duet.so',
    'app.duet.so',
    'app-staging.duet.so',
    'lander.duet.so',
    'lander-staging.duet.so',
    'APP.DUET.SO.',
  ])('shares a secure persistent cookie across Duet hosts: %s', hostname => {
    expect(serializeDuetLocaleCookie('es-419', hostname)).toBe(
      'DUET_LOCALE=es-419; Path=/; Max-Age=31536000; SameSite=Lax; Domain=.duet.so; Secure',
    )
  })

  test.each(['localhost', 'LOCALHOST.', '127.0.0.1', '::1', '[::1]'])(
    'keeps local development host-only and non-secure: %s',
    hostname => {
      expect(serializeDuetLocaleCookie('en', hostname)).toBe(
        'DUET_LOCALE=en; Path=/; Max-Age=31536000; SameSite=Lax',
      )
    },
  )

  test('keeps non-Duet preview hosts isolated while retaining HTTPS cookies', () => {
    expect(serializeDuetLocaleCookie('en', 'duet-web.vercel.app')).toBe(
      'DUET_LOCALE=en; Path=/; Max-Age=31536000; SameSite=Lax; Secure',
    )
  })
})

describe('PostHog persistence', () => {
  test.each(['duet.so', 'app.duet.so', 'app-staging.duet.so', 'lander.duet.so'])(
    'shares cookie-backed identity across Duet hosts: %s',
    hostname => {
      expect(createPostHogPersistenceOptions(hostname)).toEqual({
        persistence: 'localStorage+cookie',
        cross_subdomain_cookie: true,
        secure_cookie: true,
        __preview_cookie_wins_on_conflict: true,
      })
    },
  )

  test.each(['localhost', '127.0.0.1', '::1', '[::1]'])(
    'uses isolated non-secure persistence locally: %s',
    hostname => {
      expect(createPostHogPersistenceOptions(hostname)).toEqual({
        persistence: 'localStorage+cookie',
        cross_subdomain_cookie: false,
        secure_cookie: false,
        __preview_cookie_wins_on_conflict: false,
      })
    },
  )

  test('does not share cookies across unrelated preview hosts', () => {
    expect(createPostHogPersistenceOptions('duet-web.vercel.app')).toEqual({
      persistence: 'localStorage+cookie',
      cross_subdomain_cookie: false,
      secure_cookie: true,
      __preview_cookie_wins_on_conflict: false,
    })
  })
})

describe('PostHog client options', () => {
  test('gives every Duet app one client configuration', () => {
    expect(
      createPostHogClientOptions({ hostname: 'duet.so', apiHost: 'https://ph.example' }),
    ).toEqual({
      api_host: 'https://ph.example',
      defaults: '2026-05-30',
      persistence: 'localStorage+cookie',
      cross_subdomain_cookie: true,
      secure_cookie: true,
      __preview_cookie_wins_on_conflict: true,
    })
  })

  test('omits an ingest host the app did not configure', () => {
    const options = createPostHogClientOptions({ hostname: 'localhost' })
    expect(options).not.toHaveProperty('api_host')
    expect(options.secure_cookie).toBe(false)
  })
})
