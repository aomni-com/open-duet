import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { type ConvexHttpClient } from 'convex/browser'

import { WorkspaceCreateResultSchema } from '@repo/contract'
import {
  convexDev,
  generateAuthKeys,
  issueKey,
  mutate,
  query,
  signInWithMagicLink,
  TEST_AUTH_CODE,
  uniqueEmail,
  type ConvexDevFixture,
} from '@repo/test-harness'

import { createApiApp } from './index'

const BACKEND_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../..', 'packages/backend')
const INTERNAL_KEY = 'workspace-create-failure-internal-key'

let convex: ConvexDevFixture
let app: ReturnType<typeof createApiApp>
let owner: { client: ConvexHttpClient; user: { _id: string } }

describe('transparent workspace create failure', () => {
  beforeAll(async () => {
    convex = await convexDev(BACKEND_DIR, {
      env: {
        ...generateAuthKeys(),
        ACTION_RETRIER_LOG_LEVEL: 'ERROR',
        DUET_API_INTERNAL_KEY: INTERNAL_KEY,
        DUET_TEST_AUTH_CODE: TEST_AUTH_CODE,
        DUET_TEST_AUTH_EMAIL: '1',
        DUET_TEST_FAKE_EXE: 'always-fail',
        DUET_API_URL: 'https://api.example',
        DUET_VM_IMAGE_REF: 'ttl.sh/duet-test-failure:1h',
        DUET_APP_URL: 'http://localhost:3000',
      },
      reset: true,
    })
    app = createApiApp({ convexUrl: convex.url, internalKey: INTERNAL_KEY })
    owner = await signInWithMagicLink(convex, uniqueEmail('attach-failure'), 'Attach Failure')
    await mutate(
      owner.client,
      'testing/workspaces:activateCurrentUserSyntheticSubscriptionForTest',
      {
        internalKey: INTERNAL_KEY,
        plan: 'pro',
      },
    )
  }, 240_000)

  afterAll(async () => {
    await convex?.stop()
  })

  test('create succeeds before bounded attach retries exhaust to unhealthy', async () => {
    const key = await issueKey(owner.client)
    const slug = `attach-failure-${Date.now().toString(36)}`

    const response = await app.request('/v1/workspaces', {
      method: 'POST',
      headers: { authorization: `Bearer ${key.key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ slug, name: 'Attach Failure Workspace' }),
    })

    expect(response.status).toBe(202)
    const created = WorkspaceCreateResultSchema.parse(await response.json())
    expect(created).toEqual({ workspaceId: expect.any(String), slug, status: 'provisioning' })
    expect(await rawWorkspace(created.workspaceId)).toMatchObject({
      status: 'provisioning',
      vmAttachRunId: expect.any(String),
    })

    await eventually(async () => {
      const workspace = await rawWorkspace(created.workspaceId)
      expect(workspace.status).toBe('unhealthy')
      expect(workspace).not.toHaveProperty('vmAttachRunId')
      const events = await auditEvents(owner.client, created.workspaceId)
      expect(events.filter(event => event.event === 'workspace.vm_attach_scheduled')).toHaveLength(
        1,
      )
      expect(events.filter(event => event.event === 'workspace.provisioning_failed')).toEqual([
        expect.objectContaining({
          provenance: expect.objectContaining({
            source: 'workspace_vm_attach',
            reason: expect.stringContaining('always-failing fake exe'),
          }),
        }),
      ])
    }, 30_000)
  }, 60_000)
})

async function rawWorkspace(workspaceId: string): Promise<RawWorkspace> {
  const rows = (await query(convex, 'testing/workspaces:rawWorkspacesForTest', {
    internalKey: INTERNAL_KEY,
  })) as RawWorkspace[]
  const workspace = rows.find(row => row._id === workspaceId)
  expect(workspace).toBeDefined()
  return workspace!
}

async function auditEvents(
  client: ConvexHttpClient,
  workspaceId: string,
): Promise<Array<{ event: string; provenance?: { source?: string; reason?: string } }>> {
  return (await query(client, 'domains/workspaces/queries:getAuditEvents', {
    workspaceId,
  })) as Array<{ event: string; provenance?: { source?: string; reason?: string } }>
}

async function eventually(assertion: () => Promise<void>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      await assertion()
      return
    } catch (error) {
      lastError = error
      await Bun.sleep(50)
    }
  }
  throw lastError
}

interface RawWorkspace {
  _id: string
  slug: string
  status: string
  vmAttachRunId?: string
}
