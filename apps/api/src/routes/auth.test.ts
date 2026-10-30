import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { SIGN_IN_CODE_TTL_SECONDS } from '@repo/contract'
import {
  convexDev,
  generateAuthKeys,
  signInWithMagicLink,
  TEST_AUTH_CODE,
  uniqueEmail,
  type ConvexDevFixture,
} from '@repo/test-harness'

import { SIGN_IN_ATTEMPT_BUDGET } from '../../../../packages/backend/convex/domains/authRequests/model'
import { createApiApp } from '../index'

const BACKEND_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../..', 'packages/backend')
const INTERNAL_KEY = 'test-auth-routes-internal-key'
const APP_URL = 'http://localhost:3000'

// The minted id is the one field two 202s are allowed to differ in. Blanking it
// out is what lets the rest of the body be compared as bytes — key order, the
// constant, the id's own shape — because the caller here is anonymous and any
// difference between a known and an unknown address is an account oracle.
const REQUEST_ID_PATTERN = /req_[a-f0-9]{32}/g

let convex: ConvexDevFixture
let app: ReturnType<typeof createApiApp>
let knownEmail: string
let clock = Date.now()
let sequence = 0

beforeAll(async () => {
  convex = await convexDev(BACKEND_DIR, {
    env: {
      ...generateAuthKeys(),
      DUET_API_INTERNAL_KEY: INTERNAL_KEY,
      DUET_TEST_AUTH_CODE: TEST_AUTH_CODE,
      DUET_TEST_AUTH_EMAIL: '1',
      DUET_APP_URL: APP_URL,
    },
    reset: true,
  })
  app = createApiApp({
    convexUrl: convex.url,
    internalKey: INTERNAL_KEY,
    appUrl: APP_URL,
    // The bucket assertions below need one network per request, which is
    // only expressible where forwarded headers are trusted.
    trustProxyHeaders: true,
    now: () => clock,
  })
  knownEmail = uniqueEmail('auth-known')
  await signInWithMagicLink(convex, knownEmail, 'Casey Known')
}, 240_000)

afterAll(async () => await convex?.stop())

