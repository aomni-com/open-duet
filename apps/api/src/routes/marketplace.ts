// Deploy rail note: the staging ignore-step only triggers a build on changes
// under apps/api, and the Convex push runs INSIDE that build — so a
// backend-only change (packages/backend) never deploys on its own. Touch this
// file to carry one. (Carried: the agent.installed analytics event.)
import { ConvexError } from 'convex/values'

import {
  MarketplaceAgentInstallRequestSchema,
  MarketplaceListingCreateRequestSchema,
  isCollectionCursorError,
  MarketplaceListingRefusalSchema,
  deriveListingMetadata,
  MarketplaceAgentCloneRequestSchema,
  MarketplaceAgentMutationErrorSchema,
  WorkspaceOnboardingRequestSchema,
  WorkspaceOnboardingResponseSchema,
  MarketplaceAgentSubscriptionListSchema,
  MarketplaceAgentSubscriptionListQuerySchema,
  MarketplaceAgentSubscriptionResponseSchema,
  MarketplaceAgentUninstallResponseSchema,
  type MarketplaceAgentSubscription,
  type MarketplaceInstallSource,
  MarketplaceCatalogQuerySchema,
  MarketplaceCatalogResponseSchema,
  type MarketplaceListingSummary,
} from '@repo/contract'

import {
  createContinuationCollectionPage,
  createMaterializedCollectionPage,
} from '../collection-page'
import type { GatewayClient } from '../gateway/client'
import {
  fn,
  fnQuery,
  readJson,
  requireAuthedWorkspace,
  type ApiApp,
  type ApiContext,
  type ApiRouteRuntime,
  type WorkspaceRef,
} from '../shared'

/** A person pressing Install on the marketplace itself. */
const MARKETPLACE_INSTALL_SOURCE: MarketplaceInstallSource = 'marketplace'
const catalogPages = createContinuationCollectionPage('marketplace.catalog')
const subscriptionPages = createMaterializedCollectionPage('marketplace.subscriptions.list')

