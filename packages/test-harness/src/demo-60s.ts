import assert from 'node:assert/strict'
import { spawn, type ChildProcessWithoutNullStreams, execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { type ConvexHttpClient } from 'convex/browser'

import {
  GatewayRunnerInputRequestSchema,
  ModelTierIdSchema,
  MODEL_TIERS,
  TRAIN_CLI_CONTRACT,
  type MemoryRecord,
  type ModelTierId,
  type TrainRecord,
  type TrainRecordSummary,
  WorkspaceCreateResultSchema,
} from '@repo/contract'

import { createApiApp } from '../../../apps/api/src/index.ts'
import { createEdgeApp } from '../../../apps/edge/src/index.ts'
import {
  createModelGatewayApp,
  type ModelGatewayAppOptions,
} from '../../../apps/model-gateway/src/index.ts'
import { convexDev, type ConvexDevFixture } from './convex-dev.ts'
import { TEST_AUTH_CODE } from './convex-testing.ts'
import {
  generateAuthKeys,
  issueKey,
  mutate,
  query,
  signInWithMagicLink,
  uniqueEmail,
  type SignedInUser,
} from './convex-testing.ts'
import { assertDockerCliReady } from './docker-cli-env.ts'
import { DUET_TEST_VM_TAG, exeVmPool } from './exe-vm-pool.ts'
import { createFakeVag, serveFakeVag, type FakeVag } from './fake-vag.ts'
import {
  assertResponse,
  bearer,
  bearerJson,
  bearerTokenFromHeaders,
  readUntilTerminal,
  secondsSince,
  waitForWorkspace,
} from './staging-live-http.ts'

const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const BACKEND_DIR = join(ROOT_DIR, 'packages/backend')
const DUET_CLI_DIR = join(ROOT_DIR, 'packages/duet')
const INTERNAL_KEY = 'demo-60s-api-internal-key'
const EDGE_SECRET = 'demo-60s-edge-secret'
const DERIVE_SECRET = 'demo-60s-vm-token-derive-secret'
const DEMO_AI_GATEWAY_API_KEY = 'demo-60s-fake-vag-platform-key'
const MARKER = 'SLICEDEMO-9K4T'
export const SEEDED_MEMORY =
  'Northstar Robotics enterprise renewals cap discounts at 20 percent; launch artifacts use the calm cobalt brand voice.'
export const BUSINESS_QUESTION =
  'What discount should sales offer Northstar Robotics, and what tone should the artifact use?'

export interface Demo60sResult {
  marker: typeof MARKER
  mode: DemoAgentMode
  publicUrl: string
  answer: string
  timeline: Record<string, number>
  totalSeconds: number
  vmsCreated: string[]
  vmsDeleted: string[]
  leakCheck: { createdVmLeaks: string[]; duetTestVmCount: number }
  realSteps: string[]
  mockedAgentSeams: string[]
  modelGateway?: {
    mode: DemoModelGatewayPlan['kind']
    url?: string
    settledDebit?: ReconciledLedgerDebit
  }
}

interface WorkspaceRow {
  workspace: { _id: string; slug: string; name: string; status: string }
}

interface RawWorkspace {
  _id: string
  slug: string
  status: string
  vmName?: string
  sshDest?: string
  lastHeartbeatAt?: number
}

interface IssuedDeviceConfig {
  apiKey: string
  defaultWorkspace: string
  apiUrl: string
}

interface AgentSessionCreated {
  session: { sessionId: string; status: string }
}

type ApiApp = ReturnType<typeof createApiApp>
type TunnelProcess = { process: ChildProcessWithoutNullStreams; publicUrl: string }
type DemoAgentMode = 'mock-agent' | 'real-agent'
type StopHandle = { stop: () => void | Promise<void> }

export type DemoModelGatewayPlan =
  | { kind: 'disabled' }
  | { kind: 'external'; url: string }
  | { kind: 'local' }

export interface DemoModelGatewayFixture {
  fakeVag: FakeVag
  upstreamBaseUrl: string
  convexEnv: { AI_GATEWAY_API_KEY: string; AI_GATEWAY_BASE_URL: string }
  boot(args: {
    convexUrl: string
    internalKey: string
    expose?: (port: number) => Promise<{ publicUrl: string } & StopHandle>
    gatewayOptions?: Pick<ModelGatewayAppOptions, 'preflight'>
  }): Promise<DemoModelGatewayLeg>
  stop(): void
}

export interface DemoModelGatewayLeg {
  url: string
  localUrl: string
  fakeVag: FakeVag
  drainWaitUntil(): Promise<void>
  stop(): Promise<void>
}

export interface ReconciledLedgerDebit {
  generationId: string
  tier: ModelTierId
  upstreamGenerationId: string
  reservationId?: string
  transactionReference: string
  transactionType: 'usage' | 'reservation'
  amountMicroUsd: number
}

export function demo60sProbeCanRun(): boolean {
  return Boolean(
    process.env.EXE_TOKEN &&
    process.env.DUET_REAL_VM_IMAGE_REF &&
    process.env.RUN_DOCKER_TESTS === '1',
  )
}

export function selectDemoModelGatewayPlan(
  env: NodeJS.ProcessEnv = process.env,
): DemoModelGatewayPlan {
  if (env.DUET_DEMO_AGENT_MODE !== 'real') return { kind: 'disabled' }
  const overrideUrl = normalizeOptionalEnvUrl(env.DUET_MODEL_GATEWAY_URL)
  if (overrideUrl !== null) return { kind: 'external', url: overrideUrl }
  return { kind: 'local' }
}

export async function createDemoModelGatewayFixture(
  options: {
    aiGatewayApiKey?: string
    catalogModelId?: string
    readyAfterPolls?: number
  } = {},
): Promise<DemoModelGatewayFixture> {
  const aiGatewayApiKey = options.aiGatewayApiKey ?? DEMO_AI_GATEWAY_API_KEY
  const catalogModelId =
    options.catalogModelId ?? MODEL_TIERS.balanced.disclosedModels[0]!.gatewayModelId
  const fakeVag = createFakeVag({
    aiGatewayApiKey,
    catalogModelId,
    readyAfterPolls: options.readyAfterPolls ?? 0,
    completion: {
      text: 'Renewals rose 20 percent. Keep the brief calm cobalt, direct, and practical.',
      inputTokens: 10,
      outputTokens: 16,
      totalCost: 0.0004,
    },
  })
  const served = serveFakeVag(fakeVag, await reserveDemoPort())
  return {
    fakeVag,
    upstreamBaseUrl: served.url,
    convexEnv: {
      AI_GATEWAY_API_KEY: aiGatewayApiKey,
      AI_GATEWAY_BASE_URL: served.url,
    },
    boot: async args =>
      await bootDemoModelGatewayLeg({
        ...args,
        aiGatewayApiKey,
        upstreamBaseUrl: served.url,
        fakeVag,
      }),
    stop: served.stop,
  }
}

export async function bootDemoModelGatewayLeg(args: {
  convexUrl: string
  internalKey: string
  aiGatewayApiKey: string
  upstreamBaseUrl: string
  fakeVag: FakeVag
  expose?: (port: number) => Promise<{ publicUrl: string } & StopHandle>
  gatewayOptions?: Pick<ModelGatewayAppOptions, 'preflight'>
}): Promise<DemoModelGatewayLeg> {
  const waitUntilPromises: Promise<unknown>[] = []
  const port = await reserveDemoPort()
  const app = createModelGatewayApp({
    convexUrl: args.convexUrl,
    internalKey: args.internalKey,
    aiGatewayApiKey: args.aiGatewayApiKey,
    upstreamBaseUrl: args.upstreamBaseUrl,
    fetch: args.fakeVag.fetch,
    waitUntil: promise => {
      waitUntilPromises.push(promise)
      promise.catch(() => undefined)
    },
    ...args.gatewayOptions,
  })
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port,
    fetch: request => app.fetch(request),
  })
  let exposure: ({ publicUrl: string } & StopHandle) | undefined
  try {
    exposure = await (args.expose ?? exposeDemoPort)(server.port ?? port)
  } catch (error) {
    server.stop(true)
    throw error
  }
  return {
    url: exposure.publicUrl,
    localUrl: `http://127.0.0.1:${server.port}`,
    fakeVag: args.fakeVag,
    async drainWaitUntil() {
      await Promise.all(waitUntilPromises)
    },
    async stop() {
      try {
        await exposure?.stop()
      } finally {
        server.stop(true)
      }
    },
  }
}

