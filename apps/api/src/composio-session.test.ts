import { expect, test } from 'bun:test'

import { getFunctionName } from 'convex/server'

import {
  synchronizeComposioSession,
  ToolRouterPermissionsChangedError,
  useComposioSession,
} from './composio-session'
import type { ApiRouteRuntime, ComposioMcpProvider } from './shared'

test('creates once for a Duet session, then updates that same Composio session in place', async () => {
  const ledger = new SessionLedger()
  const creates: string[][] = []
  const updates: Array<{ providerSessionId: string; disabledToolkitSlugs: readonly string[] }> = []
  const provider = providerFixture({ creates, updates, deletes: [] })
  const runtime = runtimeFixture(ledger)
  const args = {
    workspaceId: 'workspace_1',
    duetSessionId: 'duet-session-1',
    callbackUrl: 'https://api.duet.test/callback',
  }

  await synchronizeComposioSession(runtime, provider, args)
  await synchronizeComposioSession(runtime, provider, args)
  expect(creates).toEqual([[]])
  expect(updates).toEqual([])
  expect(
    (
      await useComposioSession(runtime, provider, {
        workspaceId: 'workspace_1',
        duetSessionId: 'duet-session-1',
        callbackUrl: args.callbackUrl,
      })
    ).providerSessionId,
  ).toBe('provider-session-1')

  ledger.setPermissions(['github'])
  await synchronizeComposioSession(runtime, provider, args)

  expect(creates).toEqual([[]])
  expect(updates).toEqual([
    { providerSessionId: 'provider-session-1', disabledToolkitSlugs: ['github'] },
  ])
  expect(ledger.providerSessionId).toBe('provider-session-1')
  expect(ledger.appliedPermissionFingerprint).toBe('permissions:github')
})

test('a policy edit during creation keeps the attached provider session for an in-place retry', async () => {
  const ledger = new SessionLedger()
  ledger.permissionsOnStore = ['github']
  const traces = {
    creates: [] as string[][],
    updates: [] as Array<{
      providerSessionId: string
      disabledToolkitSlugs: readonly string[]
    }>,
    deletes: [] as string[],
  }
  const provider = providerFixture(traces)
  const runtime = runtimeFixture(ledger)
  const args = {
    workspaceId: 'workspace_1',
    duetSessionId: 'duet-session-1',
    callbackUrl: 'https://api.duet.test/callback',
  }

  await expect(synchronizeComposioSession(runtime, provider, args)).rejects.toBeInstanceOf(
    ToolRouterPermissionsChangedError,
  )
  await synchronizeComposioSession(runtime, provider, args)

  expect(traces.creates).toEqual([[]])
  expect(traces.updates).toEqual([
    { providerSessionId: 'provider-session-1', disabledToolkitSlugs: ['github'] },
  ])
  expect(traces.deletes).toEqual([])
})

test('a vanished provider session is replaced while applying current permissions', async () => {
  const ledger = new SessionLedger()
  ledger.providerSessionId = 'provider-session-gone'
  ledger.appliedPermissionFingerprint = ledger.permissionFingerprint
  ledger.setPermissions(['github'])
  const creates: string[][] = []
  const provider: ComposioMcpProvider = {
    async createToolRouterSession(args) {
      creates.push([...args.disabledToolkitSlugs])
      return mcpSession('provider-session-replacement')
    },
    async useToolRouterSession(args) {
      return mcpSession(args.providerSessionId)
    },
    async updateToolRouterSession() {
      throw Object.assign(new Error('provider session not found'), { status: 404 })
    },
    async deleteToolRouterSession() {
      throw new Error('unexpected delete')
    },
  }

  await synchronizeComposioSession(runtimeFixture(ledger), provider, {
    workspaceId: 'workspace_1',
    duetSessionId: 'duet-session-1',
    callbackUrl: 'https://api.duet.test/callback',
  })

  expect(creates).toEqual([['github']])
  expect(ledger.providerSessionId).toBe('provider-session-replacement')
  expect(ledger.appliedPermissionFingerprint).toBe('permissions:github')
})

