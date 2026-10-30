import { expect, test } from 'bun:test'

import { completeBrowserSession } from './complete-browser-session'
import { identifyDevice } from './device-identification'

const DEVICE = { visitorId: 'visitor-a', requestId: 'request-a' }

function sessionRequest(body?: unknown): Request {
  return new Request('https://app.duet.so/api/duet/session', {
    method: 'POST',
    headers: {
      origin: 'https://app.duet.so',
      'sec-fetch-site': 'same-origin',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

async function bootstrapCalls(body?: unknown): Promise<unknown[]> {
  const calls: unknown[] = []
  await completeBrowserSession({
    request: sessionRequest(body),
    bootstrap: async (_tokens, device) => {
      calls.push(device)
      return { workspaceSlug: 'acme', invited: false }
    },
    exchange: async () => new Response(null, { status: 204 }),
  })
  return calls
}

test('the identification reaches bootstrap', async () => {
  expect(await bootstrapCalls({ device: DEVICE })).toEqual([DEVICE])
})

test.each([
  ['no body at all', undefined],
  ['a body with no device', {}],
  ['a malformed device', { device: { visitorId: 'only-half' } }],
  ['a device of the wrong shape', { device: 'not-an-object' }],
  ['empty identifiers', { device: { visitorId: '', requestId: '' } }],
])('signs the user in anyway given %s', async (_label, body) => {
  // Fail open, deliberately: a client that cannot identify — ad blocker,
  // offline, no key — must still be able to sign up. The server treats a
  // missing device as an allow, so this must not become an error path.
  const calls = await bootstrapCalls(body)

  expect(calls).toEqual([undefined])
})

test('reading the device leaves the request body intact for the exchange', async () => {
  // The handler clones before reading. Consuming the original stream here would
  // strand the proxy exchange with an already-read body.
  const request = sessionRequest({ device: DEVICE })
  let exchanged: string | undefined

  await completeBrowserSession({
    request,
    bootstrap: async () => ({ workspaceSlug: 'acme', invited: false }),
    exchange: async forwarded => {
      exchanged = await forwarded.text()
      return new Response(null, { status: 204 })
    },
  })

  expect(exchanged).toBe(JSON.stringify({ device: DEVICE }))
})

test('identifyDevice returns the pair the SDK resolved', async () => {
  expect(await identifyDevice(async () => DEVICE)).toEqual(DEVICE)
})

test.each([
  ['there is no provider', undefined],
  ['the SDK rejects', async () => Promise.reject(new Error('blocked'))],
  ['the SDK resolves without ids', async () => ({})],
  ['the SDK resolves empty ids', async () => ({ visitorId: '', requestId: '' })],
])('identifyDevice reports nothing when %s', async (_label, getData) => {
  expect(await identifyDevice(getData as never)).toBeUndefined()
})
