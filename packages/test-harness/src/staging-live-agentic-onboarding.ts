import assert from 'node:assert/strict'
import path from 'node:path'

import {
  chromium,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
} from '@playwright/test'
import { ConvexHttpClient } from 'convex/browser'

import {
  MarketplaceAgentSubscriptionListSchema,
  resolveAgentConfig,
  OnboardingRecommendationsResponseSchema,
  WhoamiResponseSchema,
} from '@repo/contract'

import appEn from '../../../apps/web/messages/en/app.json'
import { getOnboardingGoal } from '../../../apps/web/spa/onboarding/onboarding-goals.ts'
import { composePurpose } from '../../../apps/web/spa/onboarding/onboarding-purpose.ts'
import { waitForDefaultSession } from './staging-live-agent-sessions.ts'
import { StagingArtifactCollector } from './staging-live-artifacts.ts'
import { waitForBrowserMagicLink } from './staging-live-browser-acceptance.ts'
import {
  attachBrowserDiagnostics,
  evaluateThroughClientNavigations,
  installStagingProtection,
  markExpectedBrowserTransition,
  navigateDeployedPage,
} from './staging-live-browser.ts'
import { fnMutation, fnQuery, readLiveEnv, type LiveEnv } from './staging-live-env.ts'
import { apiJson, bearer, stagingFetch } from './staging-live-http.ts'
import { waitForBrowserSessionCredential } from './staging-live-invite.ts'
import { resolveAgentMailInbox, taggedInboxAddress } from './staging-live-mailbox.ts'
import { workspaceGatewayLogTail } from './staging-live-official-hub.ts'
import { collectOpaquePages } from './staging-live-pagination.ts'
import { waitForHydratedMagicLinkControls } from './staging-live-public-site.ts'
import {
  recordWorkspaceCleanup,
  StagingResourceLedger,
  type StagingCleanupReport,
} from './staging-live-resource-ledger.ts'

/**
 * Agentic onboarding, end to end on deployed staging — the only place the real
 * LLM path is ever exercised.
 *
 * Everything else about this feature is proved hermetically: the composer, the
 * step graph, the minimum-3 floor and the rail's markup all have unit and
 * component coverage, and the local e2e walks the same wizard against a Convex
 * with no `AI_GATEWAY_API_KEY` — which permanently pins the FALLBACK path
 * (empty recommendations, plain catalog, no rail). That is the inverse of what
 * this journey is for.
 *
 * The one regression a hermetic suite structurally cannot catch is
 * silent-fallback-forever: a broken prompt, a revoked gateway key, a model id
 * that no longer resolves, or a timeout budget that reality outgrew all
 * degrade to exactly the same thing the local e2e calls success — an empty
 * list and a plain catalog. So this journey FAILS if the rail never arrives.
 * Staging holds the gateway key; an empty response there is a broken feature,
 * not graceful degradation.
 *
 * It also carries the no-typing guarantee's only end-to-end proof: after the
 * assistant's name, the walk touches the keyboard zero times, and the purpose
 * that reaches `workspaces.purpose` is asserted against the exact paragraph
 * the shipped composer builds from the goal's smart defaults.
 *
 * COLD IDENTITY on purpose (fixture `browser`, following `signup-abuse`): the
 * flow only exists for an owner who has never onboarded, so a programmatic
 * `login-as` workspace — already onboarded, already named — cannot reach it.
 * The run id carries the `staging-e2e-` marker, which is what exempts the
 * synthetic address from the signup gate so the workspace keeps its trial and
 * provisions a VM.
 *
 * NOT covered here: the "Write your own" branch. It burns an LLM call to prove
 * client-only string handling that `onboarding-purpose.test.ts` and the local
 * e2e already pin.
 */

const GOAL_ID = 'grow-business' as const
/** `duetOnboarding.goals.grow-business.label` — the tile the walk taps. */
const GOAL_TILE_LABEL = 'Grow my business'
const ASSISTANT_NAME = 'Nova'
/**
 * Read from the shipped catalog, not written down: the walk has to press
 * Continue once per question the goal actually asks. A constant here would
 * either strand the walk on a question it never advanced past, or press into
 * the team step and count that as a follow-up.
 */
const FOLLOW_UP_COUNT = getOnboardingGoal(GOAL_ID).questions.length
/** The contract's "exactly 4 or nothing" — the rail is 4 cards or no rail. */
const EXPECTED_RECOMMENDATIONS = 4
const REQUIRED_TEAM_SELECTIONS = 3
/** The steps this graph may ever show. `knowledge` is deleted, not hidden. */
const EXPECTED_STEP_SEQUENCE = ['identity', 'goal', 'follow-ups', 'team', 'ready'] as const

