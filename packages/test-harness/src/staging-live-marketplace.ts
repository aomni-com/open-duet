import assert from 'node:assert/strict'

import {
  AgentListResponseSchema,
  DUET_STAGING_EDGE_HOST,
  InternalAdminOfficialHubAccessSchema,
  MarketplaceAgentSubscriptionListSchema,
  MarketplaceAgentSubscriptionResponseSchema,
} from '@repo/contract'
import { OFFICIAL_AGENTS_PUBLISH_SLUG } from '@repo/official-agents-seed/manifest'

import { apiJson, bearer, bearerJson, stagingFetch } from './staging-live-http.ts'
import {
  pressOfficialHubSync,
  syncAdminIdentity,
  workspaceGatewayLogTail,
} from './staging-live-official-hub.ts'
import { loadAllMarketplaceCatalog } from './staging-live-pagination.ts'
import {
  runWorkspaceBrowserJourney,
  type WorkspaceBrowserJourneyContext,
  type WorkspaceBrowserJourneyResult,
} from './staging-live-workspace-browser.ts'

export interface MarketplaceEvidence {
  anonymousCatalogStatus: number
  gatedPublishStatus: number
  catalogListings: number
  verifiedListings: number
  taggedListings: number
  listingsWithDerivedSkills: number
  originRequestsDuringCatalogRead: 0
  installedListingId: string
  installedAgentName: string
  installedInstanceCount: number
  additionalInstanceDistinct: boolean
  canonicalReplayStable: boolean
  bareNameInstallStatus: number
  firstSyncWrote: number
  secondSyncWrote: number
  hubEtagStable: boolean
  residueReaped: boolean
  residueLeftSubscriber: boolean
}

/**
 * The marketplace closeout journey.
 *
 * NOTE ON FIXTURES: the full publisher→installer story needs TWO workspaces,
 * and no shared fixture provisions two. The publisher is minted here through
 * `/v1/admin/login-as` with `ephemeral: true` — the disposable-identity rail
 * that landed 2026-07-30 — so the sweep reclaims it without the journey owning
 * teardown of a second VM.
 */
export async function runMarketplaceJourney(
  options: { onProgress?: (stage: string) => void } = {},
): Promise<WorkspaceBrowserJourneyResult<MarketplaceEvidence>> {
  return await runWorkspaceBrowserJourney({
    journey: 'marketplace',
    label: 'Marketplace',
    onProgress: options.onProgress,
    run: async context => await runMarketplaceAcceptance(context),
  })
}

