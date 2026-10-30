import { afterEach, expect, test } from 'bun:test'

import { componentsGeneric, makeFunctionReference, type FunctionReference } from 'convex/server'

import type { Id } from '../convex/_generated/dataModel'
import { appDomainTarget } from '../convex/config'
import {
  cleanupCustomDomainFixtures,
  createCustomDomainFixture,
  settleDomainWork,
} from './custom-domains-fixture'

const nativeFetch = globalThis.fetch
afterEach(cleanupCustomDomainFixtures)
const mutation = (name: string) =>
  makeFunctionReference<'mutation'>(`domains/customDomains/model:${name}`)
const retry = makeFunctionReference<'mutation'>('domains/customDomains/internal:retryCleanup')

test('an aborted native add stays quarantined through public retries until an operator confirms remote settlement', async () => {
  const { t, args, assignments } = await createCustomDomainFixture()
  const scripted = globalThis.fetch
  let release!: () => void
  const held = new Promise<void>(resolve => {
    release = resolve
  })
  let entered!: () => void
  const received = new Promise<void>(resolve => {
    entered = resolve
  })
  let finished!: () => void
  const remoteSettled = new Promise<void>(resolve => {
    finished = resolve
  })
  const hostname = 'uncertain.example.com'
  const abort = new AbortController()
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      const body = (await request.json()) as { name: string }
      entered()
      abort.abort()
      await held
      const assignment = {
        name: body.name,
        apexName: 'example.com',
        ...appDomainTarget(),
        verified: true,
      }
      assignments.set(body.name, assignment)
      finished()
      return Response.json(assignment)
    },
  })
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST' && new URL(String(input)).pathname.endsWith('/domains')) {
        return nativeFetch(server.url, {
          ...init,
          signal: AbortSignal.any([init.signal!, abort.signal]),
        })
      }
      return scripted(input, init)
    },
    { preconnect: nativeFetch.preconnect },
  )
  try {
    const slot = await t.mutation(mutation('attach'), { ...args, slug: 'one', hostname })
    await received
    await settleDomainWork(t)
    expect(assignments.has(hostname)).toBe(false)
    const quarantined = await t.mutation(mutation('recheck'), { ...args, slug: 'one' })
    expect(quarantined).toMatchObject({
      id: slot.id,
      status: 'removing',
      operatorRepairRequired: true,
    })
    await t.mutation(mutation('remove'), { ...args, slug: 'one' })
    await settleDomainWork(t)
    expect(await t.run(ctx => ctx.db.get(slot.id as Id<'customDomains'>))).not.toBeNull()
    const failures = await t.query(
      makeFunctionReference<'query'>('domains/customDomains/internal:listCleanupFailures'),
      { cursor: null, limit: 10 },
    )
    expect(failures.page).toContainEqual(
      expect.objectContaining({ domainId: slot.id, operatorRepairRequired: true }),
    )
    await expect(
      t.mutation(mutation('attach'), { ...args, slug: 'two', hostname }),
    ).rejects.toThrow('hostname_in_use')
    release()
    await remoteSettled
    expect(assignments.get(hostname)?.gitBranch).toBe('staging')
    await expect(t.mutation(retry, { domainId: slot.id })).rejects.toThrow('invalid_request')
    globalThis.fetch = scripted
    await t.mutation(retry, { domainId: slot.id, effectSettlementConfirmed: true })
    await settleDomainWork(t)
    expect(assignments.has(hostname)).toBe(false)
    expect(await t.run(ctx => ctx.db.get(slot.id as Id<'customDomains'>))).toBeNull()
  } finally {
    release()
    server.stop(true)
  }
}, 2_000)

test('a mutating server error is quarantined even when the alias was committed before the response', async () => {
  const { t, args, assignments } = await createCustomDomainFixture()
  const scripted = globalThis.fetch
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await scripted(input, init)
      if (init?.method === 'POST' && new URL(String(input)).pathname.endsWith('/domains'))
        return Response.json({}, { status: 503 })
      return response
    },
    { preconnect: nativeFetch.preconnect },
  )
  const hostname = 'committed-error.example.com'
  const slot = await t.mutation(mutation('attach'), { ...args, slug: 'one', hostname })
  await settleDomainWork(t)
  expect(assignments.get(hostname)?.name).toBe(hostname)
  expect(await t.mutation(mutation('recheck'), { ...args, slug: 'one' })).toMatchObject({
    id: slot.id,
    operatorRepairRequired: true,
  })
})

