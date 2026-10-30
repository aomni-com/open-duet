import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { type ConvexHttpClient } from 'convex/browser'

import type { GatewayTrainJobReport } from '@repo/contract'
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

import { trainCompletionPath } from '../convex/domains/train/model'

const BACKEND_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const INTERNAL_KEY = 'test-api-internal-key'
const IMAGE_REF = 'ttl.sh/duet-test-train-status:1h'
let convex: ConvexDevFixture
let owner: { client: ConvexHttpClient; user: { _id: string; email: string } }
let sequence = 0

describe('train VM reconciliation', () => {
  beforeAll(async () => {
    convex = await convexDev(BACKEND_DIR, {
      env: {
        ...generateAuthKeys(),
        DUET_API_INTERNAL_KEY: INTERNAL_KEY,
        DUET_TEST_AUTH_CODE: TEST_AUTH_CODE,
        DUET_TEST_AUTH_EMAIL: '1',
        DUET_APP_URL: 'http://localhost:3000',
      },
      reset: true,
    })
    owner = await signInWithMagicLink(convex, uniqueEmail('train-owner'), 'Train Owner')
    await mutate(
      owner.client,
      'testing/workspaces:activateCurrentUserSyntheticSubscriptionForTest',
      {
        internalKey: INTERNAL_KEY,
      },
    )
  }, 240_000)

  afterAll(async () => await convex?.stop())

  test('replays a generation without changing the stored projection', async () => {
    const workspaceId = await prepareWorkspace('idempotent')
    const first = report('job-idempotent', '1', 'running', 'training', 10)
    await reconcile(workspaceId, first)
    await reconcile(workspaceId, { ...first, updatedAt: 999 })

    expect(await rawJob(workspaceId, first.jobId)).toMatchObject({
      generation: '1',
      phase: 'training',
      updatedAt: 10,
    })
  })

  test('acks and skips a stale report against a terminal job without regressing it', async () => {
    // A job that finishes within one poll window emits its whole preparing..done
    // batch in a single sync. If the response is lost, the gateway resends the
    // entire outbox; the older non-terminal reports must be acked (so the outbox
    // drains) but must NOT roll the terminal job back — and must NOT throw, or
    // the whole /v1/vm/sync handler 500s and the VM's sync loop wedges forever.
    const workspaceId = await prepareWorkspace('terminal')
    await reconcile(workspaceId, report('job-terminal', '2', 'done', 'done', 20))

    const accepted = await reconcile(
      workspaceId,
      report('job-terminal', '1', 'running', 'training', 19),
    )

    expect(accepted).toEqual(['1'])
    expect(await rawJob(workspaceId, 'job-terminal')).toMatchObject({
      state: 'done',
      generation: '2',
      phase: 'done',
    })
  })

  test('schedules exactly one completion email across replay', async () => {
    const workspaceId = await prepareWorkspace('email-once')
    const done = report('job-email-once', '1', 'done', 'done', 30)
    await reconcile(workspaceId, done)
    await reconcile(workspaceId, done)
    await waitFor(async () =>
      (await deliveries()).some(row => row.idempotencyKey === 'train_complete:job-email-once'),
    )

    const completionDeliveries = (await deliveries()).filter(
      row => row.idempotencyKey === 'train_complete:job-email-once',
    )
    expect(completionDeliveries).toEqual([
      expect.objectContaining({
        kind: 'train_complete',
        subject: 'Your Duet training is ready',
        attempts: 1,
        status: 'sent',
      }),
    ])
    expect(completionDeliveries[0]).not.toHaveProperty('html')
    expect(completionDeliveries[0]).not.toHaveProperty('email')
  })

  test('does not email for a failed job', async () => {
    const workspaceId = await prepareWorkspace('no-email')
    await reconcile(workspaceId, report('job-failed', '1', 'failed', 'failed', 40))
    expect(await completionWork('job-failed')).toEqual([])
    expect(
      (await deliveries()).some(row => row.idempotencyKey === 'train_complete:job-failed'),
    ).toBe(false)
  })

  test('completion links keep root jobs on computer Train and agent jobs on their Train page', () => {
    expect(trainCompletionPath('acme', undefined)).toBe('/w/acme/train')
    expect(trainCompletionPath('acme', 'research & qa')).toBe(
      '/w/acme/train/agents/research%20%26%20qa',
    )
  })

  test('a VM-first report births the projection with agent identity and createJob tolerates it', async () => {
    const workspaceId = await prepareWorkspace('vm-first-race')
    const agent = (await mutate(owner.client, 'domains/agents/model:registerAgent', {
      workspaceId,
      path: 'agents/racer',
      slug: 'racer',
    })) as { id: string }
    const projected = (await query(convex, 'domains/agents/model:getBySlug', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      slug: 'racer',
    })) as { anchorId: string }

    // The gateway's report lands before the API's createJob.
    await reconcile(workspaceId, {
      ...report('race-job', 'gen-race-1', 'running', 'training', 3),
      anchorId: projected.anchorId,
    })
    const born = await rawJob(workspaceId, 'race-job')
    expect(born?.agentId).toBe(agent.id)
    expect(born?.agentSlug).toBe('racer')

    // The API's late createJob with the same identity is a no-op success…
    const status = (await mutate(convex, 'domains/train/model:createJob', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      agentId: agent.id,
      agentSlug: 'racer',
      jobId: 'race-job',
      userId: owner.user._id,
      now: 4,
    })) as { jobId: string; agentId?: string }
    expect(status.jobId).toBe('race-job')

    // …while a mismatched scope is still an error.
    await expect(
      mutate(convex, 'domains/train/model:createJob', {
        internalKey: INTERNAL_KEY,
        workspaceId,
        jobId: 'race-job',
        userId: owner.user._id,
        now: 5,
      }),
    ).rejects.toThrow('different agent scope')
  })

  test('a report naming an unresolvable agent scope is skipped, never re-scoped to root', async () => {
    const workspaceId = await prepareWorkspace('vm-orphan-scope')
    await reconcile(workspaceId, {
      ...report('orphan-job', 'gen-orphan-1', 'running', 'training', 3),
      anchorId: 'anchor-of-a-deleted-agent',
    })
    expect(await rawJob(workspaceId, 'orphan-job')).toBeUndefined()
  })

  test('createJob rejects a same-scope projection created for a different user', async () => {
    const workspaceId = await prepareWorkspace('creator-mismatch')
    await mutate(convex, 'domains/train/model:createJob', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      jobId: 'creator-job',
      userId: owner.user._id,
      now: 1,
    })
    await expect(
      mutate(convex, 'domains/train/model:createJob', {
        internalKey: INTERNAL_KEY,
        workspaceId,
        jobId: 'creator-job',
        userId: 'someone-else',
        now: 2,
      }),
    ).rejects.toThrow('different agent scope')
  })

  test('root and agent job queries expose only their own scope', async () => {
    const workspaceId = await prepareWorkspace('scope-filter')
    const agent = (await mutate(owner.client, 'domains/agents/model:registerAgent', {
      workspaceId,
      path: 'agents/research',
      slug: 'research',
    })) as { id: string }
    await mutate(convex, 'domains/train/model:createJob', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      jobId: 'root-scope-job',
      userId: owner.user._id,
      now: 1,
    })
    for (const jobId of ['same-time-z', 'same-time-a']) {
      await mutate(convex, 'domains/train/model:createJob', {
        internalKey: INTERNAL_KEY,
        workspaceId,
        jobId,
        userId: owner.user._id,
        now: 3,
      })
    }
    await mutate(convex, 'domains/train/model:createJob', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      agentId: agent.id,
      agentSlug: 'research',
      jobId: 'agent-scope-job',
      userId: owner.user._id,
      now: 2,
    })

    const rootJobs = (await query(convex, 'domains/train/model:listJobs', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      paginationOpts: { cursor: null, numItems: 10 },
    })) as { page: Array<{ jobId: string }>; isDone: boolean }
    const agentJobs = (await query(convex, 'domains/train/model:listJobs', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      agentId: agent.id,
      paginationOpts: { cursor: null, numItems: 10 },
    })) as { page: Array<{ jobId: string; agentId?: string }>; isDone: boolean }

    expect(rootJobs).toMatchObject({
      page: [{ jobId: 'same-time-z' }, { jobId: 'same-time-a' }, { jobId: 'root-scope-job' }],
      isDone: true,
    })
    expect(agentJobs).toMatchObject({
      page: [{ jobId: 'agent-scope-job', agentId: agent.id }],
      isDone: true,
    })
    expect(
      await query(convex, 'domains/train/model:getJob', {
        internalKey: INTERNAL_KEY,
        workspaceId,
        jobId: 'agent-scope-job',
      }),
    ).toBeNull()
    expect(
      await query(convex, 'domains/train/model:getJob', {
        internalKey: INTERNAL_KEY,
        workspaceId,
        agentId: agent.id,
        jobId: 'root-scope-job',
      }),
    ).toBeNull()
  })

  test('VM reconciliation updates job progress without mutating API-owned agent identity', async () => {
    const workspaceId = await prepareWorkspace('agent-reconcile')
    const agent = (await mutate(owner.client, 'domains/agents/model:registerAgent', {
      workspaceId,
      path: 'agents/research',
      slug: 'research',
    })) as { id: string }
    await mutate(convex, 'domains/train/model:createJob', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      agentId: agent.id,
      agentSlug: 'research',
      jobId: 'agent-reconcile-job',
      userId: owner.user._id,
      now: 1,
    })

    await reconcile(workspaceId, {
      ...report('agent-reconcile-job', '1', 'running', 'training', 10),
      agentId: 'gateway-anchor-id',
    })

    expect(await rawJob(workspaceId, 'agent-reconcile-job')).toMatchObject({
      agentId: agent.id,
      agentSlug: 'research',
      generation: '1',
      phase: 'training',
    })
  })

  test('skips completion email when the owning agent was deleted', async () => {
    const workspaceId = await prepareWorkspace('deleted-agent-email')
    const agent = (await mutate(owner.client, 'domains/agents/model:registerAgent', {
      workspaceId,
      path: 'agents/research',
      slug: 'research',
    })) as { id: string }
    await mutate(convex, 'domains/train/model:createJob', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      agentId: agent.id,
      agentSlug: 'research',
      jobId: 'deleted-agent-job',
      userId: owner.user._id,
      now: 1,
    })
    await mutate(owner.client, 'domains/agents/model:deleteAgent', {
      workspaceId,
      slug: 'research',
    })

    await reconcile(workspaceId, report('deleted-agent-job', '1', 'done', 'done', 20))
    expect(await completionWork('deleted-agent-job')).toEqual([])

    expect(
      (await deliveries()).some(row => row.idempotencyKey === 'train_complete:deleted-agent-job'),
    ).toBe(false)
  })
})

