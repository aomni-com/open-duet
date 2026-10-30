import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { type ConvexHttpClient } from 'convex/browser'

import { WorkspaceCreateResultSchema } from '@repo/contract'
import {
  convexDev,
  DUET_TEST_VM_TAG,
  exeVmPool,
  generateAuthKeys,
  issueKey,
  mutate,
  query,
  signInWithMagicLink,
  TEST_AUTH_CODE,
  uniqueEmail,
  type ConvexDevFixture,
} from '@repo/test-harness'

import { createEdgeApp } from '../../edge/src/index'
import { createApiApp } from './index'

const BACKEND_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../..', 'packages/backend')
const INTERNAL_KEY = 'test-api-internal-key-real-vm'
const DERIVE_SECRET = 'test-vm-token-derive-secret'
const shouldRun = Boolean(process.env.EXE_TOKEN && process.env.DUET_REAL_VM_IMAGE_REF)

let convex: ConvexDevFixture | undefined
let apiServer: ReturnType<typeof Bun.serve> | undefined
let tunnel: ChildProcessWithoutNullStreams | undefined
let tempDir: string | undefined

describe.skipIf(!shouldRun)('slice04 real VM provisioning round trip', () => {
  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'duet-real-vm-'))
  })

  afterAll(async () => {
    tunnel?.kill('SIGTERM')
    apiServer?.stop(true)
    await convex?.stop()
    if (tempDir) await rm(tempDir, { recursive: true, force: true })
  })

  test('create registers, VM sync recovers after restart, and paused servicing removes the VM', async () => {
    tunnel?.kill('SIGTERM')
    apiServer?.stop(true)
    await convex?.stop()
    tunnel = undefined
    apiServer = undefined
    convex = undefined
    const imageRef = process.env.DUET_REAL_VM_IMAGE_REF!
    const pool = exeVmPool({ token: process.env.EXE_TOKEN })
    const createdVmNames = new Set<string>()
    const timeline: Record<string, number> = {}
    const startedAt = Date.now()

    const port = 41_000 + Math.floor(Math.random() * 1_000)
    const localApiUrl = `http://127.0.0.1:${port}`
    let app: ReturnType<typeof createApiApp> | undefined
    apiServer = Bun.serve({
      hostname: '127.0.0.1',
      port,
      fetch: request => app?.fetch(request) ?? new Response('starting', { status: 503 }),
    })
    const publicApiUrl = await startTunnel(port)

    convex = await convexDev(BACKEND_DIR, {
      env: {
        ...generateAuthKeys({ kid: 'test-key', alg: 'RS256' }),
        DUET_API_INTERNAL_KEY: INTERNAL_KEY,
        DUET_TEST_AUTH_CODE: TEST_AUTH_CODE,
        DUET_TEST_AUTH_EMAIL: '1',
        DUET_TEST_AUTH_GOOGLE: '1',
        DUET_VM_TOKEN_DERIVE_SECRET: DERIVE_SECRET,
        DUET_VM_SYNC_INTERVAL_SECONDS: '5',
        DUET_GATEWAY_EXTRA_HEADERS_JSON: JSON.stringify({ 'bypass-tunnel-reminder': 'duet' }),
        DUET_EXE_CREATE_TRANSPORT: 'ssh',
        DUET_EXE_VM_TAGS: DUET_TEST_VM_TAG,
        DUET_API_URL: publicApiUrl,
        DUET_VM_IMAGE_REF: imageRef,
        EXE_TOKEN: process.env.EXE_TOKEN!,
        DUET_APP_URL: 'http://localhost:3000',
      },
      reset: true,
    })

    app = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
    })
    await waitForPublicApi(publicApiUrl)

    try {
      const owner = await signInWithMagicLink<UserRow>(
        convex!,
        uniqueEmail('real-owner'),
        'Real VM Owner',
      )
      await preparePaidSeedWorkspace(owner.client, createdVmNames)
      const key = await issueKey(owner.client)
      const slug = uniqueSlug('real-provision')

      const createResponse = await fetch(`${localApiUrl}/v1/workspaces`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${key.key}`,
          'content-type': 'application/json',
          'bypass-tunnel-reminder': 'duet',
        },
        body: JSON.stringify({ slug, name: 'Real Provisioning' }),
      })
      expect(createResponse.status).toBe(202)
      const created = WorkspaceCreateResultSchema.parse(await createResponse.json())
      expect(created).toMatchObject({ slug, status: 'provisioning' })
      timeline.createReturned = secondsSince(startedAt)

      let active = await waitForWorkspace(
        created.workspaceId,
        workspace => workspace.status === 'active',
      )
      createdVmNames.add(active.vmName!)
      timeline.active = secondsSince(startedAt)
      expect(active.lastHeartbeatAt).toBeNumber()
      timeline.firstHeartbeat = secondsSince(startedAt)

      await pool.client.waitUntilReady(active.sshDest!, { timeoutMs: 180_000 })
      const filesKey = await issueKey(owner.client)
      const uploadPath = join(tempDir!, 'slice05-upload.bin')
      const uploadBytes = deterministicBytes(3 * 1024 * 1024)
      await writeFile(uploadPath, uploadBytes)
      const putEvidence = await curlRequest([
        '-X',
        'PUT',
        '-T',
        uploadPath,
        '-H',
        `Authorization: Bearer ${filesKey.key}`,
        `${localApiUrl}/v1/ws/${slug}/files/live/big.bin`,
      ])
      expect(putEvidence.statusLine).toInclude('200')

      const firstRange = await curlRequest([
        '-H',
        `Authorization: Bearer ${filesKey.key}`,
        '-H',
        'Range: bytes=12345-12444',
        `${localApiUrl}/v1/ws/${slug}/files/live/big.bin`,
      ])
      expect(firstRange.statusLine).toInclude('206')
      expect(firstRange.contentRange).toBe(`bytes 12345-12444/${uploadBytes.byteLength}`)
      expect(await readFile(firstRange.outputPath)).toEqual(
        Buffer.from(uploadBytes.slice(12345, 12445)),
      )

      const secondRange = await curlRequest([
        '-H',
        `Authorization: Bearer ${filesKey.key}`,
        '-H',
        'Range: bytes=2097152-2097251',
        `${localApiUrl}/v1/ws/${slug}/files/live/big.bin`,
      ])
      expect(secondRange.statusLine).toInclude('206')
      expect(secondRange.contentRange).toBe(`bytes 2097152-2097251/${uploadBytes.byteLength}`)
      expect(await readFile(secondRange.outputPath)).toEqual(
        Buffer.from(uploadBytes.slice(2097152, 2097252)),
      )
      console.log(
        `SLICE05_REAL_VM_CURL put="${putEvidence.statusLine}" range1="${firstRange.statusLine}; Content-Range: ${firstRange.contentRange}" range2="${secondRange.statusLine}; Content-Range: ${secondRange.contentRange}"`,
      )

      await pool.client.exec(
        active.sshDest!,
        'mkdir -p /home/exedev/drive && printf restored-marker > /home/exedev/drive/marker.txt',
      )
      await pool.client.exec(active.sshDest!, 'sudo systemctl stop duet-gateway.service')
      await Bun.sleep(7_000)
      await convex.mutation('domains/workspaces/provisioning:markUnhealthyWorkspaces', {
        internalKey: INTERNAL_KEY,
        now: Date.now(),
        staleAfterMs: 2_000,
      })
      const unhealthy = await waitForWorkspace(
        created.workspaceId,
        workspace => workspace.status === 'unhealthy',
      )
      expect(unhealthy.status).toBe('unhealthy')
      timeline.unhealthy = secondsSince(startedAt)

      await pool.client.restart(active.vmName!)
      active = await waitForWorkspace(
        created.workspaceId,
        workspace => workspace.status === 'active',
      )
      timeline.restartRecovered = secondsSince(startedAt)
      const markerAfterRestart = await pool.client.exec(
        active.sshDest!,
        'cat /home/exedev/drive/marker.txt',
      )
      expect(markerAfterRestart.stdout.trim()).toBe('restored-marker')
      const afterRestartRange = await curlRequest([
        '-H',
        `Authorization: Bearer ${filesKey.key}`,
        '-H',
        'Range: bytes=12345-12444',
        `${localApiUrl}/v1/ws/${slug}/files/live/big.bin`,
      ])
      expect(afterRestartRange.statusLine).toInclude('206')
      expect(afterRestartRange.contentRange).toBe(`bytes 12345-12444/${uploadBytes.byteLength}`)
      expect(await readFile(afterRestartRange.outputPath)).toEqual(
        Buffer.from(uploadBytes.slice(12345, 12445)),
      )
      console.log(
        `SLICE05_REAL_VM_AFTER_RESTART range="${afterRestartRange.statusLine}; Content-Range: ${afterRestartRange.contentRange}"`,
      )

      const decommissionNow = Date.now()
      await convex.mutation('testing/workspaces:setWorkspaceServicingForTest', {
        internalKey: INTERNAL_KEY,
        workspaceId: created.workspaceId,
        servicingStatus: 'paused',
        now: decommissionNow - 7 * 24 * 60 * 60 * 1_000,
      })
      const decommissioned = (await convex.action(
        'domains/workspaces/provisioningActions:decommissionUnservicedWorkspaces',
        {
          internalKey: INTERNAL_KEY,
          now: decommissionNow,
        },
      )) as { archived: string[] }
      expect(decommissioned.archived).toContain(created.workspaceId)
      timeline.decommissioned = secondsSince(startedAt)

      console.log(`SLICE04_REAL_VM_TIMELINE ${JSON.stringify(timeline)}`)
    } finally {
      for (const vmName of createdVmNames) {
        await pool.returnVm(vmName).catch(() => undefined)
      }
    }
    const leaks = (await pool.client.list()).filter(
      vm => vm.vm_name.startsWith('duet-test-') || vm.tags?.includes(DUET_TEST_VM_TAG),
    )
    expect(leaks).toHaveLength(0)
  }, 900_000)

  test('anchor watcher follows an obvious rename and breaks on delete-recreate elsewhere', async () => {
    tunnel?.kill('SIGTERM')
    apiServer?.stop(true)
    await convex?.stop()
    tunnel = undefined
    apiServer = undefined
    convex = undefined
    const imageRef = process.env.DUET_REAL_VM_IMAGE_REF!
    const pool = exeVmPool({ token: process.env.EXE_TOKEN })
    const createdVmNames = new Set<string>()

    const port = 42_000 + Math.floor(Math.random() * 1_000)
    const localApiUrl = `http://127.0.0.1:${port}`
    let app: ReturnType<typeof createApiApp> | undefined
    apiServer = Bun.serve({
      hostname: '127.0.0.1',
      port,
      fetch: request => app?.fetch(request) ?? new Response('starting', { status: 503 }),
    })
    const publicApiUrl = await startTunnel(port)

    convex = await convexDev(BACKEND_DIR, {
      env: {
        ...generateAuthKeys({ kid: 'test-key', alg: 'RS256' }),
        DUET_API_INTERNAL_KEY: INTERNAL_KEY,
        DUET_TEST_AUTH_CODE: TEST_AUTH_CODE,
        DUET_TEST_AUTH_EMAIL: '1',
        DUET_TEST_AUTH_GOOGLE: '1',
        DUET_VM_TOKEN_DERIVE_SECRET: DERIVE_SECRET,
        DUET_VM_SYNC_INTERVAL_SECONDS: '5',
        DUET_GATEWAY_EXTRA_HEADERS_JSON: JSON.stringify({ 'bypass-tunnel-reminder': 'duet' }),
        DUET_EXE_CREATE_TRANSPORT: 'ssh',
        DUET_EXE_VM_TAGS: DUET_TEST_VM_TAG,
        DUET_API_URL: publicApiUrl,
        DUET_VM_IMAGE_REF: imageRef,
        EXE_TOKEN: process.env.EXE_TOKEN!,
        DUET_APP_URL: 'http://localhost:3000',
      },
      reset: true,
    })

    app = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
    })
    await waitForPublicApi(publicApiUrl)

    try {
      const owner = await signInWithMagicLink<UserRow>(
        convex!,
        uniqueEmail('anchor-real-owner'),
        'Anchor Real Owner',
      )
      await preparePaidSeedWorkspace(owner.client, createdVmNames)
      const createKey = await issueKey(owner.client)
      const slug = uniqueSlug('real-anchor')

      const createResponse = await fetch(`${localApiUrl}/v1/workspaces`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${createKey.key}`,
          'content-type': 'application/json',
          'bypass-tunnel-reminder': 'duet',
        },
        body: JSON.stringify({ slug, name: 'Real Anchor Watcher' }),
      })
      expect(createResponse.status).toBe(202)
      const created = WorkspaceCreateResultSchema.parse(await createResponse.json())
      expect(created).toMatchObject({ slug, status: 'provisioning' })

      const active = await waitForWorkspace(
        created.workspaceId,
        workspace => workspace.status === 'active',
      )
      createdVmNames.add(active.vmName!)
      await pool.client.waitUntilReady(active.sshDest!, { timeoutMs: 180_000 })
      const anchorKey = await issueKey(owner.client)

      await pool.client.exec(
        active.sshDest!,
        'mkdir -p /home/exedev/drive/apps/site /home/exedev/drive/apps/break-me',
      )
      const followed = (await mutate(owner.client, 'testing/anchors:createAnchorForTest', {
        workspaceId: created.workspaceId,
        path: 'apps/site',
        kind: 'app',
        settings: {},
      })) as { id: string }
      const broken = (await mutate(owner.client, 'testing/anchors:createAnchorForTest', {
        workspaceId: created.workspaceId,
        path: 'apps/break-me',
        kind: 'publish',
        settings: {},
      })) as { id: string }

      await Bun.sleep(4_000)
      await pool.client.exec(
        active.sshDest!,
        'mv /home/exedev/drive/apps/site /home/exedev/drive/apps/site-renamed',
      )
      const followedAnchor = await waitForApiAnchor(
        localApiUrl,
        slug,
        anchorKey.key,
        followed.id,
        anchor => anchor.path === 'apps/site-renamed' && anchor.state === 'active',
      )
      expect(followedAnchor.settings).toEqual({})

      await Bun.sleep(4_000)
      await pool.client.exec(
        active.sshDest!,
        'rm -rf /home/exedev/drive/apps/break-me && mkdir -p /home/exedev/drive/elsewhere/break-me',
      )
      const brokenAnchor = await waitForApiAnchor(
        localApiUrl,
        slug,
        anchorKey.key,
        broken.id,
        anchor => anchor.path === 'apps/break-me' && anchor.state === 'broken',
      )
      expect(brokenAnchor.settings).toEqual({})
      console.log(
        `SLICE12_REAL_VM_ANCHORS followed=${JSON.stringify({ id: followedAnchor.id, path: followedAnchor.path, state: followedAnchor.state })} broken=${JSON.stringify({ id: brokenAnchor.id, path: brokenAnchor.path, state: brokenAnchor.state })}`,
      )
    } finally {
      for (const vmName of createdVmNames) {
        await pool.returnVm(vmName).catch(() => undefined)
      }
    }
    const leaks = (await pool.client.list()).filter(
      vm => vm.vm_name.startsWith('duet-test-') || vm.tags?.includes(DUET_TEST_VM_TAG),
    )
    expect(leaks).toHaveLength(0)
  }, 600_000)

  test('real-VM memory add and search satisfy the agent CLI contract', async () => {
    const imageRef = process.env.DUET_REAL_VM_IMAGE_REF!
    const pool = exeVmPool({ token: process.env.EXE_TOKEN })
    const createdVmNames = new Set<string>()

    const port = 42_000 + Math.floor(Math.random() * 1_000)
    const localApiUrl = `http://127.0.0.1:${port}`
    let app: ReturnType<typeof createApiApp> | undefined
    apiServer = Bun.serve({
      hostname: '127.0.0.1',
      port,
      fetch: request => app?.fetch(request) ?? new Response('starting', { status: 503 }),
    })
    const publicApiUrl = await startTunnel(port)

    convex = await convexDev(BACKEND_DIR, {
      env: {
        ...generateAuthKeys({ kid: 'test-key', alg: 'RS256' }),
        DUET_API_INTERNAL_KEY: INTERNAL_KEY,
        DUET_TEST_AUTH_CODE: TEST_AUTH_CODE,
        DUET_TEST_AUTH_EMAIL: '1',
        DUET_TEST_AUTH_GOOGLE: '1',
        DUET_VM_TOKEN_DERIVE_SECRET: DERIVE_SECRET,
        DUET_VM_SYNC_INTERVAL_SECONDS: '5',
        DUET_GATEWAY_EXTRA_HEADERS_JSON: JSON.stringify({ 'bypass-tunnel-reminder': 'duet' }),
        DUET_EXE_CREATE_TRANSPORT: 'ssh',
        DUET_EXE_VM_TAGS: DUET_TEST_VM_TAG,
        DUET_API_URL: publicApiUrl,
        DUET_VM_IMAGE_REF: imageRef,
        EXE_TOKEN: process.env.EXE_TOKEN!,
        DUET_APP_URL: 'http://localhost:3000',
      },
      reset: true,
    })

    app = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
    })
    await waitForPublicApi(publicApiUrl)

    try {
      const owner = await signInWithMagicLink<UserRow>(
        convex!,
        uniqueEmail('real-memory-owner'),
        'Real VM Memory Owner',
      )
      await preparePaidSeedWorkspace(owner.client, createdVmNames)
      const createKey = await issueKey(owner.client)
      const slug = uniqueSlug('real-memory')

      const createResponse = await fetch(`${localApiUrl}/v1/workspaces`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${createKey.key}`,
          'content-type': 'application/json',
          'bypass-tunnel-reminder': 'duet',
        },
        body: JSON.stringify({ slug, name: 'Real VM Memory' }),
      })
      expect(createResponse.status).toBe(202)
      const created = WorkspaceCreateResultSchema.parse(await createResponse.json())
      expect(created).toMatchObject({ slug, status: 'provisioning' })

      const active = await waitForWorkspace(
        created.workspaceId,
        workspace => workspace.status === 'active' && workspace.sshDest !== undefined,
      )
      createdVmNames.add(active.vmName!)
      await pool.client.waitUntilReady(active.sshDest!, { timeoutMs: 180_000 })
      const memoryKey = await issueKey(owner.client)

      const addResponse = await fetch(`${localApiUrl}/v1/ws/${slug}/memories`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${memoryKey.key}`,
          'content-type': 'application/json',
          'bypass-tunnel-reminder': 'duet',
        },
        body: JSON.stringify({
          content: 'Enterprise discounts cap at 20 percent',
          source: 'api',
        }),
      })
      expect(addResponse.status).toBe(200)
      const added = (await addResponse.json()) as {
        id: string
        content: string
        kind: string
        source: string
      }
      expect(added).toMatchObject({
        content: 'Enterprise discounts cap at 20 percent',
        kind: 'note',
        source: 'api',
      })

      const searchResponse = await fetch(
        `${localApiUrl}/v1/ws/${slug}/memories/search?q=discounts&limit=5`,
        {
          headers: { authorization: `Bearer ${memoryKey.key}`, 'bypass-tunnel-reminder': 'duet' },
        },
      )
      expect(searchResponse.status).toBe(200)
      const search = (await searchResponse.json()) as {
        query: string
        results: Array<{ id: string; relevanceScore?: number }>
      }
      expect(search.query).toBe('discounts')
      expect(search.results[0]).toMatchObject({ id: added.id })
      expect(search.results[0]!.relevanceScore).toBeNumber()
    } finally {
      for (const vmName of createdVmNames) {
        await pool.returnVm(vmName).catch(() => undefined)
      }
    }
  }, 900_000)

  test('real-VM published file serves live edits through edge/gateway without snapshots', async () => {
    tunnel?.kill('SIGTERM')
    apiServer?.stop(true)
    await convex?.stop()
    tunnel = undefined
    apiServer = undefined
    convex = undefined
    const imageRef = process.env.DUET_REAL_VM_IMAGE_REF!
    const pool = exeVmPool({ token: process.env.EXE_TOKEN })
    const createdVmNames = new Set<string>()

    const port = 44_000 + Math.floor(Math.random() * 1_000)
    const localApiUrl = `http://127.0.0.1:${port}`
    let app: ReturnType<typeof createApiApp> | undefined
    apiServer = Bun.serve({
      hostname: '127.0.0.1',
      port,
      fetch: request => app?.fetch(request) ?? new Response('starting', { status: 503 }),
    })
    const publicApiUrl = await startTunnel(port)

    convex = await convexDev(BACKEND_DIR, {
      env: {
        ...generateAuthKeys({ kid: 'test-key', alg: 'RS256' }),
        DUET_API_INTERNAL_KEY: INTERNAL_KEY,
        DUET_EDGE_INTERNAL_KEY: 'edge-secret',
        DUET_TEST_AUTH_CODE: TEST_AUTH_CODE,
        DUET_TEST_AUTH_EMAIL: '1',
        DUET_TEST_AUTH_GOOGLE: '1',
        DUET_VM_TOKEN_DERIVE_SECRET: DERIVE_SECRET,
        DUET_VM_SYNC_INTERVAL_SECONDS: '5',
        DUET_GATEWAY_EXTRA_HEADERS_JSON: JSON.stringify({ 'bypass-tunnel-reminder': 'duet' }),
        DUET_EXE_CREATE_TRANSPORT: 'ssh',
        DUET_EXE_VM_TAGS: DUET_TEST_VM_TAG,
        DUET_API_URL: publicApiUrl,
        DUET_VM_IMAGE_REF: imageRef,
        EXE_TOKEN: process.env.EXE_TOKEN!,
        DUET_APP_URL: 'http://localhost:3000',
      },
      reset: true,
    })

    app = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
    })
    await waitForPublicApi(publicApiUrl)

    try {
      const owner = await signInWithMagicLink<UserRow>(
        convex!,
        uniqueEmail('real-publish-owner'),
        'Real VM Publish Owner',
      )
      await preparePaidSeedWorkspace(owner.client, createdVmNames)
      const createKey = await issueKey(owner.client)
      const slug = uniqueSlug('real-publish')

      const createResponse = await fetch(`${localApiUrl}/v1/workspaces`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${createKey.key}`,
          'content-type': 'application/json',
          'bypass-tunnel-reminder': 'duet',
        },
        body: JSON.stringify({ slug, name: 'Real VM Publish' }),
      })
      expect(createResponse.status).toBe(202)
      const created = WorkspaceCreateResultSchema.parse(await createResponse.json())
      expect(created).toMatchObject({ slug, status: 'provisioning' })

      const active = await waitForWorkspace(
        created.workspaceId,
        workspace => workspace.status === 'active',
      )
      createdVmNames.add(active.vmName!)
      await pool.client.waitUntilReady(active.sshDest!, { timeoutMs: 180_000 })
      const publishKey = await issueKey(owner.client)

      const writeFirst = await fetch(`${localApiUrl}/v1/ws/${slug}/files/docs/live.txt`, {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${publishKey.key}`,
          'content-type': 'text/plain',
          'bypass-tunnel-reminder': 'duet',
        },
        body: 'slice14-first',
      })
      expect(writeFirst.status).toBe(200)

      const publishResponse = await fetch(`${localApiUrl}/v1/ws/${slug}/publishes`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${publishKey.key}`,
          'content-type': 'application/json',
          'bypass-tunnel-reminder': 'duet',
        },
        body: JSON.stringify({ path: 'docs/live.txt', slug: 'live-file' }),
      })
      expect(publishResponse.status).toBe(201)

      const edge = createEdgeApp({
        convexSiteUrl: convex.siteUrl,
        edgeSecret: 'edge-secret',
        resolveAttempts: 8,
        resolveRetryDelayMs: 500,
      })
      // Publish is a viewer: the bare URL never returns published bytes; live
      // source is only reachable through the reserved `?raw` selector.
      const publishUrl = `https://edge.duet.so/${slug}/live-file`
      const rawUrl = `${publishUrl}?raw`
      const first = await waitForEdgeText(edge.fetch, rawUrl, 'edge.duet.so', 'slice14-first')

      const writeSecond = await fetch(`${localApiUrl}/v1/ws/${slug}/files/docs/live.txt`, {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${publishKey.key}`,
          'content-type': 'text/plain',
          'bypass-tunnel-reminder': 'duet',
        },
        body: 'slice14-second',
      })
      expect(writeSecond.status).toBe(200)
      const second = await waitForEdgeText(edge.fetch, rawUrl, 'edge.duet.so', 'slice14-second')

      // The bare publish URL serves the viewer, never the raw bytes (this
      // harness configures no viewer origin, so the edge answers 502 rather
      // than proxying — either way the published text must not appear).
      const bare = await edge.fetch(new Request(publishUrl, { headers: { host: 'edge.duet.so' } }))
      expect(await bare.text()).not.toContain('slice14-second')

      const audit = (await query(owner.client, 'domains/workspaces/queries:getAuditEvents', {
        workspaceId: created.workspaceId,
      })) as Array<{ event: string }>
      expect(audit.some(event => event.event === 'publish.created')).toBe(true)
      console.log(
        `SLICE14_REAL_VM_PUBLISH first="${first}" liveEdit="${second}" url="${publishUrl}"`,
      )
    } finally {
      for (const vmName of createdVmNames) {
        await pool.returnVm(vmName).catch(() => undefined)
      }
    }
    const leaks = (await pool.client.list()).filter(
      vm => vm.vm_name.startsWith('duet-test-') || vm.tags?.includes(DUET_TEST_VM_TAG),
    )
    expect(leaks).toHaveLength(0)
  }, 900_000)

  test('real-VM registered app responds through edge/gateway and live file edits need no redeploy', async () => {
    tunnel?.kill('SIGTERM')
    apiServer?.stop(true)
    await convex?.stop()
    tunnel = undefined
    apiServer = undefined
    convex = undefined
    const imageRef = process.env.DUET_REAL_VM_IMAGE_REF!
    const pool = exeVmPool({ token: process.env.EXE_TOKEN })
    const createdVmNames = new Set<string>()

    const port = 43_000 + Math.floor(Math.random() * 1_000)
    const localApiUrl = `http://127.0.0.1:${port}`
    let app: ReturnType<typeof createApiApp> | undefined
    apiServer = Bun.serve({
      hostname: '127.0.0.1',
      port,
      fetch: request => app?.fetch(request) ?? new Response('starting', { status: 503 }),
    })
    const publicApiUrl = await startTunnel(port)

    convex = await convexDev(BACKEND_DIR, {
      env: {
        ...generateAuthKeys({ kid: 'test-key', alg: 'RS256' }),
        DUET_API_INTERNAL_KEY: INTERNAL_KEY,
        DUET_EDGE_INTERNAL_KEY: 'edge-secret',
        DUET_TEST_AUTH_CODE: TEST_AUTH_CODE,
        DUET_TEST_AUTH_EMAIL: '1',
        DUET_TEST_AUTH_GOOGLE: '1',
        DUET_VM_TOKEN_DERIVE_SECRET: DERIVE_SECRET,
        DUET_VM_SYNC_INTERVAL_SECONDS: '5',
        DUET_GATEWAY_EXTRA_HEADERS_JSON: JSON.stringify({ 'bypass-tunnel-reminder': 'duet' }),
        DUET_EXE_CREATE_TRANSPORT: 'ssh',
        DUET_EXE_VM_TAGS: DUET_TEST_VM_TAG,
        DUET_API_URL: publicApiUrl,
        DUET_VM_IMAGE_REF: imageRef,
        EXE_TOKEN: process.env.EXE_TOKEN!,
        DUET_APP_URL: 'http://localhost:3000',
      },
      reset: true,
    })

    app = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
    })
    await waitForPublicApi(publicApiUrl)

    try {
      const owner = await signInWithMagicLink<UserRow>(
        convex!,
        uniqueEmail('real-app-owner'),
        'Real VM App Owner',
      )
      await preparePaidSeedWorkspace(owner.client, createdVmNames)
      const createKey = await issueKey(owner.client)
      const slug = uniqueSlug('real-app')

      const createResponse = await fetch(`${localApiUrl}/v1/workspaces`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${createKey.key}`,
          'content-type': 'application/json',
          'bypass-tunnel-reminder': 'duet',
        },
        body: JSON.stringify({ slug, name: 'Real VM App' }),
      })
      expect(createResponse.status).toBe(202)
      const created = WorkspaceCreateResultSchema.parse(await createResponse.json())
      expect(created).toMatchObject({ slug, status: 'provisioning' })

      const active = await waitForWorkspace(
        created.workspaceId,
        workspace => workspace.status === 'active',
      )
      createdVmNames.add(active.vmName!)
      await pool.client.waitUntilReady(active.sshDest!, { timeoutMs: 180_000 })
      const appKey = await issueKey(owner.client)

      const writeFirst = await fetch(`${localApiUrl}/v1/ws/${slug}/files/apps/site/message.txt`, {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${appKey.key}`,
          'content-type': 'text/plain',
          'bypass-tunnel-reminder': 'duet',
        },
        body: 'slice13-first',
      })
      expect(writeFirst.status).toBe(200)

      const registerResponse = await fetch(`${localApiUrl}/v1/ws/${slug}/apps`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${appKey.key}`,
          'content-type': 'application/json',
          'bypass-tunnel-reminder': 'duet',
        },
        body: JSON.stringify({
          path: 'apps/site',
          command: appServerCommand(4173),
          apiScopes: [],
          port: 4173,
          slug: 'site',
        }),
      })
      expect(registerResponse.status).toBe(201)

      const visibilityResponse = await fetch(`${localApiUrl}/v1/ws/${slug}/apps/site/visibility`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${appKey.key}`,
          'content-type': 'application/json',
          'bypass-tunnel-reminder': 'duet',
        },
        body: JSON.stringify({ visibility: 'public' }),
      })
      expect(visibilityResponse.status).toBe(200)

      const edge = createEdgeApp({
        convexSiteUrl: convex.siteUrl,
        edgeSecret: 'edge-secret',
        resolveAttempts: 8,
        resolveRetryDelayMs: 500,
      })
      const appUrl = `https://site--${slug}.edge.duet.so/message.txt`
      const first = await waitForEdgeText(
        edge.fetch,
        appUrl,
        `site--${slug}.edge.duet.so`,
        'slice13-first',
      )

      const writeSecond = await fetch(`${localApiUrl}/v1/ws/${slug}/files/apps/site/message.txt`, {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${appKey.key}`,
          'content-type': 'text/plain',
          'bypass-tunnel-reminder': 'duet',
        },
        body: 'slice13-second',
      })
      expect(writeSecond.status).toBe(200)
      const second = await waitForEdgeText(
        edge.fetch,
        appUrl,
        `site--${slug}.edge.duet.so`,
        'slice13-second',
      )

      const audit = (await query(owner.client, 'domains/workspaces/queries:getAuditEvents', {
        workspaceId: created.workspaceId,
      })) as Array<{ event: string }>
      expect(audit.some(event => event.event === 'app.deployed')).toBe(true)
      expect(audit.some(event => event.event === 'app.visibility_changed')).toBe(true)
      console.log(`SLICE13_REAL_VM_APP first="${first}" liveEdit="${second}" url="${appUrl}"`)
    } finally {
      for (const vmName of createdVmNames) {
        await pool.returnVm(vmName).catch(() => undefined)
      }
    }
    const leaks = (await pool.client.list()).filter(
      vm => vm.vm_name.startsWith('duet-test-') || vm.tags?.includes(DUET_TEST_VM_TAG),
    )
    expect(leaks).toHaveLength(0)
  }, 900_000)
})

async function startTunnel(port: number): Promise<string> {
  try {
    return await startTunnelProcess(
      'bunx',
      ['localtunnel', '--port', String(port)],
      /https:\/\/[-a-z0-9]+\.loca\.lt/i,
    )
  } catch (_error) {
    tunnel?.kill('SIGTERM')
    return await startTunnelProcess(
      'cloudflared',
      ['tunnel', '--url', `http://127.0.0.1:${port}`, '--no-autoupdate'],
      /https:\/\/[-a-z0-9]+\.trycloudflare\.com/i,
    )
  }
}