describe('POST /v1/auth/email/start', () => {
  test('answers a known and an unknown address with byte-identical 202s', async () => {
    const unknownEmail = uniqueSignInEmail('unknown')

    const unknown = await start({ email: unknownEmail }, '198.51.100.1')
    const known = await start({ email: knownEmail }, '198.51.100.2')

    // Captured before the assertion below: an asymmetric matcher overwrites the
    // field it matched on the received object.
    const mintedIds = [unknown.body.request_id as string, known.body.request_id as string]
    expect([unknown.status, known.status]).toEqual([202, 202])
    expect(unknown.headers.get('content-type')).toBe(known.headers.get('content-type'))
    // The bytes, not the parsed object: key order and number formatting are
    // part of what an oracle would read.
    expect(redactRequestId(unknown.text)).toBe(redactRequestId(known.text))
    expect(unknown.text).not.toBe(known.text)
    expect(unknown.body).toEqual({
      request_id: expect.stringMatching(/^req_[a-f0-9]{32}$/) as unknown as string,
      // The published constant, never a remainder computed from a stored row —
      // a remainder would leak how long ago this address last asked.
      expires_in: SIGN_IN_CODE_TTL_SECONDS,
    })

    // Both really started a sign-in: a matching answer built from nothing would
    // satisfy the byte comparison above just as well.
    for (const [email, requestId] of [
      [unknownEmail, mintedIds[0]],
      [knownEmail, mintedIds[1]],
    ] as const) {
      const rows = await rawRequests(email)
      expect(rows.map(row => row.requestId)).toEqual([requestId as string])
      expect(rows[0]?.email).toBe(email)
    }
    expect(await deliveredCodeEmails(unknownEmail)).toBe(1)
  })

  test('accepts a request with no client_name and records one that names its agent', async () => {
    const anonymousClient = uniqueSignInEmail('no-client')
    const namedClient = uniqueSignInEmail('named-client')

    const bare = await start({ email: anonymousClient }, '198.51.100.3')
    const named = await start({ email: namedClient, client_name: 'Claude Code' }, '198.51.100.4')

    expect([bare.status, named.status]).toEqual([202, 202])
    expect((await rawRequests(anonymousClient))[0]?.clientName).toBeUndefined()
    expect((await rawRequests(namedClient))[0]?.clientName).toBe('Claude Code')
    // Naming the agent must not change the answer either.
    expect(redactRequestId(bare.text)).toBe(redactRequestId(named.text))
  })

  test('refuses a body that names no address it could mail, and starts nothing', async () => {
    const uppercased = ` ${uniqueSignInEmail('trimmed').toUpperCase()} `

    for (const body of [
      { email: 'casey' },
      { email: '' },
      {},
      { email: 'casey@example.com', client_name: '   ' },
      { email: 'casey@example.com', client_name: 'x'.repeat(100_000) },
    ]) {
      const refusal = await start(body, '198.51.100.5')
      expect(refusal.status, JSON.stringify(body)).toBe(400)
      expect(refusal.body).toEqual({ error: 'invalid_request' })
    }
    expect(await rawRequests('casey@example.com')).toEqual([])

    // The same address padded and shouted is still a legal request, and lands
    // canonicalized — the row has to match what the mail provider echoes back.
    const accepted = await start({ email: uppercased }, '198.51.100.5')
    expect(accepted.status).toBe(202)
    expect((await rawRequests(uppercased.trim().toLowerCase()))[0]?.email).toBe(
      uppercased.trim().toLowerCase(),
    )
  })

  test('needs no credential, on an app where every other /v1 path demands one', async () => {
    const email = uniqueSignInEmail('no-credential')

    const response = await app.request(startRequest({ email }, '198.51.100.6'))

    expect(response.status).toBe(202)
    // Proves the 202 above came from the bypass list and not from a missing
    // middleware: the same app, one path over, still refuses an anonymous call.
    expect((await app.request(new Request('http://localhost/v1/whoami'))).status).toBe(401)
  })

  test('bounds starts for one address across networks and resets after its window', async () => {
    const email = uniqueSignInEmail('email-bucket')

    const requestIds: string[] = []
    let refused: StartResult | undefined
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const response = await start({ email }, `203.0.113.${attempt + 1}`)
      if (response.status === 429) {
        refused = response
        break
      }
      expect(response.status).toBe(202)
      requestIds.push(response.body.request_id as string)
    }
    expect(refused).toBeDefined()
    expect(refused!.body).toMatchObject({ error: 'rate_limited' })
    expect(Number(refused!.headers.get('retry-after'))).toBeGreaterThan(0)
    expect((await rawRequests(email)).map(row => row.requestId).sort()).toEqual(requestIds.sort())
    clock += Number(refused!.headers.get('retry-after')) * 1000
    expect((await start({ email }, '203.0.113.250')).status).toBe(202)
  })

  test('charges the network bucket before it has even read the address', async () => {
    const network = '203.0.113.99'
    const email = uniqueSignInEmail('network-bucket')

    // Malformed bodies: they never reach the email bucket or the mailer, so
    // whatever exhausts the budget here can only be the network bucket.
    let exhausted = false
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const response = await start({ email: 'nope' }, network)
      if (response.status === 429) {
        exhausted = true
        break
      }
      expect(response.status).toBe(400)
    }
    expect(exhausted).toBe(true)
    const refused = await start({ email }, network)

    expect(refused.status).toBe(429)
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0)
    // Refused before the parse that would have found a perfectly good address,
    // so no request record and no mail.
    expect(await rawRequests(email)).toEqual([])
    // A caller on another network is unaffected — the bucket really is keyed.
    expect((await start({ email }, '203.0.113.98')).status).toBe(202)
  })
})