const PAGE_TIMEOUT_MS = 90_000
/** The plain catalog must not wait on the recommender — it is fetched at mount. */
const CATALOG_TIMEOUT_MS = 30_000
/** Generous against the client's own 12s abort atop the server's 10s. */
const RECOMMENDATIONS_RESPONSE_TIMEOUT_MS = 45_000
const RAIL_TIMEOUT_MS = 30_000
/** Installs land on a freshly provisioned VM; give the first pull room. */
const INSTALL_SETTLE_TIMEOUT_MS = 600_000
const INSTALL_POLL_MS = 5_000

/**
 * The purpose this walk must store: the picked goal composed with every smart
 * default, through the shipped composer and the shipped English catalog copy.
 * Nothing is typed on the follow-ups, so this IS the no-typing guarantee's
 * output — asserting on it end to end is asserting the guarantee.
 *
 * (The resolver is a twin of the local e2e's. Both are fixtures reading the
 * same message bundle the app ships; the composer, not the lookup, is the
 * thing with one owner.)
 */
const EXPECTED_PURPOSE = composePurpose({ goalId: GOAL_ID }, key => {
  let node: unknown = (appEn as { duetOnboarding: unknown }).duetOnboarding
  for (const part of key.split('.')) {
    if (node === null || typeof node !== 'object') break
    node = (node as Record<string, unknown>)[part]
  }
  if (typeof node !== 'string') throw new Error(`Missing duetOnboarding message: ${key}`)
  return node
})

export interface AgenticOnboardingEvidence {
  email: string
  workspaceSlug: string
  duetName: string
  /** The composed paragraph as whoami reports it back. */
  purpose: string
  onboardedAt: number
  /** Every distinct step the wizard rendered, in order. Never contains `knowledge`. */
  stepsRendered: string[]
  /** Wall clock from entering `team` to the recommendations response landing. */
  recommendationLatencyMs: number
  /** The four picks and the personalized reason each arrived with. */
  recommended: Array<{ agentName: string; reason: string }>
  /** Names the walk selected, and where each was tapped from. */
  selected: Array<{ agentName: string; from: 'rail' | 'browse' }>
  /** Marketplace subscription state per selected agent once installs settled. */
  installs: Array<{ agentName: string; state: string; path: string }>
  /** The starter agent the new user spoke to first, and the chat that opened. */
  talk: { agentSlug: string; sessionId: string }
  /** Where a post-onboarding visit to `/onboarding` was redirected to. */
  onboardingRevisitPath: string
}

export interface AgenticOnboardingJourneyResult {
  journey: 'agentic-onboarding'
  runId: string
  artifactDirectory: string
  evidence: AgenticOnboardingEvidence
  vmNames: string[]
  cleanup: StagingCleanupReport
}