async function startTunnelProcess(
  command: string,
  args: string[],
  urlPattern: RegExp,
): Promise<string> {
  tunnel = spawn(command, args)
  const started = new Promise<string>((resolve, reject) => {
    let output = ''
    const timer = setTimeout(
      () => reject(new Error(`cloudflared did not report a URL:\n${output}`)),
      60_000,
    )
    const onData = (chunk: Buffer) => {
      output += chunk.toString()
      const match = output.match(urlPattern)
      if (match) {
        clearTimeout(timer)
        resolve(match[0]!)
      }
    }
    tunnel!.stdout.on('data', onData)
    tunnel!.stderr.on('data', onData)
    tunnel!.on('exit', code => reject(new Error(`${command} exited ${code}:\n${output}`)))
  })
  return await started
}

async function waitForPublicApi(apiUrl: string): Promise<void> {
  const deadline = Date.now() + 30_000
  for (;;) {
    try {
      const response = await fetch(`${apiUrl}/v1/whoami`, {
        headers: { 'bypass-tunnel-reminder': 'duet' },
      })
      if (response.status === 401) return
    } catch {
      // Tunnel DNS/proxy startup is eventually consistent.
    }
    if (Date.now() >= deadline)
      throw new Error(`Public API tunnel did not become reachable: ${apiUrl}`)
    await Bun.sleep(1_000)
  }
}