export function findReconciledLedgerDebitRows(input: {
  generations: Array<Record<string, unknown>>
  transactions: Array<Record<string, unknown>>
}): ReconciledLedgerDebit | null {
  for (const generation of input.generations) {
    if (generation.status !== 'settled') continue
    const generationId = stringField(generation, '_id')
    const tier = ModelTierIdSchema.safeParse(generation.tier)
    const upstreamGenerationId = stringField(generation, 'upstreamGenerationId')
    const reservationId = stringField(generation, 'reservationId')
    if (generationId === null || !tier.success || upstreamGenerationId === null) continue
    const transaction = input.transactions.find(row => {
      const amount = numberField(row, 'amountMicroUsd')
      const type = row.type
      if (amount === null || amount >= 0) return false
      if (type !== 'usage' && type !== 'reservation') return false
      if (type === 'usage') {
        return row.reference === `ai_generation:${upstreamGenerationId}`
      }
      return reservationId !== null && row.reference === reservationId
    })
    if (transaction === undefined) continue
    return {
      generationId,
      tier: tier.data,
      upstreamGenerationId,
      ...(reservationId === null ? {} : { reservationId }),
      transactionReference: String(transaction.reference),
      transactionType: transaction.type as 'usage' | 'reservation',
      amountMicroUsd: numberField(transaction, 'amountMicroUsd')!,
    }
  }
  return null
}

export async function queryReconciledLedgerDebit(
  convex: Pick<ConvexDevFixture, 'query'>,
  workspaceId: string,
  internalKey = INTERNAL_KEY,
): Promise<ReconciledLedgerDebit | null> {
  const [generations, transactions] = await Promise.all([
    convex.query('testing/modelGateway:listGenerationsForTest', {
      internalKey,
      workspaceId,
    }) as Promise<Array<Record<string, unknown>>>,
    convex.query('testing/credits:listWorkspaceTransactionsForTest', {
      internalKey,
      workspaceId,
    }) as Promise<Array<Record<string, unknown>>>,
  ])
  return findReconciledLedgerDebitRows({ generations, transactions })
}

