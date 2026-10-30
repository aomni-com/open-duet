import { expect, test } from 'bun:test'

import { connectedProviders } from '../src/connected-providers/registry.js'

test('the registered Codex OAuth flow refreshes with the patched scope and rotated credential', async () => {
  const originalFetch = globalThis.fetch
  const claims = Buffer.from(
    JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'fixture-account' } }),
  ).toString('base64url')
  let request: Request | undefined
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      request =
        input instanceof Request ? new Request(input, init) : new Request(String(input), init)
      return Response.json({
        access_token: `header.${claims}.signature`,
        refresh_token: 'rotated-refresh',
        expires_in: 600,
      })
    },
    { preconnect() {} },
  )
  try {
    const oauth = connectedProviders()
      .find(entry => entry.id === 'openai-codex')!
      .oauth()
    const credential = await oauth.refresh(
      { type: 'oauth', access: 'expired-access', refresh: 'old-refresh', expires: 0 },
      new AbortController().signal,
    )
    expect(request!.url).toBe('https://auth.openai.com/oauth/token')
    expect(Object.fromEntries(new URLSearchParams(await request!.text()))).toEqual({
      grant_type: 'refresh_token',
      refresh_token: 'old-refresh',
      client_id: 'app_EMoamEEZ73f0CkXaXp7hrann',
      scope: 'openid profile email',
    })
    expect(credential.refresh).toBe('rotated-refresh')
    expect(credential.accountId).toBe('fixture-account')
  } finally {
    globalThis.fetch = originalFetch
  }
})