function providerFixture(traces: {
  creates: string[][]
  updates: Array<{ providerSessionId: string; disabledToolkitSlugs: readonly string[] }>
  deletes: string[]
}): ComposioMcpProvider {
  return {
    async createToolRouterSession(args) {
      traces.creates.push([...args.disabledToolkitSlugs])
      return mcpSession('provider-session-1')
    },
    async useToolRouterSession(args) {
      return mcpSession(args.providerSessionId)
    },
    async updateToolRouterSession(args) {
      traces.updates.push(args)
    },
    async deleteToolRouterSession(args) {
      traces.deletes.push(args.providerSessionId)
    },
  }
}

function mcpSession(providerSessionId: string) {
  return {
    providerSessionId,
    mcp: {
      type: 'http' as const,
      url: `https://composio.test/${providerSessionId}`,
      headers: { 'x-api-key': 'provider-key' },
    },
  }
}

function runtimeFixture(ledger: SessionLedger): ApiRouteRuntime {
  return {
    convex: {
      mutation: ledger.mutation.bind(ledger),
      query: ledger.query.bind(ledger),
    } as never,
    internalKey: 'internal-key',
    apiInternalKey: 'internal-key',
    fetchImpl: fetch,
    now: () => 1_000,
    appUrl: 'https://app.duet.test',
    officialHubOwnerEmail: 'owner@duet.test',
    officialHubBaseUrl: 'https://edge.duet.test',
  }
}

class SessionLedger {
  permissionFingerprint = 'permissions:'
  disabledToolkitSlugs: string[] = []
  providerSessionId?: string
  appliedPermissionFingerprint?: string
  mcpUrl?: string
  toolsList?: { providerSessionId: string; permissionFingerprint: string; resultJson: string }
  permissionsOnStore?: string[]

  setPermissions(disabledToolkitSlugs: string[]): void {
    this.disabledToolkitSlugs = disabledToolkitSlugs
    this.permissionFingerprint = `permissions:${disabledToolkitSlugs.join(',')}`
  }

  async query(reference: unknown, args: Record<string, unknown>): Promise<unknown> {
    const operation = getFunctionName(reference as never)
    if (
      !operation.endsWith(':getToolRouterSession') ||
      args.workspaceId !== 'workspace_1' ||
      args.duetSessionId !== 'duet-session-1'
    ) {
      return { status: 'not_found' }
    }
    return {
      status: 'found',
      permissionFingerprint: this.permissionFingerprint,
      disabledToolkitSlugs: this.disabledToolkitSlugs,
      providerSessionId: this.providerSessionId,
      appliedPermissionFingerprint: this.appliedPermissionFingerprint,
      mcpUrl: this.mcpUrl,
      toolsList: this.toolsList,
    }
  }

  async mutation(reference: unknown, args: Record<string, unknown>): Promise<unknown> {
    const operation = getFunctionName(reference as never)
    if (args.workspaceId !== 'workspace_1' || args.duetSessionId !== 'duet-session-1') {
      return { status: 'not_found' }
    }
    if (operation.endsWith(':rememberToolRouterSessionDetails')) {
      const providerSessionId = args.providerSessionId
      if (typeof providerSessionId !== 'string' || this.providerSessionId !== providerSessionId)
        return { remembered: false }
      if (typeof args.mcpUrl === 'string') this.mcpUrl = args.mcpUrl
      if (args.toolsList !== undefined) {
        const lesson = args.toolsList as { permissionFingerprint: string; resultJson: string }
        this.toolsList = { providerSessionId, ...lesson }
      }
      return { remembered: true }
    }
    if (operation.endsWith(':adoptToolRouterSession')) {
      if ((this.providerSessionId ?? null) !== args.expectedProviderSessionId) {
        return { status: 'changed' }
      }
      this.providerSessionId = String(args.providerSessionId)
      this.mcpUrl = typeof args.mcpUrl === 'string' ? args.mcpUrl : undefined
      this.toolsList = undefined
      if (this.permissionsOnStore !== undefined) {
        this.setPermissions(this.permissionsOnStore)
        this.permissionsOnStore = undefined
        this.appliedPermissionFingerprint = undefined
        return { status: 'adopted', applied: false }
      }
      this.appliedPermissionFingerprint = String(args.permissionFingerprint)
      return { status: 'adopted', applied: true }
    }
    if (operation.endsWith(':markToolRouterSessionPermissionsApplied')) {
      this.appliedPermissionFingerprint = String(args.permissionFingerprint)
      return { applied: true }
    }
    throw new Error(`unexpected mutation: ${operation}`)
  }
}