async function preparePaidSeedWorkspace(
  client: ConvexHttpClient,
  createdVmNames: Set<string>,
): Promise<void> {
  const seedWorkspace = (await listMine(client))[0]!.workspace
  await mutate(client, 'testing/workspaces:activateCurrentUserSyntheticSubscriptionForTest', {
    internalKey: INTERNAL_KEY,
  })
  const attached = await waitForWorkspace(
    seedWorkspace._id,
    workspace => workspace.vmName !== undefined,
  )
  createdVmNames.add(attached.vmName!)
}

async function waitForWorkspace(
  workspaceId: string,
  predicate: (workspace: RawWorkspace) => boolean,
): Promise<RawWorkspace> {
  const deadline = Date.now() + 240_000
  let last: RawWorkspace | undefined
  for (;;) {
    last = (await rawWorkspaces()).find(workspace => workspace._id === workspaceId)
    if (last && predicate(last)) return last
    if (Date.now() >= deadline)
      throw new Error(
        `Timed out waiting for workspace ${workspaceId}; last=${JSON.stringify(last)}`,
      )
    await Bun.sleep(1_000)
  }
}

async function waitForApiAnchor(
  apiUrl: string,
  workspaceSlug: string,
  key: string,
  anchorId: string,
  predicate: (anchor: AnchorRow) => boolean,
): Promise<AnchorRow> {
  const deadline = Date.now() + 90_000
  let last: AnchorRow | undefined
  for (;;) {
    const response = await fetch(`${apiUrl}/v1/ws/${workspaceSlug}/anchors`, {
      headers: { authorization: `Bearer ${key}`, 'bypass-tunnel-reminder': 'duet' },
    })
    expect(response.status).toBe(200)
    const body = (await response.json()) as { items: AnchorRow[]; nextCursor: string | null }
    last = body.items.find(anchor => anchor.id === anchorId)
    if (last !== undefined && predicate(last)) return last
    if (Date.now() >= deadline)
      throw new Error(`Timed out waiting for anchor ${anchorId}; last=${JSON.stringify(last)}`)
    await Bun.sleep(1_000)
  }
}