export async function waitForReconciledLedgerDebit(
  convex: Pick<ConvexDevFixture, 'query'>,
  workspaceId: string,
  options: { internalKey?: string; timeoutMs?: number; pollMs?: number } = {},
): Promise<ReconciledLedgerDebit> {
  const deadline = Date.now() + (options.timeoutMs ?? 30_000)
  let last: ReconciledLedgerDebit | null = null
  for (;;) {
    last = await queryReconciledLedgerDebit(
      convex,
      workspaceId,
      options.internalKey ?? INTERNAL_KEY,
    )
    if (last !== null) return last
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for reconciled model-gateway ledger debit; last=${JSON.stringify(last)}`,
      )
    }
    await Bun.sleep(options.pollMs ?? 250)
  }
}

export async function runDemo60sProbe(): Promise<Demo60sResult> {
  if (!process.env.EXE_TOKEN) throw new Error('EXE_TOKEN is required for the 60-second demo probe.')
  if (!process.env.DUET_REAL_VM_IMAGE_REF)
    throw new Error('DUET_REAL_VM_IMAGE_REF is required for the 60-second demo probe.')
  assertDockerCliReady()

  const startedAt = Date.now()
  const timeline: Record<string, number> = {}
  const tempDir = await mkdtemp(join(tmpdir(), 'duet-demo-60s-'))
  const pool = exeVmPool({ token: process.env.EXE_TOKEN })
  const createdVmNames = new Set<string>()
  const deletedVmNames = new Set<string>()
  let convex: ConvexDevFixture | undefined
  let apiServer: ReturnType<typeof Bun.serve> | undefined
  let tunnel: TunnelProcess | undefined
  let gatewayFixture: DemoModelGatewayFixture | undefined
  let gatewayLeg: DemoModelGatewayLeg | undefined

  try {
    const mode: DemoAgentMode =
      process.env.DUET_DEMO_AGENT_MODE === 'real' ? 'real-agent' : 'mock-agent'
    const modelGatewayPlan = selectDemoModelGatewayPlan()
    if (modelGatewayPlan.kind === 'local') {
      gatewayFixture = await createDemoModelGatewayFixture({ readyAfterPolls: 0 })
    }
    const deferredAgent = new DeferredAgentMock()
    const port = await reserveDemoPort()
    const localApiUrl = `http://127.0.0.1:${port}`
    let app!: ApiApp
    apiServer = Bun.serve({
      hostname: '127.0.0.1',
      port,
      fetch: request => app?.fetch(request) ?? new Response('starting', { status: 503 }),
    })
    tunnel = await startTunnel(port)
    const publicApiUrl = tunnel.publicUrl
    convex = await convexDev(BACKEND_DIR, {
      env: {
        ...generateAuthKeys({ kid: 'test-key', alg: 'RS256' }),
        DUET_API_INTERNAL_KEY: INTERNAL_KEY,
        DUET_EDGE_INTERNAL_KEY: EDGE_SECRET,
        DUET_TEST_AUTH_CODE: TEST_AUTH_CODE,
        DUET_TEST_AUTH_EMAIL: '1',
        DUET_TEST_AUTH_GOOGLE: '1',
        DUET_VM_TOKEN_DERIVE_SECRET: DERIVE_SECRET,
        DUET_VM_SYNC_INTERVAL_SECONDS: '5',
        DUET_GATEWAY_EXTRA_HEADERS_JSON: JSON.stringify({ 'bypass-tunnel-reminder': 'duet' }),
        DUET_EXE_CREATE_TRANSPORT: 'ssh',
        DUET_EXE_VM_TAGS: DUET_TEST_VM_TAG,
        DUET_API_URL: publicApiUrl,
        DUET_VM_IMAGE_REF: process.env.DUET_REAL_VM_IMAGE_REF,
        EXE_TOKEN: process.env.EXE_TOKEN,
        DUET_APP_URL: 'http://localhost:3000',
        ...gatewayFixture?.convexEnv,
      },
      readyTimeoutMs: 180_000,
      reset: true,
    })
    timeline.convexReady = secondsSince(startedAt)

    const modelGatewayUrl =
      modelGatewayPlan.kind === 'external'
        ? modelGatewayPlan.url
        : modelGatewayPlan.kind === 'local'
          ? await (async () => {
              assert(gatewayFixture !== undefined, 'local model gateway fixture was not prepared')
              gatewayLeg = await gatewayFixture.boot({
                convexUrl: convex!.url,
                internalKey: INTERNAL_KEY,
              })
              return gatewayLeg.url
            })()
          : undefined
    app = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      ...(modelGatewayUrl === undefined ? {} : { modelGatewayUrl }),
      ...(mode === 'mock-agent' ? { firecrawlKey: 'demo-firecrawl-key' } : {}),
      fetch: async (input, init) => {
        const requestUrl = String(input)
        const url = new URL(requestUrl)
        if (mode === 'mock-agent' && requestUrl === 'https://api.firecrawl.dev/v2/scrape') {
          return Response.json({
            success: true,
            data: { markdown: SEEDED_MEMORY, metadata: { title: 'Northstar Robotics' } },
          })
        }
        if (mode === 'mock-agent' && url.pathname === '/v1/train') {
          return Response.json({ jobId: `demo-train-${crypto.randomUUID()}` }, { status: 202 })
        }
        if (
          mode === 'mock-agent' &&
          (url.pathname === '/v1/memory' ||
            url.pathname === '/v1/memory/search' ||
            url.pathname.startsWith('/v1/train/records'))
        ) {
          return await deferredAgent.handleMemoryGatewayRequest(url, init)
        }
        const inputMatch = url.pathname.match(/^\/v1\/agent\/sessions\/([^/]+)\/input$/)
        if (mode === 'mock-agent' && inputMatch !== null) {
          const body = GatewayRunnerInputRequestSchema.parse(JSON.parse(String(init?.body)))
          assert.equal(body.input.kind, 'prompt', 'demo mock expects a prompt runner input')
          assert.equal(body.launch.tier, 'balanced', 'demo mock expects the metered launch tier')
          const sessionId = inputMatch[1]
          assert(sessionId !== undefined, 'mock agent gateway request did not include a session id')
          const answer = deferredAgent.answerBusinessQuestion()
          const vmToken = bearerTokenFromHeaders(init?.headers)
          assert(vmToken !== null, 'mock agent gateway request did not include the VM token')
          await relayAgentEvent(app, vmToken, sessionId, {
            type: 'turn_started',
            state: {
              status: 'running',
              mode: 'agent',
              agent: { status: 'running', messages: [] },
            },
          })
          await relayAgentEvent(app, vmToken, sessionId, {
            type: 'step',
            step: { type: 'text', text: answer },
          })
          await relayAgentEvent(app, vmToken, sessionId, {
            type: 'complete',
            state: {
              status: 'completed',
              mode: 'agent',
              agent: { status: 'completed', messages: [] },
            },
            status: 'completed',
            result: answer,
          })
          return Response.json({
            acceptedThroughSeq: body.throughSeq,
            disposition: 'hydrated',
          })
        }
        return await fetch(input, init)
      },
    })
    await waitForPublicApi(publicApiUrl)
    timeline.localApiReady = secondsSince(startedAt)

    const owner = await signInWithMagicLink(convex, uniqueEmail('demo-owner'), 'Demo Owner')
    const ownerUserId = (
      (await query(owner.client, 'domains/users/queries:current')) as { _id: string }
    )._id
    const seedWorkspace = (await listMine(owner.client))[0]?.workspace
    assert(seedWorkspace !== undefined, 'expected Convex auth to create the seed workspace')
    await mutate(
      owner.client,
      'testing/workspaces:activateCurrentUserSyntheticSubscriptionForTest',
      {
        internalKey: INTERNAL_KEY,
      },
    )
    const attachedSeed = await waitForWorkspace({
      workspaceId: seedWorkspace._id,
      load: async () => await loadRawWorkspace(convex!, seedWorkspace._id),
      predicate: workspace => workspace.vmName !== undefined,
      timeoutMs: 240_000,
      pollMs: 1_000,
    })
    createdVmNames.add(attachedSeed.vmName!)
    const createKey = await issueKey(owner.client)
    const workspaceSlug = uniqueSlug('demo-60s')

    const createResponse = await fetch(`${localApiUrl}/v1/workspaces`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${createKey.key}`,
        'content-type': 'application/json',
        'bypass-tunnel-reminder': 'duet',
      },
      body: JSON.stringify({ slug: workspaceSlug, name: 'Demo 60s Workspace' }),
    })
    assertResponse(createResponse, 202, 'workspace create')
    const created = WorkspaceCreateResultSchema.parse(await createResponse.json())
    assert(
      created.slug === workspaceSlug && created.status === 'provisioning',
      'workspace create did not return its provisioning status',
    )
    timeline.workspaceCreated = secondsSince(startedAt)

    const active = await waitForWorkspace({
      workspaceId: created.workspaceId,
      load: async () => await loadRawWorkspace(convex!, created.workspaceId),
      predicate: workspace => workspace.status === 'active',
      timeoutMs: 240_000,
      pollMs: 1_000,
    })
    createdVmNames.add(active.vmName!)
    timeline.workspaceActive = secondsSince(startedAt)
    assert(
      active.lastHeartbeatAt !== undefined,
      'workspace became active without a sync observation',
    )
    await pool.client.waitUntilReady(active.sshDest!, { timeoutMs: 180_000 })
    timeline.vmSshReady = secondsSince(startedAt)

    const pairedConfig = await runFreshContainerPairing({
      tempDir,
      apiPort: port,
      localApiUrl,
      workspaceSlug,
      owner,
    })
    timeline.duetInstalledAndPaired = secondsSince(startedAt)
    assert(
      pairedConfig.defaultWorkspace === workspaceSlug,
      'duet did not store the paired workspace',
    )
    assert(pairedConfig.apiKey.startsWith('duet_sk_'), 'duet did not store an approved API key')

    await grantCredits(convex, created.workspaceId, 'grant:demo-60s-agent')

    const trainInput =
      mode === 'real-agent'
        ? {
            files: [
              {
                filename: 'northstar-renewal.md',
                content: SEEDED_MEMORY,
              },
            ],
          }
        : { urls: ['https://northstar.example/company'] }
    const trainStarted = await fetch(`${localApiUrl}/v1/ws/${workspaceSlug}/train`, {
      method: 'POST',
      headers: authedJsonHeaders(pairedConfig.apiKey),
      body: JSON.stringify(trainInput),
    })
    assertResponse(trainStarted, 202, 'train start')
    const trainBody = (await trainStarted.json()) as { jobId: string }
    if (mode === 'mock-agent') {
      const trainStartedAt = Date.now()
      await convex.mutation('domains/train/model:reconcileFromVm', {
        internalKey: INTERNAL_KEY,
        workspaceId: created.workspaceId,
        trainReports: [
          {
            generation: `${trainBody.jobId}:demo-running`,
            jobId: trainBody.jobId,
            creatorUserId: ownerUserId,
            state: 'running',
            phase: 'training',
            createdAt: trainStartedAt,
            updatedAt: trainStartedAt,
            startedAt: trainStartedAt,
          },
        ],
      })
      await deferredAgent.runTrain({
        workspaceSlug,
        urls: ['https://northstar.example/company'],
      })
      const completedAt = Date.now()
      await convex.mutation('domains/train/model:reconcileFromVm', {
        internalKey: INTERNAL_KEY,
        workspaceId: created.workspaceId,
        trainReports: [
          {
            generation: `${trainBody.jobId}:demo-done`,
            jobId: trainBody.jobId,
            creatorUserId: ownerUserId,
            state: 'done',
            phase: 'done',
            createdAt: trainStartedAt,
            updatedAt: completedAt,
            startedAt: trainStartedAt,
            completedAt,
          },
        ],
      })
    }
    const trainJob = await waitForTrainDone(
      localApiUrl,
      workspaceSlug,
      trainBody.jobId,
      pairedConfig.apiKey,
    )
    assert(trainJob.state === 'done', 'train job did not complete')
    const recordsResponse = await fetch(`${localApiUrl}/v1/ws/${workspaceSlug}/train/records`, {
      headers: authedHeaders(pairedConfig.apiKey),
    })
    assertResponse(recordsResponse, 200, 'train records list')
    const records = (await recordsResponse.json()) as { records: TrainRecordSummary[] }
    const summary = records.records[0]
    assert(summary !== undefined, 'train did not create a file-backed record')
    const detailResponse = await fetch(
      `${localApiUrl}/v1/ws/${workspaceSlug}/train/records/${encodeURIComponent(summary.slug)}`,
      { headers: authedHeaders(pairedConfig.apiKey) },
    )
    assertResponse(detailResponse, 200, 'train record detail')
    const detail = (await detailResponse.json()) as { record: TrainRecord }
    assert(
      detail.record.memoryId === summary.memoryId && detail.record.content.includes('20 percent'),
      'train record list/detail did not return matching file-backed content',
    )
    timeline.bootstrapTrainMockDone = secondsSince(startedAt)

    const sessionCreated = await fetch(`${localApiUrl}/v1/ws/${workspaceSlug}/agent/sessions`, {
      method: 'POST',
      headers: authedJsonHeaders(pairedConfig.apiKey),
      body: JSON.stringify({ prompt: BUSINESS_QUESTION }),
    })
    assertResponse(sessionCreated, 201, 'agent session create')
    const session = ((await sessionCreated.json()) as AgentSessionCreated).session
    const eventsResponse = await fetch(
      `${localApiUrl}/v1/ws/${workspaceSlug}/agent/sessions/${session.sessionId}/events`,
      { headers: authedHeaders(pairedConfig.apiKey) },
    )
    const terminal = await readUntilTerminal(eventsResponse)
    const answer = String(terminal.result ?? '')
    assert(
      answer.includes('20 percent'),
      'controlled agent answer did not include the renewal fixture',
    )
    assert(
      answer.includes('calm cobalt'),
      'controlled agent answer did not include the brand fixture',
    )
    timeline.businessQuestionMockAnswered = secondsSince(startedAt)

    let settledDebit: ReconciledLedgerDebit | undefined
    if (mode === 'real-agent') {
      await gatewayLeg?.drainWaitUntil()
      settledDebit = await waitForReconciledLedgerDebit(convex, created.workspaceId, {
        timeoutMs: 45_000,
      })
      if (gatewayLeg !== undefined) {
        assert(
          gatewayLeg.fakeVag.generationIds.length > 0,
          'local fake VAG did not receive a model generation request',
        )
      }
      timeline.modelGatewayLedgerDebitSettled = secondsSince(startedAt)
    }

    const artifact = [
      '# Northstar renewal brief',
      '',
      answer,
      '',
      'Brand voice: calm cobalt, direct, practical.',
    ].join('\n')
    const writeArtifact = await fetch(
      `${localApiUrl}/v1/ws/${workspaceSlug}/files/reports/renewal.md`,
      {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${pairedConfig.apiKey}`,
          'content-type': 'text/markdown',
          'bypass-tunnel-reminder': 'duet',
        },
        body: artifact,
      },
    )
    assertResponse(writeArtifact, 200, 'artifact write')
    const publishSlug = 'renewal-brief'
    const publishResponse = await fetch(`${localApiUrl}/v1/ws/${workspaceSlug}/publishes`, {
      method: 'POST',
      headers: authedJsonHeaders(pairedConfig.apiKey),
      body: JSON.stringify({ path: 'reports/renewal.md', slug: publishSlug }),
    })
    assertResponse(publishResponse, 201, 'artifact publish')
    const edge = createEdgeApp({
      convexSiteUrl: convex.siteUrl,
      edgeSecret: EDGE_SECRET,
      resolveAttempts: 8,
      resolveRetryDelayMs: 500,
    })
    // Publish is a viewer: the bare URL (the shareable one) serves the
    // anonymous viewer page; the published source is only readable through
    // the reserved `?raw` selector, which is what this liveness probe reads.
    const publicUrl = `https://edge.duet.so/${workspaceSlug}/${publishSlug}`
    const published = await waitForEdgeText(
      edge.fetch,
      `${publicUrl}?raw`,
      'edge.duet.so',
      'Northstar renewal brief',
    )
    assert(
      published.includes('20 percent'),
      'published artifact did not include the business answer',
    )
    timeline.publishFetchLive = secondsSince(startedAt)

    for (const vmName of createdVmNames) {
      await pool.returnVm(vmName)
      deletedVmNames.add(vmName)
    }
    timeline.vmDeleted = secondsSince(startedAt)
    const allDuetTestVms = (await pool.client.list()).filter(
      vm => vm.vm_name.startsWith('duet-test-') || vm.tags?.includes(DUET_TEST_VM_TAG),
    )
    const createdVmLeaks = allDuetTestVms
      .filter(vm => createdVmNames.has(vm.vm_name))
      .map(vm => vm.vm_name)
    assert(createdVmLeaks.length === 0, `created VM leak(s): ${createdVmLeaks.join(', ')}`)

    const result: Demo60sResult = {
      marker: MARKER,
      mode,
      publicUrl,
      answer,
      timeline,
      totalSeconds: secondsSince(startedAt),
      vmsCreated: [...createdVmNames],
      vmsDeleted: [...deletedVmNames],
      leakCheck: { createdVmLeaks, duetTestVmCount: allDuetTestVms.length },
      realSteps: [
        'create workspace and wait for its real VM from the built image',
        'fresh Docker install of packed duet',
        'device pairing against local api+convex with required human approval',
        ...(mode === 'real-agent'
          ? ['model calls through DUET_MODEL_GATEWAY_URL with sync-delivered credentials']
          : []),
        'files API write',
        'publish API registration',
        'edge/gateway public fetch at duet.so/{workspace}/{slug}',
      ],
      mockedAgentSeams:
        mode === 'mock-agent'
          ? [
              'duet train runner and system manual memory writes',
              'duet --rpc agent turn and memory-grounded answer',
            ]
          : modelGatewayPlan.kind === 'local'
            ? ['controlled upstream completion; this does not prove model memory grounding']
            : [],
      modelGateway:
        modelGatewayPlan.kind === 'disabled'
          ? { mode: 'disabled' }
          : {
              mode: modelGatewayPlan.kind,
              url: modelGatewayUrl,
              ...(settledDebit === undefined ? {} : { settledDebit }),
            },
    }
    console.log(
      `${MARKER}_TIMELINE ${JSON.stringify({ timeline, totalSeconds: result.totalSeconds, publicUrl })}`,
    )
    return result
  } finally {
    await disposeDemoProbe({
      createdVmNames,
      deletedVmNames,
      returnVm: name => pool.returnVm(name),
      tunnel,
      gatewayLeg,
      gatewayFixture,
      apiServer,
      convex,
      tempDir,
    })
  }
}

