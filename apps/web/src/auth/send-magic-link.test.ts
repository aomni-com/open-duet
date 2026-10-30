import { expect, spyOn, test } from 'bun:test'

import { sendMagicLink } from './send-magic-link'

test('reports successful magic-link delivery and exposes failed delivery', async () => {
  const originalUrl = process.env.NEXT_PUBLIC_CONVEX_URL
  const fetchSpy = spyOn(globalThis, 'fetch')
  const start = { email: 'person@example.com', redirectTo: 'https://app.example.com/' }
  try {
    process.env.NEXT_PUBLIC_CONVEX_URL = 'https://fixture.convex.cloud'
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ status: 'success', value: { started: false }, logLines: [] })),
    )
    await expect(sendMagicLink(start)).rejects.toThrow('Magic-link delivery did not start')
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ status: 'success', value: { started: true }, logLines: [] })),
    )
    expect(await sendMagicLink(start)).toBeUndefined()
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({
          status: 'error',
          errorMessage: 'Email provider unavailable',
          logLines: [],
        }),
        { status: 560 },
      ),
    )
    await expect(sendMagicLink(start)).rejects.toThrow('Email provider unavailable')
  } finally {
    fetchSpy.mockRestore()
    if (originalUrl === undefined) delete process.env.NEXT_PUBLIC_CONVEX_URL
    else process.env.NEXT_PUBLIC_CONVEX_URL = originalUrl
  }
})