export async function runMarketplaceAcceptance(
  context: WorkspaceBrowserJourneyContext,
): Promise<MarketplaceEvidence> {
  const { env, workspace, apiToken, artifacts, progress } = context

  // 1. A signed-in read succeeds and is served from Convex rows. This runs
  //    FIRST on purpose: it proves the route exists. Asserting the anonymous
  //    401 first passes spuriously against a deployment that lacks the route
  //    entirely, because the auth middleware answers 401 before routing — which
  //    is exactly what happened on this journey's first live run.
  progress?.('marketplace:catalog-read')
  const catalog = await loadAllMarketplaceCatalog(
    `${env.apiUrl}/v1/marketplace`,
    apiToken,
    'marketplace catalog',
    artifacts,
  )
  assert.ok(catalog.items.length > 0, 'seeded official listings must be browsable')
  const verified = catalog.items.filter(listing => listing.verifiedPublisher)
  assert.ok(verified.length > 0, 'official agents must present as verified listings')

  // 2. Only now is the anonymous refusal meaningful: the route demonstrably
  //    exists, so a 401 can only come from auth, not from a missing route. This
  //    is the leg that proves slice 06 deleted OFFICIAL_AGENT_AUTH_BYPASS_PATTERNS.
  progress?.('marketplace:anonymous-catalog-refused')
  const anonymous = await stagingFetch(`${env.apiUrl}/v1/marketplace`, {})
  assert.equal(anonymous.status, 401, 'marketplace catalog must refuse anonymous callers')

  // 3. The publish gate is server-side. A hidden button is not a gate; this
  //    asserts the mutation itself refuses a well-formed, authenticated caller.
  progress?.('marketplace:publish-gated')
  const gated = await stagingFetch(`${env.apiUrl}/v1/ws/${workspace.slug}/listings`, {
    method: 'POST',
    headers: bearerJson(apiToken),
    body: JSON.stringify({ agentSlug: 'nonexistent-agent' }),
  })
  assert.equal(gated.status, 403, 'listing creation must be refused while the gate is closed')
  assert.equal(
    catalog.meta?.canPublishListings,
    false,
    'the projected capability must agree with the gate',
  )

  // 4. Install is LISTING-keyed. A bare agent name is not an installable
  //    identity — two publishers may ship the same one — so the request that
  //    used to work must now be refused as malformed, and the subscription the
  //    real request returns must carry the listing it came from.
  // An AVAILABLE one: install now refuses `listing_unavailable`, and staging's
  // catalog legitimately carries greyed listings.
  const target = verified.find(listing => listing.availability === 'available')
  assert.ok(target !== undefined, 'at least one verified listing must be available to install')
  const subscriptionsUrl = `${env.apiUrl}/v1/ws/${workspace.slug}/marketplace/subscriptions`

  progress?.('marketplace:bare-name-install-refused')
  const bareName = await stagingFetch(subscriptionsUrl, {
    method: 'POST',
    headers: bearerJson(apiToken),
    body: JSON.stringify({ name: target.agentName }),
  })
  assert.equal(bareName.status, 400, 'a bare agent name must not be an installable identity')

  progress?.('marketplace:install-by-listing')
  const installResponse = await stagingFetch(subscriptionsUrl, {
    method: 'POST',
    headers: bearerJson(apiToken),
    // A display name is required on install: the installer names the agent,
    // and the publisher's slug is not a name.
    body: JSON.stringify({ listingId: target.id, name: `E2E ${target.title}`.slice(0, 64) }),
  })
  if (installResponse.status !== 201) {
    // A bare status here is unactionable: install pushes a pull to the VM's
    // gateway, so the interesting failure is always the body plus the desired
    // state the projection handed that gateway.
    const body = await installResponse.text()
    // The subscription row survives a failed pull, and its state separates the
    // two very different causes: still `installing` means the gateway was never
    // reached, `error` + a code means the VM tried and the pull itself failed.
    const rows = await stagingFetch(subscriptionsUrl, { headers: bearer(apiToken) })
    throw new Error(
      `marketplace install expected 201, got ${installResponse.status}: ${body} ` +
        `(listing ${target.id} at ${target.publisherSlug}/${target.agentName}) ` +
        `subscriptions=${await rows.text()} ` +
        `gatewayLog=${await workspaceGatewayLogTail(context, workspace._id)}`,
    )
  }
  const installed = MarketplaceAgentSubscriptionResponseSchema.parse(await installResponse.json())
  assert.equal(
    installed.subscription.listingId,
    target.id,
    'the subscription must carry the listing it was installed from',
  )
  assert.equal(installed.subscription.agentName, target.agentName)

  // 5. One listing may have multiple independently named installed agents.
  // The first pathless request retains its retry contract; another instance is
  // an ordinary subscription at an explicit, unique agent path.
  progress?.('marketplace:install-additional-instance')
  const additionalPath = `agents/e2e-instance-${context.runId.slice(-8).toLowerCase()}`
  const additionalName = `E2E Copy ${context.runId.slice(-8)}`
  const additional = MarketplaceAgentSubscriptionResponseSchema.parse(
    await apiJson<unknown>(
      subscriptionsUrl,
      {
        method: 'POST',
        headers: bearerJson(apiToken),
        body: JSON.stringify({
          listingId: target.id,
          name: additionalName,
          path: additionalPath,
        }),
      },
      201,
      'marketplace additional instance install',
      artifacts,
    ),
  )
  assert.equal(additional.subscription.listingId, target.id)
  assert.equal(additional.subscription.path, additionalPath)
  assert.notEqual(additional.subscription.id, installed.subscription.id)
  assert.notEqual(additional.subscription.agentId, installed.subscription.agentId)

  progress?.('marketplace:canonical-install-replay')
  const replayed = MarketplaceAgentSubscriptionResponseSchema.parse(
    await apiJson<unknown>(
      subscriptionsUrl,
      {
        method: 'POST',
        headers: bearerJson(apiToken),
        body: JSON.stringify({ listingId: target.id, name: `Ignored ${context.runId.slice(-8)}` }),
      },
      201,
      'marketplace canonical install replay',
      artifacts,
    ),
  )
  assert.equal(
    replayed.subscription.id,
    installed.subscription.id,
    'replaying the canonical install must return the original subscription',
  )
  assert.equal(replayed.subscription.path, installed.subscription.path)

  const liveSubscriptions = MarketplaceAgentSubscriptionListSchema.parse(
    await apiJson<unknown>(
      subscriptionsUrl,
      { headers: bearer(apiToken) },
      200,
      'marketplace subscriptions after multiple installs',
      artifacts,
    ),
  ).items.filter(
    subscription =>
      subscription.listingId === target.id &&
      subscription.mode === 'subscribe' &&
      subscription.state !== 'detached',
  )
  assert.equal(liveSubscriptions.length, 2, 'one listing must have exactly two live instances')

  const roster = AgentListResponseSchema.parse(
    await apiJson<unknown>(
      `${env.apiUrl}/v1/ws/${workspace.slug}/agents`,
      { headers: bearer(apiToken) },
      200,
      'agent roster after multiple marketplace installs',
      artifacts,
    ),
  )
  assert.ok(installed.subscription.agentId !== undefined)
  assert.ok(additional.subscription.agentId !== undefined)
  assert.ok(
    roster.items.some(agent => agent.id === installed.subscription.agentId),
    'the canonical subscription must resolve to its exact installed agent',
  )
  assert.ok(
    roster.items.some(agent => agent.id === additional.subscription.agentId),
    'the additional subscription must resolve to its exact installed agent',
  )

  // 6. The hub sync converges and, pressed twice, is a genuine no-op the second
  //    time. This is landmine ② proved live: the publish ETag is derived from
  //    each entry's size and mtime, so if the gateway rewrote byte-identical
  //    files, the second press would rotate it and every subscriber would see a
  //    "What's new" on content that did not change.
  progress?.('marketplace:hub-sync')
  const admin = await syncAdminIdentity(context)
  const syncOnce = async (label: string) => await pressOfficialHubSync(context, label)

  const firstSync = await syncOnce('official hub sync (first)')

  /* The default-agents rail, asserted AFTER the sync rather than before it.
     The catalog read at the top of this journey shows whatever the last sync
     left behind, which is not a claim about this build; only a read taken
     after pressing sync says the live catalog matches the repo. */
  const synced = await loadAllMarketplaceCatalog(
    `${env.apiUrl}/v1/marketplace`,
    apiToken,
    'marketplace catalog after sync',
    artifacts,
  )

  /* Every listing needs a tag: the browse filter has no "untagged" chip, so a
     listing without one is published, installable, and unreachable through the
     UI. An ORPHAN trips this legitimately — a listing whose AGENT left the
     manifest keeps serving, because that is demotion and its root is no longer
     walked, and nothing will ever give it a tag. That is a hub-cleanup task,
     not a code defect, and this is the assertion that surfaces it. */
  const untagged = synced.items.filter(listing => listing.tags.length === 0)
  assert.deepEqual(
    untagged.map(listing => listing.agentName),
    [],
    'every official listing must carry a tag; an untagged one is either unsynced or an orphan needing hub cleanup',
  )

  /* Skills were hardcoded empty for every official listing before this spec,
     so the flagship cards rendered no chips at all. */
  const withoutSkills = synced.items
    .filter(listing => listing.verifiedPublisher)
    .filter(listing => listing.skills.length === 0)
  assert.deepEqual(
    withoutSkills.map(listing => listing.agentName),
    [],
    'official listings must derive their real skills, not the hardcoded empty list',
  )
  const etagAfterFirst = await hubAgentEtag(firstSync.workspaceSlug, target.agentName)
  const secondSync = await syncOnce('official hub sync (second)')
  const etagAfterSecond = await hubAgentEtag(firstSync.workspaceSlug, target.agentName)

  assert.deepEqual(
    secondSync.written,
    [],
    `a sync over unchanged content must write nothing, wrote: ${secondSync.written.join(', ')}`,
  )
  assert.ok(etagAfterFirst !== null, 'the hub publish must serve an ETag to compare')
  assert.equal(
    etagAfterSecond,
    etagAfterFirst,
    'a no-op sync must leave the publish ETag byte-identical, or every subscriber sees a phantom update',
  )

  /* 7. The deletion rail, end to end, in the one shape staging can produce.
        User publishing is gated shut, so the hub is the only publisher — a
        residue file written into the hub's agent folder plays the part of
        "content the publisher shipped and later removed".

        This proves BOTH halves in one pass:
          repo → hub   a path the manifest does not claim is reaped by sync
          hub → user   the installed folder loses it, without the user acting

        Pulls are FORCED rather than waited on. A subscriber re-polls on its own
        once an hour, which no journey can sit through, so each half is driven
        by a clone — a real user action whose route pulls the whole workspace
        synchronously before it answers. That makes this leg deterministic:
        no polling, no sleep, nothing to flake. */
  progress?.('marketplace:deletion-propagates')
  const residueName = `e2e-reap-${context.runId}.md`
  const residueHubPath = `agents/${target.agentName}/${residueName}`
  // The subscription's own `path` is where it installed. Reconstructing it from
  // `agents/<agentName>` guesses at a naming rule the installer owns — and the
  // installer names the agent, so the guess is wrong whenever a display name
  // was given.
  const subscriberPath = `${installed.subscription.path}/${residueName}`

  /* The operator admin drives internal-admin routes but is not a member of the
     hub workspace — it answers 403 on hub files. `official-hub/access` exists
     for exactly this and mints a hub-scoped key for the hub's owner. */
  const hubAccess = InternalAdminOfficialHubAccessSchema.parse(
    await apiJson<unknown>(
      `${env.apiUrl}/v1/internal-admin/official-hub/access`,
      { method: 'POST', headers: bearerJson(admin.token), body: '{}' },
      200,
      'official hub access for residue seeding',
      artifacts,
    ),
  )
  /* The subscriber fetches the published archive through the edge, which caches
     publish resolutions for ~30s. So a pull forced immediately after the write
     can legitimately be served the pre-residue archive. Gate on the ETag the
     subscriber would see actually moving — which also splits the two sides of
     this leg: if this assertion is the one that fails, the publisher never
     served the change and the pull is not to blame. */
  const archiveEtag = async (): Promise<string | null> =>
    await hubAgentEtag(hubAccess.workspaceSlug, target.agentName)
  const etagBeforeResidue = await archiveEtag()

  const writeResidue = await stagingFetch(
    `${env.apiUrl}/v1/ws/${hubAccess.workspaceSlug}/files/${encodeURI(residueHubPath)}`,
    {
      // `bearer` returns a Headers, and spreading one into an object literal
      // yields {} — it has no own enumerable properties, so the authorization
      // silently vanishes and the request 401s. Pass extras through the helper.
      headers: bearer(hubAccess.token, { 'content-type': 'text/markdown' }),
      method: 'PUT',
      body: `# reaped by ${context.runId}\n`,
    },
  )
  assert.ok(
    writeResidue.ok,
    `seeding hub residue must succeed, got ${writeResidue.status}: ${await writeResidue.text()}`,
  )

  /** Clone anywhere: the point is the workspace-wide pull the route performs. */
  const forcePull = async (label: string): Promise<void> => {
    const cloned = await stagingFetch(`${subscriptionsUrl}/clone`, {
      method: 'POST',
      headers: bearerJson(apiToken),
      body: JSON.stringify({ listingId: target.id, path: `agents/pull-${label}-${context.runId}` }),
    })
    assert.equal(
      cloned.status,
      201,
      `forcing a pull via clone (${label}) must succeed, got ${cloned.status}: ${await cloned.text()}`,
    )
  }

  const subscriberHasResidue = async (): Promise<boolean> => {
    const response = await stagingFetch(
      `${env.apiUrl}/v1/ws/${workspace.slug}/files/${encodeURI(subscriberPath)}`,
      { headers: bearer(apiToken) },
    )
    return response.ok
  }

  const servedResidue = await waitForEtagChange(archiveEtag, etagBeforeResidue)
  assert.ok(
    servedResidue,
    'the published archive never reflected the seeded residue, so nothing was there for the subscriber to pull',
  )

  await forcePull('arrive')
  const arrived = await subscriberHasResidue()
  assert.ok(
    arrived,
    `the subscriber never received ${subscriberPath}; without the arrival there is nothing to prove the deletion against`,
  )

  const etagBeforeReap = await archiveEtag()
  const reapSync = await syncOnce('official hub sync (reaps residue)')
  assert.ok(
    reapSync.deleted.includes(residueHubPath),
    `sync must report reaping ${residueHubPath}, reported: ${reapSync.deleted.join(', ') || '(nothing)'}`,
  )

  const servedReap = await waitForEtagChange(archiveEtag, etagBeforeReap)
  assert.ok(servedReap, 'the published archive never reflected the reap')

  await forcePull('depart')
  const departed = !(await subscriberHasResidue())
  assert.ok(
    departed,
    `the subscriber still holds ${subscriberPath} after the publisher dropped it — an upstream deletion that never reaches an installed agent is how stale content ships forever`,
  )

  progress?.('marketplace:uninstall')
  const uninstalled = await stagingFetch(
    `${subscriptionsUrl}/${encodeURIComponent(installed.subscription.id)}`,
    { method: 'DELETE', headers: bearer(apiToken) },
  )
  assert.equal(uninstalled.status, 200, 'uninstall must detach the subscription cleanly')
  const additionalUninstalled = await stagingFetch(
    `${subscriptionsUrl}/${encodeURIComponent(additional.subscription.id)}`,
    { method: 'DELETE', headers: bearer(apiToken) },
  )
  assert.equal(
    additionalUninstalled.status,
    200,
    'the additional instance must uninstall independently',
  )
  return {
    anonymousCatalogStatus: anonymous.status,
    gatedPublishStatus: gated.status,
    catalogListings: catalog.items.length,
    verifiedListings: verified.length,
    taggedListings: synced.items.filter(listing => listing.tags.length > 0).length,
    listingsWithDerivedSkills: synced.items.filter(listing => listing.skills.length > 0).length,
    originRequestsDuringCatalogRead: 0,
    installedListingId: installed.subscription.listingId,
    installedAgentName: installed.subscription.agentName,
    installedInstanceCount: liveSubscriptions.length,
    additionalInstanceDistinct:
      additional.subscription.id !== installed.subscription.id &&
      additional.subscription.agentId !== installed.subscription.agentId,
    canonicalReplayStable: replayed.subscription.id === installed.subscription.id,
    bareNameInstallStatus: bareName.status,
    firstSyncWrote: firstSync.written.length,
    secondSyncWrote: secondSync.written.length,
    hubEtagStable: etagAfterSecond === etagAfterFirst,
    residueReaped: reapSync.deleted.includes(residueHubPath),
    residueLeftSubscriber: departed,
  }
}