export function registerMarketplaceAgentsRoutes(
  app: ApiApp,
  runtime: ApiRouteRuntime,
  gatewayClient: GatewayClient,
  dependencies: {
    campaignAgentNamesForUser?: (userId: string) => Promise<readonly string[]>
  } = {},
): void {
  const campaignAgentNamesForUser =
    dependencies.campaignAgentNamesForUser ??
    (async (userId: string) =>
      (await runtime.convex.query(fnQuery('domains/campaigns/starterAgents:starterAgentsForUser'), {
        internalKey: runtime.internalKey,
        userId,
      })) as string[])

  // Catalog reads are signed-in and Convex-only: no anonymous access (MAP
  // decision 15, no public lander yet) and no request ever reaches a
  // publisher's VM, so one sleeping publisher cannot slow the shared path.
  app.get('/v1/marketplace', async c => {
    const query = MarketplaceCatalogQuerySchema.safeParse(c.req.query())
    if (!query.success) return c.json({ error: 'invalid_request' }, 400)
    const binding = {
      subject: `user:${c.get('auth').user.id}`,
      filters: {
        q: query.data.q,
        tag: query.data.tag,
        availability: query.data.availability,
        verifiedPublisher: query.data.verifiedPublisher,
      },
      order: 'installs desc, internal creation time desc',
    }
    let pagination
    try {
      pagination = await catalogPages.paginationOpts(query.data, binding)
    } catch (error) {
      if (isCollectionCursorError(error)) return c.json({ error: 'invalid_cursor' }, 400)
      throw error
    }
    const result = (await runtime.convex.query(
      fnQuery('domains/marketplace/listings:catalogPage'),
      { internalKey: runtime.internalKey, paginationOpts: pagination },
    )) as {
      page: MarketplaceListingSummary[]
      continueCursor: string
      isDone: boolean
      canPublishListings: boolean
    }
    const q = query.data.q?.toLocaleLowerCase()
    // Filtering is page-relative to the bounded Convex read. A sparse match
    // may therefore return a short or empty page with a continuation; that
    // continuation has already advanced past the inspected source rows.
    const listings = result.page.filter(listing => {
      if (
        query.data.verifiedPublisher !== undefined &&
        listing.verifiedPublisher !== query.data.verifiedPublisher
      )
        return false
      if (query.data.tag !== undefined && !listing.tags.includes(query.data.tag)) return false
      if (query.data.availability !== undefined && listing.availability !== query.data.availability)
        return false
      return (
        q === undefined ||
        `${listing.title} ${listing.summary} ${listing.agentName} ${listing.publisherSlug}`
          .toLocaleLowerCase()
          .includes(q)
      )
    })
    try {
      const page = await catalogPages.response({ ...result, page: listings }, binding)
      return c.json(
        MarketplaceCatalogResponseSchema.parse({
          ...page,
          meta: { canPublishListings: result.canPublishListings },
        }),
      )
    } catch (error) {
      if (isCollectionCursorError(error)) return c.json({ error: 'invalid_cursor' }, 400)
      throw error
    }
  })

  app.get('/v1/marketplace/:publisherSlug/:agentName', async c => {
    if (new URL(c.req.url).search.length > 0) return c.json({ error: 'invalid_request' }, 400)
    const detail = await runtime.convex.query(fnQuery('domains/marketplace/listings:detail'), {
      internalKey: runtime.internalKey,
      publisherSlug: c.req.param('publisherSlug'),
      agentName: c.req.param('agentName'),
    })
    return detail === null ? c.json({ error: 'not_found' }, 404) : c.json(detail)
  })

  // Order matters and is the whole point: gate, then inspect through the
  // publisher's own gateway, THEN create the publish and the listing. An
  // ineligible agent is refused before anything of it becomes public.
  app.post('/v1/ws/:workspaceSlug/listings', async c => {
    const workspace = requireAuthedWorkspace(c, 'agents')
    if ('response' in workspace) return workspace.response
    if (workspace.role === 'viewer') return c.json({ error: 'forbidden' }, 403)
    const body = MarketplaceListingCreateRequestSchema.safeParse(await readJson(c.req.raw))
    if (!body.success) return c.json({ error: 'invalid_request' }, 400)

    // The GATE COMES FIRST. Inspecting before checking it means a caller who
    // may not publish at all still triggers a walk of their VM, and is answered
    // with a 409 about their agent instead of a 403 about the capability. Found
    // by the live staging journey.
    const capability = (await runtime.convex.query(
      fnQuery('domains/marketplace/listings:catalog'),
      { internalKey: runtime.internalKey, limit: 1 },
    )) as { canPublishListings: boolean }
    if (!capability.canPublishListings) return c.json({ error: 'publishing_disabled' }, 403)

    const agentPath = `agents/${body.data.agentSlug}`
    const inspection = await gatewayClient.inspectListableAgent(workspace.slug, agentPath)
    if (!inspection.ok) {
      return c.json(
        { error: inspection.error },
        inspection.error === 'gateway_unavailable' ? 502 : 409,
      )
    }
    const derived = deriveListingMetadata({
      ...inspection.origin,
      // Absent on the wire from a gateway that predates tags; absent and null
      // both mean "this agent declared none", and the snapshot type carries
      // one spelling of that so the projection never has to know which.
      agentJson: inspection.origin.agentJson ?? null,
      agentDisplayName: body.data.title ?? body.data.agentSlug,
    })
    if ('error' in derived) return c.json({ error: derived.error }, 409)

    try {
      const listing = await runtime.convex.mutation(
        fn('domains/marketplace/listings:registerListingFromAgent'),
        {
          internalKey: runtime.internalKey,
          actorId: c.get('auth').user.id,
          workspaceId: workspace.id,
          agentSlug: body.data.agentSlug,
          derived,
          ...(body.data.title === undefined ? {} : { titleOverride: body.data.title }),
          ...(body.data.summary === undefined ? {} : { summaryOverride: body.data.summary }),
        },
      )
      return c.json({ listing }, 201)
    } catch (error) {
      return listingMutationError(c, error)
    }
  })

  app.delete('/v1/ws/:workspaceSlug/listings/:listingId', async c => {
    const workspace = requireAuthedWorkspace(c, 'agents')
    if ('response' in workspace) return workspace.response
    if (workspace.role === 'viewer') return c.json({ error: 'forbidden' }, 403)
    try {
      return c.json(
        await runtime.convex.mutation(fn('domains/marketplace/listings:unlistListing'), {
          internalKey: runtime.internalKey,
          actorId: c.get('auth').user.id,
          workspaceId: workspace.id,
          listingId: c.req.param('listingId'),
        }),
      )
    } catch (error) {
      return listingMutationError(c, error)
    }
  })

  app.get('/v1/ws/:workspaceSlug/marketplace/subscriptions', async c => {
    const workspace = requireAuthedWorkspace(c, 'agents')
    if ('response' in workspace) return workspace.response
    const query = MarketplaceAgentSubscriptionListQuerySchema.safeParse(c.req.query())
    if (!query.success) return c.json({ error: 'invalid_request' }, 400)
    const subscriptions = (await runtime.convex.query(
      fnQuery('domains/marketplace/model:listByWorkspace'),
      { internalKey: runtime.internalKey, workspaceId: workspace.id },
    )) as MarketplaceAgentSubscription[]
    try {
      const page = await subscriptionPages.response(
        query.data,
        {
          subject: `workspace:${workspace.id}`,
          filters: {},
          order: 'agent name asc, path asc, subscription id asc',
        },
        subscriptions,
        subscription => [subscription.agentName, subscription.path, subscription.id],
      )
      return c.json(MarketplaceAgentSubscriptionListSchema.parse(page))
    } catch (error) {
      if (isCollectionCursorError(error)) return c.json({ error: 'invalid_cursor' }, 400)
      throw error
    }
  })

  app.post('/v1/ws/:workspaceSlug/onboarding', async c => {
    const workspace = requireAuthedWorkspace(c, 'agents', { allowIncomplete: true })
    if ('response' in workspace) return workspace.response
    if (workspace.role !== 'owner') return c.json({ error: 'forbidden' }, 403)
    const body = WorkspaceOnboardingRequestSchema.safeParse(await readJson(c.req.raw))
    if (!body.success) return c.json({ error: 'invalid_request' }, 400)
    const campaignNames = await campaignAgentNamesForUser(c.get('auth').user.id)
    const clientNames = 'skip' in body.data ? [] : body.data.selectedNames
    const names = [...campaignNames, ...clientNames.filter(name => !campaignNames.includes(name))]
    // Who asked. An agent the user picked is their choice even when a campaign
    // also seeded it — being shown an agent is not choosing one, and it is the
    // choosing that a breakdown of onboarding picks means to count.
    const installSource = (name: string): MarketplaceInstallSource =>
      clientNames.includes(name) ? 'onboarding' : 'campaign'

    let completion: { duetName: string; onboardedAt: number }
    try {
      completion = (await runtime.convex.mutation(
        fn('domains/workspaces/birth:completeWorkspaceOnboarding'),
        {
          internalKey: runtime.internalKey,
          actorId: c.get('auth').user.id,
          workspaceId: workspace.id,
          duetName: body.data.duetName,
          ...(body.data.purpose === undefined ? {} : { purpose: body.data.purpose }),
          ...(body.data.goal === undefined ? {} : { goal: body.data.goal }),
          // What the USER chose, so `names` above — which leads with the agents a
          // campaign seeded — would answer a different question than the one the
          // team step asked.
          selectedAgentNames: clientNames,
        },
      )) as { duetName: string; onboardedAt: number }
    } catch (error) {
      if (
        error instanceof ConvexError &&
        typeof error.data === 'object' &&
        error.data !== null &&
        (error.data as { error?: unknown }).error === 'payment_method_required'
      ) {
        return c.json({ error: 'payment_method_required' }, 409)
      }
      throw error
    }
    // Onboarding and campaigns are the only callers that still speak bare
    // names, and they resolve through the ONE official-workspace resolver, so a
    // community listing sharing the name can never satisfy a campaign.
    // Everything downstream of here is listing-keyed.
    const resolved = (await runtime.convex.query(
      fnQuery('domains/marketplace/listings:officialListingIdsByName'),
      { internalKey: runtime.internalKey, names },
    )) as Array<{ name: string; listingId: string | null }>

    const results = []
    for (const { name, listingId } of resolved) {
      try {
        if (listingId === null) throw new ConvexError({ error: 'listing_removed' })
        const subscription = await runtime.convex.mutation(
          fn('domains/marketplace/model:install'),
          {
            internalKey: runtime.internalKey,
            actorId: c.get('auth').user.id,
            workspaceId: workspace.id,
            listingId,
            source: installSource(name),
          },
        )
        results.push({ name, ok: true as const, subscription })
      } catch (error) {
        const parsed =
          error instanceof ConvexError
            ? MarketplaceAgentMutationErrorSchema.safeParse(error.data)
            : undefined
        // A campaign-derived install that fails is the product's problem, not
        // the new user's: they never asked for this agent and can do nothing
        // about it. Surfacing it would put an unactionable error in front of
        // every person registering through that campaign, so it is logged and
        // marked, never shown. A failure for an agent the user picked
        // themselves still surfaces.
        const campaign = campaignNames.includes(name)
        if (campaign) {
          console.warn('[onboarding] campaign marketplace install failed', {
            workspaceId: workspace.id,
            name,
          })
        }
        results.push({
          name,
          ok: false as const,
          ...(campaign ? { campaign: true as const } : {}),
          failure: parsed?.success === true ? parsed.data : { error: 'install_failed' as const },
        })
      }
    }
    const pulled = results.some(result => result.ok)
      ? await pullAndApplyMarketplaceAgents(runtime, gatewayClient, workspace)
      : undefined
    const settled = new Map(
      (pulled?.subscriptions ?? []).map(subscription => [subscription.id, subscription]),
    )
    return c.json(
      WorkspaceOnboardingResponseSchema.parse({
        ...completion,
        results: results.map(result => {
          if (!result.ok) return result
          const applied = settled.get(result.subscription.id)
          if (applied !== undefined) return { ...result, subscription: applied }
          if (pulled?.ok === true) {
            throw new Error('Applied marketplace subscription missing')
          }
          return result
        }),
        ...(pulled?.ok === false ? { pullError: 'pull_failed' as const } : {}),
      }),
    )
  })

  app.post('/v1/ws/:workspaceSlug/marketplace/subscriptions', async c => {
    const workspace = requireAuthedWorkspace(c, 'agents')
    if ('response' in workspace) return workspace.response
    if (workspace.role === 'viewer') return c.json({ error: 'forbidden' }, 403)
    const body = MarketplaceAgentInstallRequestSchema.safeParse(await readJson(c.req.raw))
    if (!body.success) return c.json({ error: 'invalid_request' }, 400)
    try {
      const subscription = await runtime.convex.mutation(fn('domains/marketplace/model:install'), {
        internalKey: runtime.internalKey,
        actorId: c.get('auth').user.id,
        workspaceId: workspace.id,
        listingId: body.data.listingId,
        name: body.data.name,
        ...(body.data.path === undefined ? {} : { path: body.data.path }),
        source: MARKETPLACE_INSTALL_SOURCE,
      })
      const pulled = await pullAndApplyMarketplaceAgents(runtime, gatewayClient, workspace)
      if (!pulled.ok) return pulled.response
      const applied = requireAppliedSubscription(pulled.subscriptions, subscription.id)
      return c.json(
        MarketplaceAgentSubscriptionResponseSchema.parse({ subscription: applied }),
        201,
      )
    } catch (error) {
      return marketplaceMutationError(c, error)
    }
  })

  app.post('/v1/ws/:workspaceSlug/marketplace/subscriptions/clone', async c => {
    const workspace = requireAuthedWorkspace(c, 'agents')
    if ('response' in workspace) return workspace.response
    if (workspace.role === 'viewer') return c.json({ error: 'forbidden' }, 403)
    const body = MarketplaceAgentCloneRequestSchema.safeParse(await readJson(c.req.raw))
    if (!body.success) return c.json({ error: 'invalid_request' }, 400)
    try {
      const subscription = await runtime.convex.mutation(fn('domains/marketplace/model:clone'), {
        internalKey: runtime.internalKey,
        actorId: c.get('auth').user.id,
        workspaceId: workspace.id,
        listingId: body.data.listingId,
        path: body.data.path,
        source: MARKETPLACE_INSTALL_SOURCE,
      })
      const pulled = await pullAndApplyMarketplaceAgents(runtime, gatewayClient, workspace)
      if (!pulled.ok) return pulled.response
      const applied = requireAppliedSubscription(pulled.subscriptions, subscription.id)
      return c.json(
        MarketplaceAgentSubscriptionResponseSchema.parse({ subscription: applied }),
        201,
      )
    } catch (error) {
      return marketplaceMutationError(c, error)
    }
  })

  app.post(
    '/v1/ws/:workspaceSlug/marketplace/subscriptions/:subscriptionId/acknowledge',
    async c => {
      const workspace = requireAuthedWorkspace(c, 'agents')
      if ('response' in workspace) return workspace.response
      if (workspace.role === 'viewer') return c.json({ error: 'forbidden' }, 403)
      try {
        const subscription = await runtime.convex.mutation(
          fn('domains/marketplace/model:acknowledge'),
          {
            internalKey: runtime.internalKey,
            actorId: c.get('auth').user.id,
            workspaceId: workspace.id,
            subscriptionId: c.req.param('subscriptionId'),
          },
        )
        return c.json(MarketplaceAgentSubscriptionResponseSchema.parse({ subscription }))
      } catch (error) {
        return marketplaceMutationError(c, error)
      }
    },
  )

  app.delete('/v1/ws/:workspaceSlug/marketplace/subscriptions/:subscriptionId', async c => {
    const workspace = requireAuthedWorkspace(c, 'agents')
    if ('response' in workspace) return workspace.response
    if (workspace.role === 'viewer') return c.json({ error: 'forbidden' }, 403)
    try {
      const result = await runtime.convex.mutation(fn('domains/marketplace/model:uninstall'), {
        internalKey: runtime.internalKey,
        actorId: c.get('auth').user.id,
        workspaceId: workspace.id,
        subscriptionId: c.req.param('subscriptionId'),
      })
      return c.json(MarketplaceAgentUninstallResponseSchema.parse(result))
    } catch (error) {
      return marketplaceMutationError(c, error)
    }
  })
}