describe('POST /v1/auth/email/verify', () => {
  // DUET_TEST_AUTH_CODE pins every code in the fixture to one constant, so two
  // accounts each holding a live code put two rows under one hash — and
  // `verifyCodeAndSignIn` reads that index with `.unique()`, which throws for
  // reasons that have nothing to do with the code the caller sent. Clearing the
  // ground before each case keeps these tests about the route.
  beforeEach(async () => {
    await convex.mutation('testing/authRequests:discardVerificationCodesForTest', {
      internalKey: INTERNAL_KEY,
    })
  })

  test('turns a code into a human key and registers the new person', async () => {
    const email = uniqueSignInEmail('verify-new')
    const requestId = await startFor(email)

    const issued = await verify({
      request_id: requestId,
      code: TEST_AUTH_CODE,
      name: 'Casey Vance',
      workspace_name: 'Vance Roofing',
    })

    expect(issued.status).toBe(200)
    expect(issued.body).toMatchObject({
      token_type: 'bearer',
      created: true,
      workspace: { slug: 'vance-roofing', name: 'Vance Roofing' },
    })
    expect(issued.body.access_token).toMatch(/^duet_sk_/)

    // The key is the point of the whole rail, so prove it authenticates rather
    // than merely that it was returned.
    const whoami = await app.request(
      new Request('http://localhost/v1/whoami', {
        headers: { authorization: `Bearer ${issued.body.access_token as string}` },
      }),
    )
    expect(whoami.status).toBe(200)
    expect(await whoami.json()).toMatchObject({ user: { email } })
  })

  test('refuses a wrong code without spending the request, and counts down', async () => {
    const requestId = await startFor(uniqueSignInEmail('verify-wrong'))

    const wrong = await verify({ request_id: requestId, code: 'ZZZZ-ZZZZ' })
    expect(wrong.status).toBe(400)
    expect(wrong.body).toEqual({
      error: 'invalid_code',
      attempts_remaining: SIGN_IN_ATTEMPT_BUDGET - 1,
    })

    // The right code still works afterwards: a wrong guess costs an attempt,
    // not the request.
    const issued = await verify({ request_id: requestId, code: TEST_AUTH_CODE })
    expect(issued.status).toBe(200)
  })

  test('answers an unknown request id with 410 rather than an oracle', async () => {
    const expired = await verify({
      request_id: `req_${'0'.repeat(32)}`,
      code: TEST_AUTH_CODE,
    })
    expect(expired.status).toBe(410)
    expect(expired.body).toEqual({ error: 'expired' })
  })

  test('rejects a malformed body before it reaches the domain', async () => {
    const bad = await verify({ request_id: 'not-a-request-id', code: TEST_AUTH_CODE })
    expect(bad.status).toBe(400)
    expect(bad.body).toEqual({ error: 'invalid_request' })

    const badCode = await verify({ request_id: `req_${'0'.repeat(32)}`, code: 'lowercase' })
    expect(badCode.status).toBe(400)
    expect(badCode.body).toEqual({ error: 'invalid_request' })
  })

  test('is reachable with no credential at all', async () => {
    // Proves the bypass wiring covers verify too. Without it the middleware
    // 401s before the handler ever runs, and every assertion above would be
    // testing the wrong thing.
    const anonymous = await verify({
      request_id: `req_${'0'.repeat(32)}`,
      code: TEST_AUTH_CODE,
    })
    expect(anonymous.status).not.toBe(401)
  })

  test('buckets guesses per request id, not per address', async () => {
    // Keying this on the address would let anyone lock a victim out of their
    // own sign-in by burning the bucket from outside.
    const requestId = await startFor(uniqueSignInEmail('verify-bucket'))
    const statuses: number[] = []
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const response = await verify(
        { request_id: requestId, code: 'ZZZZ-ZZZZ' },
        `198.51.100.${attempt + 20}`,
      )
      statuses.push(response.status)
      if (response.status === 429) break
    }
    expect(statuses.at(-1)).toBe(429)

    // A different request is untouched by the first one's exhausted bucket.
    const other = await startFor(uniqueSignInEmail('verify-bucket-other'))
    const fresh = await verify({ request_id: other, code: TEST_AUTH_CODE })
    expect(fresh.status).not.toBe(429)
  })
})

function uniqueSignInEmail(label: string): string {
  sequence += 1
  const nonce = `${sequence}-${Date.now()}`
  return `auth-route-${label}-${nonce}@${label}-${nonce}.example`
}

function startRequest(body: unknown, network: string): Request {
  return new Request('http://localhost/v1/auth/email/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': network },
    body: JSON.stringify(body),
  })
}

interface StartResult {
  status: number
  headers: Headers
  text: string
  body: Record<string, unknown>
}

async function start(body: unknown, network: string): Promise<StartResult> {
  const response = await app.request(startRequest(body, network))
  const text = await response.text()
  return {
    status: response.status,
    headers: response.headers,
    text,
    body: JSON.parse(text) as Record<string, unknown>,
  }
}

function verifyRequest(body: unknown, network: string): Request {
  return new Request('http://localhost/v1/auth/email/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': network },
    body: JSON.stringify(body),
  })
}

async function verify(body: unknown, network = '203.0.113.9'): Promise<StartResult> {
  const response = await app.request(verifyRequest(body, network))
  const text = await response.text()
  return {
    status: response.status,
    headers: response.headers,
    text,
    body: JSON.parse(text) as Record<string, unknown>,
  }
}

/** Start a sign-in and hand back the id. The code is the pinned test constant. */
async function startFor(email: string): Promise<string> {
  const started = await start({ email }, '203.0.113.1')
  return started.body.request_id as string
}

function redactRequestId(text: string): string {
  return text.replace(REQUEST_ID_PATTERN, 'req_<minted>')
}

interface RequestRow {
  requestId: string
  email: string
  clientName?: string
}

async function rawRequests(email: string): Promise<RequestRow[]> {
  return (await convex.query('testing/authRequests:rawRequests', {
    internalKey: INTERNAL_KEY,
    email,
  })) as RequestRow[]
}

async function deliveredCodeEmails(to: string): Promise<number> {
  const deliveries = (await convex.query('testing/invitations:emailDeliveries', {
    internalKey: INTERNAL_KEY,
    to,
  })) as Array<{ kind: string; status: string }>
  return deliveries.filter(
    delivery => delivery.kind === 'auth_magic_link' && delivery.status === 'sent',
  ).length
}