export async function disposeDemoProbe(resources: {
  createdVmNames: Set<string>
  deletedVmNames: Set<string>
  returnVm: (name: string) => Promise<void>
  tunnel?: TunnelProcess
  gatewayLeg?: Pick<DemoModelGatewayLeg, 'stop'>
  gatewayFixture?: Pick<DemoModelGatewayFixture, 'stop'>
  apiServer?: Pick<ReturnType<typeof Bun.serve>, 'stop'>
  convex?: Pick<ConvexDevFixture, 'stop'>
  tempDir: string
}): Promise<void> {
  const { createdVmNames, deletedVmNames } = resources
  const errors: unknown[] = []
  const release = async (cleanup: () => unknown | Promise<unknown>) => {
    try {
      await cleanup()
    } catch (error) {
      errors.push(error)
    }
  }
  for (const vmName of createdVmNames) {
    if (deletedVmNames.has(vmName)) continue
    await release(async () => {
      await resources.returnVm(vmName)
      deletedVmNames.add(vmName)
    })
  }
  await release(async () => {
    if (resources.tunnel) await stopTunnelProcess(resources.tunnel.process)
  })
  await release(async () => await resources.gatewayLeg?.stop())
  await release(() => resources.gatewayFixture?.stop())
  await release(async () => await resources.apiServer?.stop(true))
  await release(async () => await resources.convex?.stop())
  await release(async () => await rm(resources.tempDir, { recursive: true, force: true }))
  if (errors.length > 0) throw new AggregateError(errors, 'demo resource cleanup failed')
}