async function curlRequest(
  args: string[],
): Promise<{ statusLine: string; contentRange: string | null; outputPath: string }> {
  const outputPath = join(
    tempDir!,
    `curl-body-${Date.now()}-${Math.random().toString(36).slice(2)}.bin`,
  )
  const proc = Bun.spawn(['curl', '-sS', '-D', '-', '-o', outputPath, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (exitCode !== 0) throw new Error(`curl failed with exit ${exitCode}: ${stderr}`)
  const statusLine =
    stdout
      .split(/\r?\n/)
      .filter(line => line.startsWith('HTTP/'))
      .at(-1) ?? ''
  const contentRangeLine = stdout
    .split(/\r?\n/)
    .find(line => line.toLowerCase().startsWith('content-range:'))
  return {
    statusLine,
    contentRange: contentRangeLine?.slice('content-range:'.length).trim() ?? null,
    outputPath,
  }
}

function deterministicBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length)
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = index % 251
  }
  return bytes
}

function appServerCommand(port: number): string {
  return [
    'bun',
    '-e',
    JSON.stringify(
      "Bun.serve({hostname:'127.0.0.1',port:" +
        port +
        ",fetch:async req=>{const path=new URL(req.url).pathname.slice(1)||'message.txt'; return new Response(await Bun.file(path).text(),{headers:{'content-type':'text/plain'}})}}); await new Promise(()=>{})",
    ),
  ].join(' ')
}

