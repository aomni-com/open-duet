import assert from 'node:assert/strict'
import path from 'node:path'

import {
  MODEL_TIERS,
  ModelTierIdSchema,
  WhoamiResponseSchema,
  WorkspaceDefaultModelResponseSchema,
  X_DUET_TIER_HEADER,
  tierBillsAtFlatRate,
  type ModelTierId,
} from '@repo/contract'

import { deleteStagingSession } from './staging-live-agent-sessions.ts'
import { markExpectedBrowserTransition, navigateDeployedPage } from './staging-live-browser.ts'
import { fnQuery } from './staging-live-env.ts'
import {
  apiJson,
  bearer,
  bearerJson,
  stagingFetch,
  vercelBypassHeaders,
} from './staging-live-http.ts'
import { workspaceIsDeleted } from './staging-live-resource-ledger.ts'
import { type ParsedSseFrame, readEventStream, waitForWorkspace } from './staging-live-streaming.ts'
import {
  runWorkspaceBrowserJourney,
  type WorkspaceBrowserJourneyContext,
  type WorkspaceBrowserJourneyResult,
} from './staging-live-workspace-browser.ts'

const GENERATION_WAIT_MS = 300_000
// One SSE connection cannot outlive the load balancer, which kills a held
// connection around 255s — and a fresh VM's first turn routinely starts LATER
// than that (measured 250,896ms of `startedInMs` on 2026-07-31, with the POST
// returning 200 after 251,405ms). Holding one socket for the whole turn is a
// coin flip against the cold floor, so each leg stays well under the kill and
// the read resumes across as many legs as the overall budget allows.
const SSE_LEG_MS = 120_000
const TURN_WAIT_MS = 900_000
const POLL_MS = 2_000

/** What the public pricing cards name, in the copy the lander ships. */
const PUBLIC_PLAN_NAMES = ['Starter', 'Pro', 'Max'] as const

type TokenUsage = {
  uncachedInputTokens: number
  cachedInputTokens: number
  outputTokens: number
}

type SettledGeneration = {
  id: string
  model: string
  tier: ModelTierId
  upstreamGenerationId: string
  billedCostMicroUsd: number
  upstreamCostMicroUsd: number
  usage: TokenUsage
  debitMicroUsd: number
}

export interface VirtualModelTiersEvidence {
  versions: {
    runtime: string
  }
  defaultTier: {
    /** Plan-dependent (starter/pro/max -> balanced/balanced/frontier). */
    before: string
    configured: 'balanced'
    effective: 'balanced'
  }
  standard: SettledGeneration & {
    independentlyComputedMicroUsd: number
  }
  max: Pick<SettledGeneration, 'id' | 'model' | 'tier'>
  /** A model outside the claimed tier's closure runs, billed at its upstream cost. */
  outOfTierModel: Pick<
    SettledGeneration,
    'id' | 'model' | 'tier' | 'billedCostMicroUsd' | 'upstreamCostMicroUsd' | 'debitMicroUsd'
  > & { status: 200 }
  screenshots: string[]
}

export async function runVirtualModelTiersJourney(
  options: { onProgress?: (stage: string) => void } = {},
): Promise<WorkspaceBrowserJourneyResult<VirtualModelTiersEvidence>> {
  return await runWorkspaceBrowserJourney({
    journey: 'virtual-model-tiers',
    label: 'Virtual Model Tiers',
    onProgress: options.onProgress,
    run: async context => await runVirtualModelTiersAcceptance(context),
  })
}

/** A short same-conversation regression for tier selection surviving restoration. */
export async function runTierRestorationJourney(
  options: { onProgress?: (stage: string) => void } = {},
): Promise<WorkspaceBrowserJourneyResult<{ sessionId: string; turns: SettledGeneration[] }>> {
  return await runWorkspaceBrowserJourney({
    journey: 'tier-restoration',
    label: 'Tier Restoration',
    onProgress: options.onProgress,
    run: runTierRestorationAcceptance,
  })
}

