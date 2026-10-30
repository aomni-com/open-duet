import { expect, spyOn, test } from 'bun:test'

import { reportRequestFailure } from './request-failure'

test('request diagnostics preserve transport codes and mask credentials in nested failures', () => {
  const logged = spyOn(console, 'error').mockImplementation(() => {})
  const key = `duet_sk_${'a'.repeat(64)}`
  const failure = new Error(
    `failed https://upstream.example/auth?code=one-time-code using ${key}`,
    {
      cause: Object.assign(new Error('socket refused Bearer private-bearer-token'), {
        code: 'ECONNREFUSED',
      }),
    },
  )
  try {
    reportRequestFailure(
      new Request('https://web.example/api/duet/session'),
      'session_exchange_failed',
      failure,
    )
    const diagnostic = JSON.stringify(logged.mock.calls)
    expect(diagnostic).toContain('ECONNREFUSED')
    expect(diagnostic).toContain('socket refused')
    expect(diagnostic).toContain('[REDACTED]')
    expect(diagnostic).not.toContain(key)
    expect(diagnostic).not.toContain('one-time-code')
    expect(diagnostic).not.toContain('private-bearer-token')
  } finally {
    logged.mockRestore()
  }
})
