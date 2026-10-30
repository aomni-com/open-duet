import assert from 'node:assert/strict'
import path from 'node:path'

import { ConvexHttpClient } from 'convex/browser'

import { AppResponseSchema, type App } from '@repo/contract'

import { proveAppHttpContract, type AppHttpContractEvidence } from './apps-live-http.ts'
import { deleteStagingSession } from './staging-live-agent-sessions.ts'
import { StagingArtifactCollector } from './staging-live-artifacts.ts'
import { fnMutation, fnQuery, type Workspace } from './staging-live-env.ts'
import { apiJson, bearer, bearerJson, secondsSince, stagingFetch } from './staging-live-http.ts'
import {
  recordWorkspaceCleanup,
  StagingResourceLedger,
  type StagingCleanupReport,
  workspaceIsDeleted,
} from './staging-live-resource-ledger.ts'
import { readAnnouncedRuntime } from './staging-live-runtime'
import {
  assertWorkspaceCanBecomeActive,
  readEventStream,
  waitForWorkspace,
} from './staging-live-streaming.ts'
import { readWorkspaceJourneyEnv, type WorkspaceJourneyEnv } from './staging-live-workspace-env.ts'

const SPIKE_SLUG = 'pulse'
const SPIKE_PATH = 'apps/pulse'
const AGENT_TERMINAL_BUDGET_MS = 600_000
const APP_ROW_BUDGET_MS = 600_000
const APP_CONTENT_BUDGET_MS = 180_000

export interface AppsLiveAcceptanceEvidence extends AppHttpContractEvidence {
  journey: 'build-app'
  runId: string
  workspaceSlug: string
  appUrl: string
  registeredMs: number
  agentTerminalMs: number
  first200Ms: number
  contentAttempts: number
  iconPath: string
  iconBytes: number
  readmePresent: boolean
  cleanup?: StagingCleanupReport
}

// The acceptance prompt is deliberately a natural product ask: the build-apps
// skill (installed on the VM) must carry the whole workflow — surface choice,
// early registration, generated icon, theme support, API design, live updates,
// and final polish.
export function acceptancePrompt(runId: string): string {
  return [
    `Build and deploy a tiny public task list as an app: name it "Pulse", use the slug ${SPIKE_SLUG}, put it at ${SPIKE_PATH}, and make it publicly accessible.`,
    `Its homepage must display the text SPIKE-OK-${runId}.`,
    'People need to add tasks with POST /api/tasks using {title}, list them with GET /api/tasks, and receive live updates from GET /events.',
    'Keep it minimal. Follow your build-apps workflow end to end, including the app icon.',
  ].join('\n')
}

export function classifyAppResponse(body: string, marker: string): 'marker' | 'other' {
  return body.includes(marker) ? 'marker' : 'other'
}

export interface WaitForAppContentResult {
  ok: boolean
  attempts: number
  lastStatus?: number
  lastBodyPreview?: string
}

export async function waitForAppContent(args: {
  url: string
  marker: string
  timeoutMs: number
  intervalMs: number
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>
}): Promise<WaitForAppContentResult> {
  const fetchImpl = args.fetchImpl ?? fetch
  const deadline = Date.now() + args.timeoutMs
  let attempts = 0
  let lastStatus: number | undefined
  let lastBodyPreview: string | undefined
  for (;;) {
    attempts += 1
    try {
      const response = await fetchImpl(args.url, { redirect: 'follow' })
      lastStatus = response.status
      const body = await response.text()
      lastBodyPreview = body.slice(0, 200)
      if (response.status === 200 && classifyAppResponse(body, args.marker) === 'marker') {
        return { ok: true, attempts, lastStatus, lastBodyPreview }
      }
    } catch (error) {
      lastBodyPreview = error instanceof Error ? error.message : String(error)
    }
    if (Date.now() >= deadline) return { ok: false, attempts, lastStatus, lastBodyPreview }
    await new Promise(resolve => setTimeout(resolve, args.intervalMs))
  }
}

