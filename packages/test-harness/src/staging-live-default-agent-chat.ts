import assert from 'node:assert/strict'

import {
  isKnownTimelineEvent,
  MarketplaceAgentSubscriptionListSchema,
  MarketplaceAgentSubscriptionResponseSchema,
} from '@repo/contract'

import appEn from '../../../apps/web/messages/en/app.json'
import { waitForDefaultSession, waitForSessionHistory } from './staging-live-agent-sessions.ts'
import { markExpectedBrowserTransition, navigateDeployedPage } from './staging-live-browser.ts'
import { apiJson, bearer, bearerJson } from './staging-live-http.ts'
import { pressOfficialHubSync, sweepListingAvailability } from './staging-live-official-hub.ts'
import { collectOpaquePages, loadAllMarketplaceCatalog } from './staging-live-pagination.ts'
import {
  runWorkspaceBrowserJourney,
  type WorkspaceBrowserJourneyContext,
  type WorkspaceBrowserJourneyResult,
} from './staging-live-workspace-browser.ts'

export interface DefaultAgentChatEvidence {
  listingId: string
  agentSlug: string
  subscriptionState: string
  sessionId: string
  terminalType: string
}

/** A fresh workspace's first pull races its VM coming up; poll, don't sample. */
const INSTALL_SETTLE_TIMEOUT_MS = 180_000
const INSTALL_POLL_MS = 3_000
const AGENT_REPLY_TIMEOUT_MS = 240_000
const HUB_WAKE_TIMEOUT_MS = 600_000

const PROMPT = 'Say hello in one short sentence.'

/**
 * The most ordinary thing a new user does, end to end: install an agent from
 * the hub, open it, and send it the first message through the composer. The
 * agent declares no onboarding, so nothing ever stamps it as onboarded — and
 * that must not matter: an agent's chat opens on registration, and only a
 * declared onboarding is ever a lock.
 */
export async function runDefaultAgentChatJourney(
  options: { onProgress?: (stage: string) => void } = {},
): Promise<WorkspaceBrowserJourneyResult<DefaultAgentChatEvidence>> {
  return await runWorkspaceBrowserJourney({
    journey: 'default-agent-chat',
    label: 'Default agent chat',
    onProgress: options.onProgress,
    run: async context => await runDefaultAgentChatAcceptance(context),
  })
}