class DeferredAgentMock {
  private readonly records: MemoryRecord[] = []
  private readonly trainRecords: TrainRecord[] = []
  private sequence = 0

  async runTrain(input: { workspaceSlug: string; urls: string[] }): Promise<void> {
    const argv = TRAIN_CLI_CONTRACT.argv({
      sourceDir: `/tmp/duet-train/${input.workspaceSlug}`,
      slug: input.workspaceSlug,
      storeDir: `/tmp/duet-train/${input.workspaceSlug}/memories`,
    })
    assert(argv[0] === 'train' && !argv.includes('--json'), 'mock train contract drifted')
    assert(
      input.urls.includes('https://northstar.example/company'),
      'demo train URL was not passed through',
    )
    const createdAt = new Date(1_783_440_000_000 + this.sequence).toISOString()
    this.sequence += 1
    this.trainRecords.push({
      slug: input.workspaceSlug,
      memoryId: `mem_train_${this.sequence}`,
      createdAt,
      observedDate: createdAt.slice(0, 10),
      hasArchive: false,
      content: SEEDED_MEMORY,
    })
    await Bun.sleep(50)
  }

  async handleMemoryGatewayRequest(url: URL, init?: RequestInit): Promise<Response> {
    if (url.pathname === '/v1/train/records') {
      return Response.json({ records: this.trainRecords.map(toTrainRecordSummary) })
    }
    const recordMatch = url.pathname.match(/^\/v1\/train\/records\/([^/]+)$/)
    if (recordMatch !== null && init?.method === undefined) {
      const slug = decodeURIComponent(recordMatch[1]!)
      const record = this.trainRecords.find(candidate => candidate.slug === slug)
      return record === undefined
        ? Response.json({ error: 'not_found' }, { status: 404 })
        : Response.json({ record })
    }
    if (url.pathname === '/v1/memory' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as {
        content: string
        source: MemoryRecord['source']
      }
      return Response.json(this.addRecord(body.content, 'note', body.source))
    }
    if (url.pathname === '/v1/memory/search') {
      const query = url.searchParams.get('q') ?? ''
      const limit = Number(url.searchParams.get('limit') ?? '10')
      return Response.json({ query, limit, results: this.search(query, limit) })
    }
    return Response.json({ error: 'not_found' }, { status: 404 })
  }