export async function runAppsLiveAcceptance(
  options: {
    onProgress?: (stage: string) => void
  } = {},
): Promise<AppsLiveAcceptanceEvidence> {
  const env = readWorkspaceJourneyEnv()
  const startedAt = Date.now()
  const runId = `staging-e2e-apps-${startedAt.toString(36)}-${crypto.randomUUID().slice(0, 6)}`
  const marker = `SPIKE-OK-${runId}`
  const progress = (stage: string) => options.onProgress?.(stage)
  const convex = new ConvexHttpClient(env.convexUrl)
  const ledger = new StagingResourceLedger(runId)
  const artifacts = new StagingArtifactCollector(path.join(env.artifactRoot, runId), [
    env.internalKey,
    env.loginSecret,
    env.vercelBypassSecret,
  ])
  await artifacts.initialize()
  const evidence: Partial<AppsLiveAcceptanceEvidence> = { journey: 'build-app', runId }
  let result: AppsLiveAcceptanceEvidence | undefined

  try {
    progress('login')
    const email = `${runId}-admin@duet.so`
    const login = await apiJson<{ token: string; userId: string; workspaceSlug: string }>(
      `${env.apiUrl}/v1/admin/login-as`,
      {
        method: 'POST',
        headers: bearerJson(env.loginSecret),
        body: JSON.stringify({ email, create: true, ephemeral: true, name: `Apps Spike ${runId}` }),
      },
      200,
      'programmatic login',
      artifacts,
    )
    ledger.record({
      kind: 'user',
      id: login.userId,
      label: `${runId}:owner:${email}`,
      cleanupPriority: -100,
      cleanup: async () => {
        await convex.mutation(fnMutation('testing/stagingE2e:retireUserByEmailForTest'), {
          internalKey: env.internalKey,
          email,
        })
      },
      verify: async () =>
        (await convex.query(fnQuery('testing/stagingE2e:userByEmailForTest'), {
          internalKey: env.internalKey,
          email,
        })) === null,
    })
    const whoami = await apiJson<{
      workspaces: Array<{ id: string; slug: string; status: string }>
    }>(`${env.apiUrl}/v1/whoami`, { headers: bearer(login.token) }, 200, 'whoami', artifacts)
    const seed = whoami.workspaces.find(row => row.slug === login.workspaceSlug)
    assert(seed !== undefined, 'login-as workspace missing from whoami')
    evidence.workspaceSlug = seed.slug
    recordWorkspaceCleanup({
      ledger,
      convex,
      env,
      output: { vmNames: [] },
      workspaceId: seed.id,
      slug: seed.slug,
    })
    await convex.mutation(
      fnMutation('testing/workspaces:activateSyntheticSubscriptionByEmailForTest'),
      {
        internalKey: env.internalKey,
        email,
      },
    )
    await convex.mutation(fnMutation('domains/credits/internal:applyLedgerEntry'), {
      internalKey: env.internalKey,
      workspaceId: seed.id,
      amountMicroUsd: 10_000_000,
      type: 'grant',
      reference: `grant:apps-spike:${crypto.randomUUID()}`,
    })

    progress('workspace:active')
    // Wait for full gateway release convergence before probing runner behavior.
    // `dispatched:false` now means the prompt is durable and queued; registration
    // drains it once the matching gateway is ready.
    let workspace: Workspace = await waitForWorkspace(convex, env.internalKey, seed.id, row => {
      assertWorkspaceCanBecomeActive(row)
      return (
        row.status === 'active' &&
        row.vmName !== undefined &&
        row.lastHeartbeatAt !== undefined &&
        row.runtimeVersion !== undefined
      )
    })
    const gateway = (await convex.query(
      fnQuery('domains/workspaces/provisioning:gatewayConnectionBySlug'),
      { internalKey: env.internalKey, slug: seed.slug },
    )) as { vmToken: string } | { refusal: 'paused' } | null
    assert(
      gateway !== null && !('refusal' in gateway),
      'active workspace had no gateway connection',
    )
    const announcedRelease = await readAnnouncedRuntime({
      apiUrl: env.apiUrl,
      vmToken: gateway.vmToken,
      artifacts,
    })

    workspace = await waitForWorkspace(convex, env.internalKey, seed.id, row => {
      assertWorkspaceCanBecomeActive(row)
      return row.status === 'active' && row.runtimeVersion === announcedRelease.version
    })

    progress('agent:dispatch')
    const created = await apiJson<{ session: { sessionId: string }; dispatched: boolean }>(
      `${env.apiUrl}/v1/ws/${workspace.slug}/agent/sessions`,
      {
        method: 'POST',
        headers: bearerJson(login.token),
        body: JSON.stringify({ prompt: acceptancePrompt(runId) }),
      },
      201,
      'agent session create',
      artifacts,
    )
    // Create acknowledges once the prompt is durable; registration polling is
    // the delivery oracle for the background runner handoff.
    assert(!created.dispatched, 'agent session create bypassed the durable queue handoff')
    ledger.record({
      kind: 'session',
      id: created.session.sessionId,
      label: `${runId}:session`,
      cleanup: async () =>
        await deleteStagingSession(env, workspace.slug, created.session.sessionId, login.token),
      verify: async () => await workspaceIsDeleted(convex, env.internalKey, workspace._id),
    })

    progress('app:registered')
    const eventsUrlEarly = `${env.apiUrl}/v1/ws/${workspace.slug}/agent/sessions/${created.session.sessionId}/events`
    try {
      await waitForAppRow(env, workspace.slug, login.token)
    } catch (error) {
      // Diagnosis beats a bare timeout: dump the tail of the agent's own
      // transcript before cleanup destroys the session.
      const transcript = await readEventStream(
        eventsUrlEarly,
        login.token,
        undefined,
        10_000,
      ).catch(() => undefined)
      const tail = transcript?.frames
        .slice(-8)
        .map(frame => JSON.stringify(frame.event).slice(0, 300))
      console.error('APPS_LIVE_AGENT_TAIL', JSON.stringify(tail, undefined, 1))
      throw error
    }
    evidence.registeredMs = Date.now() - startedAt

    progress('agent:terminal')
    const eventsUrl = `${env.apiUrl}/v1/ws/${workspace.slug}/agent/sessions/${created.session.sessionId}/events`
    await readEventStream(eventsUrl, login.token, undefined, AGENT_TERMINAL_BUDGET_MS)
    evidence.agentTerminalMs = Date.now() - startedAt

    progress('app:identity')
    const finalApp = await waitForAppRow(env, workspace.slug, login.token)
    assert(
      finalApp.name === 'Pulse',
      `app name was ${finalApp.name ?? '(unset)'} — skill did not set it`,
    )
    assert(finalApp.icon !== undefined, 'app icon path unset — skill did not generate an icon')
    const iconResponse = await stagingFetch(
      `${env.apiUrl}/v1/ws/${workspace.slug}/files/${finalApp.anchorPath}/${finalApp.icon}?v=${finalApp.updatedAt}`,
      { headers: bearer(login.token) },
    )
    assert.equal(iconResponse.status, 200, 'icon file GET failed')
    const iconType = iconResponse.headers.get('content-type') ?? ''
    const iconBytes = new Uint8Array(await iconResponse.arrayBuffer())
    assert(iconType.startsWith('image/'), `icon content-type was ${iconType}`)
    assert(iconBytes.byteLength <= 1_048_576, `icon exceeds 1 MB (${iconBytes.byteLength})`)
    evidence.iconPath = finalApp.icon
    evidence.iconBytes = iconBytes.byteLength

    progress('app:public')
    if (finalApp.visibility !== 'public') {
      await apiJson(
        `${env.apiUrl}/v1/ws/${workspace.slug}/apps/${SPIKE_SLUG}/visibility`,
        {
          method: 'POST',
          headers: bearerJson(login.token),
          body: JSON.stringify({ visibility: 'public' }),
        },
        200,
        'set app public',
        artifacts,
      )
      console.warn('APPS_LIVE_WARN app was not public — prompt asked for public access')
    }

    progress('app:content')
    const content = await waitForAppContent({
      url: finalApp.canonicalUrl,
      marker,
      timeoutMs: APP_CONTENT_BUDGET_MS,
      intervalMs: 3_000,
    })
    assert(
      content.ok,
      `app URL never served the marker (status ${content.lastStatus}, body: ${content.lastBodyPreview})`,
    )
    const themed = await fetch(`${finalApp.canonicalUrl}?theme=dark`, { redirect: 'follow' })
    assert.equal(themed.status, 200, 'themed URL did not return 200')
    evidence.appUrl = finalApp.canonicalUrl
    evidence.first200Ms = Date.now() - startedAt
    evidence.contentAttempts = content.attempts

    progress('app:readme')
    const readmeResponse = await stagingFetch(
      `${env.apiUrl}/v1/ws/${workspace.slug}/files/${finalApp.anchorPath}/README.md`,
      { headers: bearer(login.token) },
    )
    evidence.readmePresent = readmeResponse.status === 200
    assert.equal(readmeResponse.status, 200, 'app README.md was not available through Files')

    progress('app:live-http')
    Object.assign(
      evidence,
      await proveAppHttpContract({
        appUrl: finalApp.canonicalUrl,
        taskTitle: `LIVE-TASK-${runId}`,
        fetchImpl: stagingFetch,
      }),
    )
    result = evidence as AppsLiveAcceptanceEvidence
  } finally {
    progress('cleanup')
    evidence.cleanup = await ledger.cleanupAll()
    console.log(
      `APPS_LIVE_TIMING total=${secondsSince(startedAt, 1)}s evidence=${JSON.stringify(evidence)}`,
    )
  }

  assert(result !== undefined, 'acceptance completed without evidence')
  assert(evidence.cleanup !== undefined, 'acceptance completed without cleanup evidence')
  if (evidence.cleanup.status !== 'pass') {
    throw new Error(`acceptance cleanup failed: ${JSON.stringify(evidence.cleanup)}`)
  }
  return result
}

async function waitForAppRow(
  env: Pick<WorkspaceJourneyEnv, 'apiUrl'>,
  slug: string,
  token: string,
): Promise<App> {
  const deadline = Date.now() + APP_ROW_BUDGET_MS
  for (;;) {
    const response = await stagingFetch(`${env.apiUrl}/v1/ws/${slug}/apps/${SPIKE_SLUG}`, {
      headers: bearer(token),
    })
    if (response.status === 200) {
      return AppResponseSchema.parse(await response.json()).app
    }
    assert(Date.now() < deadline, `agent never registered ${SPIKE_SLUG} within budget`)
    await new Promise(resolve => setTimeout(resolve, 3_000))
  }
}
