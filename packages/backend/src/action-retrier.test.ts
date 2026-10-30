import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { makeFunctionReference, type FunctionReference } from 'convex/server'

import {
  convexDev,
  generateAuthKeys,
  mutate,
  query,
  signInWithMagicLink,
  TEST_AUTH_CODE,
  uniqueEmail,
  type ConvexDevFixture,
} from '@repo/test-harness'

const BACKEND_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const INTERNAL_KEY = 'test-api-internal-key'

let convex: ConvexDevFixture

describe('durable action scheduling', () => {
  beforeAll(async () => {
    convex = await convexDev(BACKEND_DIR, {
      env: {
        ...generateAuthKeys({ kid: 'test-key', alg: 'RS256' }),
        ACTION_RETRIER_LOG_LEVEL: 'ERROR',
        DUET_API_INTERNAL_KEY: INTERNAL_KEY,
        DUET_TEST_AUTH_CODE: TEST_AUTH_CODE,
        DUET_TEST_AUTH_EMAIL: '1',
        DUET_APP_URL: 'http://localhost:3000',
      },
      reset: true,
    })
  }, 240_000)

  afterAll(async () => {
    await convex?.stop()
  })

  test('a transiently failing action retries and records its VM once', async () => {
    const user = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail('retrier-transient'),
      'Retrier Transient',
    )
    const workspace = (await listMine(user.client))[0]!.workspace

    await mutate(convex, 'testing/actionRetrier:schedule', {
      internalKey: INTERNAL_KEY,
      workspaceId: workspace._id,
      failuresBeforeSuccess: 2,
    })

    const state = await waitForCompletion(workspace._id)
    expect(state).toEqual({
      attempts: 3,
      completions: [{ result: 'success' }],
      status: 'active',
      vmName: `retrier-fixture-${workspace._id}`,
      vmRecords: 1,
    })
  }, 60_000)

  test('an exhausted action reports failure once and marks the workspace unhealthy', async () => {
    const user = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail('retrier-exhausted'),
      'Retrier Exhausted',
    )
    const workspace = (await listMine(user.client))[0]!.workspace

    await mutate(convex, 'testing/actionRetrier:schedule', {
      internalKey: INTERNAL_KEY,
      workspaceId: workspace._id,
      failuresBeforeSuccess: 100,
    })

    const state = await waitForCompletion(workspace._id)
    expect(state.attempts).toBeGreaterThan(1)
    expect(state.attempts).toBeLessThan(100)
    expect(state.completions).toHaveLength(1)
    expect(state.completions[0]).toMatchObject({
      result: 'failed',
      error: expect.stringContaining('Retrier fixture failure'),
    })
    expect(state.status).toBe('unhealthy')
    expect(state.vmName).toBeUndefined()
    expect(state.vmRecords).toBe(0)
  }, 60_000)

  test('the generic conversion action settles an attributed signup run', async () => {
    const user = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail('retrier-conversion'),
      'Retrier Conversion',
    )
    const scheduled = (await mutate(convex, 'testing/conversions:scheduleSignup', {
      internalKey: INTERNAL_KEY,
      userId: user.user._id,
    })) as { instanceId: string; runId: string }

    // The retrier's bookkeeping row is left for the component's own daily
    // vacuum cron; instance settlement is the only completion contract.
    // Settlement — not the campaign's configurable journey state — is what
    // the durable action rail owes.
    const state = await waitForConversionSettlement(scheduled.instanceId, scheduled.runId)
    expect(state.activeRunId).toBeUndefined()
    expect(state.inputs).toEqual([])
    expect(state.lastError).toBeUndefined()
  }, 60_000)
})

async function waitForCompletion(workspaceId: string): Promise<RetrierFixtureState> {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const state = (await query(convex, 'testing/actionRetrier:state', {
      internalKey: INTERNAL_KEY,
      workspaceId,
    })) as RetrierFixtureState
    if (state.completions.length === 1) return state
    await Bun.sleep(50)
  }
  throw new Error('Timed out waiting for retrier fixture completion')
}

async function listMine(client: SignedInUser['client']): Promise<ListMineItem[]> {
  return (await client.query(
    makeFunctionReference('domains/workspaces/queries:listMine') as FunctionReference<'query'>,
    {},
  )) as ListMineItem[]
}

async function waitForConversionSettlement(
  instanceId: string,
  runId: string,
): Promise<ConversionFixtureState> {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const state = (await query(convex, 'testing/conversions:state', {
      internalKey: INTERNAL_KEY,
      instanceId,
      runId,
    })) as ConversionFixtureState
    if (state.activeRunId === undefined && state.inputs.length === 0) return state
    await Bun.sleep(50)
  }
  throw new Error('Timed out waiting for conversion settlement')
}

interface SignedInUser {
  client: ConvexDevFixture['client']
}

interface UserRow {
  _id: string
}

interface ListMineItem {
  workspace: {
    _id: string
  }
}

interface RetrierFixtureState {
  attempts: number
  completions: Array<{ result: 'success' | 'failed'; error?: string }>
  status: string
  vmName?: string
  vmRecords: number
}

interface ConversionFixtureState {
  activeRunId?: string
  done: boolean
  inputs: string[]
  lastError?: string
  state: unknown
}