async function waitForEdgeText(
  edgeFetch: (request: Request) => Promise<Response>,
  url: string,
  host: string,
  expected: string,
): Promise<string> {
  const deadline = Date.now() + 90_000
  let last = ''
  for (;;) {
    const response = await edgeFetch(new Request(url, { headers: { host } }))
    last = await response.text()
    if (response.status === 200 && last === expected) return last
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for edge app text ${expected}; status=${response.status}; last=${JSON.stringify(last)}`,
      )
    }
    await Bun.sleep(1_000)
  }
}

async function rawWorkspaces(): Promise<RawWorkspace[]> {
  return (await convex!.query('testing/workspaces:rawWorkspacesForTest', {
    internalKey: INTERNAL_KEY,
  })) as RawWorkspace[]
}

async function listMine(client: ConvexHttpClient): Promise<WorkspaceRow[]> {
  return (await query(client, 'domains/workspaces/queries:listMine', {})) as WorkspaceRow[]
}

function uniqueSlug(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function secondsSince(startedAt: number): number {
  return Number(((Date.now() - startedAt) / 1000).toFixed(1))
}

interface UserRow {
  _id: string
  email: string
  name?: string
}

interface WorkspaceRow {
  workspace: RawWorkspace
  role: string
}

interface RawWorkspace {
  _id: string
  slug: string
  status: string
  vmName?: string
  sshDest?: string
  httpsUrl?: string
  lastHeartbeatAt?: number
}

interface AnchorRow {
  id: string
  path: string
  state: 'active' | 'broken'
  settings: unknown
}