function report(
  jobId: string,
  generation: string,
  state: 'running' | 'done' | 'failed',
  phase: 'training' | 'done' | 'failed',
  updatedAt: number,
) {
  return {
    generation,
    jobId,
    creatorUserId: owner.user._id,
    state,
    phase,
    createdAt: 1,
    updatedAt,
    startedAt: 2,
    ...(state === 'done' || state === 'failed' ? { completedAt: updatedAt } : {}),
  }
}

async function reconcile(workspaceId: string, trainReport: GatewayTrainJobReport) {
  return await mutate(convex, 'domains/train/model:reconcileFromVm', {
    internalKey: INTERNAL_KEY,
    workspaceId,
    trainReports: [trainReport],
  })
}

async function rawJob(workspaceId: string, jobId: string) {
  const rows = (await query(convex, 'testing/train:listRawForTest', {
    internalKey: INTERNAL_KEY,
    workspaceId,
  })) as Array<Record<string, unknown>>
  return rows.find(row => row.jobId === jobId)
}

async function completionWork(jobId: string) {
  return await query(convex, 'testing/train:completionWorkForTest', {
    internalKey: INTERNAL_KEY,
    jobId,
  })
}

async function deliveries() {
  return (await query(convex, 'testing/invitations:emailDeliveries', {
    internalKey: INTERNAL_KEY,
    to: owner.user.email,
  })) as Array<{
    idempotencyKey: string
    kind: string
    subject: string
    attempts: number
    status: string
  }>
}

async function prepareWorkspace(prefix: string): Promise<string> {
  const slug = `${prefix}-${Date.now()}-${++sequence}`
  return (
    (await mutate(convex, 'testing/workspaces:prepareWorkspaceForRegistration', {
      internalKey: INTERNAL_KEY,
      actorId: owner.user._id,
      slug,
      name: slug,
      imageRef: IMAGE_REF,
      provisioningTokenHash: 'hash',
      provisioningTokenExpiresAt: Date.now() + 60_000,
      now: Date.now(),
    })) as { workspaceId: string }
  ).workspaceId
}

async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error('timed out waiting for email')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}