export async function runAgenticOnboardingJourney(
  options: { onProgress?: (stage: string) => void } = {},
): Promise<AgenticOnboardingJourneyResult> {
  const env = readLiveEnv()
  const runId = `staging-e2e-agentic-onboarding-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 6)}`
  const artifactDirectory = path.join(env.artifactRoot, runId)
  const progress = (stage: string) => options.onProgress?.(stage)
  const convex = new ConvexHttpClient(env.convexUrl)
  const ledger = new StagingResourceLedger(runId)
  const secrets = [env.internalKey, env.vercelBypassSecret]
  const artifacts = new StagingArtifactCollector(artifactDirectory, secrets)
  const vmNames: string[] = []
  let browser: Browser | undefined
  let context: BrowserContext | undefined
  let evidence: AgenticOnboardingEvidence | undefined
  let cleanup: StagingCleanupReport | undefined
  let primaryError: unknown

  await artifacts.initialize()
  try {
    const inbox = await resolveAgentMailInbox({
      apiKey: env.agentMailApiKey,
      address: env.agentMailInboxAddress,
    })
    // `staging-e2e-` in the tag is the signup gate's exemption marker: without
    // it the identity signs in but the trial is withheld, and a workspace with
    // no VM cannot settle an agent install.
    const email = taggedInboxAddress(inbox.address, runId)

    progress('browser')
    browser = await chromium.launch({ headless: env.headless })
    context = await browser.newContext()
    await installStagingProtection(context, env)
    attachBrowserDiagnostics(context, artifacts)
    // Installed before the first navigation so it survives every client-side
    // step change: the wizard is one document, and this records the whole
    // sequence rather than only the steps the walk happens to stop on. That is
    // what makes "no knowledge step ever appears" an assertion instead of an
    // absence of evidence.
    await context.addInitScript(() => {
      const observed: string[] = []
      ;(window as unknown as { __duetOnboardingSteps: string[] }).__duetOnboardingSteps = observed
      const record = () => {
        const step = document
          .querySelector('[data-onboarding-step]')
          ?.getAttribute('data-onboarding-step')
        if (step != null && step !== '' && observed.at(-1) !== step) observed.push(step)
      }
      new MutationObserver(record).observe(document, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ['data-onboarding-step'],
      })
      record()
    })
    const page = await context.newPage()
    page.setDefaultTimeout(PAGE_TIMEOUT_MS)
    page.setDefaultNavigationTimeout(PAGE_TIMEOUT_MS)

    progress('cold-signup')
    const workspaceSlug = await signUpCold({ env, page, ledger, runId, email, inboxId: inbox.id })
    const sessionToken = await waitForBrowserSessionCredential({
      cookies: async () => await (context as BrowserContext).cookies(env.appUrl),
    })
    secrets.push(sessionToken)

    // Record cleanup as early as the ids exist: the workspace teardown takes
    // the VM with it, and a journey that throws mid-walk must still not leave
    // a live VM behind.
    const identity = await readWhoami(page)
    const workspace = identity.workspaces.find(candidate => candidate.slug === workspaceSlug)
    assert(workspace !== undefined, `signup workspace ${workspaceSlug} was absent from whoami`)
    assert.equal(
      workspace.onboardedAt,
      undefined,
      'a freshly signed-up workspace was already onboarded — the wizard under test was skipped',
    )
    recordWorkspaceCleanup({
      ledger,
      convex,
      env,
      output: { vmNames },
      workspaceId: workspace.id,
      slug: workspace.slug,
    })
    ledger.record({
      kind: 'user',
      id: identity.user.id,
      label: `${runId}:owner:${email}`,
      // Negative: the workspace (and its VM) must go before the identity that
      // owns it, or the teardown loses the actor it needs.
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

    evidence = await walkOnboarding({
      env,
      page,
      progress,
      email,
      workspaceSlug,
      sessionToken,
      artifacts,
      operator: { env, runId, artifacts, ledger, convex },
    })
  } catch (error) {
    primaryError = error
    throw error
  } finally {
    progress('cleanup')
    await context?.close().catch(() => undefined)
    await browser?.close().catch(() => undefined)
    cleanup = await ledger.cleanupAll()
    await Promise.all([
      artifacts.flushDiagnostics(),
      artifacts.writeJson('journey.json', {
        journey: 'agentic-onboarding',
        runId,
        artifactDirectory,
        evidence,
        vmNames,
        cleanup,
        ...(primaryError === undefined
          ? {}
          : { error: primaryError instanceof Error ? primaryError.message : String(primaryError) }),
      }),
    ])
  }

  assert(evidence !== undefined, 'journey completed without evidence')
  assert(cleanup !== undefined, 'journey completed without cleanup evidence')
  if (cleanup.status !== 'pass') {
    throw new Error(`journey cleanup failed: ${JSON.stringify(cleanup)}`)
  }
  return { journey: 'agentic-onboarding', runId, artifactDirectory, evidence, vmNames, cleanup }
}

/**
 * A genuinely cold signup through the deployed sign-in page. Returns the slug
 * of the workspace the product minted, taken from the route it lands on —
 * reaching `/w/:slug/onboarding` at all is the first assertion.
 */
async function signUpCold(args: {
  env: LiveEnv
  page: Page
  ledger: StagingResourceLedger
  runId: string
  email: string
  inboxId: string
}): Promise<string> {
  const { env, page, ledger, runId, email, inboxId } = args
  markExpectedBrowserTransition(page)
  await navigateDeployedPage(page, `${env.appUrl}/sign-in?returnTo=%2F`)

  const controls = await waitForHydratedMagicLinkControls(page)
  await controls.email.fill(email)
  const requestedAt = Date.now()
  const [intent] = await Promise.all([
    page.waitForResponse(
      response =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === '/api/auth/magic-link',
    ),
    controls.submit.click({ noWaitAfter: true }),
  ])
  assert.equal(intent.status(), 204, 'magic-link intent failed')

  const magicLink = await waitForBrowserMagicLink({
    env,
    page,
    ledger,
    email,
    inboxId,
    requestedAt,
    runId,
    returnTo: '/',
  })
  markExpectedBrowserTransition(page)
  await navigateDeployedPage(page, magicLink)

  // A brand-new owner is routed to the wizard rather than into the product —
  // the gate, not a link, is what puts them here.
  await page.waitForURL(url => /^\/w\/[^/]+\/onboarding$/.test(url.pathname), { timeout: 180_000 })
  const slug = new URL(page.url()).pathname.split('/')[2]
  assert(slug !== undefined && slug !== '', 'workspace slug was absent from the onboarding route')
  return slug
}

async function walkOnboarding(args: {
  env: LiveEnv
  page: Page
  progress: (stage: string) => void
  email: string
  workspaceSlug: string
  sessionToken: string
  artifacts: StagingArtifactCollector
  /** Whoever reads a workspace's gateway log when an install will not settle. */
  operator: Parameters<typeof workspaceGatewayLogTail>[0]
}): Promise<AgenticOnboardingEvidence> {
  const { env, page, progress, email, workspaceSlug, sessionToken, artifacts, operator } = args
  const onboarding = page.locator('[data-onboarding-step]')

  progress('identity')
  await waitForOnboardingStep(page, 'identity')
  await onboarding
    .getByRole('textbox', { name: 'Assistant name', exact: true })
    .fill(ASSISTANT_NAME)
  await onboarding.locator('header').getByText(ASSISTANT_NAME, { exact: true }).waitFor()
  await onboarding.getByRole('button', { name: 'Continue', exact: true }).click()

  // Goal: a tile tap both records the goal and advances — there is no second
  // Continue here, which is the whole point of the tap-through design.
  progress('goal')
  await waitForOnboardingStep(page, 'goal')
  await onboarding.getByRole('button', { name: GOAL_TILE_LABEL, exact: true }).click()

  // Registered before the follow-ups because the request fires on ENTERING
  // team, once they are answered; Playwright buffers responses from here on.
  const recommendationsResponse = page.waitForResponse(
    response =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname.endsWith('/onboarding/recommendations'),
    { timeout: RECOMMENDATIONS_RESPONSE_TIMEOUT_MS },
  )

  // The no-typing guarantee, literally: every follow-up screen already carries
  // a complete answer, and is advanced with taps and nothing else.
  progress('follow-ups')
  for (let index = 0; index < FOLLOW_UP_COUNT; index++) {
    await waitForOnboardingStep(page, 'follow-ups')
    await page.waitForFunction(
      expected =>
        document.querySelector('[data-onboarding-step]')?.getAttribute('data-followup-index') ===
        expected,
      String(index),
    )
    const preSelected = onboarding.locator('[data-onboarding-chip-row] [aria-pressed="true"]')
    await preSelected.first().waitFor()
    assert.equal(
      await preSelected.count(),
      1,
      `follow-up ${index} did not open with exactly one chip pre-selected`,
    )
    // The optional detail field stays untouched; a walk that typed here would
    // compose a different purpose and quietly stop testing the guarantee.
    const detail = onboarding.locator('input[id^="onboarding-detail-"]')
    assert.equal(await detail.count(), 1, `follow-up ${index} rendered more than one question`)
    assert.equal(
      await detail.inputValue(),
      '',
      `follow-up ${index} opened with a pre-filled detail field`,
    )
    await onboarding.getByRole('button', { name: 'Continue', exact: true }).click()
  }

  progress('team:catalog')
  const enteredTeamAt = Date.now()
  await waitForOnboardingStep(page, 'team')

  // The plain verified catalog renders immediately — it is fetched at mount and
  // owes the recommender nothing. Asserted BEFORE the rail so a rail failure
  // can never be confused with a marketplace failure.
  const allCards = onboarding.locator('[data-marketplace-state]')
  await allCards.first().waitFor({ timeout: CATALOG_TIMEOUT_MS })
  const catalogSize = await allCards.count()
  assert(
    catalogSize >= REQUIRED_TEAM_SELECTIONS,
    `the team step rendered ${catalogSize} official agents; the minimum-3 floor needs at least ${REQUIRED_TEAM_SELECTIONS}`,
  )

  progress('team:recommendations')
  const response = await recommendationsResponse.catch(() => undefined)
  assert(
    response !== undefined,
    `entering the team step never fired POST /onboarding/recommendations within ${RECOMMENDATIONS_RESPONSE_TIMEOUT_MS}ms`,
  )
  const recommendationLatencyMs = Date.now() - enteredTeamAt
  assert.equal(
    response.status(),
    200,
    'the recommendations endpoint must always answer 200 — failures degrade in the body, never in the status',
  )
  const body = OnboardingRecommendationsResponseSchema.parse(await response.json())
  assert.equal(
    body.recommendations.length,
    EXPECTED_RECOMMENDATIONS,
    'staging returned an EMPTY recommendation list. Staging holds the gateway key, so this is the ' +
      'silent-fallback-forever regression this journey exists to catch: the model id, the prompt, ' +
      'the catalog validation or the 10s budget is broken, not the network. ' +
      `(purpose sent: ${JSON.stringify(EXPECTED_PURPOSE)}, latency ${recommendationLatencyMs}ms)`,
  )
  for (const recommendation of body.recommendations) {
    assert(
      recommendation.reason.trim().length > 0,
      `recommendation for ${recommendation.agentName} arrived with an empty reason`,
    )
  }
  assert.equal(
    new Set(body.recommendations.map(item => item.agentName)).size,
    EXPECTED_RECOMMENDATIONS,
    'the recommender returned duplicate agents',
  )

  progress('team:rail')
  const rail = onboarding.locator('[data-onboarding-recommendations="ready"]')
  const railCards = rail.locator('[data-marketplace-state]')
  try {
    await railCards.nth(EXPECTED_RECOMMENDATIONS - 1).waitFor({ timeout: RAIL_TIMEOUT_MS })
  } catch (error) {
    // Precision before failure: say whether onboarding is merely un-personalized
    // (the catalog still works, the user can still finish) or actually broken.
    const usable = (await allCards.count()) >= REQUIRED_TEAM_SELECTIONS
    await artifacts.writeJson('rail-failure.json', {
      recommendations: body.recommendations,
      railCards: await railCards.count(),
      catalogCards: await allCards.count(),
      plainCatalogUsable: usable,
    })
    throw new Error(
      `the "picked for you" rail never rendered ${EXPECTED_RECOMMENDATIONS} cards within ${RAIL_TIMEOUT_MS}ms ` +
        `even though the endpoint returned ${body.recommendations.length} recommendations ` +
        `(${body.recommendations.map(item => item.agentName).join(', ')}). ` +
        `The plain catalog is ${usable ? 'still usable, so onboarding degrades rather than dead-ends' : 'ALSO broken'}. ` +
        'Most likely the recommended names no longer join the verified catalog. ' +
        `Original wait: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  assert.equal(
    await railCards.count(),
    EXPECTED_RECOMMENDATIONS,
    'the rail rendered a partial "picked for you" row — it is four cards or none',
  )
  const reasons = rail.locator('[data-testid="marketplace-card-reason"]')
  assert.equal(
    await reasons.count(),
    EXPECTED_RECOMMENDATIONS,
    'a recommended card rendered without its personalized reason',
  )
  for (let index = 0; index < EXPECTED_RECOMMENDATIONS; index++) {
    const reason = (await reasons.nth(index).innerText()).trim()
    assert(reason.length > 0, `recommended card ${index} rendered an empty reason`)
  }

  // Cards identify themselves by their selection label ("Select <title>"), so
  // the browse grid is "every card that is not in the rail".
  const railLabels = await cardLabels(railCards)
  const browseLabels = (await cardLabels(allCards)).filter(label => !railLabels.includes(label))
  assert(
    browseLabels.length > 0,
    'every catalog card was recommended — the walk cannot prove a browse-grid selection',
  )

  progress('team:selection')
  const picks: Array<{ label: string; from: 'rail' | 'browse' }> = [
    { label: railLabels[0]!, from: 'rail' },
    { label: browseLabels[0]!, from: 'browse' },
    { label: browseLabels[1] ?? railLabels[1]!, from: browseLabels[1] ? 'browse' : 'rail' },
  ]
  // The floor is stated BY the primary button (its label counts down), so the
  // button is located by its data hook rather than its name — the name is the
  // thing under test.
  const teamContinue = onboarding.locator('[data-onboarding-primary]')
  assert.equal(
    await teamContinue.isEnabled(),
    false,
    'Continue was enabled with zero selections despite a healthy catalog',
  )
  for (const pick of picks.slice(0, 2)) {
    await onboarding.getByRole('checkbox', { name: pick.label, exact: true }).click()
  }
  assert.equal(
    (await teamContinue.innerText()).trim(),
    'Pick 1 more agent',
    'the primary button did not name how many more agents are needed',
  )
  assert.equal(
    await teamContinue.isEnabled(),
    false,
    `Continue was enabled at 2 of ${REQUIRED_TEAM_SELECTIONS} required selections`,
  )
  await onboarding.getByRole('checkbox', { name: picks[2]!.label, exact: true }).click()
  await page.waitForFunction(() =>
    [...document.querySelectorAll('button[type="submit"]')].some(
      button => !(button as HTMLButtonElement).disabled,
    ),
  )
  assert.equal(
    (await teamContinue.innerText()).trim(),
    'Continue',
    'the primary button kept counting after the floor was met',
  )
  await teamContinue.click()

  progress('ready')
  await waitForOnboardingStep(page, 'ready')
  const stepsRendered = await page.evaluate(
    () => (window as unknown as { __duetOnboardingSteps: string[] }).__duetOnboardingSteps,
  )
  assert(
    !stepsRendered.includes('knowledge'),
    `the deleted knowledge step rendered during onboarding: ${stepsRendered.join(' → ')}`,
  )
  assert.deepEqual(
    stepsRendered,
    [...EXPECTED_STEP_SEQUENCE],
    'the wizard did not render exactly the five steps of the agentic graph',
  )

  const [completion] = await Promise.all([
    page.waitForResponse(
      response_ =>
        response_.request().method() === 'POST' &&
        new URL(response_.url()).pathname.endsWith('/onboarding'),
    ),
    onboarding.getByRole('button', { name: 'Enter your workspace', exact: true }).click(),
  ])
  assert.equal(completion.status(), 200, 'workspace onboarding completion failed')
  const completionRequest = completion.request().postDataJSON() as {
    duetName: string
    selectedNames?: string[]
    purpose?: string
    goal?: string
  }
  assert.equal(completionRequest.duetName, ASSISTANT_NAME)
  assert.equal(completionRequest.goal, GOAL_ID)
  assert.equal(
    completionRequest.purpose,
    EXPECTED_PURPOSE,
    'the completion carried a purpose the shipped composer would not build from taps alone',
  )
  const selectedAgentNames = completionRequest.selectedNames ?? []
  assert.equal(
    selectedAgentNames.length,
    REQUIRED_TEAM_SELECTIONS,
    'completion must carry exactly the three selected agents',
  )
  const completionBody = (await completion.json()) as {
    results: Array<{ name: string; ok: boolean }>
    pullError?: string
  }
  assert.deepEqual(
    completionBody.results.filter(result => !result.ok),
    [],
    'a selected agent failed to install',
  )
  // Every pick, not just every reported one: a name the install loop dropped
  // would otherwise pass as "nothing failed".
  assert.deepEqual(
    completionBody.results.map(result => result.name).sort(),
    [...selectedAgentNames].sort(),
    'completion must report an install for each selected agent',
  )

  // The install warning is a real deployed branch (the VM pull can lose a race
  // with a freshly provisioned workspace). Either way the user gets their
  // workspace on the next click — and the subscription poll below is what
  // actually settles whether the agents landed.
  progress('enter-workspace')
  const warning = onboarding.getByRole('button', {
    name: 'Continue to your workspace',
    exact: true,
  })
  // The agents section is the destination; which face it opens on (the root
  // agent, its welcome app) is the product's call and has changed before.
  const inAgentsSection = (url: URL) =>
    url.pathname === `/w/${workspaceSlug}/agents` ||
    url.pathname.startsWith(`/w/${workspaceSlug}/agents/`)
  await Promise.race([
    page.waitForURL(inAgentsSection).catch(() => undefined),
    warning.waitFor().catch(() => undefined),
  ])
  if (await warning.isVisible().catch(() => false)) {
    await warning.click()
  }
  await page.waitForURL(inAgentsSection)
  await page.locator('[data-drive-shell="true"]').waitFor()
  await page.locator('aside').getByText(ASSISTANT_NAME, { exact: true }).first().waitFor()

  progress('whoami')
  const identity = await readWhoami(page)
  const workspace = identity.workspaces.find(candidate => candidate.slug === workspaceSlug)
  assert(workspace !== undefined, 'the onboarded workspace vanished from whoami')
  assert.equal(workspace.duetName, ASSISTANT_NAME)
  assert.equal(typeof workspace.onboardedAt, 'number', 'onboardedAt was not stamped')
  assert.equal(
    workspace.purpose,
    EXPECTED_PURPOSE,
    'the stored purpose is not the paragraph the shipped composer builds from the tapped defaults',
  )

  progress('installs')
  const installs = await waitForSettledInstalls({
    env,
    sessionToken,
    workspaceSlug,
    workspaceId: workspace.id,
    agentNames: selectedAgentNames,
    operator,
    pushOutcome: completionBody.pullError ?? 'pushed',
  })

  /* The point of picking a team is talking to it. The starter agents declare
     no onboarding, so nothing stamps them onboarded — and the first message
     through the composer must open the chat regardless. A backend gate once
     keyed human access on that stamp and every fixture had stamped it, which
     is why this journey, not a fixture, sends the message. */
  progress('talk')
  const talkSlug = await talkableStarterAgent({ env, page, sessionToken, workspaceSlug, installs })
  // Onboarding completes before the VM has even registered, and reads through
  // it answer 409 until it has. A person sees the workspace settle before the
  // agent page can draw its composer; the journey waits for the same thing.
  await waitForWorkspaceReads({ env, sessionToken, workspaceSlug, agentSlug: talkSlug })
  markExpectedBrowserTransition(page)
  await navigateDeployedPage(
    page,
    `${env.appUrl}/w/${encodeURIComponent(workspaceSlug)}/agents/${encodeURIComponent(talkSlug)}`,
  )
  const surface = page.locator('[data-session-surface="product"]')
  await surface.waitFor({ state: 'visible', timeout: 60_000 })
  const dialog = page.getByRole('dialog')
  const openDialogText = async () =>
    (
      await dialog
        .first()
        .innerText()
        .catch(() => '')
    )
      .replace(/\s+/g, ' ')
      .slice(0, 300)
  const composer = surface.locator('[data-compose-bar-editor]')
  try {
    await composer.fill(FIRST_MESSAGE, { timeout: 90_000 })
  } catch (error) {
    const bodyText = (
      await page
        .locator('body')
        .innerText()
        .catch(() => '')
    ).replace(/\s+/g, ' ')
    throw new Error(
      `the composer for ${talkSlug} never became editable at ${page.url()}: ` +
        `${error instanceof Error ? error.message.split('\n')[0] : String(error)}; ` +
        `surface=${await surface.count()} composer=${await composer.count()} ` +
        `onboardButtons=${await page.getByRole('button', { name: /onboard/i }).count()} ` +
        `dialog="${await openDialogText()}"; ` +
        `page text: ${bodyText.slice(0, 600)}`,
    )
  }
  const send = surface.getByRole('button', { name: 'Send', exact: true })
  try {
    await send.click({ timeout: 60_000 })
  } catch (error) {
    const bodyText = (
      await page
        .locator('body')
        .innerText()
        .catch(() => '')
    ).replace(/\s+/g, ' ')
    throw new Error(
      `Send never took the click for ${talkSlug} at ${page.url()}: ` +
        `${error instanceof Error ? error.message.split('\n')[0] : String(error)}; ` +
        `dialogs=${await dialog.count()} dialog="${await openDialogText()}" ` +
        `sendEnabled=${await send.isEnabled().catch(() => 'n/a')}; ` +
        `page text: ${bodyText.slice(0, 600)}`,
    )
  }
  const talkSessionId = await waitForDefaultSession(env, workspaceSlug, talkSlug, sessionToken, {
    label: 'agentic-onboarding:default-session',
  })
  const createError = appEn.duetApp.sessionProduct.createError
  assert.equal(
    await page.getByText(createError, { exact: true }).count(),
    0,
    `the composer reported "${createError}" for ${talkSlug}`,
  )
  await surface.getByText(FIRST_MESSAGE, { exact: true }).first().waitFor({ timeout: 30_000 })

  // The onboarding route belongs to the pre-onboarded window only.
  progress('revisit')
  markExpectedBrowserTransition(page)
  await navigateDeployedPage(
    page,
    `${env.appUrl}/w/${encodeURIComponent(workspaceSlug)}/onboarding`,
  )
  await page.waitForURL(url => url.pathname !== `/w/${workspaceSlug}/onboarding`)
  const onboardingRevisitPath = new URL(page.url()).pathname
  assert.equal(
    await page.locator('[data-onboarding-step]').count(),
    0,
    'the onboarding wizard rendered again for an onboarded workspace',
  )

  return {
    email,
    workspaceSlug,
    duetName: ASSISTANT_NAME,
    purpose: workspace.purpose,
    onboardedAt: workspace.onboardedAt!,
    stepsRendered,
    recommendationLatencyMs,
    recommended: body.recommendations.map(item => ({
      agentName: item.agentName,
      reason: item.reason,
    })),
    selected: picks.map((pick, index) => ({
      agentName: selectedAgentNames[index] ?? pick.label,
      from: pick.from,
    })),
    installs,
    talk: { agentSlug: talkSlug, sessionId: talkSessionId },
    onboardingRevisitPath,
  }
}

const FIRST_MESSAGE = 'Say hello in one short sentence.'
const WORKSPACE_READS_TIMEOUT_MS = 180_000

/** Until a read through the workspace VM answers, not just its control plane. */
async function waitForWorkspaceReads(args: {
  env: LiveEnv
  sessionToken: string
  workspaceSlug: string
  agentSlug: string
}): Promise<void> {
  const { env, sessionToken, workspaceSlug, agentSlug } = args
  const url = `${env.apiUrl}/v1/ws/${workspaceSlug}/files/agents/${encodeURIComponent(agentSlug)}/agent.json?optional=1`
  const deadline = Date.now() + WORKSPACE_READS_TIMEOUT_MS
  let last = 'unsent'
  for (;;) {
    const response = await stagingFetch(url, { headers: bearer(sessionToken) })
    if (response.status === 200 || response.status === 204) return
    last = `${response.status} ${(await response.text()).slice(0, 120)}`
    assert.ok(
      Date.now() < deadline,
      `reads through the workspace VM never answered within ${WORKSPACE_READS_TIMEOUT_MS / 1000}s (last: ${last})`,
    )
    await Bun.sleep(3_000)
  }
}

/**
 * Which starter agent a new user can talk to right away — and getting the
 * others out of the way. A pick whose `agent.json` declares onboarding shows
 * the locked card, not a composer, and the onboarding chain hands a fresh
 * workspace straight into the first locked pick's setup with a transition
 * overlay; those paths belong to the agent-onboarding journey. Here every
 * locked pick is completed through the public route, as a user who finished
 * setup would, so the chain has nothing to open, and the answer is a pick
 * that declares no onboarding — or, failing that, the first pick just
 * completed.
 */
async function talkableStarterAgent(args: {
  env: LiveEnv
  page: Page
  sessionToken: string
  workspaceSlug: string
  installs: ReadonlyArray<{ agentName: string; state: string; path: string }>
}): Promise<string> {
  const { env, page, sessionToken, workspaceSlug, installs } = args
  const active = installs.filter(install => install.state === 'active')
  assert(active.length > 0, 'no starter agent became active to talk to')
  let unlocked: string | undefined
  for (const install of active) {
    const slug = install.path.split('/').at(-1)!
    const encodedPath = `${install.path}/agent.json`.split('/').map(encodeURIComponent).join('/')
    const response = await stagingFetch(
      `${env.apiUrl}/v1/ws/${workspaceSlug}/files/${encodedPath}?optional=1`,
      { headers: bearer(sessionToken) },
    )
    const source = response.status === 204 ? undefined : await response.text()
    if (resolveAgentConfig(source).onboarding === undefined) {
      unlocked ??= slug
      continue
    }
    // Through the page, on the browser's own session — the same call the
    // product's mark-onboarded control makes.
    const completed = await evaluateThroughClientNavigations(
      async () =>
        await page.evaluate(
          async ({ workspaceSlug, slug }) => {
            const response = await fetch(
              `/api/duet/ws/${encodeURIComponent(workspaceSlug)}/agents/${encodeURIComponent(slug)}/onboarded`,
              {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ onboarded: true }),
              },
            )
            return { status: response.status, body: await response.text() }
          },
          { workspaceSlug, slug },
        ),
    )
    assert.equal(
      completed.status,
      200,
      `completing ${slug}'s onboarding answered ${completed.status}: ${completed.body.slice(0, 200)}`,
    )
  }
  return unlocked ?? active[0]!.path.split('/').at(-1)!
}

/**
 * "Installs settled": every selected agent has a subscription that stopped
 * being `installing`, and none of them landed in `error`. A fresh workspace's
 * first pull races its VM coming up, so this polls rather than sampling once.
 */
async function waitForSettledInstalls(args: {
  env: LiveEnv
  sessionToken: string
  workspaceSlug: string
  workspaceId: string
  agentNames: readonly string[]
  operator: Parameters<typeof workspaceGatewayLogTail>[0]
  /** Whether completion's post-install pull reached the VM, for the failure message. */
  pushOutcome: string
}): Promise<Array<{ agentName: string; state: string; path: string }>> {
  const { env, sessionToken, workspaceSlug, agentNames } = args
  const deadline = Date.now() + INSTALL_SETTLE_TIMEOUT_MS
  for (;;) {
    // Every page: the list is paginated by agent name, and a team of three
    // does not fit on page one.
    const subscriptions = await collectOpaquePages(async cursor =>
      MarketplaceAgentSubscriptionListSchema.parse(
        await apiJson(
          `${env.apiUrl}/v1/ws/${workspaceSlug}/marketplace/subscriptions${cursor === null ? '' : `?cursor=${encodeURIComponent(cursor)}`}`,
          { headers: bearer(sessionToken) },
          200,
          'agentic-onboarding:subscriptions',
        ),
      ),
    )
    const mine = agentNames.map(agentName => {
      const row = subscriptions.find(candidate => candidate.agentName === agentName)
      return { agentName, state: row?.state, path: row?.path }
    })
    const failed = mine.filter(row => row.state === 'error')
    assert.deepEqual(failed, [], `selected agents failed to install: ${JSON.stringify(failed)}`)
    if (mine.every(row => row.state !== undefined && row.state !== 'installing')) {
      return mine.map(row => ({ agentName: row.agentName, state: row.state!, path: row.path! }))
    }
    if (Date.now() >= deadline) {
      assert.fail(
        `selected agents never finished installing within ${INSTALL_SETTLE_TIMEOUT_MS / 1000}s: ` +
          `${JSON.stringify(mine)} — either the workspace VM never reported, or the pull is stuck; ` +
          `live subscriptions: ${JSON.stringify(subscriptions.map(row => ({ agentName: row.agentName, state: row.state, mode: row.mode, path: row.path })))}; ` +
          `completion pull push: ${args.pushOutcome}; ` +
          `gateway log: ${await workspaceGatewayLogTail(args.operator, args.workspaceId)}`,
      )
    }
    await Bun.sleep(INSTALL_POLL_MS)
  }
}

async function cardLabels(cards: Locator): Promise<string[]> {
  const labels = await cards.evaluateAll(nodes =>
    nodes.map(node => node.getAttribute('aria-label') ?? ''),
  )
  assert(
    labels.every(label => label.length > 0),
    'an agent card rendered without its selection label',
  )
  return labels
}

async function readWhoami(page: Page): Promise<ReturnType<typeof WhoamiResponseSchema.parse>> {
  const result = await evaluateThroughClientNavigations(
    async () =>
      await page.evaluate(async () => {
        const response = await fetch('/api/duet/whoami')
        return { status: response.status, body: await response.json() }
      }),
  )
  assert.equal(result.status, 200, 'browser whoami failed')
  return WhoamiResponseSchema.parse(result.body)
}

async function waitForOnboardingStep(page: Page, step: string): Promise<void> {
  await page.waitForFunction(
    expected =>
      document.querySelector('[data-onboarding-step]')?.getAttribute('data-onboarding-step') ===
      expected,
    step,
  )
}
