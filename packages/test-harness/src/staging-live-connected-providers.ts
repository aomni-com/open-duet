import assert from 'node:assert/strict'

import type { Page } from '@playwright/test'
import type { ConvexHttpClient } from 'convex/browser'

import { isKnownTimelineEvent } from '@repo/contract'
import { FAKE_OAUTH_ISSUER_QUOTA_AFTER_MS } from '@repo/fake-oauth-issuer'

import { deleteStagingSession } from './staging-live-agent-sessions.ts'
import {
  assertNoCredentialArtifacts,
  type StagingArtifactCollector,
} from './staging-live-artifacts.ts'
import { markExpectedBrowserTransition, navigateDeployedPage } from './staging-live-browser.ts'
import {
  CONNECTED_PROVIDERS_STAGING_LEGS,
  fnQuery,
  type LiveEnv,
  type Workspace,
} from './staging-live-env.ts'
import { apiJson, bearer, bearerJson } from './staging-live-http.ts'
import {
  loadChronologicalSessionHistory,
  type ChronologicalSessionHistory,
} from './staging-live-pagination.ts'
import type { StagingResourceLedger } from './staging-live-resource-ledger.ts'
import { workspaceIsDeleted } from './staging-live-resource-ledger.ts'
import { readEventStream, waitForWorkspace } from './staging-live-streaming.ts'
import {
  runWorkspaceBrowserJourney,
  type WorkspaceBrowserJourneyResult,
} from './staging-live-workspace-browser.ts'

type ConnectedProvidersLeg = (typeof CONNECTED_PROVIDERS_STAGING_LEGS)[number]

export interface ConnectedProvidersAcceptanceResult {
  passedLegs: ConnectedProvidersLeg[]
  planSessionId: string
  fallbackSessionId: string
}

export async function runConnectedProvidersSequence(args: {
  actions: Record<ConnectedProvidersLeg, () => Promise<void>>
  pass(leg: ConnectedProvidersLeg): void
  cleanup(): Promise<void>
}): Promise<void> {
  try {
    for (const leg of CONNECTED_PROVIDERS_STAGING_LEGS) {
      await args.actions[leg]()
      args.pass(leg)
    }
  } finally {
    await args.cleanup()
  }
}

