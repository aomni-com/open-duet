import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { AdminLoginAsResponseSchema } from '@repo/contract'
import { ConvexHttpClient } from 'convex/browser'

import { fnMutation, fnQuery, readLiveEnv, type LiveEnv, type Workspace } from './staging-live-env.ts'
import { apiJson, bearer, bearerJson, stagingFetch } from './staging-live-http.ts'
import { StagingArtifactCollector } from './staging-live-artifacts.ts'
import {
  recordWorkspaceCleanup,
  StagingResourceLedger,
  type StagingCleanupReport,
} from './staging-live-resource-ledger.ts'

const DEFAULT_CRAWL_TIMEOUT_MS = 180_000
const DEFAULT_POLL_MS = 2_000
const SERVICE_VOICE_ID = 'CPEHCHnlRsWkpvhbDlfn'

export interface ServiceCatalogLedgerRow {
  amountMicroUsd: number
  reference: string
  metadata?: {
    context?: {
      service?: string
      routeId?: string
      vendorCostMicroUsd?: number
    }
  }
}

export interface ServiceCatalogJourneyEvidence {
  journey: 'service-catalog'
  runId: string
  workspaceSlug: string
  secondWorkspaceSlug: string
  discovery: { status: number; serviceIds: string[] }
  tts: { status: number; bytes: number; chargeUsd: string | null }
  music: { status: number; bytes: number; chargeUsd: string | null }
  crawl: { startStatus: number; pollCount: number; crawlId: string; terminalStatus: string }
  unlisted: { status: number; bodyBytes: number }
  voice: {
    resourceId: string
    createStatus: number
    crossWorkspaceEditStatus: number
    expiredState: string
  }
  ledger: {
    rows: Array<{ reference: string; vendorCostMicroUsd: number; amountMicroUsd: number }>
    parity: boolean
  }
  cleanup?: StagingCleanupReport
}

interface LoginIdentity {
  email: string
  userId: string
  token: string
  workspace: Workspace
}

interface ServiceCatalogRunOptions {
  env?: LiveEnv
  artifactRoot?: string
  crawlTimeoutMs?: number
  pollMs?: number
  fetchImpl?: typeof stagingFetch
  now?: () => number
  onProgress?: (stage: string) => void
}

/**
 * Run the closeout journey through the deployed service proxy. Every identity,
 * workspace, and created voice is recorded before the next network operation,
 * so a failed paid request still has a deterministic cleanup path.
 */
