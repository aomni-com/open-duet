import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

import {
  MarketplaceAgentSubscriptionResponseSchema,
  SessionCreateResponseSchema,
} from '@repo/contract'
import { shellQuote } from '@repo/exe'
import { loadOfficialSeedFiles } from '@repo/official-agents-seed'

import { provisionStagingAgent } from './staging-live-agent-fixture'
import { deleteStagingSession } from './staging-live-agent-sessions'
import { apiJson, apiText, bearer, bearerJson } from './staging-live-http'
import {
  inspectModelRefreshProbe,
  MODEL_REFRESH_MEDIA,
} from './staging-live-model-refresh-evidence'
import { loadAllMarketplaceCatalog } from './staging-live-pagination'
import { runProviderModelAliasesAcceptance } from './staging-live-provider-model-aliases'
import { workspaceIsDeleted } from './staging-live-resource-ledger'
import { listGenerations, readTurnToTerminal } from './staging-live-virtual-model-tiers'
import {
  runWorkspaceBrowserJourney,
  type WorkspaceBrowserJourneyContext,
} from './staging-live-workspace-browser'

export async function runModelRefreshJourney(
  options: { onProgress?: (stage: string) => void } = {},
) {
  return await runWorkspaceBrowserJourney({
    journey: 'model-refresh',
    label: 'Model refresh',
    onProgress: options.onProgress,
    run: runModelRefreshAcceptance,
  })
}

async function runModelRefreshAcceptance(context: WorkspaceBrowserJourneyContext) {
  const { env, apiToken, workspace, artifacts, progress } = context
  const base = `${env.apiUrl}/v1/ws/${workspace.slug}`
  const aliases = await runProviderModelAliasesAcceptance(context, ['openai-max', 'anthropic-max'])
  progress('model-refresh:subscriber-content')
  const catalog = await loadAllMarketplaceCatalog(
    `${env.apiUrl}/v1/marketplace`,
    apiToken,
    'model refresh official catalog',
    artifacts,
  )
  const content = []
  for (const [agentName, app] of [
    ['writer', 'setup-voice'],
    ['brand-designer', 'setup-brand'],
  ] as const) {
    const target = catalog.items.find(
      row =>
        row.verifiedPublisher && row.agentName === agentName && row.availability === 'available',
    )
    assert(target, `${agentName} official listing unavailable; sync the hub before acceptance`)
    const installed = MarketplaceAgentSubscriptionResponseSchema.parse(
      await apiJson(
        `${base}/marketplace/subscriptions`,
        {
          method: 'POST',
          headers: bearerJson(apiToken),
          body: JSON.stringify({ listingId: target.id, name: `Refresh ${agentName}` }),
        },
        201,
        `install refreshed ${agentName}`,
        artifacts,
      ),
    )
    // Workspace teardown owns subscriptions and their installed bytes, including failed installs.
    const filePath = `${installed.subscription.path}/apps/${app}/duet.ts`
    const received = await apiText(
      `${base}/files/${encodeURI(filePath)}`,
      { headers: bearer(apiToken) },
      200,
      `${agentName} subscriber bytes`,
      artifacts,
    )
    const expected = loadOfficialSeedFiles().find(
      file => file.path === `agents/${agentName}/apps/${app}/duet.ts`,
    )
    assert(expected, 'missing generated official app fixture')
    const sha256 = createHash('sha256').update(received).digest('hex')
    assert.equal(sha256, expected.sha256, `${agentName} subscriber has stale generated content`)
    content.push({ listingId: target.id, path: filePath, sha256 })
  }

  progress('model-refresh:installed-cli-probes')
  const probePath = `agents/model-refresh-${context.runId.slice(-6)}`
  await provisionStagingAgent({
    ...context,
    slug: `model-refresh-${context.runId.slice(-6)}`,
    name: 'Model refresh CLI probe',
    anchorPath: probePath,
    description:
      'Execute the exact acceptance script provided by the user once. Do not edit, repeat, delegate, or substitute its checks.',
  })
  const skill = await Bun.file(
    new URL('../../skills-registry/skills/build-apps/SKILL.md', import.meta.url),
  ).text()
  const config = {
    roles: MODEL_REFRESH_MEDIA,
    runtimeVersion: aliases.runtime.runtimeVersion,
    duetArtifact: aliases.runtime.duetArtifact,
    skillHash: createHash('sha256')
      .update(skill.replaceAll('{{APP_URL}}', env.appUrl))
      .digest('hex'),
  }
  const source = await Bun.file(
    new URL('./fixtures/model-refresh/probe.ts', import.meta.url),
  ).text()
  await apiText(
    `${base}/files/${probePath}/model-refresh-probe.ts`,
    {
      method: 'PUT',
      headers: bearer(apiToken, { 'content-type': 'text/plain' }),
      body: source,
    },
    200,
    'write bounded CLI probe',
    artifacts,
  )
  const before = new Set((await listGenerations(context)).map(row => row._id))
  const created = SessionCreateResponseSchema.parse(
    await apiJson(
      `${base}/agent/sessions`,
      {
        method: 'POST',
        headers: bearerJson(apiToken),
        body: JSON.stringify({
          cwd: probePath,
          tier: 'balanced',
          prompt: `Run exactly this command once from your current directory, with a foreground wait budget of 2400 seconds: bun ./model-refresh-probe.ts ${shellQuote(JSON.stringify(config))}. Do not edit the script, rerun it, delegate it, or substitute your own checks. After it exits report its exit status. The script intentionally performs a fixed set of paid model acceptance calls.`,
        }),
      },
      201,
      'execute installed CLI acceptance',
      artifacts,
    ),
  )
  const sessionId = created.session.sessionId
  context.ledger.record({
    kind: 'session',
    id: sessionId,
    label: `${context.runId}:model-refresh:${sessionId}`,
    cleanup: async () => await deleteStagingSession(env, workspace.slug, sessionId, apiToken),
    verify: async () => await workspaceIsDeleted(context.convex, env.internalKey, workspace._id),
  })
  const stream = await readTurnToTerminal(
    `${base}/agent/sessions/${sessionId}/events`,
    apiToken,
    undefined,
    2_500_000,
  )
  const raw = await apiText(
    `${base}/files/${probePath}/model-refresh-receipt.json`,
    { headers: bearer(apiToken) },
    200,
    'read CLI acceptance receipt',
    artifacts,
  )
  const probe = JSON.parse(raw)
  await artifacts.writeJson('model-refresh-cli.json', probe)
  inspectModelRefreshProbe(probe)
  assert.equal(
    stream.frames.find(frame => frame.event.type === 'complete')?.event.status,
    'completed',
    'probe execution session failed',
  )
  const generations = await waitForProbeGenerations(context, before)
  const executed = new Set(aliases.turns.flatMap(turn => turn.execution.map(row => row.id)))
  const chatCosts = (await listGenerations(context))
    .filter(row => executed.has(row._id))
    .map(row => {
      assert(typeof row.upstreamCostMicroUsd === 'number', 'missing upstream chat cost telemetry')
      return {
        id: row._id,
        model: row.model,
        upstreamCostMicroUsd: row.upstreamCostMicroUsd,
        billedCostMicroUsd: row.billedCostMicroUsd,
      }
    })
  assert.equal(chatCosts.length, executed.size, 'missing refreshed chat generation cost receipts')
  const evidence = {
    aliases,
    runtimeVersion: aliases.runtime.runtimeVersion,
    duetArtifact: aliases.runtime.duetArtifact,
    content,
    probe,
    generations,
    chatCosts,
    preservedHistoryRows: aliases.preservedHistoryRows,
  }
  await artifacts.writeJson('model-refresh.json', evidence)
  return evidence
}