export async function runTierRestorationAcceptance(
  context: WorkspaceBrowserJourneyContext,
): Promise<{ sessionId: string; turns: SettledGeneration[] }> {
  const { env, workspace, apiToken, runId, ledger, convex, artifacts, progress } = context
  const base = `${env.apiUrl}/v1/ws/${workspace.slug}/agent/sessions`
  const marker = `remember-${crypto.randomUUID().slice(0, 8)}`
  let before = await generationIds(context)
  const created = await apiJson<{ session: { sessionId: string } }>(
    base,
    {
      method: 'POST',
      headers: bearerJson(apiToken),
      body: JSON.stringify({
        tier: 'frontier',
        prompt: `Remember this marker for later: ${marker}. Reply with only that marker. Do not use tools.`,
      }),
    },
    201,
    'create Frontier conversation',
    artifacts,
  )
  const sessionId = created.session.sessionId
  ledger.record({
    kind: 'session',
    id: sessionId,
    label: `${runId}:tier-restoration:${sessionId}`,
    cleanup: async () => await deleteStagingSession(env, workspace.slug, sessionId, apiToken),
    verify: async () => await workspaceIsDeleted(convex, env.internalKey, workspace._id),
  })
  const turns: SettledGeneration[] = []
  let cursor: number | undefined
  // Every terminal destroys its runner. The two follow-ups therefore exercise
  // both replacing an expensive checkpoint tier and restoring the replacement.
  for (const [index, tier] of (['frontier', 'balanced', 'balanced'] as const).entries()) {
    progress(`tier-restoration:turn-${index + 1}:${tier}`)
    const postedAt = Date.now()
    if (index > 0) {
      before = await generationIds(context)
      await apiJson(
        `${base}/${sessionId}/messages`,
        {
          method: 'POST',
          headers: bearerJson(apiToken),
          body: JSON.stringify({
            tier,
            prompt: 'Reply with only the marker from my first message. Do not use tools.',
          }),
        },
        202,
        `resume conversation at ${tier}`,
        artifacts,
      )
    }
    const stream = await readTurnToTerminal(
      `${base}/${sessionId}/events`,
      apiToken,
      cursor,
      TURN_WAIT_MS,
    )
    const terminal = stream.frames.find(frame => frame.event.type === 'complete')
    assert.equal(terminal?.event.status, 'completed', `${tier} turn did not complete`)
    const reply = stream.frames
      .flatMap(frame => {
        const step = frame.event.step
        return frame.event.type === 'step' && isRecord(step) && step.type === 'text'
          ? [String(step.text)]
          : []
      })
      .join('\n')
    assert(reply.includes(marker), `${tier} turn lost the original conversation marker`)
    cursor = stream.lastId
    assert(cursor !== undefined, 'completed turn omitted its event cursor')
    const generation = await waitForTierSwitch(context, before, tier, postedAt, sessionId)
    assert(tierBillsAtFlatRate(tier, generation.model), `${tier} routed outside its model set`)
    const expectedCharge = independentlyPriceTierUsageMicroUsd(
      MODEL_TIERS[tier].rates,
      generation.usage,
    )
    assert.equal(generation.billedCostMicroUsd, expectedCharge, 'wrong tier price')
    assert.equal(generation.debitMicroUsd, -expectedCharge, 'wrong ledger debit')
    turns.push(generation)
  }
  const evidence = { sessionId, turns }
  await artifacts.writeJson('tier-restoration.json', evidence)
  return evidence
}