export async function runConnectedProvidersOAuthAcceptance(args: {
  env: Pick<LiveEnv, 'apiUrl' | 'appUrl' | 'internalKey' | 'fakeOAuthIssuerUrl'>
  page: Page
  apiToken: string
  workspace: Workspace
  runId: string
  ledger: StagingResourceLedger
  convex: ConvexHttpClient
  artifacts: StagingArtifactCollector
  progress(stage: string): void
}): Promise<ConnectedProvidersAcceptanceResult> {
  const { env, page, workspace, apiToken, runId, ledger, convex, artifacts, progress } = args
  assertConnectedProvidersStagingPreflight(env, process.env)
  const passedLegs: ConnectedProvidersLeg[] = []
  const settingsUrl = `${env.appUrl}/w/${workspace.slug}/settings/connected-providers`
  const providerRow = page.locator('[data-provider="openai-codex"]')
  let planSessionId = ''
  let fallbackSessionId = ''
  let generationsBeforePlan = new Set<string>()
  /* Every answer the VM gave about the connect, because the card is only a
     projection of them. `connected-by-label` has failed here with nothing but
     "did not reach connected", and the reason it cannot say more is that the
     transition is the CLI's on the VM: it emits a device code, then the agent
     polls the issuer and reports back. The card is right or wrong for exactly
     the reason those answers say, and the VM is deleted at cleanup. */
  const connectPolls: { at: number; status: number; body: string }[] = []
  page.on('response', response => {
    const path = new URL(response.url()).pathname
    if (!/\/connected-providers\/connect\//.test(path)) return
    void response
      .text()
      .then(body => {
        connectPolls.push({
          at: Date.now(),
          status: response.status(),
          body: body.slice(0, 400),
        })
      })
      .catch(() => undefined)
  })

  await runConnectedProvidersSequence({
    pass: leg => passedLegs.push(leg),
    cleanup: async () => {
      await artifacts.writeJson('connected-providers.json', {
        passedLegs,
        planSessionId,
        fallbackSessionId,
        provider: 'openai-codex',
        finalCardState: await providerRow.getAttribute('data-provider-state').catch(() => null),
        connectPolls: connectPolls.slice(-40),
      })
      await assertNoOAuthTokenArtifacts(artifacts.directory)
    },
    actions: {
      'card-connect': async () => {
        progress('connected-providers:card-connect')
        await providerRow.getByRole('button', { name: 'Connect', exact: true }).click()
      },
      'device-code-shown': async () => {
        progress('connected-providers:device-code-shown')
        const userCode = providerRow.locator('code')
        await userCode.waitFor({ timeout: 60_000 })
        assert.notEqual((await userCode.textContent())?.trim() ?? '', '')
        const verificationLink = providerRow.locator('a[target="_blank"]')
        await verificationLink.waitFor()
        assert.match((await verificationLink.getAttribute('href')) ?? '', /^https:\/\//)
      },
      'connected-by-label': async () => {
        progress('connected-providers:connected-by-label')
        await waitForProviderState(providerRow, 'connected', 180_000)
        await providerRow.getByText(/Connected by /i).waitFor()
      },
      'plan-covered-session': async () => {
        progress('connected-providers:plan-covered-session')
        generationsBeforePlan = new Set(
          (await listGatewayGenerations(convex, env.internalKey, workspace._id)).map(row =>
            String(row._id),
          ),
        )
        planSessionId = await createJourneySession({
          env,
          workspace,
          apiToken,
          runId,
          ledger,
          convex,
          artifacts,
          label: 'plan-covered',
          prompt: 'Reply with exactly: ok',
        })
        const history = await waitForTerminalHistory(env, workspace.slug, planSessionId, apiToken)
        assertUsageRow(history, 'openai-codex', 'plan-covered', true)
        const after = await listGatewayGenerations(convex, env.internalKey, workspace._id)
        assert.equal(
          after.filter(row => !generationsBeforePlan.has(String(row._id))).length,
          0,
          'plan-covered session created a model-gateway generation ledger entry',
        )
      },
      'quota-fallback': async () => {
        progress('connected-providers:quota-fallback')
        // The hosted issuer is stateless: quota is a time boundary carried by
        // the access token, so wait past that boundary after proving coverage.
        await Bun.sleep(FAKE_OAUTH_ISSUER_QUOTA_AFTER_MS + 1_000)
        fallbackSessionId = await createJourneySession({
          env,
          workspace,
          apiToken,
          runId,
          ledger,
          convex,
          artifacts,
          label: 'quota-fallback',
          prompt: 'Reply with exactly: fallback-ok',
        })
        const stream = await readEventStream(
          `${env.apiUrl}/v1/ws/${workspace.slug}/agent/sessions/${fallbackSessionId}/events`,
          apiToken,
          undefined,
          300_000,
        )
        assert(stream.terminal, 'quota fallback session did not reach a terminal event')
        const notices = stream.frames.filter(frame => {
          const event = frame.event
          return (
            event.type === 'system' &&
            typeof event.message === 'string' &&
            /ChatGPT plan limit hit.*Duet credits/i.test(event.message)
          )
        })
        assert.equal(notices.length, 1, 'quota fallback did not emit exactly one system notice')
        const history = await loadHistory(env, workspace.slug, fallbackSessionId, apiToken)
        assertUsageRow(history, 'duet-gateway', 'metered', false)
        await waitForNewGatewayGeneration(
          convex,
          env.internalKey,
          workspace._id,
          generationsBeforePlan,
        )
      },
      disconnect: async () => {
        progress('connected-providers:disconnect')
        await providerRow.getByRole('button', { name: 'Disconnect', exact: true }).click()
        await waitForProviderState(providerRow, 'disconnected', 60_000)
      },
      'reprovision-preserves-connection': async () => {
        progress('connected-providers:reprovision-preserves-connection')
        await providerRow.getByRole('button', { name: 'Connect', exact: true }).click()
        await waitForProviderState(providerRow, 'connected', 180_000)
        await apiJson(
          `${env.apiUrl}/v1/ws/${workspace.slug}/reprovision`,
          { method: 'POST', headers: bearer(apiToken) },
          202,
          'connected-provider connection-preserving reprovision',
          artifacts,
        )
        await waitForWorkspace(
          convex,
          env.internalKey,
          workspace._id,
          row =>
            row.status === 'active' &&
            row.vmName !== undefined &&
            row.vmName !== workspace.vmName &&
            row.lastHeartbeatAt !== undefined &&
            (workspace.lastHeartbeatAt === undefined ||
              row.lastHeartbeatAt > workspace.lastHeartbeatAt),
        )
        markExpectedBrowserTransition(page)
        await navigateDeployedPage(page, settingsUrl)
        await waitForProviderState(providerRow, 'connected', 60_000)
      },
    },
  })

  return { passedLegs, planSessionId, fallbackSessionId }
}

export async function runConnectedProvidersPageSmoke(args: {
  env: Pick<LiveEnv, 'appUrl'>
  page: Page
  workspace: Workspace
  progress(stage: string): void
}): Promise<void> {
  args.progress('connected-providers:page')
  const settingsUrl = `${args.env.appUrl}/w/${args.workspace.slug}/settings/connected-providers`
  const providerRow = args.page.locator('[data-provider="openai-codex"]')
  markExpectedBrowserTransition(args.page)
  await navigateDeployedPage(args.page, settingsUrl)
  await providerRow.waitFor()
  assert.equal(await providerRow.getAttribute('data-provider-state'), 'disconnected')
}

export function assertConnectedProvidersStagingPreflight(
  env: Pick<LiveEnv, 'fakeOAuthIssuerUrl' | 'apiUrl' | 'appUrl'>,
  source: NodeJS.ProcessEnv,
): void {
  for (const [name, value] of [
    ['DUET_CONNECT_FAKE_ISSUER_URL', env.fakeOAuthIssuerUrl],
    ['DUET_API_URL', env.apiUrl],
    ['DUET_APP_URL', env.appUrl],
  ] as const) {
    if (!new URL(value).hostname.includes('staging')) {
      throw new Error(`${name} must target staging for the connected-provider journey`)
    }
  }
  if (
    source.DUET_CONNECT_FAKE_ISSUER_URL !== undefined &&
    [source.DUET_API_URL, source.DUET_APP_URL].some(value =>
      value === undefined ? false : !new URL(value).hostname.includes('staging'),
    )
  ) {
    throw new Error('DUET_CONNECT_FAKE_ISSUER_URL must be absent from production')
  }
}

export async function assertNoOAuthTokenArtifacts(directory: string): Promise<void> {
  await assertNoCredentialArtifacts(directory)
}

async function createJourneySession(args: {
  env: Pick<LiveEnv, 'apiUrl' | 'appUrl' | 'internalKey' | 'fakeOAuthIssuerUrl'>
  workspace: Workspace
  apiToken: string
  runId: string
  ledger: StagingResourceLedger
  convex: ConvexHttpClient
  artifacts: StagingArtifactCollector
  label: string
  prompt: string
}): Promise<string> {
  const created = await apiJson<{ session: { sessionId: string } }>(
    `${args.env.apiUrl}/v1/ws/${args.workspace.slug}/agent/sessions`,
    {
      method: 'POST',
      headers: bearerJson(args.apiToken),
      body: JSON.stringify({ prompt: args.prompt }),
    },
    201,
    `connected-provider ${args.label} session`,
    args.artifacts,
  )
  const sessionId = created.session.sessionId
  args.ledger.record({
    kind: 'session',
    id: sessionId,
    label: `${args.runId}:connected-provider-${args.label}:${sessionId}`,
    cleanup: async () =>
      await deleteStagingSession(args.env, args.workspace.slug, sessionId, args.apiToken),
    verify: async () =>
      await workspaceIsDeleted(args.convex, args.env.internalKey, args.workspace._id),
  })
  return sessionId
}

async function loadHistory(
  env: Pick<LiveEnv, 'apiUrl' | 'appUrl' | 'internalKey' | 'fakeOAuthIssuerUrl'>,
  workspaceSlug: string,
  sessionId: string,
  apiToken: string,
): Promise<ChronologicalSessionHistory> {
  return await loadChronologicalSessionHistory(
    `${env.apiUrl}/v1/ws/${workspaceSlug}/agent/sessions/${sessionId}/history`,
    apiToken,
    'connected-provider session history',
  )
}

async function waitForTerminalHistory(
  env: Pick<LiveEnv, 'apiUrl' | 'appUrl' | 'internalKey' | 'fakeOAuthIssuerUrl'>,
  workspaceSlug: string,
  sessionId: string,
  apiToken: string,
): Promise<ChronologicalSessionHistory> {
  const deadline = Date.now() + 300_000
  for (;;) {
    const history = await loadHistory(env, workspaceSlug, sessionId, apiToken)
    if (
      history.events.some(row =>
        ['complete', 'ask', 'interrupted', 'sleep'].includes(row.event.type),
      )
    ) {
      return history
    }
    if (Date.now() >= deadline) throw new Error('connected-provider session did not terminate')
    await Bun.sleep(1_000)
  }
}

function assertUsageRow(
  history: ChronologicalSessionHistory,
  provider: 'openai-codex' | 'duet-gateway',
  billing: 'plan-covered' | 'metered',
  zeroCost: boolean,
): void {
  const terminal = [...history.events]
    .reverse()
    .find(
      row =>
        isKnownTimelineEvent(row.event) &&
        ['complete', 'ask', 'interrupted', 'sleep'].includes(row.event.type),
    )?.event
  assert(
    terminal && isKnownTimelineEvent(terminal) && 'usageByModel' in terminal,
    'terminal event omitted model usage',
  )
  const rows = terminal.usageByModel ?? []
  const row = rows.find(
    candidate =>
      candidate.transport.provider === provider && candidate.transport.billing === billing,
  )
  assert(row !== undefined, `missing ${provider}/${billing} usage row`)
  if (zeroCost) assert.equal(row.usage.cost.total, 0, 'plan-covered usage was not $0')
  else assert(row.usage.cost.total > 0, 'metered fallback usage did not carry cost')
}

async function listGatewayGenerations(
  convex: ConvexHttpClient,
  internalKey: string,
  workspaceId: string,
): Promise<Array<Record<string, unknown>>> {
  return (await convex.query(fnQuery('testing/modelGateway:listGenerationsForTest'), {
    internalKey,
    workspaceId,
  })) as Array<Record<string, unknown>>
}

async function waitForNewGatewayGeneration(
  convex: ConvexHttpClient,
  internalKey: string,
  workspaceId: string,
  before: Set<string>,
): Promise<void> {
  const deadline = Date.now() + 300_000
  for (;;) {
    const rows = await listGatewayGenerations(convex, internalKey, workspaceId)
    if (rows.some(row => !before.has(String(row._id)))) return
    if (Date.now() >= deadline) throw new Error('metered fallback created no gateway generation')
    await Bun.sleep(2_000)
  }
}

async function waitForProviderState(
  row: ReturnType<Page['locator']>,
  state: string,
  timeout = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeout
  for (;;) {
    const observed = await row.getAttribute('data-provider-state')
    if (observed === state) return
    if (Date.now() >= deadline) {
      throw new Error(`provider card did not reach ${state}; it is ${observed ?? 'absent'}`)
    }
    await Bun.sleep(250)
  }
}

/**
 * Focused-journey wrapper (staging-live-selection). Unlike the full run —
 * where these legs self-skip until the fake issuer is provisioned — an
 * explicit `--journey connected-providers` demands the issuer: absence is
 * a hard, named error rather than a silent skip.
 */
export async function runConnectedProvidersJourney(
  options: { onProgress?: (stage: string) => void } = {},
): Promise<WorkspaceBrowserJourneyResult<ConnectedProvidersAcceptanceResult>> {
  const fakeOAuthIssuerUrl = process.env.DUET_CONNECT_FAKE_ISSUER_URL?.trim() ?? ''
  if (fakeOAuthIssuerUrl === '') {
    throw new Error(
      'connected-providers journey requires DUET_CONNECT_FAKE_ISSUER_URL ' +
        '(and DUET_ENABLE_FAKE_OAUTH_ISSUER=1 on the staging api) — ' +
        'provision the fake issuer before running this journey focused',
    )
  }
  return await runWorkspaceBrowserJourney({
    journey: 'connected-providers',
    label: 'Connected Providers',
    onProgress: options.onProgress,
    run: async context => {
      const env = { ...context.env, fakeOAuthIssuerUrl }
      await runConnectedProvidersPageSmoke({
        env,
        page: context.page,
        workspace: context.workspace,
        progress: context.progress,
      })
      return await runConnectedProvidersOAuthAcceptance({
        env,
        page: context.page,
        apiToken: context.apiToken,
        workspace: context.workspace,
        runId: context.runId,
        ledger: context.ledger,
        convex: context.convex,
        artifacts: context.artifacts,
        progress: context.progress,
      })
    },
  })
}