export async function runServiceCatalogStagingJourney(
  options: ServiceCatalogRunOptions = {},
): Promise<ServiceCatalogJourneyEvidence> {
  const env = options.env ?? readLiveEnv()
  const fetchImpl = options.fetchImpl ?? stagingFetch
  const now = options.now ?? Date.now
  const runId = `staging-e2e-service-catalog-${now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`
  const crawlTimeoutMs = options.crawlTimeoutMs ?? numberEnv('DUET_SERVICE_CATALOG_CRAWL_TIMEOUT_MS', DEFAULT_CRAWL_TIMEOUT_MS)
  const pollMs = options.pollMs ?? numberEnv('DUET_SERVICE_CATALOG_POLL_MS', DEFAULT_POLL_MS)
  const artifactRoot = options.artifactRoot ?? env.artifactRoot
  const progress = (stage: string) => options.onProgress?.(stage)
  const artifacts = new StagingArtifactCollector(path.join(artifactRoot, runId), [
    env.internalKey,
    env.loginSecret,
    env.vercelBypassSecret,
  ])
  await artifacts.initialize()
  const convex = new ConvexHttpClient(env.convexUrl)
  const ledger = new StagingResourceLedger(runId)
  const cleanupOutput = { vmNames: [] as string[] }
  let evidence: ServiceCatalogJourneyEvidence | undefined
  let journeyError: unknown

  try {
    progress('identity')
    const owner = await provisionIdentity({ env, fetchImpl, runId, label: 'owner', ledger, convex, artifacts, cleanupOutput })
    const second = await provisionIdentity({ env, fetchImpl, runId, label: 'second', ledger, convex, artifacts, cleanupOutput })

    progress('discovery')
    const discoveryResponse = await serviceFetch(env, fetchImpl, owner, '/v1/services', { method: 'GET' })
    assert.equal(discoveryResponse.status, 200, 'service discovery failed')
    const discoveryBody = (await discoveryResponse.json()) as { items?: Array<{ id?: string }> }
    const serviceIds = (discoveryBody.items ?? []).flatMap(item => (typeof item.id === 'string' ? [item.id] : []))
    assert(serviceIds.includes('elevenlabs'), 'discovery omitted ElevenLabs')
    assert(serviceIds.includes('firecrawl'), 'discovery omitted Firecrawl')

    progress('elevenlabs:tts')
    const ttsBody = JSON.stringify({ text: `Service catalog closeout ${runId}`, model_id: 'eleven_flash_v2_5' })
    const ttsResponse = await serviceFetch(env, fetchImpl, owner, `/v1/services/elevenlabs/v1/text-to-speech/${SERVICE_VOICE_ID}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: ttsBody,
    })
    const ttsBytes = (await ttsResponse.arrayBuffer()).byteLength
    assert.equal(ttsResponse.status, 200, `ElevenLabs TTS failed: ${ttsResponse.status}`)
    assert(ttsBytes > 0, 'ElevenLabs TTS returned no audio bytes')

    progress('elevenlabs:music')
    const musicResponse = await serviceFetch(env, fetchImpl, owner, '/v1/services/elevenlabs/v1/music', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'one short soft instrumental tone', music_length_ms: 10_000, force_instrumental: true }),
    })
    const musicBytes = (await musicResponse.arrayBuffer()).byteLength
    assert.equal(musicResponse.status, 200, `ElevenLabs music failed: ${musicResponse.status}`)
    assert(musicBytes > 0, 'ElevenLabs music returned no audio bytes')

    progress('firecrawl:crawl')
    const crawl = await runCrawl({ env, fetchImpl, owner, timeoutMs: crawlTimeoutMs, pollMs })

    progress('unlisted-route')
    const unlistedResponse = await serviceFetch(env, fetchImpl, owner, '/v1/services/elevenlabs/v1/history', { method: 'GET' })
    const unlistedBody = await unlistedResponse.arrayBuffer()
    assert.equal(unlistedResponse.status, 404, 'unlisted service route did not return 404')
    assert.equal(unlistedBody.byteLength, 0, 'unlisted route returned a body')

    progress('voice-pool')
    const voice = await runVoicePool({ env, fetchImpl, owner, second, convex, pollMs, artifacts, runId, ledger })

    const ledgerRows = await waitForLedger({ convex, env, workspaceId: owner.workspace._id, expected: 3, timeoutMs: crawlTimeoutMs, pollMs })
    progress('ledger')
    const parityRows = ledgerRows
      .filter(row => row.metadata?.context?.service !== undefined && row.metadata.context.vendorCostMicroUsd !== undefined)
      .map(row => ({
        reference: row.reference,
        vendorCostMicroUsd: row.metadata!.context!.vendorCostMicroUsd!,
        amountMicroUsd: row.amountMicroUsd,
      }))
    assert(parityRows.length >= 3, `expected at least three service ledger rows, found ${parityRows.length}`)
    assertLedgerParity(parityRows)

    evidence = {
      journey: 'service-catalog',
      runId,
      workspaceSlug: owner.workspace.slug,
      secondWorkspaceSlug: second.workspace.slug,
      discovery: { status: discoveryResponse.status, serviceIds },
      tts: { status: ttsResponse.status, bytes: ttsBytes, chargeUsd: ttsResponse.headers.get('x-duet-charge-usd') },
      music: { status: musicResponse.status, bytes: musicBytes, chargeUsd: musicResponse.headers.get('x-duet-charge-usd') },
      crawl,
      unlisted: { status: unlistedResponse.status, bodyBytes: unlistedBody.byteLength },
      voice,
      ledger: { rows: parityRows, parity: true },
    }
    await artifacts.writeJson('journey.json', evidence)
  } catch (error) {
    journeyError = error
  }
  const cleanup = await ledger.cleanupAll()
  await artifacts.writeJson('cleanup.json', cleanup)
  await artifacts.flushDiagnostics()
  if (evidence !== undefined) evidence.cleanup = cleanup
  if (cleanup.status !== 'pass') {
    throw new Error(`service-catalog staging cleanup failed: ${JSON.stringify(cleanup)}`)
  }
  if (journeyError !== undefined) throw journeyError
  if (evidence === undefined) throw new Error('service-catalog journey completed without evidence')
  return evidence
}

export function assertLedgerParity(
  rows: ReadonlyArray<{ reference: string; vendorCostMicroUsd: number; amountMicroUsd: number }>,
): void {
  assert(rows.length > 0, 'no service ledger rows were recorded')
  for (const row of rows) {
    assert(Number.isFinite(row.vendorCostMicroUsd), `ledger row ${row.reference} has no vendor cost`)
    assert.equal(
      row.amountMicroUsd,
      -Math.ceil(Math.ceil(row.vendorCostMicroUsd) * 1.2),
      `ledger row ${row.reference} did not apply the standard 20% margin`,
    )
  }
}

export function defaultServiceCatalogVoiceFixturePath(): string {
  return fileURLToPath(new URL('../../../apps/web/tests/visual/assets/session-inline-media/recap.wav', import.meta.url))
}

async function provisionIdentity(args: {
  env: LiveEnv
  fetchImpl: typeof stagingFetch
  runId: string
  label: string
  ledger: StagingResourceLedger
  convex: ConvexHttpClient
  artifacts: StagingArtifactCollector
  cleanupOutput: { vmNames: string[] }
}): Promise<LoginIdentity> {
  const email = `${args.runId}-${args.label}@agentmail.to`
  const loginResponse = await args.fetchImpl(`${args.env.apiUrl}/v1/admin/login-as`, {
    method: 'POST',
    headers: bearerJson(args.env.loginSecret),
    body: JSON.stringify({ email, name: `Service Catalog ${args.label}`, create: true, ephemeral: true }),
  })
  assert.equal(loginResponse.status, 200, `programmatic ${args.label} login failed`)
  const login = AdminLoginAsResponseSchema.parse(await loginResponse.json())
  args.artifacts.registerSecret(login.token)
  args.ledger.record({
    kind: 'user',
    id: login.userId,
    label: `${args.runId}:user:${args.label}:${email}`,
    cleanupPriority: -100,
    cleanup: async () => {
      // The workspace ledger normally removes this first. Keep the identity
      // cleanup self-sufficient as well: a failure between login-as and
      // recording the workspace must not strand the VM that login-as created.
      const owned = (await args.convex.query(fnQuery('testing/workspaces:workspacesByOwnerForTest'), {
        internalKey: args.env.internalKey,
        userId: login.userId,
      })) as Array<{ _id: string }>
      for (const workspace of owned) {
        await args.convex.mutation(fnMutation('testing/workspaces:deleteWorkspaceByIdForTest'), {
          internalKey: args.env.internalKey,
          workspaceId: workspace._id,
        })
      }
      await args.convex.mutation(fnMutation('testing/stagingE2e:retireUserByEmailForTest'), {
        internalKey: args.env.internalKey,
        email,
      })
    },
    verify: async () =>
      (await args.convex.query(fnQuery('testing/stagingE2e:userByEmailForTest'), {
        internalKey: args.env.internalKey,
        email,
      })) === null,
  })
  const whoami = await apiJson<{ workspaces: Array<{ id: string; slug: string; status: string }> }>(
    `${args.env.apiUrl}/v1/whoami`,
    { headers: bearer(login.token) },
    200,
    `${args.label} whoami`,
    args.artifacts,
  )
  const row = whoami.workspaces.find(candidate => candidate.slug === login.workspaceSlug)
  assert(row !== undefined, `${args.label} login workspace was missing from whoami`)
  const workspace: Workspace = { _id: row.id, slug: row.slug, status: row.status }
  recordWorkspaceCleanup({ ledger: args.ledger, convex: args.convex, env: args.env, output: args.cleanupOutput, workspaceId: workspace._id, slug: workspace.slug })
  await args.convex.mutation(fnMutation('testing/workspaces:activateSyntheticSubscriptionByEmailForTest'), {
    internalKey: args.env.internalKey,
    email,
    plan: 'pro',
  })
  await args.convex.mutation(fnMutation('domains/credits/internal:applyLedgerEntry'), {
    internalKey: args.env.internalKey,
    workspaceId: workspace._id,
    amountMicroUsd: 10_000_000,
    type: 'grant',
    reference: `grant:${args.runId}:${args.label}`,
  })
  return { email, userId: login.userId, token: login.token, workspace }
}

async function serviceFetch(
  env: LiveEnv,
  fetchImpl: typeof stagingFetch,
  identity: LoginIdentity,
  pathName: string,
  init: RequestInit,
): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set('authorization', `Bearer ${identity.token}`)
  headers.set('x-duet-workspace', identity.workspace.slug)
  return await fetchImpl(`${env.apiUrl}${pathName}`, { ...init, headers })
}

async function runCrawl(args: {
  env: LiveEnv
  fetchImpl: typeof stagingFetch
  owner: LoginIdentity
  timeoutMs: number
  pollMs: number
}): Promise<ServiceCatalogJourneyEvidence['crawl']> {
  const started = await serviceFetch(args.env, args.fetchImpl, args.owner, '/v1/services/firecrawl/v2/crawl', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: 'https://example.com', scrapeOptions: { formats: ['markdown'] } }),
  })
  const startStatus = started.status
  assert.equal(startStatus, 200, `Firecrawl crawl start failed: ${startStatus}`)
  const startBody = (await started.json()) as { id?: unknown; crawlId?: unknown }
  const crawlId = typeof startBody.id === 'string' ? startBody.id : typeof startBody.crawlId === 'string' ? startBody.crawlId : undefined
  assert(crawlId !== undefined, 'Firecrawl crawl start returned no job id')
  const deadline = Date.now() + args.timeoutMs
  let pollCount = 0
  for (;;) {
    pollCount += 1
    const response = await serviceFetch(args.env, args.fetchImpl, args.owner, `/v1/services/firecrawl/v2/crawl/${encodeURIComponent(crawlId)}`, { method: 'GET' })
    assert.equal(response.status, 200, `Firecrawl crawl poll failed: ${response.status}`)
    const body = (await response.json()) as { status?: unknown }
    const status = typeof body.status === 'string' ? body.status : ''
    if (status === 'completed') return { startStatus, pollCount, crawlId, terminalStatus: status }
    if (status === 'failed' || status === 'cancelled') throw new Error(`Firecrawl crawl ended ${status}`)
    if (Date.now() >= deadline) throw new Error(`Firecrawl crawl did not complete within ${args.timeoutMs}ms`)
    await Bun.sleep(args.pollMs)
  }
}

async function runVoicePool(args: {
  env: LiveEnv
  fetchImpl: typeof stagingFetch
  owner: LoginIdentity
  second: LoginIdentity
  convex: ConvexHttpClient
  pollMs: number
  artifacts: StagingArtifactCollector
  runId: string
  ledger: StagingResourceLedger
}): Promise<ServiceCatalogJourneyEvidence['voice']> {
  const form = new FormData()
  form.set('name', `duet-${args.runId}`)
  form.set('description', 'Disposable service-catalog closeout voice')
  const samplePath = process.env.DUET_SERVICE_CATALOG_VOICE_FIXTURE?.trim() || defaultServiceCatalogVoiceFixturePath()
  const sampleBytes = await Bun.file(samplePath).arrayBuffer()
  assert(sampleBytes.byteLength > 44, `voice fixture is missing or too short: ${samplePath}`)
  form.set('files', new Blob([sampleBytes], { type: 'audio/wav' }), 'sample.wav')
  const create = await serviceFetch(args.env, args.fetchImpl, args.owner, '/v1/services/elevenlabs/v1/voices/add', { method: 'POST', body: form })
  const createText = await create.text()
  if (create.status === 401 || create.status === 403) {
    throw new Error(`VOICE_CREATE_PREREQUISITE: staging ElevenLabs key cannot create voices (HTTP ${create.status}); grant voice-write scope before running closeout. Response: ${createText.slice(0, 300)}`)
  }
  assert.equal(create.status, 200, `ElevenLabs voice creation failed: ${create.status}`)
  const createBody = JSON.parse(createText) as { voice_id?: unknown }
  const resourceId = typeof createBody.voice_id === 'string' ? createBody.voice_id : undefined
  assert(resourceId !== undefined, 'voice creation returned no voice_id; cannot track cleanup')
  await args.artifacts.writeJson('voice-create.json', { status: create.status, voiceId: resourceId })

  args.ledger.record({
    kind: 'service-pool',
    id: `elevenlabs:voice:${resourceId}`,
    label: `${args.runId}:service-pool:elevenlabs:voice:${resourceId}`,
    cleanupPriority: 20,
    cleanup: async () => {
      const row = (await args.convex.query(fnQuery('testing/serviceVault:poolResourceForTest'), {
        internalKey: args.env.internalKey,
        serviceId: 'elevenlabs',
        pool: 'voice',
        resourceId,
      })) as { state?: string } | null
      if (row === null || row.state !== 'live') return
      const response = await serviceFetch(args.env, args.fetchImpl, args.owner, `/v1/services/elevenlabs/v1/voices/${encodeURIComponent(resourceId)}`, { method: 'DELETE' })
      if (response.status !== 200 && response.status !== 204 && response.status !== 404) {
        throw new Error(`voice cleanup returned HTTP ${response.status}`)
      }
    },
    verify: async () => {
      const row = (await args.convex.query(fnQuery('testing/serviceVault:poolResourceForTest'), {
        internalKey: args.env.internalKey,
        serviceId: 'elevenlabs',
        pool: 'voice',
        resourceId,
      })) as { state?: string } | null
      return row === null || row.state !== 'live'
    },
  })

  const forbidden = await serviceFetch(args.env, args.fetchImpl, args.second, `/v1/services/elevenlabs/v1/voices/${encodeURIComponent(resourceId)}/edit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: `forbidden-${args.runId}` }),
  })
  const forbiddenBody = await forbidden.text()
  assert.equal(forbidden.status, 403, `second workspace voice edit was not refused: ${forbidden.status} ${forbiddenBody.slice(0, 300)}`)

  await args.convex.mutation(fnMutation('testing/serviceVault:expirePoolResourceForTest'), {
    internalKey: args.env.internalKey,
    serviceId: 'elevenlabs',
    pool: 'voice',
    resourceId,
    delayMs: 1_000,
  })
  const deadline = Date.now() + 60_000
  let expiredState = 'pending'
  while (Date.now() < deadline) {
    const row = (await args.convex.query(fnQuery('testing/serviceVault:poolResourceForTest'), {
      internalKey: args.env.internalKey,
      serviceId: 'elevenlabs',
      pool: 'voice',
      resourceId,
    })) as { state?: string } | null
    expiredState = row?.state ?? 'missing'
    if (expiredState === 'expired') break
    await Bun.sleep(args.pollMs)
  }
  assert.equal(expiredState, 'expired', `voice pool resource did not expire (state=${expiredState})`)
  return { resourceId, createStatus: create.status, crossWorkspaceEditStatus: forbidden.status, expiredState }
}

async function waitForLedger(args: {
  convex: ConvexHttpClient
  env: LiveEnv
  workspaceId: string
  expected: number
  timeoutMs: number
  pollMs: number
}): Promise<ServiceCatalogLedgerRow[]> {
  const deadline = Date.now() + args.timeoutMs
  let rows: ServiceCatalogLedgerRow[] = []
  while (Date.now() < deadline) {
    rows = (await args.convex.query(fnQuery('testing/credits:listWorkspaceTransactionsForTest'), {
      internalKey: args.env.internalKey,
      workspaceId: args.workspaceId,
    })) as ServiceCatalogLedgerRow[]
    const serviceRows = rows.filter(row => row.metadata?.context?.service !== undefined)
    if (serviceRows.length >= args.expected) return rows
    await Bun.sleep(args.pollMs)
  }
  return rows
}

function numberEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim()
  if (!raw) return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`)
  return value
}
