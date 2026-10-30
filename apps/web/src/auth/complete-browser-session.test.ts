import { expect, spyOn, test } from 'bun:test'

import { completeBrowserSession } from './complete-browser-session'

test('bootstrap failures retain their cause in server logs', async () => {
  const logged = spyOn(console, 'error').mockImplementation(() => {})
  try {
    const response = await completeBrowserSession({
      request: new Request('https://web.example/api/duet/session', {
        method: 'POST',
        headers: { origin: 'https://web.example' },
      }),
      bootstrap: async () => {
        throw new Error('Workspace lookup failed [Request ID: bootstrap-123]')
      },
      exchange: async () => {
        throw new Error('must not exchange after failed bootstrap')
      },
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'bootstrap_failed' })
    expect(JSON.stringify(logged.mock.calls)).toContain('bootstrap-123')
  } finally {
    logged.mockRestore()
  }
})