export async function runVirtualModelTiersAcceptance(
  context: WorkspaceBrowserJourneyContext,
): Promise<VirtualModelTiersEvidence> {
  const { env, workspace, apiToken, runId, ledger, convex, artifacts, progress } = context
  const base = `${env.apiUrl}/v1/ws/${workspace.slug}`
  const landerUrl = requiredStagingUrl('DUET_LANDER_URL')
  const modelGatewayUrl = requiredStagingUrl('DUET_MODEL_GATEWAY_URL')

  progress('virtual-model-tiers:versions')
  const versionedWorkspace = await waitForWorkspace(
    convex,
    env.internalKey,
    workspace._id,
    row => row.status === 'active' && row.runtimeVersion !== undefined,
  )
  assert(versionedWorkspace.runtimeVersion !== undefined, 'active VM omitted its runtime identity')
  const versions = {
    runtime: versionedWorkspace.runtimeVersion,
  }

  progress('virtual-model-tiers:subscriber-default')
  const beforeWhoami = WhoamiResponseSchema.parse(
    await apiJson(
      `${env.apiUrl}/v1/whoami`,
      { headers: bearer(apiToken) },
      200,
      'subscriber default tier',
      artifacts,
    ),
  )
  const beforeWorkspace = beforeWhoami.workspaces.find(row => row.id === workspace._id)
  assert(beforeWorkspace !== undefined, 'subscriber workspace missing from whoami')
  // The unconfigured default depends on the fixture account's billing plan
  // (starter/pro/max -> balanced/balanced/frontier), which this journey does
  // not control. Plan-default behavior is pinned by backend tests; here we
  // only prove the subscriber wire shape, then exercise an explicit default.
  assert(
    ['frontier', 'balanced'].includes(beforeWorkspace.defaultTier.effective),
    'subscriber default tier missing from whoami',
  )

  WorkspaceDefaultModelResponseSchema.parse(
    await apiJson(
      `${base}/default-model`,
      {
        method: 'PUT',
        headers: bearerJson(apiToken),
        body: JSON.stringify({ tier: 'balanced' }),
      },
      200,
      'set Standard workspace default',
      artifacts,
    ),
  )
  const afterWhoami = WhoamiResponseSchema.parse(
    await apiJson(
      `${env.apiUrl}/v1/whoami`,
      { headers: bearer(apiToken) },
      200,
      'read Standard workspace default',
      artifacts,
    ),
  )
  const afterWorkspace = afterWhoami.workspaces.find(row => row.id === workspace._id)
  assert(afterWorkspace !== undefined, 'updated subscriber workspace missing from whoami')
  assert.equal(afterWorkspace.defaultTier.configured, 'balanced')
  assert.equal(afterWorkspace.defaultTier.effective, 'balanced')

  progress('virtual-model-tiers:standard-session')
  const generationsBeforeStandard = await generationIds(context)
  const created = await apiJson<{ session: { sessionId: string } }>(
    `${base}/agent/sessions`,
    {
      method: 'POST',
      headers: bearerJson(apiToken),
      body: JSON.stringify({
        prompt:
          'Explain in 120 to 160 words why independently verified billing arithmetic matters. ' +
          'Use plain prose and finish with the exact word verified.',
        tier: 'balanced',
      }),
    },
    201,
    'create Standard tier session',
    artifacts,
  )
  const sessionId = created.session.sessionId
  ledger.record({
    kind: 'session',
    id: sessionId,
    label: `${runId}:virtual-model-tiers:${sessionId}`,
    cleanup: async () =>
      await deleteStagingSession(env, versionedWorkspace.slug, sessionId, apiToken),
    verify: async () => await workspaceIsDeleted(convex, env.internalKey, versionedWorkspace._id),
  })

  const eventsUrl = `${base}/agent/sessions/${sessionId}/events`
  const standardStream = await readTurnToTerminal(eventsUrl, apiToken, undefined, TURN_WAIT_MS)
  if (!standardStream.terminal) {
    // A session stuck at lastEventSeq=2 (created + prompt_submitted, no agent output)
    // is the runner never producing a turn, and only the VM's own log says why.
    // Fetched before the assert so cleanup cannot reap the evidence first.
    assert.fail(
      `Standard session did not reach a terminal event; ` +
        `frames=${standardStream.frames.length} ` +
        `gatewayLog=${await tiersGatewayLog(context)}`,
    )
  }
  assert(
    standardStream.frames.some(
      frame =>
        frame.event.type === 'step' &&
        isRecord(frame.event.step) &&
        frame.event.step.type === 'text',
    ),
    // Dump what DID arrive. Reaching a terminal without a text step means
    // either the turn genuinely produced no text, or the reconnecting read
    // missed the frames that carried it — and only the event roster tells the
    // two apart.
    // `complete` carries status/error: a turn that FAILED emits exactly this
    // shape — turn_started then complete, no text step — and is indistinguishable
    // from "produced no text" unless the terminal's own status is printed.
    // The gateway log settles WHY a turn produced nothing. A 401 here has two
    // very different causes and the log distinguishes them: a
    // `spawn_model_credentials` warning means the runner was spawned with no
    // key at all (credentials had not yet arrived on a sync tick); its absence
    // means credentials were present and were REJECTED, which is a rotation or
    // scope problem instead.
    `Standard session emitted no routed text completion; gatewayLog=${await tiersGatewayLog(
      context,
    )} frames=${JSON.stringify(
      standardStream.frames.map(frame => ({
        id: frame.id,
        type: frame.event.type,
        step: isRecord(frame.event.step) ? frame.event.step.type : undefined,
        status: frame.event.status,
        error: frame.event.error,
        result:
          typeof frame.event.result === 'string' ? frame.event.result.slice(0, 200) : undefined,
      })),
    )}`,
  )
  const standard = await waitForFirstTieredGeneration(
    context,
    generationsBeforeStandard,
    'balanced',
  )
  assert(
    tierBillsAtFlatRate(standard.tier, standard.model),
    `Standard routed outside its closure: ${standard.model}`,
  )

  progress('virtual-model-tiers:standard-billing')
  const independentlyComputedMicroUsd = independentlyPriceTierUsageMicroUsd(
    MODEL_TIERS.balanced.rates,
    standard.usage,
  )
  assert.equal(
    standard.billedCostMicroUsd,
    independentlyComputedMicroUsd,
    'generation billed cost did not match independent Standard-rate arithmetic',
  )
  assert.equal(
    standard.debitMicroUsd,
    -independentlyComputedMicroUsd,
    'ledger debit did not exactly match independent Standard-rate arithmetic',
  )
  assert.notEqual(
    standard.upstreamCostMicroUsd,
    independentlyComputedMicroUsd,
    'private upstream cost unexpectedly equaled the customer tier charge',
  )

  progress('virtual-model-tiers:max-follow-up')
  const generationsBeforeMax = await generationIds(context)
  const switchPostedAt = Date.now()
  await apiJson(
    `${base}/agent/sessions/${sessionId}/messages`,
    {
      method: 'POST',
      headers: bearerJson(apiToken),
      body: JSON.stringify({
        prompt: 'Reply with one sentence confirming the tier switch.',
        tier: 'frontier',
      }),
    },
    202,
    'switch live session to Max',
    artifacts,
  )
  const maxStream = await readTurnToTerminal(
    eventsUrl,
    apiToken,
    standardStream.lastId,
    TURN_WAIT_MS,
  )
  assert(maxStream.terminal, 'Max follow-up did not reach a terminal event')
  // The follow-up must actually SUCCEED before its tier means anything. A turn
  // that terminates `failed` produces no completion of its own, and then the
  // only fresh generations are the PREVIOUS turn's trailing memory and
  // embedding work — which is attributed to the previous tier and looks
  // exactly like "the switch did not take effect". Judging tiers without this
  // check cannot tell a real regression from a failed turn.
  const maxTerminal = maxStream.frames.find(frame =>
    ['complete', 'ask', 'sleep', 'interrupted'].includes(String(frame.event.type)),
  )
  assert.equal(
    maxTerminal?.event.status ?? 'completed',
    'completed',
    `Max follow-up terminated unsuccessfully, so its tier proves nothing: ${JSON.stringify({
      type: maxTerminal?.event.type,
      status: maxTerminal?.event.status,
      error: maxTerminal?.event.error,
    })}`,
  )
  const max = await waitForTierSwitch(
    context,
    generationsBeforeMax,
    'frontier',
    switchPostedAt,
    sessionId,
  )
  assert(tierBillsAtFlatRate(max.tier, max.model), `Max routed outside its closure: ${max.model}`)

  progress('virtual-model-tiers:out-of-tier-model')
  // No model is gated on the plan or the tier: a Standard claim naming a Max-only
  // model runs, and bills that model's upstream cost instead of Standard's rate.
  const outOfTierModelId = MODEL_TIERS.frontier.closure.find(
    model => !tierBillsAtFlatRate('balanced', model),
  )
  assert(outOfTierModelId !== undefined, 'every Max model is also billed flat by Standard')
  const outOfTierBefore = await generationIds(context)
  const outOfTierResponse = await stagingFetch(`${modelGatewayUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: bearerJson(apiToken, {
      [X_DUET_TIER_HEADER]: 'balanced',
    }),
    body: JSON.stringify({
      model: outOfTierModelId,
      max_tokens: 16,
      messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
    }),
  })
  assert.equal(
    outOfTierResponse.status,
    200,
    `out-of-tier model was refused: ${await outOfTierResponse.text()}`,
  )
  await outOfTierResponse.arrayBuffer().catch(() => undefined)
  const outOfTier = await waitForSettledGeneration(
    context,
    outOfTierBefore,
    row => row.model === outOfTierModelId && row.tier === 'balanced',
  )
  assert.equal(
    outOfTier.billedCostMicroUsd,
    outOfTier.upstreamCostMicroUsd,
    'out-of-tier model did not bill its upstream cost',
  )
  assert.equal(outOfTier.debitMicroUsd, -outOfTier.upstreamCostMicroUsd, 'wrong out-of-tier debit')

  progress('virtual-model-tiers:screenshots')
  const screenshots = await captureTierScreenshots({
    context,
    sessionId,
    landerUrl,
  })

  const evidence: VirtualModelTiersEvidence = {
    versions,
    defaultTier: {
      before: beforeWorkspace.defaultTier.effective,
      configured: 'balanced',
      effective: 'balanced',
    },
    standard: { ...standard, independentlyComputedMicroUsd },
    max: { id: max.id, model: max.model, tier: max.tier },
    outOfTierModel: {
      status: 200,
      id: outOfTier.id,
      model: outOfTier.model,
      tier: outOfTier.tier,
      billedCostMicroUsd: outOfTier.billedCostMicroUsd,
      upstreamCostMicroUsd: outOfTier.upstreamCostMicroUsd,
      debitMicroUsd: outOfTier.debitMicroUsd,
    },
    screenshots,
  }
  await artifacts.writeJson('virtual-model-tiers.json', evidence)
  return evidence
}

export function independentlyPriceTierUsageMicroUsd(
  rates: {
    inputTokensPer1M: number
    outputTokensPer1M: number
    cachedInputTokensPer1M: number
  },
  usage: TokenUsage,
): number {
  const nanoPerMicro = 1_000n
  const totalNanoUsd =
    checkedTokenCount('uncachedInputTokens', usage.uncachedInputTokens) *
      rateNanoUsdPerToken(rates.inputTokensPer1M) +
    checkedTokenCount('cachedInputTokens', usage.cachedInputTokens) *
      rateNanoUsdPerToken(rates.cachedInputTokensPer1M) +
    checkedTokenCount('outputTokens', usage.outputTokens) *
      rateNanoUsdPerToken(rates.outputTokensPer1M)
  const whole = totalNanoUsd / nanoPerMicro
  const rounded = totalNanoUsd % nanoPerMicro >= nanoPerMicro / 2n ? whole + 1n : whole
  assert(rounded <= BigInt(Number.MAX_SAFE_INTEGER), 'independent tier charge overflowed')
  return Number(rounded)
}

async function captureTierScreenshots(args: {
  context: WorkspaceBrowserJourneyContext
  sessionId: string
  landerUrl: string
}): Promise<string[]> {
  const { env, page, workspace, artifacts } = args.context
  const screenshots: string[] = []
  const capture = async (name: string) => {
    await page.screenshot({ path: path.join(artifacts.directory, name), fullPage: true })
    screenshots.push(name)
  }

  markExpectedBrowserTransition(page)
  await navigateDeployedPage(page, `${env.appUrl}/w/${workspace.slug}/sessions/${args.sessionId}`)
  await page.getByRole('button', { name: 'Quality: Max' }).click()
  assert.equal(await page.getByRole('menuitemradio', { name: /^Max/ }).isChecked(), true)
  await capture('virtual-model-tiers-picker.png')
  await page.keyboard.press('Escape')

  markExpectedBrowserTransition(page)
  await navigateDeployedPage(page, `${env.appUrl}/w/${workspace.slug}/settings/general`)
  await page.getByRole('heading', { name: /default (quality|tier)/i }).waitFor()
  await page.getByText('Standard', { exact: true }).first().waitFor()
  await capture('virtual-model-tiers-settings-card.png')

  markExpectedBrowserTransition(page)
  await navigateDeployedPage(page, `${env.appUrl}/w/${workspace.slug}/settings/usage`)
  await page.locator('[data-ledger-type="usage"]').filter({ hasText: 'Standard' }).first().waitFor()
  await capture('virtual-model-tiers-usage-badges.png')

  const landerOrigin = new URL(args.landerUrl).origin
  await page.context().route(`${landerOrigin}/**`, async route => {
    await route.continue({
      headers: {
        ...route.request().headers(),
        ...vercelBypassHeaders(env.vercelBypassSecret),
      },
    })
  })
  markExpectedBrowserTransition(page)
  await navigateDeployedPage(page, `${args.landerUrl}/pricing`)
  // The plan ladder, not the tier ladder: the page states what a buyer picks
  // and what its credits buy, and never the tiers' token rates.
  for (const plan of PUBLIC_PLAN_NAMES) {
    await page.getByText(plan, { exact: true }).first().waitFor()
  }
  await capture('virtual-model-tiers-lander-pricing.png')
  return screenshots
}

async function generationIds(context: WorkspaceBrowserJourneyContext): Promise<Set<string>> {
  return new Set((await listGenerations(context)).map(row => row._id))
}

export async function listGenerations(
  context: WorkspaceBrowserJourneyContext,
): Promise<Array<Record<string, unknown> & { _id: string }>> {
  const rows = (await context.convex.query(fnQuery('testing/modelGateway:listGenerationsForTest'), {
    internalKey: context.env.internalKey,
    workspaceId: context.workspace._id,
  })) as Array<Record<string, unknown>>
  return rows.map(row => {
    assert.equal(typeof row._id, 'string', 'generation row omitted its id')
    return row as Record<string, unknown> & { _id: string }
  })
}

async function waitForSettledGeneration(
  context: WorkspaceBrowserJourneyContext,
  before: Set<string>,
  matches: (row: Record<string, unknown>) => boolean,
): Promise<SettledGeneration> {
  const deadline = Date.now() + GENERATION_WAIT_MS
  for (;;) {
    const [generations, transactions] = await Promise.all([
      listGenerations(context),
      context.convex.query(fnQuery('testing/credits:listWorkspaceTransactionsForTest'), {
        internalKey: context.env.internalKey,
        workspaceId: context.workspace._id,
      }) as Promise<Array<Record<string, unknown>>>,
    ])
    const row = generations.find(
      candidate =>
        !before.has(candidate._id) && matches(candidate) && candidate.status === 'settled',
    )
    const parsed = row === undefined ? null : settledGeneration(row, transactions)
    if (parsed !== null) return parsed
    assert(Date.now() < deadline, 'timed out waiting for the matching settled generation')
    await Bun.sleep(POLL_MS)
  }
}

async function waitForFirstTieredGeneration(
  context: WorkspaceBrowserJourneyContext,
  before: Set<string>,
  expectedTier: ModelTierId,
): Promise<SettledGeneration> {
  const deadline = Date.now() + GENERATION_WAIT_MS
  for (;;) {
    const [generations, transactions] = await Promise.all([
      listGenerations(context),
      context.convex.query(fnQuery('testing/credits:listWorkspaceTransactionsForTest'), {
        internalKey: context.env.internalKey,
        workspaceId: context.workspace._id,
      }) as Promise<Array<Record<string, unknown>>>,
    ])
    // Support calls (classifier, memory, embeddings) bill at cost, so only a
    // model the tier bills flat can carry the tier-rate assertion.
    const fresh = generations.filter(
      row =>
        !before.has(row._id) &&
        ModelTierIdSchema.safeParse(row.tier).success &&
        tierBillsAtFlatRate(ModelTierIdSchema.parse(row.tier), String(row.model)),
    )
    const first = fresh[0]
    if (first !== undefined) {
      const tier = ModelTierIdSchema.parse(first.tier)
      assert.equal(
        tier,
        expectedTier,
        `next tiered generation attributed ${tier}; fresh=${JSON.stringify(
          fresh.map(row => ({
            tier: row.tier,
            model: row.model,
            status: row.status,
            createdAt: row.createdAt,
          })),
        )}`,
      )
      if (first.status === 'settled') {
        const parsed = settledGeneration(first, transactions)
        if (parsed !== null) return parsed
      }
    }
    assert(Date.now() < deadline, `timed out waiting for settled ${expectedTier} generation`)
    await Bun.sleep(POLL_MS)
  }
}

/**
 * Leg 5's assertion, and the diagnostic that settled what it should be.
 *
 * `waitForFirstTieredGeneration` cannot be used here. It takes the OLDEST new
 * tiered generation and asserts on the first poll where any exists — but one
 * turn produces SEVERAL generations (a tier's closure spans direct targets,
 * vision fallbacks, advisor targets, the classifier, and the memory/embedding
 * models), and `gatewayGenerations` rows carry no session or turn id, so
 * attribution is by time alone. A late generation from the PREVIOUS turn is
 * found first and fails the assert whether or not the switch worked.
 *
 * What actually has to be true after a tier switch: a generation on the NEW
 * tier appears, and once it has, nothing after it reverts to the old one. That
 * tolerates stragglers from the previous turn (which are expected and correct)
 * while still catching a switch that genuinely did not take — the old tier
 * continuing forever, with no new-tier generation ever appearing.
 *
 * On timeout it dumps every fresh generation with its offset from the moment
 * the switch was POSTed, which is the artefact that distinguishes the two.
 */
/**
 * Read the event stream to a terminal event ACROSS reconnects.
 *
 * The server already supports resumption — it honours `last-event-id` — but a
 * single `readEventStream` call holds one connection, and when the balancer
 * kills it the journey sees "did not reach a terminal event" for a turn that is
 * running perfectly well. Resuming from the last id it actually saw replays
 * anything missed, so a slow cold start costs time rather than a false failure.
 */
export async function readTurnToTerminal(
  url: string,
  token: string,
  lastEventId: number | undefined,
  overallMs: number,
): Promise<{ frames: ParsedSseFrame[]; lastId?: number; terminal: boolean }> {
  const deadline = Date.now() + overallMs
  const frames: ParsedSseFrame[] = []
  let cursor = lastEventId
  for (;;) {
    const remaining = deadline - Date.now()
    if (remaining <= 0)
      return { frames, ...(cursor === undefined ? {} : { lastId: cursor }), terminal: false }
    try {
      const leg = await readEventStream(url, token, cursor, Math.min(remaining, SSE_LEG_MS), {
        // Without this a timed-out leg throws away both its frames and its id,
        // and the next leg resumes with no `last-event-id` — which makes the
        // server stream from NOW, so everything the abandoned leg saw (the
        // routed text completion among it) is never observed at all.
        returnPartialOnTimeout: true,
      })
      frames.push(...leg.frames)
      if (leg.lastId !== undefined) cursor = leg.lastId
      if (leg.terminal) {
        return { frames, ...(cursor === undefined ? {} : { lastId: cursor }), terminal: true }
      }
    } catch {
      // Transport death is the expected case here, not an error worth failing
      // on — reconnect and let the server replay.
    }
    await Bun.sleep(POLL_MS)
  }
}

async function waitForTierSwitch(
  context: WorkspaceBrowserJourneyContext,
  before: Set<string>,
  expectedTier: ModelTierId,
  postedAt: number,
  sessionId: string,
): Promise<SettledGeneration> {
  const deadline = Date.now() + GENERATION_WAIT_MS
  let sawExpected = false
  for (;;) {
    const [generations, transactions] = await Promise.all([
      listGenerations(context),
      context.convex.query(fnQuery('testing/credits:listWorkspaceTransactionsForTest'), {
        internalKey: context.env.internalKey,
        workspaceId: context.workspace._id,
      }) as Promise<Array<Record<string, unknown>>>,
    ])
    const fresh = generations.filter(row => !before.has(row._id) && row.tier !== undefined)
    const dump = () =>
      JSON.stringify(
        fresh.map(row => ({
          tier: row.tier,
          model: row.model,
          status: row.status,
          // Relative to the switch, because absolute epochs cannot be read at a
          // glance and the sign is the whole question: negative means the row
          // predates the switch and belongs to the previous turn.
          msAfterSwitch:
            typeof row.createdAt === 'number' ? row.createdAt - postedAt : row.createdAt,
        })),
      )

    const firstExpectedIndex = fresh.findIndex(row => row.tier === expectedTier)
    if (firstExpectedIndex >= 0) {
      sawExpected = true
      // Nothing may revert once the new tier has appeared. A straggler from the
      // previous turn is fine BEFORE the switch lands; the old tier reappearing
      // after it is the actual regression this leg exists to catch.
      const reverted = fresh.slice(firstExpectedIndex).filter(row => row.tier !== expectedTier)
      assert.equal(
        reverted.length,
        0,
        `tier reverted after the switch to ${expectedTier}; fresh=${dump()}`,
      )
      const settled = fresh.slice(firstExpectedIndex).find(row => {
        if (row.status !== 'settled') return false
        // Classifier, memory and embedding calls prove attribution but bill at
        // cost; the leg prices the turn's own output.
        if (!tierBillsAtFlatRate(expectedTier, String(row.model))) return false
        const generation = settledGeneration(row, transactions)
        return generation !== null && generation.usage.outputTokens > 0
      })
      if (settled !== undefined) {
        const parsed = settledGeneration(settled, transactions)
        if (parsed !== null) return parsed
      }
    }
    if (Date.now() >= deadline) {
      // WHICH SIDE lost the tier. `lastModelId` is what the backend itself
      // resolved for the most recent input: `frontier` means the request was
      // taken correctly and the tier was lost downstream (API dispatch, gateway
      // spawn, or the agent's own header); `balanced` means it never took the
      // requested tier at all. Without this the dump says a tier was lost but
      // not by whom.
      const row = (await context.convex.query(fnQuery('testing/agentSessions:rawSessionForTest'), {
        internalKey: context.env.internalKey,
        sessionId,
      })) as { lastModelId?: string } | null
      // The VM's own log is the only place the SPAWN is visible. Generations
      // carry no session or turn id, so a row's timestamp cannot say which turn
      // produced it — a previous turn's memory/embedding work finishing after
      // the switch looks identical to the new turn routing on the old tier.
      // What is unambiguous: which tier the runner was actually spawned with.
      assert.fail(
        sawExpected
          ? `saw ${expectedTier} but none settled in time; fresh=${dump()}`
          : `no ${expectedTier} generation ever appeared after the switch — the tier did NOT take effect; ` +
              `backendLastModelId=${row?.lastModelId} fresh=${dump()} ` +
              `gatewayLog=${await tiersGatewayLog(context)}`,
      )
    }
    await Bun.sleep(POLL_MS)
  }
}

function settledGeneration(
  row: Record<string, unknown> & { _id: string },
  transactions: Array<Record<string, unknown>>,
): SettledGeneration | null {
  const tier = ModelTierIdSchema.parse(row.tier)
  const model = requiredString(row, 'model')
  const upstreamGenerationId = requiredString(row, 'upstreamGenerationId')
  const billedCostMicroUsd = requiredNonnegativeInteger(row, 'billedCostMicroUsd')
  const upstreamCostMicroUsd = requiredNonnegativeInteger(row, 'upstreamCostMicroUsd')
  const upstreamMetadata = requiredRecord(row, 'upstreamMetadata')
  const usageRow = requiredRecord(upstreamMetadata, 'usage')
  const usage = {
    uncachedInputTokens: requiredNonnegativeInteger(usageRow, 'uncachedInputTokens'),
    cachedInputTokens: requiredNonnegativeInteger(usageRow, 'cachedInputTokens'),
    outputTokens: requiredNonnegativeInteger(usageRow, 'outputTokens'),
  }
  const transaction = transactions.find(
    candidate =>
      candidate.type === 'usage' && candidate.reference === `ai_generation:${upstreamGenerationId}`,
  )
  if (transaction === undefined) return null
  const debitMicroUsd = requiredInteger(transaction, 'amountMicroUsd')
  assert(debitMicroUsd < 0, 'generation ledger entry was not a debit')
  return {
    id: row._id,
    model,
    tier,
    upstreamGenerationId,
    billedCostMicroUsd,
    upstreamCostMicroUsd,
    usage,
    debitMicroUsd,
  }
}

function rateNanoUsdPerToken(dollarsPer1M: number): bigint {
  const scaled = dollarsPer1M * 1_000
  assert(Number.isInteger(scaled), `rate ${dollarsPer1M} cannot be represented exactly`)
  return BigInt(scaled)
}

function checkedTokenCount(name: string, value: number): bigint {
  assert(Number.isSafeInteger(value) && value >= 0, `${name} must be a nonnegative safe integer`)
  return BigInt(value)
}

function requiredString(row: Record<string, unknown>, field: string): string {
  const value = row[field]
  assert(typeof value === 'string', `${field} must be a string`)
  assert(value.length > 0, `${field} must not be empty`)
  return value
}

function requiredNonnegativeInteger(row: Record<string, unknown>, field: string): number {
  const value = requiredInteger(row, field)
  assert(value >= 0, `${field} must be nonnegative`)
  return value
}

function requiredInteger(row: Record<string, unknown>, field: string): number {
  const value = row[field]
  assert(Number.isSafeInteger(value), `${field} must be a safe integer`)
  return value as number
}

function requiredRecord(row: Record<string, unknown>, field: string): Record<string, unknown> {
  const value = row[field]
  assert(isRecord(value), `${field} must be an object`)
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function requiredStagingUrl(name: 'DUET_LANDER_URL' | 'DUET_MODEL_GATEWAY_URL'): string {
  const value = process.env[name]?.trim().replace(/\/+$/, '')
  if (!value) throw new Error(`${name} is required for the virtual-model-tiers journey`)
  if (!new URL(value).hostname.includes('staging')) {
    throw new Error(`${name} must target a staging hostname`)
  }
  return value
}

/**
 * The agent-session lines of the VM's own gateway log.
 *
 * Best-effort: a diagnostic that can itself fail the journey would mask the
 * failure it exists to explain. Uses the `<runId>-admin@duet.so` shape because
 * `assertStagingE2ESyntheticEmail` refuses to reap anything else.
 */
async function tiersGatewayLog(context: WorkspaceBrowserJourneyContext): Promise<string> {
  const { env, workspace, runId, artifacts } = context
  try {
    const admin = await apiJson<{ token: string }>(
      `${env.apiUrl}/v1/admin/login-as`,
      {
        method: 'POST',
        headers: bearerJson(env.loginSecret),
        body: JSON.stringify({
          email: `${runId}-admin@duet.so`,
          create: true,
          ephemeral: true,
          name: `Tiers log reader ${runId}`,
          ttlSeconds: 900,
        }),
      },
      200,
      'tiers log-reader login',
      artifacts,
    )
    const response = await stagingFetch(
      `${env.apiUrl}/v1/internal-admin/workspaces/${workspace._id}/logs?source=gateway`,
      { headers: bearer(admin.token) },
    )
    if (!response.ok) return `<log read ${response.status}>`
    const text = await response.text()
    // Raw tail, unfiltered: a keyword filter here once returned "<no agent
    // lines>" on a log that simply had none, which reads as "the log is empty"
    // and is not the same claim.
    return `bytes=${text.length} tail=${text.slice(-1200)}`
  } catch (error) {
    return `<log read threw: ${error instanceof Error ? error.message : String(error)}>`
  }
}
