import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { ConvexHttpClient } from 'convex/browser'

import { MAX_EXPORTED_APP_CREDENTIALS } from '@repo/contract'

import { managedAuthenticationDiagnostic } from '../fixtures/staging-app-key-export-service'
import { runAppKeyExportAcceptance } from './staging-live-app-key-export'
import { StagingArtifactCollector } from './staging-live-artifacts'
import { StagingResourceLedger } from './staging-live-resource-ledger'

const APP = {
  id: 'fixture-app',
  workspaceId: 'workspace',
  anchorId: 'anchor',
  anchorPath: 'apps/app-key-export',
  anchorState: 'active',
  command: 'bun service.ts',
  apiScopes: ['apps', 'services'],
  port: 41000,
  slug: 'app-key-export',
  visibility: 'folder',
  canonicalUrl: 'https://probe.example.test',
  runtimeStatus: 'reconciled',
  createdByUserId: 'owner',
  createdAt: 1,
  updatedAt: 1,
  controls: {
    manageDomain: true,
    updateRuntime: true,
    makePublic: true,
    makePrivate: false,
    delete: true,
  },
}

test('the staging receipt cannot accept managed key presence without actual app authentication', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'app-key-export-'))
  const ledger = new StagingResourceLedger('export-test', Date.now, async () => undefined)
  let diagnosticReads = 0
  let exportRequests = 0
  try {
    await expect(
      runAppKeyExportAcceptance({
        env: { apiUrl: 'https://api.example.test', internalKey: 'fixture-internal' },
        workspace: { _id: 'workspace', slug: 'workspace' },
        apiToken: 'fixture-owner-token',
        runId: 'export-test',
        ledger,
        artifacts: new StagingArtifactCollector(directory, []),
        progress: () => undefined,
        expectedCliVersion: '1.2.3',
        expectedSkillHash: 'fixture-skill-hash',
        convex: new ConvexHttpClient('https://fixture.convex.cloud'),
        fetchImpl: async (url, init) => {
          const pathname = new URL(String(url)).pathname
          if (pathname.endsWith('/diagnostics')) {
            if (++diagnosticReads > 1)
              throw new Error('fixture stopped before managed authentication')
            return Response.json({
              managedKeyPresent: true,
              managedAuthenticated: false,
              cliVersion: '1.2.3',
              buildAppsSkillHash: 'fixture-skill-hash',
              cliCommandAvailable: true,
            })
          }
          if (pathname.endsWith('/cli-export')) exportRequests += 1
          if (pathname.endsWith('/launch'))
            return new Response(null, {
              status: 302,
              headers: { location: 'https://probe.example.test' },
            })
          if (pathname.endsWith('/apps') && init?.method === 'POST')
            return Response.json({ app: APP }, { status: 201 })
          return Response.json({ ok: true })
        },
      }),
    ).rejects.toThrow('fixture stopped before managed authentication')
    expect(exportRequests).toBe(0)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 10_000)