test('ownership verification failures remain operational observations rather than alias-write quarantine', async () => {
  const { t, args, provider } = await createCustomDomainFixture()
  await t.mutation(mutation('attach'), { ...args, slug: 'one', hostname: 'verify.example.com' })
  await settleDomainWork(t)
  provider.ownershipVerified = false
  const scripted = globalThis.fetch
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      if (new URL(String(input)).pathname.endsWith('/verify'))
        return Response.json({}, { status: 503 })
      return scripted(input, init)
    },
    { preconnect: nativeFetch.preconnect },
  )
  await t.mutation(mutation('recheck'), { ...args, slug: 'one' })
  await settleDomainWork(t)
  const slot = await t.mutation(mutation('recheck'), { ...args, slug: 'one' })
  expect(slot).toMatchObject({ status: 'active', lastError: 'Vercel domain request failed (503)' })
  expect(slot).not.toHaveProperty('operatorRepairRequired')
})

test('cancellation before alias dispatch admits no remote write and remains normally retryable', async () => {
  const { t, args, assignments, requests } = await createCustomDomainFixture()
  const slot = await t.mutation(mutation('attach'), {
    ...args,
    slug: 'one',
    hostname: 'not-dispatched.example.com',
  })
  await t.run(async ctx => {
    for (const scheduled of await ctx.db.system.query('_scheduled_functions').collect())
      if (scheduled.state.kind === 'pending') await ctx.scheduler.cancel(scheduled._id)
  })
  await t.mutation(makeFunctionReference<'mutation'>('domains/customDomains/work:dispatchDue'), {})
  const admitted = (await t.run(ctx => ctx.db.get(slot.id as Id<'customDomains'>)))!
  await t.run(ctx =>
    ctx.runMutation(
      componentsGeneric().actionRetrier!.public!.cancel! as FunctionReference<'mutation'>,
      { runId: admitted.runId },
    ),
  )
  await t.action(makeFunctionReference<'action'>('domains/customDomains/actions:perform'), {
    domainId: slot.id,
    revision: admitted.runRevision,
    operation: 'add',
  })
  expect(requests).toEqual([])
  const stopped = await t.mutation(mutation('recheck'), { ...args, slug: 'one' })
  expect(stopped).not.toHaveProperty('operatorRepairRequired')
  await settleDomainWork(t)
  expect(assignments.get('not-dispatched.example.com')?.name).toBe('not-dispatched.example.com')
})

test('an aborted native delete cannot release the hostname for a future assignment', async () => {
  const { t, args, assignments } = await createCustomDomainFixture()
  const hostname = 'uncertain-delete.example.com'
  const slot = await t.mutation(mutation('attach'), { ...args, slug: 'one', hostname })
  await settleDomainWork(t)
  const scripted = globalThis.fetch
  let release!: () => void
  const held = new Promise<void>(resolve => {
    release = resolve
  })
  let entered!: () => void
  const received = new Promise<void>(resolve => {
    entered = resolve
  })
  let finished!: () => void
  const remoteSettled = new Promise<void>(resolve => {
    finished = resolve
  })
  const abort = new AbortController()
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch() {
      entered()
      abort.abort()
      await held
      assignments.delete(hostname)
      finished()
      return Response.json({})
    },
  })
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'DELETE')
        return nativeFetch(server.url, {
          ...init,
          signal: AbortSignal.any([init.signal!, abort.signal]),
        })
      return scripted(input, init)
    },
    { preconnect: nativeFetch.preconnect },
  )
  try {
    await t.mutation(mutation('remove'), { ...args, slug: 'one' })
    await received
    await settleDomainWork(t)
    expect(assignments.has(hostname)).toBe(true)
    expect(await t.mutation(mutation('recheck'), { ...args, slug: 'one' })).toMatchObject({
      operatorRepairRequired: true,
    })
    await expect(
      t.mutation(mutation('attach'), { ...args, slug: 'two', hostname }),
    ).rejects.toThrow('hostname_in_use')
    release()
    await remoteSettled
    expect(await t.run(ctx => ctx.db.get(slot.id as Id<'customDomains'>))).not.toBeNull()
    globalThis.fetch = scripted
    await t.mutation(retry, { domainId: slot.id, effectSettlementConfirmed: true })
    await settleDomainWork(t)
    await t.mutation(mutation('attach'), { ...args, slug: 'two', hostname })
    await settleDomainWork(t)
    expect(assignments.get(hostname)).toMatchObject({ name: hostname, gitBranch: 'staging' })
  } finally {
    release()
    server.stop(true)
  }
}, 2_000)
