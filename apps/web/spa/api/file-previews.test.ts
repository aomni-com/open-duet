import { expect, test } from 'bun:test'

import { loadFileTextPreview } from './file-previews'

test('requests the first 4 KiB of a text preview', async () => {
  let request: { input: RequestInfo | URL; init?: RequestInit } | undefined
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    request = { input, init }
    return new Response('preview')
  }

  const controller = new AbortController()
  expect(await loadFileTextPreview('/preview.txt', controller.signal, fetchImpl)).toBe('preview')
  expect(request?.input).toBe('/preview.txt')
  expect(new Headers(request?.init?.headers).get('range')).toBe('bytes=0-4095')
  expect(request?.init?.signal).toBe(controller.signal)
})

test('does not project a failed preview response as file text', async () => {
  const fetchImpl = async () => new Response('not found', { status: 404 })
  expect(
    await loadFileTextPreview('/missing.txt', new AbortController().signal, fetchImpl),
  ).toBeUndefined()
})