export async function runDefaultAgentChatAcceptance(
  context: WorkspaceBrowserJourneyContext,
): Promise<DefaultAgentChatEvidence> {
  const { env, page, workspace, apiToken, artifacts, progress } = context
  const base = `${env.apiUrl}/v1/ws/${workspace.slug}`

  progress('default-agent-chat:install')
  const catalog = await loadAllMarketplaceCatalog(
    `${env.apiUrl}/v1/marketplace`,
    apiToken,
    'default-agent-chat catalog',
    artifacts,
  )
  let listing = installableVerifiedListing(catalog.items)
  if (listing === undefined) {
    // Staging's hub greys out when its VM is retired between runs. An operator
    // presses sync to bring it back; the sweep that would flip the listings
    // runs every fifteen minutes, so it is pressed here too.
    progress('default-agent-chat:wake-hub')
    await pressOfficialHubSync(context, 'default-agent-chat hub sync', {
      retryUntilMs: HUB_WAKE_TIMEOUT_MS,
    })
    await sweepListingAvailability(context)
    listing = installableVerifiedListing(
      (
        await loadAllMarketplaceCatalog(
          `${env.apiUrl}/v1/marketplace`,
          apiToken,
          'default-agent-chat catalog after hub sync',
          artifacts,
        )
      ).items,
    )
  }
  assert.ok(listing !== undefined, 'a verified listing must be available to install')
  const installed = MarketplaceAgentSubscriptionResponseSchema.parse(
    await apiJson<unknown>(
      `${base}/marketplace/subscriptions`,
      {
        method: 'POST',
        headers: bearerJson(apiToken),
        body: JSON.stringify({ listingId: listing.id, name: `E2E ${listing.title}`.slice(0, 64) }),
      },
      201,
      'default-agent-chat install',
      artifacts,
    ),
  ).subscription
  const agentSlug = installed.path.split('/').at(-1)
  assert.ok(agentSlug, `subscription path ${installed.path} names no agent folder`)

  progress('default-agent-chat:settle')
  const subscriptionState = await waitForActiveSubscription(context, installed.id)

  // The first message goes through the same composer a person uses, so the
  // request is the one the product sends: the owner's default-chat alias.
  progress('default-agent-chat:speak')
  const agentUrl = `${env.appUrl}/w/${encodeURIComponent(workspace.slug)}/agents/${encodeURIComponent(agentSlug)}`
  markExpectedBrowserTransition(page)
  await navigateDeployedPage(page, agentUrl)
  const surface = page.locator('[data-session-surface="product"]')
  await surface.waitFor({ state: 'visible', timeout: 60_000 })
  await surface.locator('[data-compose-bar-editor]').fill(PROMPT)
  await surface.getByRole('button', { name: 'Send', exact: true }).click()

  progress('default-agent-chat:created')
  const sessionId = await waitForDefaultSession(env, workspace.slug, agentSlug, apiToken, {
    label: 'default-agent-chat default session',
    artifacts,
  })
  const createError = appEn.duetApp.sessionProduct.createError
  assert.equal(
    await page.getByText(createError, { exact: true }).count(),
    0,
    `the composer reported "${createError}" after the session was created`,
  )
  await surface.getByText(PROMPT, { exact: true }).first().waitFor({ timeout: 30_000 })

  // A created row is not a conversation until the agent answers in it.
  progress('default-agent-chat:reply')
  const history = await waitForSessionHistory(
    env,
    workspace.slug,
    sessionId,
    apiToken,
    rows =>
      rows.events.some(
        row =>
          isKnownTimelineEvent(row.event) &&
          row.event.type === 'complete' &&
          row.event.status === 'completed',
      ),
    AGENT_REPLY_TIMEOUT_MS,
  )
  const terminal = history.events.findLast(
    row => isKnownTimelineEvent(row.event) && row.event.type === 'complete',
  )
  assert.ok(terminal !== undefined)

  return {
    listingId: listing.id,
    agentSlug,
    subscriptionState,
    sessionId,
    terminalType: terminal.event.type,
  }
}

function installableVerifiedListing<T extends { verifiedPublisher: boolean; availability: string }>(
  items: readonly T[],
): T | undefined {
  return items.find(item => item.verifiedPublisher && item.availability === 'available')
}

async function waitForActiveSubscription(
  context: WorkspaceBrowserJourneyContext,
  subscriptionId: string,
): Promise<string> {
  const { env, workspace, apiToken, artifacts } = context
  const deadline = Date.now() + INSTALL_SETTLE_TIMEOUT_MS
  for (;;) {
    const items = await collectOpaquePages(async cursor =>
      MarketplaceAgentSubscriptionListSchema.parse(
        await apiJson<unknown>(
          `${env.apiUrl}/v1/ws/${workspace.slug}/marketplace/subscriptions${cursor === null ? '' : `?cursor=${encodeURIComponent(cursor)}`}`,
          { headers: bearer(apiToken) },
          200,
          'default-agent-chat subscriptions',
          artifacts,
        ),
      ),
    )
    const state = items.find(row => row.id === subscriptionId)?.state
    assert.notEqual(state, 'error', 'the installed agent landed in error')
    if (state === 'active') return state
    assert.ok(
      Date.now() < deadline,
      `subscription ${subscriptionId} never became active within ${INSTALL_SETTLE_TIMEOUT_MS / 1000}s (state: ${state})`,
    )
    await Bun.sleep(INSTALL_POLL_MS)
  }
}
