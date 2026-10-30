import { appendFile } from 'node:fs/promises'

// Replace only the HTTP edge; the installed CLI still uses the shipped SDK OAuth and transport.
const claims = Buffer.from(
  JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'fixture-account' } }),
).toString('base64url')
const originalFetch = globalThis.fetch
globalThis.fetch = Object.assign(
  async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const request =
      input instanceof Request ? new Request(input, init) : new Request(String(input), init)
    const url = new URL(request.url)
    if (url.protocol === 'data:') return originalFetch(request)
    const bytes = await request.arrayBuffer()
    const text = (
      request.headers.get('content-encoding') === 'zstd'
        ? Bun.zstdDecompressSync(bytes)
        : Buffer.from(bytes)
    ).toString('utf8')
    await appendFile(
      process.env.PUBLIC_PATCH_REQUESTS!,
      JSON.stringify({
        url: request.url,
        headers: Object.fromEntries(request.headers),
        body: text,
      }) + '\n',
    )
    if (url.hostname === 'auth.openai.com') {
      if (url.pathname.endsWith('/deviceauth/usercode'))
        return Response.json({
          device_auth_id: 'fixture-device',
          user_code: 'FIXTURE',
          interval: 0,
        })
      if (url.pathname.endsWith('/deviceauth/token'))
        return Response.json({
          authorization_code: 'fixture-code',
          code_verifier: 'fixture-verifier',
        })
      if (url.pathname === '/oauth/token')
        return Response.json({
          access_token: `header.${claims}.signature`,
          refresh_token: 'fixture-refresh',
          expires_in: 0,
        })
    }
    if (url.hostname === 'chatgpt.com' && url.pathname.endsWith('/responses'))
      return Response.json({ error: { message: 'Controlled plan refusal' } }, { status: 402 })
    throw new Error(`Unexpected outbound request: ${url.origin}${url.pathname}`)
  },
  { preconnect() {} },
)
