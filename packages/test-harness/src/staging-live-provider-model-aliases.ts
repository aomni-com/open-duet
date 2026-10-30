import assert from 'node:assert/strict'

import {
  PROVIDER_MODEL_ALIASES,
  PROVIDER_MODEL_ALIAS_IDS,
  SessionCreateResponseSchema,
  WhoamiResponseSchema,
  type ProviderModelAliasId,
} from '@repo/contract'

import { provisionStagingAgent } from './staging-live-agent-fixture'
import {
  deleteStagingSession,
  loadSessionHistory,
  loadSessionSnapshot,
} from './staging-live-agent-sessions'
import { markExpectedBrowserTransition, navigateDeployedPage } from './staging-live-browser'
import { fnQuery } from './staging-live-env'
import { apiJson, bearer, bearerJson } from './staging-live-http'
import {
  inspectAliasGenerations,
  inspectAliasHistory,
  inspectAliasRoutingArtifact,
} from './staging-live-provider-model-aliases-evidence'
import { workspaceIsDeleted } from './staging-live-resource-ledger'
import { readAnnouncedRuntime } from './staging-live-runtime'
import { listGenerations, readTurnToTerminal } from './staging-live-virtual-model-tiers'
import {
  runWorkspaceBrowserJourney,
  type WorkspaceBrowserJourneyContext,
} from './staging-live-workspace-browser'

export async function runProviderModelAliasesJourney(
  options: { onProgress?: (stage: string) => void } = {},
) {
  return await runWorkspaceBrowserJourney({
    journey: 'provider-model-aliases',
    label: 'Provider Model Aliases',
    onProgress: options.onProgress,
    run: runProviderModelAliasesAcceptance,
  })
}

export async function runProviderModelAliasesAcceptance(
  context: WorkspaceBrowserJourneyContext,
  aliases: readonly [ProviderModelAliasId, ...ProviderModelAliasId[]] = PROVIDER_MODEL_ALIAS_IDS,
) {
  const { env, page, workspace, apiToken, artifacts, ledger, convex, runId, progress } = context
  const base = `${env.apiUrl}/v1/ws/${workspace.slug}`
  const initialAlias = aliases[0]
  const initialLabel = PROVIDER_MODEL_ALIASES[initialAlias].label
  const settingsUrl = `${env.appUrl}/w/${workspace.slug}/settings/general`
  progress('provider-model-aliases:workspace-default')
  markExpectedBrowserTransition(page)
  await navigateDeployedPage(page, settingsUrl)
  const card = page.locator('[data-default-tier-card]')
  await card.getByRole('button').click()
  await page.getByRole('menuitem', { name: 'Advanced', exact: true }).hover()
  const [saved] = await Promise.all([
    page.waitForResponse(
      response =>
        new URL(response.url()).pathname === `/api/duet/ws/${workspace.slug}/default-model` &&
        response.request().method() === 'PUT',
    ),
    page.getByRole('menuitemradio', { name: new RegExp(`^${initialLabel}`) }).click(),
  ])
  assert.equal(saved.status(), 200, 'workspace alias selection was not saved')
  markExpectedBrowserTransition(page)
  await navigateDeployedPage(page, settingsUrl)
  await card.getByRole('button', { name: new RegExp(initialLabel) }).waitFor()
  const whoami = WhoamiResponseSchema.parse(
    await apiJson(
      `${env.apiUrl}/v1/whoami`,
      { headers: bearer(apiToken) },
      200,
      'saved alias default',
      artifacts,
    ),
  )
  assert.equal(
    whoami.workspaces.find(row => row.id === workspace._id)?.defaultTier.configured,
    initialAlias,
  )

  const anchorPath = `agents/alias-probe-${runId.slice(-6)}`
  const agent = await provisionStagingAgent({
    ...context,
    slug: `alias-probe-${runId.slice(-6)}`,
    name: 'Alias probe',
    description: 'For this acceptance task, answer the user directly without tools or delegation.',
    anchorPath,
  })
  const prompt = 'Reply with exactly ALIAS_OK. Do not use tools, delegate, or create tasks.'
  let before = new Set((await listGenerations(context)).map(row => row._id))
  const created = SessionCreateResponseSchema.parse(
    await apiJson(
      `${base}/agent/sessions`,
      {
        method: 'POST',
        headers: bearerJson(apiToken),
        body: JSON.stringify({ cwd: anchorPath, prompt }),
      },
      201,
      'create alias-inheriting conversation',
      artifacts,
    ),
  )
  const sessionId = created.session.sessionId
  ledger.record({
    kind: 'session',
    id: sessionId,
    label: `${runId}:aliases:${sessionId}`,
    cleanup: async () => await deleteStagingSession(env, workspace.slug, sessionId, apiToken),
    verify: async () => await workspaceIsDeleted(convex, env.internalKey, workspace._id),
  })
  assert.equal(
    created.snapshot.tier,
    initialAlias,
    'new conversation did not inherit workspace alias',
  )
  assert.equal(created.snapshot.agent?.id, agent.id, 'conversation did not use nested agent')
  const eventsUrl = `${base}/agent/sessions/${sessionId}/events`
  let cursor: number | undefined
  const turns = []
  let priorHistory: Awaited<ReturnType<typeof loadSessionHistory>>['events'] = []
  // The repeated final alias exercises restoring a saved choice without sending a tier override.
  for (const [index, alias] of [...aliases, aliases[aliases.length - 1]!].entries()) {
    progress(`provider-model-aliases:turn-${index + 1}:${alias}`)
    if (index > 0) {
      before = new Set((await listGenerations(context)).map(row => row._id))
      await apiJson(
        `${base}/agent/sessions/${sessionId}/messages`,
        {
          method: 'POST',
          headers: bearerJson(apiToken),
          body: JSON.stringify({
            prompt,
            ...(index === aliases.length ? {} : { tier: alias }),
          }),
        },
        202,
        'resume alias conversation',
        artifacts,
      )
    }
    const stream = await readTurnToTerminal(eventsUrl, apiToken, cursor, 900_000)
    const terminal = stream.frames.find(frame => frame.event.type === 'complete')
    assert.equal(
      terminal?.event.status,
      'completed',
      `${alias} turn failed: ${String(terminal?.event.error ?? 'no completion')}`,
    )
    assert(stream.lastId !== undefined, 'completed alias turn omitted event cursor')
    cursor = stream.lastId
    const snapshot = await loadSessionSnapshot(env, workspace.slug, sessionId, apiToken)
    assert.equal(snapshot.tier, alias, 'saved alias changed during execution')
    const history = await loadSessionHistory(env, workspace.slug, sessionId, apiToken)
    inspectAliasHistory(priorHistory, history.events, prompt)
    priorHistory = history.events
    turns.push({ alias, ...(await waitForAliasSettlement(context, alias, before)) })
  }

  progress('provider-model-aliases:runtime-artifact')
  const runtime = await inspectRuntime(context, anchorPath)
  markExpectedBrowserTransition(page)
  await navigateDeployedPage(page, `${env.appUrl}/w/${workspace.slug}/sessions/${sessionId}`)
  await page
    .getByRole('button', {
      name: `Quality: ${PROVIDER_MODEL_ALIASES[aliases[aliases.length - 1]!].label}`,
    })
    .waitFor()

  progress('provider-model-aliases:ordinary-router')
  await apiJson(
    `${base}/agent/sessions/${sessionId}/messages`,
    {
      method: 'POST',
      headers: bearerJson(apiToken),
      body: JSON.stringify({ prompt, tier: 'balanced' }),
    },
    202,
    'return to ordinary router',
    artifacts,
  )
  const routerStream = await readTurnToTerminal(eventsUrl, apiToken, cursor, 900_000)
  assert.equal(
    routerStream.frames.find(frame => frame.event.type === 'complete')?.event.status,
    'completed',
    'ordinary router turn failed',
  )
  assert.equal(
    (await loadSessionSnapshot(env, workspace.slug, sessionId, apiToken)).tier,
    'balanced',
  )
  const evidence = {
    sessionId,
    workspaceDefault: initialAlias,
    preservedHistoryRows: priorHistory.length,
    anchorPath,
    runtime,
    turns,
    restoredRouter: 'balanced',
  }
  await artifacts.writeJson('provider-model-aliases.json', evidence)
  return evidence
}

