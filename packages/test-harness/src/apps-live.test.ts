import { describe, expect, test } from 'bun:test'

import { classifyAppResponse, waitForAppContent } from './apps-live.ts'

describe('apps live acceptance helpers', () => {
  test('classifies only the exact run marker as real app content', () => {
    expect(classifyAppResponse('<h1>SPIKE-OK-r1</h1>', 'SPIKE-OK-r1')).toBe('marker')
    expect(classifyAppResponse('<h1>SPIKE-OK-r2</h1>', 'SPIKE-OK-r1')).toBe('other')
    expect(classifyAppResponse('is being built', 'SPIKE-OK-r1')).toBe('other')
    expect(classifyAppResponse('', 'SPIKE-OK-r1')).toBe('other')
  })

  test('waitForAppContent polls until the marker body arrives and reports timing', async () => {
    const bodies = ['<pre>502 app_unavailable</pre>', 'building', '<h1>SPIKE-OK-r1</h1>']
    let calls = 0
    const result = await waitForAppContent({
      url: 'https://spike-hello--ws.edge-staging.duet.so/',
      marker: 'SPIKE-OK-r1',
      timeoutMs: 5_000,
      intervalMs: 1,
      fetchImpl: async () => new Response(bodies[Math.min(calls++, bodies.length - 1)]),
    })
    expect(result.ok).toBe(true)
    expect(calls).toBe(3)
    expect(result.attempts).toBe(3)
  })

  test('waitForAppContent times out with the last observed body preserved', async () => {
    const result = await waitForAppContent({
      url: 'https://spike-hello--ws.edge-staging.duet.so/',
      marker: 'SPIKE-OK-r1',
      timeoutMs: 5,
      intervalMs: 1,
      fetchImpl: async () => new Response('still building', { status: 404 }),
    })
    expect(result.ok).toBe(false)
    expect(result.lastStatus).toBe(404)
    expect(result.lastBodyPreview).toContain('still building')
  })
})