test('the joined journey proves overlap, capacity recovery, irreversible revocation and cleans every created app', async () => {
  for (const [catalogStatus, corruptCapacityLimit] of [
    [200, false],
    [503, false],
    [200, true],
  ] as const) {
    const directory = await mkdtemp(path.join(tmpdir(), 'app-key-export-'))
    const ledger = new StagingResourceLedger('joined-export', Date.now, async () => undefined)
    let appId = 0
    let exists = false
    let serial = 0
    const active = new Map<string, string>()
    const issued = new Map<string, string>()
    const issue = () => {
      if (active.size === MAX_EXPORTED_APP_CREDENTIALS)
        return Response.json(
          {
            error: 'app_credential_limit',
            limit: MAX_EXPORTED_APP_CREDENTIALS + (corruptCapacityLimit ? 1 : 0),
          },
          { status: 409 },
        )
      const id = `export-${++serial}`
      const key = `duet_sk_fixture-export-${serial}`
      active.set(id, key)
      issued.set(id, key)
      return Response.json(
        {
          credentialId: id,
          prefix: 'duet_sk_fixture',
          createdAt: serial,
          expiresAt: null,
          key,
          apiUrl: 'https://api.example.test',
          gatewayBaseUrl: 'https://gateway.example.test',
        },
        { status: 201, headers: { 'cache-control': 'private, no-store' } },
      )
    }
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input))
      const pathname = url.pathname
      const method = init?.method ?? 'GET'
      if (pathname.endsWith('/diagnostics'))
        return Response.json({
          managedAuthenticated: true,
          cliCommandAvailable: true,
          cliVersion: '1.2.3',
          buildAppsSkillHash: 'fixture-skill-hash',
        })
      if (pathname.endsWith('/launch'))
        return new Response(null, {
          status: 302,
          headers: { location: 'https://probe.example.test/admit' },
        })
      if (pathname === '/admit')
        return new Response(null, {
          status: 302,
          headers: { 'set-cookie': 'fixture=grant; Secure; HttpOnly' },
        })
      if (pathname === '/cli-export' || pathname.endsWith('/credentials/export')) return issue()
      if (pathname === '/cli-revoke') {
        active.delete(JSON.parse(String(init?.body)).credentialId)
        return Response.json({ ok: true })
      }
      if (pathname === '/cli-list' || pathname.endsWith('/credentials'))
        return Response.json({
          items: [...active.keys()].map(credentialId => ({
            credentialId,
            prefix: 'duet_sk_fixture',
            createdAt: 1,
            expiresAt: null,
          })),
          nextCursor: null,
        })
      if (pathname.includes('/credentials/') && method === 'DELETE') {
        active.delete(pathname.split('/').at(-1)!)
        return Response.json({ ok: true })
      }
      if (pathname === '/v1/whoami' || pathname === '/v1/models') {
        const token = new Headers(init?.headers).get('authorization')?.slice('Bearer '.length)
        if (pathname === '/v1/models') {
          expect(new Headers(init?.headers).get('x-duet-workspace')).toBeNull()
          expect(new Headers(init?.headers).get('x-duet-tier')).toBeNull()
        }
        return Response.json(
          {},
          {
            status: [...active.values()].includes(token ?? '')
              ? pathname === '/v1/models'
                ? catalogStatus
                : 200
              : 401,
          },
        )
      }
      if (pathname.endsWith('/apps') && method === 'POST') {
        exists = true
        return Response.json({ app: { ...APP, id: `fixture-app-${++appId}` } }, { status: 201 })
      }
      if (pathname.endsWith('/apps/app-key-export')) {
        if (method === 'PATCH') {
          active.clear()
          return Response.json({ app: { ...APP, id: `fixture-app-${appId}` } })
        }
        if (method === 'DELETE') {
          active.clear()
          exists = false
          return Response.json({ ok: true })
        }
        return Response.json(
          exists ? { app: { ...APP, id: `fixture-app-${appId}` } } : { error: 'not_found' },
          { status: exists ? 200 : 404 },
        )
      }
      return Response.json({ ok: true })
    }
    try {
      const accepted = runAppKeyExportAcceptance({
        env: { apiUrl: 'https://api.example.test', internalKey: 'fixture-internal' },
        workspace: { _id: 'workspace', slug: 'workspace' },
        apiToken: 'fixture-owner-token',
        runId: 'joined-export',
        ledger,
        artifacts: new StagingArtifactCollector(directory, []),
        progress: () => undefined,
        expectedCliVersion: '1.2.3',
        expectedSkillHash: 'fixture-skill-hash',
        fetchImpl,
        convex: new ConvexHttpClient('https://fixture.convex.cloud', {
          fetch: Object.assign(
            async (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
              const body = JSON.parse(String(init?.body))
              return Response.json({
                status: 'success',
                value:
                  exists && body.args[0].id === `fixture-app-${appId}`
                    ? [{ slug: 'app-key-export' }]
                    : [],
              })
            },
            { preconnect: globalThis.fetch.preconnect },
          ),
        }),
      })
      if (catalogStatus !== 200) {
        await expect(accepted).rejects.toThrow(
          'external exported app failed catalog authentication',
        )
      } else if (corruptCapacityLimit) {
        await expect(accepted).rejects.toThrow('capacity refusal had the wrong limit')
      } else {
        const evidence = await accepted
        expect(evidence).toMatchObject({
          managedAuthenticated: true,
          cliVersion: '1.2.3',
          exportsOverlap: true,
          individualRevocation: true,
          capacityBounded: true,
          capacityRecovered: true,
          scopeChangePermanent: true,
          rowBindingPermanent: true,
          catalogAuthenticated: true,
        })
        for (const key of issued.values()) expect(JSON.stringify(evidence)).not.toContain(key)
      }
      expect((await ledger.cleanupAll()).status).toBe('pass')
      expect(exists).toBe(false)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }
})

test('the service authenticates its managed app identity through the public whoami contract', async () => {
  expect(
    await managedAuthenticationDiagnostic(
      {
        DUET_APP_API_KEY: 'fixture-managed-token',
        DUET_API_URL: 'https://api.example.test',
      },
      'workspace',
      async (_url, init) => {
        expect(new Headers(init?.headers).get('authorization')).toBe('Bearer fixture-managed-token')
        return Response.json({ credential: { kind: 'app' }, workspaces: [{ slug: 'workspace' }] })
      },
    ),
  ).toEqual({ managedKeyPresent: true, managedAuthenticated: true })
})