async function pullAndApplyMarketplaceAgents(
  runtime: ApiRouteRuntime,
  gatewayClient: GatewayClient,
  workspace: Pick<WorkspaceRef, 'id' | 'slug'>,
): Promise<
  | { ok: true; subscriptions: MarketplaceAgentSubscription[] }
  | { ok: false; subscriptions: MarketplaceAgentSubscription[]; response: Response }
> {
  const pulled = await gatewayClient.pushMarketplaceAgentsPull(workspace.slug)
  const applied =
    pulled.reports === undefined
      ? undefined
      : await runtime.convex.mutation(fn('domains/marketplace/model:applyPullReports'), {
          internalKey: runtime.internalKey,
          workspaceId: workspace.id,
          reports: pulled.reports,
        })
  const subscriptions = applied?.subscriptions ?? []
  return pulled.ok
    ? { ok: true, subscriptions }
    : { ok: false, subscriptions, response: pulled.response }
}

function requireAppliedSubscription(
  subscriptions: MarketplaceAgentSubscription[],
  subscriptionId: string,
): MarketplaceAgentSubscription {
  const subscription = subscriptions.find(candidate => candidate.id === subscriptionId)
  if (subscription === undefined) throw new Error('Applied marketplace subscription missing')
  return subscription
}

function marketplaceMutationError(c: ApiContext, error: unknown) {
  if (error instanceof ConvexError) {
    const parsed = MarketplaceAgentMutationErrorSchema.safeParse(error.data)
    if (parsed.success) return c.json(parsed.data, 409)
  }
  const message = error instanceof Error ? error.message : String(error)
  if (/Requires editor access|not found/i.test(message)) {
    return c.json(
      { error: /not found/i.test(message) ? 'not_found' : 'forbidden' },
      /not found/i.test(message) ? 404 : 403,
    )
  }
  throw error
}

function listingMutationError(c: ApiContext, error: unknown) {
  if (error instanceof ConvexError) {
    const parsed = MarketplaceListingRefusalSchema.safeParse(error.data)
    if (parsed.success) {
      // `publishing_disabled` is an authorization answer, not a bad request:
      // the caller is well-formed, the capability is closed.
      return c.json(parsed.data, parsed.data.error === 'publishing_disabled' ? 403 : 409)
    }
  }
  throw error
}
