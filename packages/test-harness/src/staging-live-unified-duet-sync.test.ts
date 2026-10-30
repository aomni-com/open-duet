import { expect, spyOn, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ConvexHttpClient } from 'convex/browser'

import { configPathForHome, saveConfig } from '../../duet/src/config'
import { StagingArtifactCollector } from './staging-live-artifacts'
import { StagingResourceLedger } from './staging-live-resource-ledger'
import {
  recordUnifiedSyncMachineCleanup,
  registerTrackedSyncMachine,
  waitMirrorDetached,
} from './staging-live-unified-duet-sync'
import { readWorkspaceBrowserEnv } from './staging-live-workspace-browser'

test('machine cleanup remains verifiable after the central ledger retires the member', async () => {
  let retired = false
  let removed = false
  const server = Bun.serve({
    port: 0,
    fetch: request => {
      const path = new URL(request.url).pathname
      if (path === '/api/query') return Response.json({ status: 'success', value: !removed })
      if (retired) return Response.json({ error: 'unauthorized' }, { status: 401 })
      if (request.method === 'DELETE') {
        removed = true
        return Response.json({ ok: true })
      }
      return Response.json({ items: [], nextCursor: null })
    },
  })
  try {
    const ledger = new StagingResourceLedger('run_cleanup', Date.now, async () => {})
    const env = readWorkspaceBrowserEnv({
      DUET_API_URL: 'https://api-staging.duet.so',
      DUET_APP_URL: 'https://app-staging.duet.so',
      CONVEX_DEPLOYMENT: 'dev:fixture',
      DUET_API_INTERNAL_KEY: 'internal',
      DUET_PROGRAMMATIC_LOGIN_SECRET: 'login',
      VERCEL_AUTOMATION_BYPASS_SECRET: 'bypass',
      AGENTMAIL_API_KEY: 'mail',
      DUET_E2E_AGENTMAIL_INBOX_ADDRESS: 'fixture@agentmail.to',
    })
    env.apiUrl = server.url.toString().replace(/\/$/, '')
    recordUnifiedSyncMachineCleanup(
      {
        env,
        ledger,
        runId: ledger.runId,
        artifacts: new StagingArtifactCollector('/unused', []),
        convex: new ConvexHttpClient(server.url.toString()),
      },
      'machine',
      'member',
      'member-credential',
    )
    ledger.record({
      kind: 'user',
      id: 'member',
      label: `${ledger.runId}:member`,
      cleanupPriority: -100,
      cleanup: async () => {
        retired = true
      },
      verify: async () => retired,
    })
    const report = await ledger.cleanupAll()
    expect(report.status).toBe('pass')
    expect(report.resources.find(row => row.id === 'machine')?.status).toBe('deleted')
    expect(removed).toBe(true)
  } finally {
    await server.stop(true)
  }
})

test('registry removal alone cannot certify an existing peer detached', async () => {
  const server = Bun.serve({ port: 0, fetch: () => Response.json({ items: [], nextCursor: null }) })
  const now = spyOn(Date, 'now').mockReturnValue(0)
  try {
    const env = readWorkspaceBrowserEnv({
      DUET_API_URL: 'https://api-staging.duet.so',
      DUET_APP_URL: 'https://app-staging.duet.so',
      CONVEX_DEPLOYMENT: 'dev:fixture',
      DUET_API_INTERNAL_KEY: 'internal',
      DUET_PROGRAMMATIC_LOGIN_SECRET: 'login',
      VERCEL_AUTOMATION_BYPASS_SECRET: 'bypass',
      AGENTMAIL_API_KEY: 'mail',
      DUET_E2E_AGENTMAIL_INBOX_ADDRESS: 'fixture@agentmail.to',
    })
    env.apiUrl = server.url.toString().replace(/\/$/, '')
    const handle = {
      slug: 'workspace',
      localDir: '/scratch',
      stop: async () => {},
      poll: async () => {
        now.mockReturnValue(100_000)
        return {
          connected: true,
          converged: true,
          needBytes: 0,
          remoteCompletion: 100,
          conflicts: 0,
          reposMissingRemote: [],
        }
      },
    }
    await expect(
      waitMirrorDetached(
        { env, apiToken: 'owner', artifacts: new StagingArtifactCollector('/unused', []) },
        { _id: 'workspace', slug: 'workspace', status: 'active' },
        'removed-machine',
        handle,
      ),
    ).rejects.toThrow('Existing mirror did not detach')
  } finally {
    now.mockRestore()
    await server.stop(true)
  }
})

test('a local config failure cannot strand the remotely registered sync machine', async () => {
  const home = await mkdtemp(join(tmpdir(), 'duet-tracked-machine-'))
  let server: Bun.Server<unknown> | undefined
  try {
    const configPath = configPathForHome(home)
    const binary = join(home, 'fake-syncthing')
    await writeFile(
      binary,
      `#!${process.execPath}\nconst dir = process.argv.find(arg => arg.startsWith('--home='))?.slice(7); if(process.argv.includes('generate')) { await Bun.write(dir+'/cert.pem','cert'); await Bun.write(dir+'/key.pem','key'); } else console.log('AAAAAAA-AAAAAAA');\n`,
    )
    await chmod(binary, 0o755)
    server = Bun.serve({
      port: 0,
      fetch: async request => {
        if (request.method === 'POST') {
          // Corrupt only the scratch destination after the remote creation is accepted.
          await rm(configPath)
          await mkdir(configPath)
          return Response.json({
            machineId: 'remote-machine',
            name: 'scratch',
            syncthingDeviceId: 'AAAAAAA-AAAAAAA',
            createdAt: 1,
            lastUsedAt: 1,
          })
        }
        return Response.json({ ok: true })
      },
    })
    const ledger = new StagingResourceLedger('run_local_write', Date.now, async () => {})
    const env = readWorkspaceBrowserEnv({
      DUET_API_URL: 'https://api-staging.duet.so',
      DUET_APP_URL: 'https://app-staging.duet.so',
      CONVEX_DEPLOYMENT: 'dev:fixture',
      DUET_API_INTERNAL_KEY: 'internal',
      DUET_PROGRAMMATIC_LOGIN_SECRET: 'login',
      VERCEL_AUTOMATION_BYPASS_SECRET: 'bypass',
      AGENTMAIL_API_KEY: 'mail',
      DUET_E2E_AGENTMAIL_INBOX_ADDRESS: 'fixture@agentmail.to',
    })
    env.apiUrl = server.url.toString().replace(/\/$/, '')
    await saveConfig({ apiKey: 'key', apiUrl: env.apiUrl }, configPath)
    const context = {
      env,
      ledger,
      runId: ledger.runId,
      convex: new ConvexHttpClient(server.url.toString()),
      artifacts: new StagingArtifactCollector('/unused', []),
    }
    await expect(
      registerTrackedSyncMachine(context, home, binary, 'member', 'cleanup-key'),
    ).rejects.toMatchObject({ code: 'EISDIR' })
    expect(ledger.snapshot().map(row => ({ kind: row.kind, id: row.id }))).toEqual([
      { kind: 'sync-machine', id: 'remote-machine' },
    ])
  } finally {
    await server?.stop(true)
    await rm(home, { recursive: true, force: true })
  }
})