async function waitForAliasSettlement(
  context: WorkspaceBrowserJourneyContext,
  alias: ProviderModelAliasId,
  before: Set<string>,
) {
  const deadline = Date.now() + 300_000
  for (;;) {
    const [rows, transactions] = await Promise.all([
      listGenerations(context),
      context.convex.query(fnQuery('testing/credits:listWorkspaceTransactionsForTest'), {
        internalKey: context.env.internalKey,
        workspaceId: context.workspace._id,
      }) as Promise<Record<string, unknown>[]>,
    ])
    const evidence = inspectAliasGenerations(
      alias,
      rows.filter(row => !before.has(row._id)),
      transactions,
    )
    if (evidence) return evidence
    assert(Date.now() < deadline, `timed out waiting for ${alias} execution settlement and debit`)
    await Bun.sleep(2_000)
  }
}

async function inspectRuntime(context: WorkspaceBrowserJourneyContext, anchorPath: string) {
  const { env, workspace, convex, artifacts } = context
  const connection = (await convex.query(
    fnQuery('domains/workspaces/provisioning:gatewayConnectionBySlug'),
    { internalKey: env.internalKey, slug: workspace.slug },
  )) as { vmToken: string; httpsUrl: string } | null
  assert(connection?.vmToken, 'runtime inspection requires the existing gateway connection')
  const manifest = await readAnnouncedRuntime({
    apiUrl: env.apiUrl,
    vmToken: connection.vmToken,
    artifacts,
    label: 'announced alias runtime',
  })
  const health = await apiJson<{ runtimeVersion: string }>(
    `${connection.httpsUrl.replace(/\/+$/, '')}/health`,
    { headers: bearer(connection.vmToken) },
    200,
    'active alias gateway process',
    artifacts,
  )
  assert.equal(
    health.runtimeVersion,
    manifest.version,
    'running runtime is not the announced inventory',
  )
  const configPath = `${anchorPath}/.duet/models.json`
  const fileUrl = new URL(`${connection.httpsUrl.replace(/\/+$/, '')}/v1/internal-admin/file`)
  fileUrl.searchParams.set('path', configPath)
  const file = await apiJson<{ path: string; content: string; truncated: boolean }>(
    fileUrl.toString(),
    { headers: bearer(connection.vmToken) },
    200,
    'nested managed alias routing file',
    artifacts,
  )
  assert.equal(file.truncated, false, 'managed routing evidence was truncated')
  assert.equal(file.path, configPath, 'gateway read a different routing file')
  const routing: unknown = JSON.parse(file.content)
  inspectAliasRoutingArtifact(routing)
  // Health proves the running process; the announced manifest identifies its release.
  // The existing bounded file reader proves the nested materialization, not /opt bytes.
  return {
    runtimeVersion: health.runtimeVersion,
    duetArtifact: manifest.artifacts.find(artifact => artifact.name === 'duet')!,
    cwd: anchorPath,
    configPath,
    routing,
  }
}
