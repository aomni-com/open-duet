import { expect, test } from 'bun:test'

import { waitForSharedFileBytes } from './staging-live-share.ts'

test('share byte arrival accepts matching product-API bytes after transient absence', async () => {
  const requests: Request[] = []
  const responses = [
    new Response(JSON.stringify({ error: 'gateway_failed' }), { status: 502 }),
    new Response(JSON.stringify({ error: 'not_found' }), { status: 404 }),
    new Response('rail-delivered-bytes', { status: 200 }),
  ]
  const times = [1_000, 1_250]

  const result = await waitForSharedFileBytes({
    url: 'https://ctl-staging.duet.so/v1/ws/recipient/files/shared/run/proof.txt',
    token: 'duet_sk_browser',
    expectedBytes: 'rail-delivered-bytes',
    timeoutMs: 5_000,
    pollMs: 1,
    now: () => times.shift() ?? 1_250,
    sleep: async () => undefined,
    fetchImpl: async (input, init) => {
      requests.push(new Request(input, init))
      return responses.shift()!
    },
  })

  expect(result.latencyMs).toBe(250)
  expect(requests.map(request => request.url)).toEqual([
    'https://ctl-staging.duet.so/v1/ws/recipient/files/shared/run/proof.txt',
    'https://ctl-staging.duet.so/v1/ws/recipient/files/shared/run/proof.txt',
    'https://ctl-staging.duet.so/v1/ws/recipient/files/shared/run/proof.txt',
  ])
  expect(
    requests.every(request => request.headers.get('authorization') === 'Bearer duet_sk_browser'),
  ).toBe(true)
})

test('share byte arrival retries wrong bytes and reports them at the deadline', async () => {
  const times = [1_000, 1_010, 1_020]
  let reads = 0
  await expect(
    waitForSharedFileBytes({
      url: 'https://ctl-staging.duet.so/v1/ws/recipient/files/shared/run/proof.txt',
      token: 'duet_sk_browser',
      expectedBytes: 'origin-bytes',
      timeoutMs: 15,
      now: () => times.shift() ?? 1_020,
      sleep: async () => undefined,
      fetchImpl: async () => {
        reads += 1
        return new Response('stale-recipient-bytes', { status: 200 })
      },
    }),
  ).rejects.toThrow('shared file bytes differed from the origin write')
  expect(reads).toBeGreaterThan(1)
})

test('share byte arrival converges when repair lands mid-poll', async () => {
  let reads = 0
  let now = 1000
  const result = await waitForSharedFileBytes({
    url: 'https://ctl-staging.duet.so/v1/ws/recipient/files/shared/run/proof.txt',
    token: 'duet_sk_browser',
    expectedBytes: 'origin-bytes',
    now: () => now,
    sleep: async () => undefined,
    fetchImpl: async () => {
      reads += 1
      now += 25
      return new Response(reads < 3 ? 'stale-recipient-bytes' : 'origin-bytes', { status: 200 })
    },
  })
  expect(result.latencyMs).toBe(75)
  expect(reads).toBe(3)
})

test('share byte arrival has a finite bound while the recipient path is absent', async () => {
  const times = [1_000, 1_010]

  await expect(
    waitForSharedFileBytes({
      url: 'https://ctl-staging.duet.so/v1/ws/recipient/files/shared/run/proof.txt',
      token: 'duet_sk_browser',
      expectedBytes: 'origin-bytes',
      timeoutMs: 5,
      now: () => times.shift() ?? 1_010,
      sleep: async () => undefined,
      fetchImpl: async () => new Response(null, { status: 404 }),
    }),
  ).rejects.toThrow('Timed out waiting 5ms for shared file bytes')
})