  answerBusinessQuestion(): string {
    const seeded = this.trainRecords.find(memory => memory.content.includes('20 percent'))
    assert(seeded !== undefined, 'mock agent turn did not receive seeded train memory')
    return 'Sales should cap the Northstar Robotics discount at 20 percent and write the artifact in the calm cobalt brand voice.'
  }

  private addRecord(
    content: string,
    kind: MemoryRecord['kind'],
    source: MemoryRecord['source'],
  ): MemoryRecord {
    this.sequence += 1
    const createdAt = new Date(1_783_440_000_000 + this.sequence).toISOString()
    const record: MemoryRecord = {
      id: `mem_demo_${this.sequence}`,
      content,
      kind,
      source,
      priority: kind === 'manual' ? 'high' : 'medium',
      createdAt,
      lastUsedAt: createdAt,
      observedDate: createdAt.slice(0, 10),
      tags: kind === 'manual' ? ['train', `train:${this.sequence}`] : [],
      packScore: 1,
    }
    this.records.push(record)
    return record
  }

  private search(query: string, limit: number): MemoryRecord[] {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
    return this.records
      .map(record => ({
        ...record,
        relevanceScore: terms.reduce(
          (score, term) => score + (record.content.toLowerCase().includes(term) ? 1 : 0),
          0,
        ),
      }))
      .filter(record => (record.relevanceScore ?? 0) > 0)
      .sort((a, b) => (b.relevanceScore ?? 0) - (a.relevanceScore ?? 0))
      .slice(0, limit)
  }
}

function toTrainRecordSummary(record: TrainRecord): TrainRecordSummary {
  return {
    slug: record.slug,
    memoryId: record.memoryId,
    createdAt: record.createdAt,
    observedDate: record.observedDate,
    hasArchive: record.hasArchive,
  }
}