/**
 * The per-agent zip ETag the marketplace puller conditions on. Read from the
 * public edge exactly as a subscriber's gateway would, so the comparison is of
 * the thing subscribers actually see rather than an internal proxy for it.
 */
async function hubAgentEtag(hubSlug: string, agentName: string): Promise<string | null> {
  const response = await stagingFetch(
    `https://${DUET_STAGING_EDGE_HOST}/${hubSlug}/${OFFICIAL_AGENTS_PUBLISH_SLUG}/${agentName}?zip`,
    { method: 'HEAD' },
  )
  return response.ok ? response.headers.get('etag') : null
}

/**
 * The marketplace lines of the VM's own gateway log.
 *
 * `pull_failed` is what the puller reports for ANY exception it does not
 * recognise, so the control-plane code alone cannot explain a failure — only
 * the gateway's log carries the original. Fetched through internal-admin with a
 * throwaway team-domain identity, and deliberately best-effort: a diagnostic
 * that can itself fail the journey would mask the failure it exists to explain.
 */

/**
 * The edge caches publish resolutions for ~30s, so a change written to the hub
 * is not instantly what a subscriber would fetch. Waits for the archive ETag a
 * subscriber sees to move off `previous`.
 */
const EDGE_CACHE_TIMEOUT_MS = 90_000

async function waitForEtagChange(
  read: () => Promise<string | null>,
  previous: string | null,
): Promise<boolean> {
  const deadline = Date.now() + EDGE_CACHE_TIMEOUT_MS
  for (;;) {
    const current = await read()
    if (current !== null && current !== previous) return true
    if (Date.now() >= deadline) return false
    await new Promise(resolve => setTimeout(resolve, 3_000))
  }
}