async function waitForProbeGenerations(
  context: WorkspaceBrowserJourneyContext,
  before: Set<string>,
) {
  const models: string[] = [...new Set(Object.values(MODEL_REFRESH_MEDIA))].filter(
    model => model !== MODEL_REFRESH_MEDIA.video,
  )
  models.push('openai/gpt-6-luna', 'spacexai/grok-4.7', 'zai/glm-5.3')
  const deadline = Date.now() + 300_000
  for (;;) {
    const rows = (await listGenerations(context)).filter(row => !before.has(row._id))
    assert(
      !rows.some(row => /gpt-5\.[46]|claude-opus-5$/.test(String(row.model))),
      'retired model dispatched after convergence',
    )
    if (
      models.every(model =>
        rows.some(
          row =>
            row.model === model &&
            row.status === 'settled' &&
            typeof row.upstreamCostMicroUsd === 'number',
        ),
      )
    ) {
      return rows.map(row => ({
        id: row._id,
        model: row.model,
        tier: row.tier,
        status: row.status,
        upstreamCostMicroUsd: row.upstreamCostMicroUsd,
        billedCostMicroUsd: row.billedCostMicroUsd,
      }))
    }
    assert(
      Date.now() < deadline,
      `model refresh settlement incomplete: ${models.filter(model => !rows.some(row => row.model === model && row.status === 'settled')).join(', ')}`,
    )
    await Bun.sleep(2_000)
  }
}