async function runFreshContainerPairing(input: {
  tempDir: string
  apiPort: number
  localApiUrl: string
  workspaceSlug: string
  owner: SignedInUser
}): Promise<IssuedDeviceConfig> {
  const packDir = await mkdtemp(join(input.tempDir, 'duet-pack-'))
  const tarball = join(packDir, 'duet.tgz')
  const publicPackage = join(packDir, 'public-package')
  execFileSync(process.execPath, ['scripts/build-public-package.ts', publicPackage], {
    cwd: DUET_CLI_DIR,
    stdio: 'ignore',
  })
  execFileSync(process.execPath, ['pm', 'pack', '--filename', tarball], {
    cwd: publicPackage,
    stdio: 'ignore',
  })
  const sharedDir = await mkdtemp(join(input.tempDir, 'duet-container-'))
  const script = dockerPairingScript(input.apiPort, input.workspaceSlug)
  const docker = Bun.spawn(
    [
      'docker',
      'run',
      '--rm',
      '--add-host=host.docker.internal:host-gateway',
      '-v',
      `${tarball}:/tmp/duet.tgz:ro`,
      '-v',
      `${sharedDir}:/work`,
      'oven/bun:1.3.14',
      'bash',
      '-lc',
      script,
    ],
    { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
  )
  const stdoutPromise = new Response(docker.stdout).text()
  const stderrPromise = new Response(docker.stderr).text()
  try {
    const device = await waitForJsonFile<{ device_code: string; user_code: string }>(
      join(sharedDir, 'device.json'),
      90_000,
    )
    const pending = await fetch(`${input.localApiUrl}/v1/device/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'bypass-tunnel-reminder': 'duet' },
      body: JSON.stringify({ device_code: device.device_code }),
    })
    assertResponse(pending, 200, 'pre-approval device poll')
    const pendingBody = (await pending.json()) as { status: string; access_token?: string }
    assert(
      pendingBody.status === 'pending' || pendingBody.status === 'slow_down',
      `expected pending/slow_down before approval, got ${pendingBody.status}`,
    )
    assert(
      pendingBody.access_token === undefined,
      'device token endpoint yielded a key before approval',
    )
    const actor = (await query(input.owner.client, 'domains/users/queries:current', {})) as {
      _id: string
    }
    await mutate(input.owner.client, 'domains/apiKeys/deviceApi:approve', {
      internalKey: INTERNAL_KEY,
      actorId: actor._id,
      userCode: device.user_code,
      now: Date.now(),
    })
    const exitCode = await docker.exited
    const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise])
    if (exitCode !== 0) {
      throw new Error(
        `duet Docker pairing failed with exit ${exitCode}\nstdout=${stdout}\nstderr=${stderr}`,
      )
    }
    assert(
      stdout.includes('DEMO_DUET_CLI_PAIRING ok'),
      'fresh-container duet pairing marker missing',
    )
    const config = await waitForJsonFile<IssuedDeviceConfig>(
      join(sharedDir, 'home', '.duet', 'config.json'),
      10_000,
    )
    assert(
      config.apiUrl === `http://127.0.0.1:34567`,
      'container did not pair through its fresh API proxy',
    )
    return config
  } finally {
    docker.kill('SIGTERM')
    await docker.exited.catch(() => undefined)
  }
}

function dockerPairingScript(apiPort: number, workspaceSlug: string): string {
  return [
    'set -euo pipefail',
    'mkdir -p /work/home',
    'export HOME=/work/home',
    "cat > /tmp/device-proxy.ts <<'PROXY'",
    `const upstream = "http://host.docker.internal:${apiPort}/v1"`,
    'Bun.serve({',
    '  hostname: "127.0.0.1",',
    '  port: 34567,',
    '  async fetch(request) {',
    '    const url = new URL(request.url)',
    '    const target = upstream + url.pathname.replace(/^\\/v1/, "") + url.search',
    '    const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.text()',
    '    const response = await fetch(target, { method: request.method, headers: request.headers, body })',
    '    if (url.pathname === "/v1/device/code") {',
    '      const json = await response.clone().json()',
    '      await Bun.write("/work/device.json", JSON.stringify(json))',
    '      return Response.json(json, { status: response.status, headers: response.headers })',
    '    }',
    '    return response',
    '  }',
    '})',
    'PROXY',
    'bun /tmp/device-proxy.ts >/work/proxy.log 2>&1 &',
    'proxy_pid=$!',
    'trap "kill $proxy_pid >/dev/null 2>&1 || true" EXIT',
    'timeout 30 bash -lc \'until bun -e "const r = await fetch(\\"http://127.0.0.1:34567/v1/device/token\\", { method: \\"POST\\", headers: {\\"content-type\\":\\"application/json\\"}, body: JSON.stringify({device_code:\\"f\\".repeat(64)}) }); if (!r.ok) process.exit(1)" >/dev/null 2>&1; do sleep 0.2; done\'',
    'timeout 60 bun add -g --production /tmp/duet.tgz >/work/install.log 2>&1 || { cat /work/install.log; exit 1; }',
    'export PATH="/root/.bun/bin:$PATH"',
    `timeout 120 duet --api-url http://127.0.0.1:34567 --json login >/work/login.ndjson 2>/work/login.err`,
    `duet workspace use ${workspaceSlug} >/work/workspace.txt`,
    'duet --json whoami >/work/whoami.json',
    'grep "\\"status\\":\\"approved\\"" /work/login.ndjson >/dev/null',
    'printf "DEMO_DUET_CLI_PAIRING ok\\n"',
  ].join('\n')
}

async function startTunnel(
  port: number,
): Promise<{ process: ChildProcessWithoutNullStreams; publicUrl: string }> {
  try {
    return await startTunnelProcess(
      'bunx',
      ['localtunnel', '--port', String(port)],
      /https:\/\/[-a-z0-9]+\.loca\.lt/i,
    )
  } catch {
    return await startTunnelProcess(
      'cloudflared',
      ['tunnel', '--url', `http://127.0.0.1:${port}`, '--no-autoupdate'],
      /https:\/\/[-a-z0-9]+\.trycloudflare\.com/i,
    )
  }
}

async function exposeDemoPort(port: number): Promise<{ publicUrl: string } & StopHandle> {
  const tunnel = await startTunnel(port)
  return {
    publicUrl: tunnel.publicUrl,
    stop: async () => await stopTunnelProcess(tunnel.process),
  }
}

async function stopTunnelProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()))
  const timer = setTimeout(() => child.kill('SIGKILL'), 5_000)
  try {
    child.kill('SIGTERM')
    await exited
  } finally {
    clearTimeout(timer)
  }
}

