import { afterEach, expect, mock, spyOn, test } from 'bun:test'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { convexTest } from 'convex-test'

import { bootstrapUser } from '../convex/domains/invitations/model'
import schema from '../convex/schema'

const previous = {
  key: process.env.RESEND_API_KEY,
  segment: process.env.DUET_RESEND_USERS_SEGMENT_ID,
}

afterEach(() => {
  mock.restore()
  for (const [key, value] of [
    ['RESEND_API_KEY', previous.key],
    ['DUET_RESEND_USERS_SEGMENT_ID', previous.segment],
  ] as const) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

test('first authenticated bootstrap adds the user to Resend without repeating on login', async () => {
  process.env.RESEND_API_KEY = 're_signup_fixture'
  process.env.DUET_RESEND_USERS_SEGMENT_ID = 'fixture-users'
  const contacts = new Map<string, unknown>()
  let writes = 0
  mockFetch(async (input, init) => {
    const request = new Request(input, init)
    if (request.method === 'GET') return Response.json({}, { status: 404 })
    const body = await request.json()
    contacts.set(body.email, body)
    writes += 1
    return Response.json({ id: 'fixture-contact' })
  })

  const { t, userId } = await fixture()
  await t.run(ctx => bootstrapUser(ctx, userId))
  for (let i = 0; i < 100 && !contacts.has('new-user@example.com'); i += 1) {
    await new Promise(resolve => setTimeout(resolve, 10))
    await t.finishInProgressScheduledFunctions()
  }
  expect(contacts.get('new-user@example.com')).toEqual({
    email: 'new-user@example.com',
    first_name: 'Casey',
    last_name: 'Jones',
    segments: [{ id: 'fixture-users' }],
  })
  await t.run(ctx => bootstrapUser(ctx, userId))
  await t.finishInProgressScheduledFunctions()
  expect(writes).toBe(1)
})

async function fixture(ephemeral = false) {
  const t = convexTest(schema, {
    '../convex/_generated/api.ts': async () => ({}),
    '../convex/services/resendContacts.ts': () => import('../convex/services/resendContacts'),
    '../convex/domains/users/queries.ts': () => import('../convex/domains/users/queries'),
  })
  const directory = dirname(
    fileURLToPath(import.meta.resolve('@convex-dev/action-retrier/package.json')),
  )
  const component = `${directory}/src/component`
  const { default: componentSchema } = await import(`${component}/schema.ts`)
  t.registerComponent('actionRetrier', componentSchema, {
    './_generated/api.ts': () => import(`${component}/_generated/api.js`),
    './public.ts': () => import(`${component}/public.ts`),
    './run.ts': () => import(`${component}/run.ts`),
  })
  const userId = await t.run(async ctx => {
    const userId = await ctx.db.insert('users', {
      email: 'new-user@example.com',
      firstName: 'Casey',
      lastName: 'Jones',
      emailVerificationTime: 1,
      paidCreditBalanceMicroUsd: 0,
      monthlyCreditBalanceMicroUsd: 0,
      memberDirectoryRevision: 0,
      createdAt: 1,
      updatedAt: 1,
      ...(ephemeral ? { ephemeralExpiresAt: Date.now() + 60_000 } : {}),
    })
    const workspaceId = await ctx.db.insert('workspaces', {
      name: 'Existing',
      slug: 'existing',
      status: 'active',
      billingUserId: userId,
      createdAt: 1,
    })
    await ctx.db.insert('workspaceMembers', { userId, workspaceId, role: 'owner' })
    return userId
  })
  return { t, userId }
}

test('Resend retries do not block signup or resubscribe an existing contact', async () => {
  process.env.RESEND_API_KEY = 're_signup_fixture'
  process.env.DUET_RESEND_USERS_SEGMENT_ID = 'fixture-users'
  const contact = { email: 'new-user@example.com', unsubscribed: true, segments: ['newsletter'] }
  let attempts = 0
  mockFetch(async (input, init) => {
    const request = new Request(input, init)
    if (request.method === 'GET') return Response.json(contact)
    expect(request.url).toBe(
      'https://api.resend.com/contacts/new-user%40example.com/segments/fixture-users',
    )
    expect(await request.text()).toBe('')
    attempts += 1
    if (attempts === 1) return Response.json({ message: 'unavailable' }, { status: 503 })
    contact.segments.push('fixture-users')
    return Response.json({ id: 'fixture-users' })
  })
  const { t, userId } = await fixture()
  expect(await t.run(ctx => bootstrapUser(ctx, userId))).toMatchObject({ invited: false })
  for (let i = 0; i < 100 && !contact.segments.includes('fixture-users'); i += 1) {
    await new Promise(resolve => setTimeout(resolve, 10))
    await t.finishInProgressScheduledFunctions()
  }
  expect(contact).toEqual({
    email: 'new-user@example.com',
    unsubscribed: true,
    segments: ['newsletter', 'fixture-users'],
  })
  expect(attempts).toBe(2)
})

test('disposable signups do not create marketing contacts', async () => {
  process.env.RESEND_API_KEY = 're_signup_fixture'
  let requests = 0
  mockFetch(async () => {
    requests += 1
    return Response.json({ id: 'unexpected-contact' })
  })
  const { t, userId } = await fixture(true)
  await t.run(ctx => bootstrapUser(ctx, userId))
  await new Promise(resolve => setTimeout(resolve, 20))
  await t.finishInProgressScheduledFunctions()
  expect(requests).toBe(0)
})

function mockFetch(
  implementation: (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => Promise<Response>,
) {
  spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(implementation, { preconnect: fetch.preconnect }),
  )
}