async function startTunnelProcess(
  command: string,
  args: string[],
  urlPattern: RegExp,
): Promise<TunnelProcess> {
  const child = spawn(command, args)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const publicUrl = await new Promise<string>((resolve, reject) => {
      let output = ''
      timer = setTimeout(
        () => reject(new Error(`${command} did not report a URL:\n${output}`)),
        60_000,
      )
      const onData = (chunk: Buffer) => {
        output += chunk.toString()
        const match = output.match(urlPattern)
        if (match) resolve(match[0]!)
      }
      child.stdout.on('data', onData)
      child.stderr.on('data', onData)
      child.once('error', reject)
      child.once('exit', code => reject(new Error(`${command} exited ${code}:\n${output}`)))
    })
    return { process: child, publicUrl }
  } catch (error) {
    if (child.pid !== undefined) await stopTunnelProcess(child)
    throw error
  } finally {
    if (timer) clearTimeout(timer)
  }
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
      // Tunnel DNS and proxy startup are eventually consistent.
    }
    if (Date.now() >= deadline)
      throw new Error(`Public API tunnel did not become reachable: ${apiUrl}`)
    await Bun.sleep(1_000)
  }
}

async function loadRawWorkspace(
  convex: ConvexDevFixture,
  workspaceId: string,
): Promise<RawWorkspace | undefined> {
  const workspaces = (await convex.query('testing/workspaces:rawWorkspacesForTest', {
    internalKey: INTERNAL_KEY,
  })) as RawWorkspace[]
  return workspaces.find(workspace => workspace._id === workspaceId)
}

async function waitForTrainDone(
  apiUrl: string,
  workspaceSlug: string,
  jobId: string,
  key: string,
): Promise<{ state: string; phase: string }> {
  const deadline = Date.now() + 30_000
  let last: unknown
  for (;;) {
    const response = await fetch(`${apiUrl}/v1/ws/${workspaceSlug}/train/${jobId}`, {
      headers: authedHeaders(key),
    })
    assertResponse(response, 200, 'train status')
    const body = (await response.json()) as { job: { state: string; phase: string } }
    last = body
    if (body.job.state === 'done' || body.job.state === 'failed') return body.job
    if (Date.now() >= deadline)
      throw new Error(`Timed out waiting for train ${jobId}; last=${JSON.stringify(last)}`)
    await Bun.sleep(250)
  }
}

async function waitForEdgeText(
  edgeFetch: (request: Request) => Promise<Response>,
  url: string,
  host: string,
  expectedSubstring: string,
): Promise<string> {
  const deadline = Date.now() + 90_000
  let last = ''
  let status = 0
  for (;;) {
    const response = await edgeFetch(new Request(url, { headers: { host } }))
    status = response.status
    last = await response.text()
    if (status === 200 && last.includes(expectedSubstring)) return last
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for edge text; status=${status}; last=${JSON.stringify(last)}`,
      )
    }
    await Bun.sleep(1_000)
  }
}

async function relayAgentEvent(
  app: ApiApp,
  vmToken: string,
  sessionId: string,
  event: Record<string, unknown>,
): Promise<void> {
  const response = await app.request(`/v1/vm/agent/sessions/${sessionId}/events`, {
    method: 'POST',
    headers: { authorization: `Bearer ${vmToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ relayId: crypto.randomUUID(), event }),
  })
  assertResponse(response, 200, 'relay agent event')
}

async function waitForJsonFile<T>(path: string, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let last = ''
  for (;;) {
    if (existsSync(path)) {
      last = await readFile(path, 'utf8')
      if (last.trim().length > 0) return JSON.parse(last) as T
    }
    if (Date.now() >= deadline)
      throw new Error(`Timed out waiting for JSON file ${path}; last=${last}`)
    await Bun.sleep(100)
  }
}

async function listMine(client: ConvexHttpClient): Promise<WorkspaceRow[]> {
  return (await query(client, 'domains/workspaces/queries:listMine', {})) as WorkspaceRow[]
}

async function grantCredits(
  convex: ConvexDevFixture,
  workspaceId: string,
  reference: string,
): Promise<void> {
  await convex.mutation('domains/credits/internal:applyLedgerEntry', {
    internalKey: INTERNAL_KEY,
    workspaceId,
    amountMicroUsd: 10_000_000,
    type: 'grant',
    reference,
  })
}

function authedHeaders(key: string): Headers {
  return bearer(key, { 'bypass-tunnel-reminder': 'duet' })
}

function authedJsonHeaders(key: string): Headers {
  return bearerJson(key, { 'bypass-tunnel-reminder': 'duet' })
}

function normalizeOptionalEnvUrl(value: string | undefined): string | null {
  if (value === undefined || value.trim() === '') return null
  return value.replace(/\/+$/g, '')
}

function stringField(row: Record<string, unknown>, field: string): string | null {
  const value = row[field]
  return typeof value === 'string' && value.length > 0 ? value : null
}

function numberField(row: Record<string, unknown>, field: string): number | null {
  const value = row[field]
  return typeof value === 'number' ? value : null
}

async function reserveDemoPort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : null
      server.close(error => {
        if (error) reject(error)
        else if (port === null) reject(new Error('Failed to reserve local port'))
        else resolve(port)
      })
    })
  })
}

function uniqueSlug(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}
