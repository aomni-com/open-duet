import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

import { ConvexHttpClient } from 'convex/browser'
import { ConvexError } from 'convex/values'

import { MAX_AGENTS_PER_WORKSPACE, appControls } from '@repo/contract'
import { OFFICIAL_AGENTS_WORKSPACE_SLUG } from '@repo/official-agents-seed/manifest'
import {
  convexDev,
  generateAuthKeys,
  mutate,
  query,
  signInWithMagicLink,
  TEST_AUTH_CODE,
  uniqueEmail,
  type ConvexDevFixture,
} from '@repo/test-harness'

import type { Doc } from '../convex/_generated/dataModel'

const INTERNAL_KEY = 'test-official-agents-internal-key'
const BACKEND_DIR = new URL('..', import.meta.url).pathname

let convex: ConvexDevFixture
let owner: { client: ConvexHttpClient; user: { _id: string; email: string } }
let sequence = 0
let sharedGolden: { workspaceId: string; listings: GoldenListings } | undefined

type GoldenListings = Record<'research' | 'writer' | 'analyst', string>

describe('official agents backend domain (OA-SLICE-03-KZQ7)', () => {
  beforeAll(async () => {
    convex = await convexDev(BACKEND_DIR, {
      env: {
        ...generateAuthKeys(),
        DUET_API_INTERNAL_KEY: INTERNAL_KEY,
        DUET_TEST_AUTH_CODE: TEST_AUTH_CODE,
        DUET_TEST_AUTH_EMAIL: '1',
        DUET_APP_URL: 'http://localhost:3000',
      },
      reset: true,
    })
    owner = await signInWithMagicLink(
      convex,
      uniqueEmail('official-agents-owner'),
      'Official Agents Owner',
    )
  }, 240_000)

  afterAll(async () => {
    await convex?.stop()
  })

  test('install registers an installing subscription, agent, and translated golden apps', async () => {
    const { goldenWorkspaceId, workspaceId, listings } = await officialFixture('install')
    await mutate(owner.client, 'domains/apps/model:registerApp', {
      workspaceId: goldenWorkspaceId,
      path: 'official/research/apps/dashboard',
      slug: 'dashboard',
      name: 'Dashboard',
      command: 'bun run start',
      apiScopes: [],
      installCommand: 'bun install',
      now: 10_100,
    })

    const subscription = (await mutate(owner.client, 'domains/marketplace/model:install', {
      workspaceId,
      listingId: listings.research,
      now: 11_000,
    })) as { id: string; state: string; path: string; agentId: string; anchorId: string }

    expect(subscription).toMatchObject({
      listingId: listings.research,
      path: 'agents/research',
      mode: 'subscribe',
      state: 'installing',
    })
    const agents = await rawAgents()
    expect(agents.find(agent => agent._id === subscription.agentId)).toMatchObject({
      workspaceId,
      anchorId: subscription.anchorId,
      slug: 'research',
      listingSubscriptionId: subscription.id,
    })
    expect(
      await query(owner.client, 'domains/agents/model:listByWorkspace', { workspaceId }),
    ).toContainEqual(expect.objectContaining({ listingSubscriptionId: subscription.id }))
    const apps = (await query(convex, 'testing/apps:rawAppsForTest', {
      internalKey: INTERNAL_KEY,
    })) as Doc<'apps'>[]
    const installedApp = apps.find(app => app.listingSubscriptionId === subscription.id)
    expect(installedApp).toMatchObject({
      workspaceId,
      command: 'bun run start',
      installCommand: 'bun install',
      apiScopes: [],
      name: 'Dashboard',
      listingSubscriptionId: subscription.id,
    })
    expect(
      await query(owner.client, 'domains/anchors/model:getById', {
        anchorId: installedApp?.anchorId,
      }),
    ).toMatchObject({ path: 'agents/research/apps/dashboard' })
  })

  // The chosen name is the installer's, permanently. Nothing about a listing —
  // a pull, an ETag bump, an app-declaration refresh, or the publisher renaming
  // their own agent — may reach back into it, which is the property that makes
  // asking for a name at install worth doing at all.
  test('an install keeps the name its installer chose, and the slug stays the listing’s', async () => {
    const { workspaceId, listings } = await officialFixture('install-name')

    const subscription = (await mutate(owner.client, 'domains/marketplace/model:install', {
      workspaceId,
      listingId: listings.research,
      name: 'Mary',
      now: 11_000,
    })) as { id: string; agentId: string; agentName: string }

    // Two different fields with two different owners: the installer names the
    // agent, the listing owns the subscription's slug cache.
    expect(subscription.agentName).toBe('research')
    const installed = (await rawAgents()).find(agent => agent._id === subscription.agentId)
    expect(installed).toMatchObject({ name: 'Mary', slug: 'research' })

    await mutate(convex, 'domains/marketplace/model:applyPullReports', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      reports: [
        {
          subscriptionId: subscription.id,
          state: 'active',
          appliedEtag: 'etag-2',
          lastAppliedAt: 12_000,
        },
      ],
      now: 12_000,
    })

    const afterPull = (await rawAgents()).find(agent => agent._id === subscription.agentId)
    expect(afterPull).toMatchObject({ name: 'Mary', slug: 'research' })
  })

  // Nobody to prompt — a campaign link, a signup's starter agents — and a user
  // who simply declined to type one reach the same place: the agent wears the
  // listing's slug. One fallback, not two.
  test('an install with no name takes the listing slug', async () => {
    const { goldenWorkspaceId, workspaceId } = await officialFixture('install-unnamed')
    const titled = await seedTitledListing(goldenWorkspaceId, 'titled-agent', 'Titled Agent')

    const subscription = (await mutate(owner.client, 'domains/marketplace/model:install', {
      workspaceId,
      listingId: titled,
      now: 11_000,
    })) as { agentId: string }

    // Deliberately NOT the listing's title: the fallback is the slug, so a
    // title-preference rule cannot creep back in unnoticed.
    const installed = (await rawAgents()).find(agent => agent._id === subscription.agentId)
    expect(installed).toMatchObject({ name: 'titled-agent', slug: 'titled-agent' })
  })

  test('replaying a canonical install adopts the existing official subscription', async () => {
    const { workspaceId, listings } = await officialFixture('install-replay')
    const first = (await mutate(owner.client, 'domains/marketplace/model:install', {
      workspaceId,
      listingId: listings.research,
      now: 11_000,
    })) as Subscription

    const replay = (await mutate(owner.client, 'domains/marketplace/model:install', {
      workspaceId,
      listingId: listings.research,
      now: 12_000,
    })) as Subscription

    expect(replay).toEqual(first)
    expect(await rawSubscriptions(workspaceId)).toEqual([
      expect.objectContaining({
        _id: first.id,
        listingId: listings.research,
        agentName: 'research',
        path: 'agents/research',
      }),
    ])
  })

  test('subscription listing ignores long detached history and orders every live state', async () => {
    const { workspaceId, listings } = await officialFixture('list-live-states')
    await mutate(convex, 'testing/marketplace:seedSubscriptionListHistoryForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      listingId: listings.research,
      createdByUserId: owner.user._id,
      detachedCount: 1_000,
      live: [
        { agentName: 'zeta', path: 'agents/zeta', state: 'error' },
        { agentName: 'alpha', path: 'agents/alpha', state: 'active' },
        { agentName: 'mu', path: 'agents/mu', state: 'installing' },
      ],
    })

    const listed = await listSubscriptions(workspaceId)

    expect(listed.map(row => [row.agentName, row.path, row.state])).toEqual([
      ['alpha', 'agents/alpha', 'active'],
      ['mu', 'agents/mu', 'installing'],
      ['zeta', 'agents/zeta', 'error'],
    ])
  })

  test('an install records the listing it came from, and a replay records nothing', async () => {
    const { workspaceId, listings } = await officialFixture('install-audit')
    const installed = (await mutate(owner.client, 'domains/marketplace/model:install', {
      workspaceId,
      listingId: listings.research,
      name: 'Renamed Research',
      source: 'onboarding',
      now: 11_000,
    })) as Subscription

    expect(await installEvents(workspaceId)).toEqual([
      {
        event: 'agent.installed',
        actorId: owner.user._id,
        at: 11_000,
        provenance: {
          subscriptionId: installed.id,
          listingId: listings.research,
          // The PUBLISHER's slug, which is what a breakdown counts — not the
          // installer's `slug`/`name`, which they may rename to anything.
          listingSlug: 'research',
          agentId: installed.agentId,
          anchorId: installed.anchorId,
          slug: 'research',
          path: 'agents/research',
          installMode: 'subscribe',
          source: 'onboarding',
        },
      },
    ])

    // The replay adopts the existing subscription rather than installing, so
    // counting installs must not count it twice.
    await mutate(owner.client, 'domains/marketplace/model:install', {
      workspaceId,
      listingId: listings.research,
      source: 'marketplace',
      now: 12_000,
    })
    expect(await installEvents(workspaceId)).toHaveLength(1)

    // A second copy of the SAME listing at a renamed path: the two slugs now
    // disagree, and it is the listing's that says which agent was installed.
    await mutate(owner.client, 'domains/marketplace/model:install', {
      workspaceId,
      listingId: listings.research,
      path: 'agents/customer-portal',
      now: 13_000,
    })
    expect((await installEvents(workspaceId)).at(-1)).toMatchObject({
      provenance: expect.objectContaining({
        listingSlug: 'research',
        slug: 'customer-portal',
        source: 'marketplace',
      }),
    })
  })

  test('one listing supports independent canonical and explicitly named subscriptions', async () => {
    const { workspaceId, listings } = await officialFixture('multi')
    const installBaseline = await listingInstallCount(listings.research)

    const canonical = (await mutate(owner.client, 'domains/marketplace/model:install', {
      workspaceId,
      listingId: listings.research,
      now: 12_100,
    })) as Subscription
    const customerPortal = (await mutate(owner.client, 'domains/marketplace/model:install', {
      workspaceId,
      listingId: listings.research,
      name: 'Customer Portal',
      path: 'agents/customer-portal',
      now: 12_200,
    })) as Subscription
    const adminConsole = (await mutate(owner.client, 'domains/marketplace/model:install', {
      workspaceId,
      listingId: listings.research,
      name: 'Admin Console',
      path: 'agents/admin-console',
      now: 12_300,
    })) as Subscription

    const replay = (await mutate(owner.client, 'domains/marketplace/model:install', {
      workspaceId,
      listingId: listings.research,
      name: 'Ignored replay name',
      now: 12_400,
    })) as Subscription

    expect(replay).toEqual(canonical)
    expect(new Set([canonical.id, customerPortal.id, adminConsole.id]).size).toBe(3)
    expect(new Set([canonical.agentId, customerPortal.agentId, adminConsole.agentId]).size).toBe(3)
    const subscriptions = (await rawSubscriptions(workspaceId)).filter(
      subscription => subscription.listingId === listings.research,
    )
    expect(subscriptions).toHaveLength(3)
    expect(
      subscriptions.map(subscription => ({
        id: subscription._id,
        agentId: subscription.agentId,
        listingId: subscription.listingId,
        agentName: subscription.agentName,
        path: subscription.path,
        mode: subscription.mode,
        state: subscription.state,
      })),
    ).toEqual(
      expect.arrayContaining([
        {
          id: canonical.id,
          agentId: canonical.agentId,
          listingId: listings.research,
          agentName: 'research',
          path: 'agents/research',
          mode: 'subscribe',
          state: 'installing',
        },
        {
          id: customerPortal.id,
          agentId: customerPortal.agentId,
          listingId: listings.research,
          agentName: 'research',
          path: 'agents/customer-portal',
          mode: 'subscribe',
          state: 'installing',
        },
        {
          id: adminConsole.id,
          agentId: adminConsole.agentId,
          listingId: listings.research,
          agentName: 'research',
          path: 'agents/admin-console',
          mode: 'subscribe',
          state: 'installing',
        },
      ]),
    )
    expect(
      (await rawAgents())
        .filter(agent =>
          [canonical.agentId, customerPortal.agentId, adminConsole.agentId].includes(agent._id),
        )
        .map(agent => ({
          id: agent._id,
          name: agent.name,
          listingSubscriptionId: agent.listingSubscriptionId,
        })),
    ).toEqual(
      expect.arrayContaining([
        { id: canonical.agentId, name: 'research', listingSubscriptionId: canonical.id },
        {
          id: customerPortal.agentId,
          name: 'Customer Portal',
          listingSubscriptionId: customerPortal.id,
        },
        {
          id: adminConsole.agentId,
          name: 'Admin Console',
          listingSubscriptionId: adminConsole.id,
        },
      ]),
    )
    expect(await listingInstallCount(listings.research)).toBe(installBaseline + 3)

    for (const [index, subscription] of [customerPortal, canonical, adminConsole].entries()) {
      await mutate(owner.client, 'domains/marketplace/model:uninstall', {
        workspaceId,
        subscriptionId: subscription.id,
        now: 12_500 + index,
      })
      expect(await listingInstallCount(listings.research)).toBe(installBaseline + 2 - index)
    }
    expect(
      (await rawSubscriptions(workspaceId))
        .filter(subscription => subscription.listingId === listings.research)
        .map(subscription => subscription.state),
    ).toEqual(['detached', 'detached', 'detached'])
  })

  test('install refuses a claimed target path with the typed collision payload', async () => {
    const { workspaceId, listings } = await officialFixture('collision')
    await mutate(owner.client, 'testing/anchors:createAnchorForTest', {
      workspaceId,
      path: 'agents/research',
      kind: 'agent',
      settings: {},
    })

    const error = await mutate(owner.client, 'domains/marketplace/model:install', {
      workspaceId,
      listingId: listings.research,
    }).catch(value => value)

    expect(error).toBeInstanceOf(ConvexError)
    expect(
      (error as ConvexError<{ error: string; path: string; renameRequired: boolean }>).data,
    ).toEqual({
      error: 'path_exists',
      path: 'agents/research',
      renameRequired: true,
    })
  })

  test('a detached subscription does not hold its path against a fresh install', async () => {
    /* Detached is the tombstone every reader excludes — an uninstalled agent,
       a taken-down listing, a VM that lost the files. The collision check was
       the one reader that forgot, which left the canonical path "in use" by a
       row whose folder is gone by definition: an empty drive on which nothing
       could ever be installed at its own path again. Found live, on a
       workspace whose VM reset had detached every subscription. */
    const { workspaceId, listings } = await officialFixture('detached-path')
    const first = (await mutate(owner.client, 'domains/marketplace/model:install', {
      workspaceId,
      listingId: listings.research,
      now: 50_000,
    })) as Subscription
    await mutate(owner.client, 'domains/marketplace/model:uninstall', {
      workspaceId,
      subscriptionId: first.id,
      now: 50_100,
    })
    /* An uninstall alone rightly still collides: it unmanages the agent and
       the folder stays, so the anchor holds the path. The live case had lost
       the folder too — the drive was empty and the anchor rail had reaped the
       rows — leaving the tombstone as the only thing at the path. Deleting
       the agent models that half. */
    await mutate(owner.client, 'domains/agents/model:deleteAgent', {
      workspaceId,
      slug: 'research',
      now: 50_150,
    })

    const again = (await mutate(owner.client, 'domains/marketplace/model:install', {
      workspaceId,
      listingId: listings.research,
      now: 50_200,
    })) as Subscription

    // A fresh subscription at the canonical path — not the tombstone revived,
    // and not a rename dialog for a folder that does not exist.
    expect(again.path).toBe('agents/research')
    expect(again.id).not.toBe(first.id)
    expect(again.state).toBe('installing')
  })

  test('install accepts an explicit rename path and stays a subscription', async () => {
    const { workspaceId, listings } = await officialFixture('rename')
    await mutate(owner.client, 'testing/anchors:createAnchorForTest', {
      workspaceId,
      path: 'agents/research',
      kind: 'agent',
      settings: {},
    })

    const subscription = (await mutate(owner.client, 'domains/marketplace/model:install', {
      workspaceId,
      listingId: listings.research,
      path: 'agents/research-official',
    })) as { path: string; mode: string; state: string }

    expect(subscription.path).toBe('agents/research-official')
    expect(subscription.mode).toBe('subscribe')
    expect(subscription.state).toBe('installing')
  })

  test('two publishers of the same agent name are two distinct installs', async () => {
    // The case the whole listing-keyed cutover exists for. Every earlier
    // fixture had exactly one publisher, so name-keyed install looked correct.
    const { workspaceId, listings } = await officialFixture('same-name')
    const rivalWorkspaceId = await createWorkspace('same-name-rival')
    const rivalListingId = await seedListing(rivalWorkspaceId, 'research', { verified: false })

    const official = (await mutate(owner.client, 'domains/marketplace/model:install', {
      workspaceId,
      listingId: listings.research,
      now: 60_000,
    })) as Subscription
    // The canonical path is taken by the official install, so the community
    // listing of the SAME name collides rather than silently adopting it.
    const collision = await mutate(owner.client, 'domains/marketplace/model:install', {
      workspaceId,
      listingId: rivalListingId,
      now: 60_100,
    }).catch(value => value)
    expect((collision as ConvexError<{ error: string }>).data).toMatchObject({
      error: 'path_exists',
    })

    const rival = (await mutate(owner.client, 'domains/marketplace/model:install', {
      workspaceId,
      listingId: rivalListingId,
      path: 'agents/research-acme',
      now: 60_200,
    })) as Subscription
    expect(rival.id).not.toBe(official.id)
    expect(rival.listingId).toBe(rivalListingId)
    expect(official.listingId).toBe(listings.research)
    // Both carry the same display name — which is precisely why the name can
    // never be the identity.
    expect(rival.agentName).toBe(official.agentName)
  })

  test('official-name lookup uses the official workspace rather than another verified publisher', async () => {
    const rivalWorkspaceId = await createWorkspace('lookup-rival')
    await seedListing(rivalWorkspaceId, 'lookup-target', { verified: true })
    const { goldenWorkspaceId } = await officialFixture('lookup')
    const officialListingId = await seedListing(goldenWorkspaceId, 'lookup-target', {
      verified: true,
    })

    expect(
      await query(convex, 'domains/marketplace/listings:officialListingIdsByName', {
        internalKey: INTERNAL_KEY,
        names: ['lookup-target'],
      }),
    ).toEqual([{ name: 'lookup-target', listingId: officialListingId }])
  })

  test('install refuses an unavailable or removed listing with a typed error', async () => {
    const { workspaceId } = await officialFixture('unavailable')
    const deadWorkspaceId = await createWorkspace('unavailable-publisher')
    const deadListingId = await seedListing(deadWorkspaceId, 'dead-agent', { verified: false })

    await mutate(convex, 'testing/marketplace:setListingStateForTest', {
      internalKey: INTERNAL_KEY,
      listingId: deadListingId,
      availability: 'unavailable',
      now: 61_000,
    })
    const unavailable = await mutate(owner.client, 'domains/marketplace/model:install', {
      workspaceId,
      listingId: deadListingId,
      now: 61_100,
    }).catch(value => value)
    expect((unavailable as ConvexError<{ error: string }>).data).toEqual({
      error: 'listing_unavailable',
    })

    await mutate(convex, 'testing/marketplace:setListingStateForTest', {
      internalKey: INTERNAL_KEY,
      listingId: deadListingId,
      availability: 'available',
      state: 'unlisted',
      now: 61_200,
    })
    const removed = await mutate(owner.client, 'domains/marketplace/model:install', {
      workspaceId,
      listingId: deadListingId,
      now: 61_300,
    }).catch(value => value)
    expect((removed as ConvexError<{ error: string }>).data).toEqual({ error: 'listing_removed' })
  })

  test('install delegates the workspace agent cap to agent registration', async () => {
    const { workspaceId, listings } = await officialFixture('limit')
    const anchor = (await mutate(owner.client, 'testing/anchors:createAnchorForTest', {
      workspaceId,
      path: 'agents/filler',
      kind: 'agent',
      settings: {},
    })) as { id: string }
    await mutate(convex, 'testing/agents:fillWorkspaceAgentsForLimitTest', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      anchorId: anchor.id,
      createdByUserId: owner.user._id,
      count: MAX_AGENTS_PER_WORKSPACE,
      prefix: 'filler',
      now: 20_000,
    })

    const error = await mutate(owner.client, 'domains/marketplace/model:install', {
      workspaceId,
      listingId: listings.research,
    }).catch(value => value)
    expect(error).toBeInstanceOf(ConvexError)
    expect((error as ConvexError<{ error: string }>).data).toEqual({
      error: 'agent_limit_exceeded',
    })
  })

  test('uninstall detaches ownership while preserving registered rows', async () => {
    const fixture = await installedFixture('uninstall')
    await mutate(owner.client, 'domains/apps/model:updateApp', {
      workspaceId: fixture.goldenWorkspaceId,
      slug: 'dashboard',
      apiScopes: ['members'],
      now: 29_000,
    })
    await applyReport(fixture.workspaceId, fixture.subscription.id, 'etag-1', 30_000)
    const credentialApp = (await rawApps()).find(
      app => app.listingSubscriptionId === fixture.subscription.id,
    )!
    const credential = (await mutate(convex, 'domains/apiKeys/mutations:mintAppKey', {
      internalKey: INTERNAL_KEY,
      appId: credentialApp._id,
      now: 30_500,
    })) as { prefix: string }

    expect(
      await mutate(owner.client, 'domains/marketplace/model:uninstall', {
        workspaceId: fixture.workspaceId,
        subscriptionId: fixture.subscription.id,
        now: 31_000,
      }),
    ).toEqual({ ok: true })
    const subscriptions = await rawSubscriptions(fixture.workspaceId)
    expect(subscriptions).toContainEqual(
      expect.objectContaining({ _id: fixture.subscription.id, state: 'detached' }),
    )
    const agents = await rawAgents()
    expect(agents.find(agent => agent._id === fixture.subscription.agentId)).not.toHaveProperty(
      'listingSubscriptionId',
    )
    const installedApp = (await rawApps()).find(
      app => app.workspaceId === fixture.workspaceId && app.slug === 'dashboard',
    )
    expect(installedApp).toBeDefined()
    expect(installedApp).not.toHaveProperty('listingSubscriptionId')
    expect(installedApp).not.toHaveProperty('disabledAt')
    expect((await rawApiKeys()).find(key => key.prefix === credential.prefix)?.revokedAt).toBe(
      31_000,
    )
  })

  test('deleting a subscribed agent detaches ownership and decrements its install count', async () => {
    const fixture = await installedFixture('agent-delete')
    const installsBeforeDelete = await listingInstallCount(fixture.listings.research)

    await mutate(owner.client, 'domains/agents/model:deleteAgent', {
      workspaceId: fixture.workspaceId,
      slug: 'research',
      now: 31_000,
    })

    expect(await listSubscriptions(fixture.workspaceId)).toEqual([])
    expect(await rawSubscriptions(fixture.workspaceId)).toContainEqual(
      expect.objectContaining({
        _id: fixture.subscription.id,
        state: 'detached',
        updatedAt: 31_000,
      }),
    )
    expect((await rawAgents()).find(agent => agent._id === fixture.subscription.agentId)).toBe(
      undefined,
    )
    expect(
      (await rawApps()).find(
        app => app.workspaceId === fixture.workspaceId && app.slug === 'dashboard',
      ),
    ).not.toHaveProperty('listingSubscriptionId')
    expect(await listingInstallCount(fixture.listings.research)).toBe(installsBeforeDelete - 1)
  })

  test('clone materializes at the chosen path and detaches on its first applied report', async () => {
    const { goldenWorkspaceId, workspaceId, listings } = await officialFixture('clone')
    await seedGoldenApp(goldenWorkspaceId)
    const clone = (await mutate(owner.client, 'domains/marketplace/model:clone', {
      workspaceId,
      listingId: listings.research,
      path: 'my-agents/research-copy',
      now: 40_000,
    })) as Subscription
    expect(clone).toMatchObject({
      mode: 'clone_once',
      state: 'installing',
      path: 'my-agents/research-copy',
    })

    await applyReport(workspaceId, clone.id, 'clone-etag', 41_000)
    expect(await rawSubscriptions(workspaceId)).toContainEqual(
      expect.objectContaining({ _id: clone.id, state: 'detached', appliedEtag: 'clone-etag' }),
    )
    const clonedApp = (await rawApps()).find(
      app => app.workspaceId === workspaceId && app.slug === 'dashboard',
    )
    expect(clonedApp).not.toHaveProperty('listingSubscriptionId')
  })

  test('the first apply is its own receipt; only a later apply is unread', async () => {
    // The user installed exactly this revision, so there is nothing to
    // review. A card-side install never lands on the detail page (whose
    // viewing is what acknowledges), so an unstamped receipt here surfaces as
    // "Update available to review" the moment an install finishes.
    const fixture = await installedFixture('receipt')
    await applyReport(fixture.workspaceId, fixture.subscription.id, 'etag-initial', 60_000)
    const afterInstall = (await rawSubscriptions(fixture.workspaceId)).find(
      row => row._id === fixture.subscription.id,
    )!
    expect(afterInstall.appliedEtag).toBe('etag-initial')
    expect(afterInstall.acknowledgedEtag).toBe('etag-initial')

    // A REAL update moves the applied revision alone — the receipt stays put,
    // so the unread badge appears for updates and only for updates.
    await applyReport(fixture.workspaceId, fixture.subscription.id, 'etag-next', 61_000)
    const afterUpdate = (await rawSubscriptions(fixture.workspaceId)).find(
      row => row._id === fixture.subscription.id,
    )!
    expect(afterUpdate.appliedEtag).toBe('etag-next')
    expect(afterUpdate.acknowledgedEtag).toBe('etag-initial')
  })

  test('acknowledge durably copies the current applied etag', async () => {
    const fixture = await installedFixture('acknowledge')
    await applyReport(fixture.workspaceId, fixture.subscription.id, 'etag-current', 50_000)

    const acknowledged = await mutate(owner.client, 'domains/marketplace/model:acknowledge', {
      workspaceId: fixture.workspaceId,
      subscriptionId: fixture.subscription.id,
      now: 51_000,
    })
    expect(acknowledged).toMatchObject({
      appliedEtag: 'etag-current',
      acknowledgedEtag: 'etag-current',
    })
  })

  test('a pull report moves the subscriber’s own row and never the listing’s content revision', async () => {
    /* THE FIREWALL. A subscriber's report is the obvious place to learn what
       the publisher's bytes are at — every subscriber of a listing observes
       the same ETag — and it is the wrong place. The listing's revision is
       projected to EVERY other subscriber, so a report that could write it
       would hand one hostile installer a fan-out: report a novel revision,
       and the whole fleet pulls from a rival publisher's origin at once.
       Same rule the availability sweep already keeps: a report moves its own
       subscription and nothing else. */
    const fixture = await installedFixture('revfw')
    // Stamp it first: an unstamped listing makes the assertion below
    // `undefined === undefined`, which cannot catch a report that OVERWRITES a
    // real revision — the shape a hostile installer would actually exploit.
    await mutate(convex, 'testing/marketplace:stampListingRevisionForTest', {
      internalKey: INTERNAL_KEY,
      listingId: fixture.listings.research,
      contentRevision: 'press-1',
      now: 69_000,
    })
    const before = await rawListing(fixture.listings.research)
    expect(before.contentRevision).toBe('press-1')

    await applyReport(
      fixture.workspaceId,
      fixture.subscription.id,
      'etag-from-a-subscriber',
      70_000,
    )

    const after = await rawListing(fixture.listings.research)
    expect(after.contentRevision).toBe('press-1')
    expect(after.availability).toBe(before.availability)
    expect(after.state).toBe(before.state)
    expect(after.installs).toBe(before.installs)
    // The subscriber's own row DID move — this is a firewall, not a no-op.
    expect(await listSubscriptions(fixture.workspaceId)).toContainEqual(
      expect.objectContaining({
        id: fixture.subscription.id,
        appliedEtag: 'etag-from-a-subscriber',
      }),
    )
  })

  test('report intake records errors and applied state while duplicate reports are idempotent', async () => {
    const fixture = await installedFixture('reports')
    await mutate(convex, 'domains/marketplace/model:applyPullReports', {
      internalKey: INTERNAL_KEY,
      workspaceId: fixture.workspaceId,
      reports: [
        {
          subscriptionId: fixture.subscription.id,
          state: 'error',
          lastErrorCode: 'recursive_limit_exceeded',
        },
      ],
      now: 60_000,
    })
    expect(await listSubscriptions(fixture.workspaceId)).toContainEqual(
      expect.objectContaining({
        id: fixture.subscription.id,
        state: 'error',
        lastErrorCode: 'recursive_limit_exceeded',
      }),
    )

    await applyReport(fixture.workspaceId, fixture.subscription.id, 'etag-1', 61_000)
    const beforeDuplicate = (await rawApps()).find(
      app => app.listingSubscriptionId === fixture.subscription.id,
    )
    await applyReport(fixture.workspaceId, fixture.subscription.id, 'etag-1', 62_000)
    const afterDuplicate = (await rawApps()).find(
      app => app.listingSubscriptionId === fixture.subscription.id,
    )
    expect(afterDuplicate).toEqual(beforeDuplicate)
  })

  test('a stale error report cannot knock a healthy subscription back to error', async () => {
    // Install pushes a pull WHILE the recurring VM sync is in flight, so an
    // error observed before a later success can arrive after it. The active
    // branch already rejected stale reports; the error branch applied them
    // unconditionally and moved a working agent to "Needs attention".
    const fixture = await installedFixture('stale-error')
    await applyReport(fixture.workspaceId, fixture.subscription.id, 'etag-good', 80_000)

    expect(
      await applyErrorReport(
        fixture.workspaceId,
        fixture.subscription.id,
        'origin_unreachable',
        79_000,
        81_000,
      ),
    ).toMatchObject({
      rejectedStaleSubscriptionIds: [fixture.subscription.id],
      subscriptions: [expect.objectContaining({ state: 'active', appliedEtag: 'etag-good' })],
    })

    // An error observed AFTER the last success is real and still lands.
    expect(
      await applyErrorReport(
        fixture.workspaceId,
        fixture.subscription.id,
        'origin_unreachable',
        82_000,
        82_000,
      ),
    ).toMatchObject({
      rejectedStaleSubscriptionIds: [],
      subscriptions: [expect.objectContaining({ state: 'error' })],
    })
  })

  test('an applied-etag advance reseeds current golden app rows and rejects stale reports', async () => {
    const fixture = await installedFixture('reseed')
    await applyReport(fixture.workspaceId, fixture.subscription.id, 'etag-1', 70_000)
    await mutate(owner.client, 'domains/apps/model:updateApp', {
      workspaceId: fixture.goldenWorkspaceId,
      slug: 'dashboard',
      command: 'bun run changed',
      apiScopes: ['members'],
      now: 71_000,
    })
    await mutate(owner.client, 'domains/apps/model:registerApp', {
      workspaceId: fixture.goldenWorkspaceId,
      path: 'official/research/apps/worker',
      slug: 'worker',
      command: 'bun run worker',
      apiScopes: ['members'],
      now: 71_100,
    })
    await applyReport(fixture.workspaceId, fixture.subscription.id, 'etag-2', 72_000)

    const installed = (await rawApps()).filter(
      app => app.listingSubscriptionId === fixture.subscription.id,
    )
    expect(installed.find(app => app.slug === 'dashboard')).toMatchObject({
      command: 'bun run changed',
      apiScopes: ['members'],
      contentGeneration: 'etag-2',
    })
    expect(installed.find(app => app.slug === 'worker')).toMatchObject({
      command: 'bun run worker',
      contentGeneration: 'etag-2',
    })
    const installedWorker = installed.find(app => app.slug === 'worker')!
    const workerCredential = (await mutate(convex, 'domains/apiKeys/mutations:mintAppKey', {
      internalKey: INTERNAL_KEY,
      appId: installedWorker._id,
      now: 72_050,
    })) as { prefix: string }

    await mutate(owner.client, 'domains/apps/model:deleteApp', {
      workspaceId: fixture.goldenWorkspaceId,
      slug: 'worker',
      now: 72_100,
    })
    await applyReport(fixture.workspaceId, fixture.subscription.id, 'etag-3', 73_000)
    // The publisher dropping an app is them deleting it, so the subscriber's row
    // goes too. It used to be switched off and left there — a marketplace-managed
    // app refuses direct deletion, so a disabled one sat on the map forever with
    // no way for its owner to remove it.
    expect(
      (await rawApps()).find(
        app => app.listingSubscriptionId === fixture.subscription.id && app.slug === 'worker',
      ),
    ).toBeUndefined()
    expect(
      (await rawApiKeys()).find(key => key.prefix === workerCredential.prefix)?.revokedAt,
    ).toBe(73_000)

    expect(
      await applyReport(fixture.workspaceId, fixture.subscription.id, 'etag-stale', 69_000),
    ).toMatchObject({
      ok: true,
      rejectedStaleSubscriptionIds: [fixture.subscription.id],
      subscriptions: [
        expect.objectContaining({
          id: fixture.subscription.id,
          state: 'active',
          appliedEtag: 'etag-3',
        }),
      ],
    })
    expect(await listSubscriptions(fixture.workspaceId)).toContainEqual(
      expect.objectContaining({ id: fixture.subscription.id, appliedEtag: 'etag-3' }),
    )
  })

  // A managed app is the publisher's declaration materialised. It leaves by
  // uninstalling its subscription (or deleting the agent, which detaches) —
  // never by deleteApp, and its runtime is never edited in place: both would
  // silently drift from (or be clobbered by) the next publisher sync, and a
  // delete used to orphan the anchor out from under that sync. Visibility
  // stays the installer's: the sync never touches it.
  test('a managed app refuses direct update and delete but keeps visibility local', async () => {
    const fixture = await installedFixture('managed-guard')
    await applyReport(fixture.workspaceId, fixture.subscription.id, 'etag-guard', 26_000)

    const deleteError = await mutate(owner.client, 'domains/apps/model:deleteApp', {
      workspaceId: fixture.workspaceId,
      slug: 'dashboard',
      now: 27_000,
    }).catch(value => value)
    expect(deleteError).toBeInstanceOf(Error)
    expect(String(deleteError)).toMatch(/read-only/i)

    const updateError = await mutate(owner.client, 'domains/apps/model:updateApp', {
      workspaceId: fixture.workspaceId,
      slug: 'dashboard',
      command: 'bun run hijack',
      now: 27_100,
    }).catch(value => value)
    expect(updateError).toBeInstanceOf(Error)
    expect(String(updateError)).toMatch(/read-only/i)

    const untouched = (await rawApps()).find(
      app => app.listingSubscriptionId === fixture.subscription.id && app.slug === 'dashboard',
    )
    expect(untouched).toMatchObject({ command: 'bun run start' })

    const published = (await mutate(owner.client, 'domains/apps/model:setVisibility', {
      workspaceId: fixture.workspaceId,
      slug: 'dashboard',
      visibility: 'public',
      now: 27_200,
    })) as { visibility: string }
    expect(published.visibility).toBe('public')
  })

  // The same policy through the third door: a plain `registerApp` POSTed at a
  // managed app's existing path is a re-registration, and re-registration
  // rewrites the publisher-owned runtime (command, scopes, port, name, icon).
  // Only the app's own subscription sync may pass — that path carries the
  // subscription linkage; a direct register carries none.
  /**
   * The deadlock this pins: a publisher removes an app, the subscriber's VM
   * applies the tree (so the app's files vanish), then reconciles apps from rows
   * that still name it — and the install command fails against a directory with
   * no package.json. The pull reports `error`, and retirement only ran on the
   * success branch, so the row that caused the failure survived to cause it
   * again. Forever, on every poll, with no way out but uninstalling.
   */
  test('an app the publisher dropped is retired even when the pull reports failure', async () => {
    const fixture = await installedFixture('drop-app')
    await applyReport(fixture.workspaceId, fixture.subscription.id, 'etag-a', 70_000)
    expect(
      (await rawApps())
        .filter(app => app.listingSubscriptionId === fixture.subscription.id && !app.disabledAt)
        .map(app => app.slug),
    ).toEqual(['dashboard'])

    // The publisher stops shipping it.
    await mutate(owner.client, 'domains/apps/model:deleteApp', {
      workspaceId: fixture.goldenWorkspaceId,
      slug: 'dashboard',
      now: 71_000,
    })

    // The subscriber's next pull FAILS — which is what the stale row causes.
    await applyErrorReport(
      fixture.workspaceId,
      fixture.subscription.id,
      'pull_failed',
      undefined,
      72_000,
    )

    expect(
      (await rawApps())
        .filter(app => app.listingSubscriptionId === fixture.subscription.id && !app.disabledAt)
        .map(app => app.slug),
    ).toEqual([])
  })

  test('a managed app refuses direct re-registration at its path', async () => {
    const fixture = await installedFixture('managed-rereg')
    await applyReport(fixture.workspaceId, fixture.subscription.id, 'etag-rereg', 26_000)
    const managed = (await query(owner.client, 'domains/apps/model:listByWorkspace', {
      workspaceId: fixture.workspaceId,
    })) as Array<{ slug: string; anchorPath: string }>
    const dashboardPath = managed.find(app => app.slug === 'dashboard')!.anchorPath

    const registerError = await mutate(owner.client, 'domains/apps/model:registerApp', {
      workspaceId: fixture.workspaceId,
      path: dashboardPath,
      slug: 'dashboard',
      command: 'bun run hijack',
      apiScopes: ['services'],
      now: 27_000,
    }).catch(value => value)
    expect(registerError).toBeInstanceOf(Error)
    expect(String(registerError)).toMatch(/read-only/i)

    const untouched = (await rawApps()).find(
      app => app.listingSubscriptionId === fixture.subscription.id && app.slug === 'dashboard',
    )
    expect(untouched).toMatchObject({
      command: 'bun run start',
      apiScopes: [],
      listingSubscriptionId: fixture.subscription.id,
    })
  })

  // The delete/update refusal above is only enforceable by a client if it can
  // SEE the ownership: `apps.list` fed by-slug deletes to in-VM agents with no
  // marker, which is exactly how a managed app got deleted in the first place.
  test('the app projection carries subscription ownership', async () => {
    const fixture = await installedFixture('managed-visible')
    await applyReport(fixture.workspaceId, fixture.subscription.id, 'etag-visible', 26_000)

    const listed = (await query(owner.client, 'domains/apps/model:listByWorkspace', {
      workspaceId: fixture.workspaceId,
    })) as Array<Record<string, unknown>>
    expect(listed.find(app => app.slug === 'dashboard')).toMatchObject({
      listingSubscriptionId: fixture.subscription.id,
    })
  })

  // The product contract for the ONE registration owner: an app that arrives
  // via a marketplace install is indistinguishable from the same app registered
  // directly — same visibility, same auto-port rule, same slug handling, same
  // runtime status. The only fields an install may add are its subscription
  // linkage: `listingSubscriptionId` and `contentGeneration`.
  test('an installed app row equals a directly registered one apart from subscription linkage', async () => {
    const fixture = await installedFixture('equivalence')
    // Content lands, so the installed app reaches the same enabled state a
    // direct register starts in.
    await applyReport(fixture.workspaceId, fixture.subscription.id, 'etag-eq', 26_000)
    const installed = (await rawApps()).find(
      app => app.listingSubscriptionId === fixture.subscription.id && app.slug === 'dashboard',
    )!

    const directWorkspaceId = await createWorkspace('equivalence-direct')
    const direct = (await mutate(owner.client, 'domains/apps/model:registerApp', {
      workspaceId: directWorkspaceId,
      path: 'agents/research/apps/dashboard',
      slug: 'dashboard',
      name: 'Dashboard',
      command: 'bun run start',
      apiScopes: [],
      installCommand: 'bun install',
      now: 26_000,
    })) as { id: string }
    const directRow = (await rawApps()).find(app => app._id === direct.id)!

    const essence = (app: Doc<'apps'>) => ({
      slug: app.slug,
      command: app.command,
      apiScopes: app.apiScopes,
      installCommand: app.installCommand,
      name: app.name,
      icon: app.icon,
      visibility: app.visibility,
      runtimeStatus: app.runtimeStatus,
      port: app.port,
      disabledAt: app.disabledAt,
    })
    expect(essence(installed)).toEqual(essence(directRow))
    expect(installed).toMatchObject({
      listingSubscriptionId: fixture.subscription.id,
      contentGeneration: 'etag-eq',
    })
    expect(directRow).not.toHaveProperty('listingSubscriptionId')
    expect(directRow).not.toHaveProperty('contentGeneration')
  })

  // The pull batch rides the workspace's recurring VM sync. One subscription
  // whose apply throws (here: the publisher ships a new app whose target path
  // is claimed by an incompatible anchor) must fail alone — marked `error` on
  // its own row — instead of throwing out of the batch, which used to 500
  // every 5s poll and halt the workspace's whole sync loop.
  test('one failing subscription apply marks itself error instead of sinking the batch', async () => {
    const { goldenWorkspaceId, workspaceId, listings } = await officialFixture('apply-shield')
    const writer = (await mutate(owner.client, 'domains/marketplace/model:install', {
      workspaceId,
      listingId: listings.writer,
      now: 25_000,
    })) as Subscription
    const analyst = (await mutate(owner.client, 'domains/marketplace/model:install', {
      workspaceId,
      listingId: listings.analyst,
      now: 25_100,
    })) as Subscription
    // The installer claims writer's future app path with an agent anchor…
    await mutate(owner.client, 'testing/anchors:createAnchorForTest', {
      workspaceId,
      path: 'agents/writer/apps/panel',
      kind: 'agent',
      settings: {},
    })
    // …and only then does the publisher declare apps at both listings.
    for (const [agent, slug] of [
      ['writer', 'panel'],
      ['analyst', 'report'],
    ] as const) {
      await mutate(owner.client, 'domains/apps/model:registerApp', {
        workspaceId: goldenWorkspaceId,
        path: `official/${agent}/apps/${slug}`,
        slug,
        command: `bun run ${slug}`,
        apiScopes: [],
        now: 25_200,
      })
    }

    const result = await mutate(convex, 'domains/marketplace/model:applyPullReports', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      reports: [
        {
          subscriptionId: writer.id,
          state: 'active',
          appliedEtag: 'etag-shield',
          lastAppliedAt: 26_000,
        },
        {
          subscriptionId: analyst.id,
          state: 'active',
          appliedEtag: 'etag-shield',
          lastAppliedAt: 26_000,
        },
      ],
      now: 26_000,
    })

    expect(result).toMatchObject({ ok: true })
    const subscriptions = await rawSubscriptions(workspaceId)
    expect(subscriptions).toContainEqual(
      expect.objectContaining({ _id: writer.id, state: 'error', lastErrorCode: 'apply_failed' }),
    )
    expect(subscriptions).toContainEqual(
      expect.objectContaining({ _id: analyst.id, state: 'active', appliedEtag: 'etag-shield' }),
    )
    expect((await rawApps()).find(app => app.listingSubscriptionId === analyst.id)).toMatchObject({
      slug: 'report',
      contentGeneration: 'etag-shield',
    })
  })

  // The menu is drawn from `appControls`, and the mutation decides what actually
  // happens. When those two disagree the product offers a button that always
  // fails — which is what shipped once: the controls let a switched-off managed
  // app be deleted and `deleteApp` refused every managed app, so the dialog
  // answered "could not be deleted. Try again" forever.
  //
  // Asserted as agreement rather than as two separate rules, because the rule
  // itself is allowed to change; what must never differ is the pair.
  test('what appControls offers for a managed app is what deleteApp accepts', async () => {
    const fixture = await installedFixture('managed-delete')
    const installed = (await rawApps()).find(
      app => app.workspaceId === fixture.workspaceId && app.slug === 'dashboard',
    )!
    const attemptDelete = async () =>
      await mutate(owner.client, 'domains/apps/model:deleteApp', {
        workspaceId: fixture.workspaceId,
        slug: 'dashboard',
      })
        .then(() => true)
        .catch(() => false)
    // The same function the API projects `controls` from, fed the same row, so
    // this asserts the pair the product ships rather than a restatement of
    // either half.
    const offersDelete = async () => {
      const row = (await rawApps()).find(
        app => app.workspaceId === fixture.workspaceId && app.slug === 'dashboard',
      )!
      return appControls('owner', {
        anchorState: 'active',
        ...(row.listingSubscriptionId === undefined
          ? {}
          : { listingSubscriptionId: row.listingSubscriptionId }),
        ...(row.disabledAt === undefined ? {} : { disabledAt: row.disabledAt }),
      }).delete
    }

    // Still installing: the row is written before its files land, and deleting
    // it races the pull about to enable it.
    expect(installed.disabledAt).toBeDefined()
    expect(await offersDelete()).toBe(false)
    expect(await attemptDelete()).toBe(false)

    // Landed: the publisher ships it, so it leaves by uninstalling the
    // subscription, never by deleting the row out from under them.
    await mutate(convex, 'testing/apps:forceDisabledAtForTest', {
      internalKey: INTERNAL_KEY,
      appId: installed._id,
    })
    expect(await offersDelete()).toBe(false)
    expect(await attemptDelete()).toBe(false)

    // And it is still there — a refusal, not a silent no-op.
    expect(
      (await rawApps()).find(
        app => app.workspaceId === fixture.workspaceId && app.slug === 'dashboard',
      ),
    ).toBeDefined()
  })
})

interface Subscription {
  id: string
  agentId: string
  anchorId: string
  listingId: string
  agentName: string
  state: string
  path: string
}

async function installedFixture(prefix: string) {
  const fixture = await officialFixture(prefix)
  await seedGoldenApp(fixture.goldenWorkspaceId)
  const subscription = (await mutate(owner.client, 'domains/marketplace/model:install', {
    workspaceId: fixture.workspaceId,
    listingId: fixture.listings.research,
    now: 25_000,
  })) as Subscription
  return { ...fixture, subscription }
}

async function seedGoldenApp(goldenWorkspaceId: string) {
  await mutate(owner.client, 'domains/apps/model:registerApp', {
    workspaceId: goldenWorkspaceId,
    path: 'official/research/apps/dashboard',
    slug: 'dashboard',
    name: 'Dashboard',
    command: 'bun run start',
    apiScopes: [],
    installCommand: 'bun install',
    now: 10_100,
  })
}

async function applyErrorReport(
  workspaceId: string,
  subscriptionId: string,
  lastErrorCode: string,
  observedAt: number | undefined,
  now: number,
) {
  return await mutate(convex, 'domains/marketplace/model:applyPullReports', {
    internalKey: INTERNAL_KEY,
    workspaceId,
    reports: [
      {
        subscriptionId,
        state: 'error',
        lastErrorCode,
        ...(observedAt === undefined ? {} : { observedAt }),
      },
    ],
    now,
  })
}

async function applyReport(
  workspaceId: string,
  subscriptionId: string,
  appliedEtag: string,
  lastAppliedAt: number,
) {
  return await mutate(convex, 'domains/marketplace/model:applyPullReports', {
    internalKey: INTERNAL_KEY,
    workspaceId,
    reports: [{ subscriptionId, state: 'active', appliedEtag, lastAppliedAt }],
    now: lastAppliedAt,
  })
}

async function listSubscriptions(workspaceId: string) {
  return (await query(owner.client, 'domains/marketplace/model:listByWorkspace', {
    workspaceId,
  })) as Array<Record<string, unknown>>
}

async function rawSubscriptions(workspaceId: string) {
  return (await query(convex, 'testing/marketplace:rawSubscriptionsForTest', {
    internalKey: INTERNAL_KEY,
    workspaceId,
  })) as Array<Record<string, unknown>>
}

async function installEvents(workspaceId: string) {
  const events = (await query(owner.client, 'domains/workspaces/queries:getAuditEvents', {
    workspaceId,
  })) as Array<{
    id: string
    event: string
    actorId: string
    at: number
    provenance?: Record<string, unknown>
  }>
  return events
    .filter(event => event.event === 'agent.installed')
    .map(({ id: _id, ...event }) => event)
}

async function rawListing(listingId: string): Promise<Doc<'agentListings'>> {
  const listings = (await query(convex, 'testing/marketplace:rawListingsForTest', {
    internalKey: INTERNAL_KEY,
  })) as Doc<'agentListings'>[]
  const listing = listings.find(candidate => candidate._id === listingId)
  if (listing === undefined) throw new Error(`Missing listing ${listingId}`)
  return listing
}

async function listingInstallCount(listingId: string): Promise<number> {
  return (await rawListing(listingId)).installs
}

async function rawApps(): Promise<Doc<'apps'>[]> {
  return (await query(convex, 'testing/apps:rawAppsForTest', {
    internalKey: INTERNAL_KEY,
  })) as Doc<'apps'>[]
}

async function rawAgents(): Promise<Doc<'agents'>[]> {
  return (await query(convex, 'testing/agents:rawAgentsForTest', {
    internalKey: INTERNAL_KEY,
  })) as Doc<'agents'>[]
}

async function rawApiKeys(): Promise<Array<{ prefix: string; revokedAt?: number }>> {
  return (await query(convex, 'testing/apiKeys:rawApiKeysForTest', {
    internalKey: INTERNAL_KEY,
  })) as Array<{ prefix: string; revokedAt?: number }>
}

async function officialFixture(prefix: string) {
  await mutate(owner.client, 'testing/workspaces:activateCurrentUserSyntheticSubscriptionForTest', {
    internalKey: INTERNAL_KEY,
  })
  // ONE official workspace for the whole suite. Bare-name onboarding resolves
  // through the durable official workspace slug, while ordinary installs remain
  // listing-id keyed.
  const goldenWorkspaceId =
    sharedGolden?.workspaceId ?? (await createWorkspaceWithSlug(OFFICIAL_AGENTS_WORKSPACE_SLUG))
  const isNewGolden = sharedGolden === undefined
  const workspaceId = await createWorkspace(`${prefix}-target`)
  if (isNewGolden) {
    await mutate(owner.client, 'domains/publishes/model:createPublish', {
      workspaceId: goldenWorkspaceId,
      path: 'official',
      kind: 'folder',
      slug: 'official-agents',
      now: 10_000,
    })
  }
  if (!isNewGolden) return { goldenWorkspaceId, workspaceId, listings: sharedGolden!.listings }
  // The official hub's listings are ordinary marketplace rows; only the
  // bare-name onboarding resolver gives this workspace special meaning.
  await mutate(convex, 'testing/marketplace:markVerifiedPublisherForTest', {
    internalKey: INTERNAL_KEY,
    workspaceId: goldenWorkspaceId,
    now: 10_000,
  })
  const hubPublish = (await query(convex, 'testing/marketplace:publishBySlugForTest', {
    internalKey: INTERNAL_KEY,
    workspaceId: goldenWorkspaceId,
    slug: 'official-agents',
  })) as { _id: string }
  const listings: GoldenListings = {
    research: '',
    writer: '',
    analyst: '',
  }
  for (const agentName of ['research', 'writer', 'analyst'] as const) {
    const registered = (await mutate(owner.client, 'domains/agents/model:registerAgent', {
      workspaceId: goldenWorkspaceId,
      path: `official/${agentName}`,
      slug: agentName,
      name: agentName,
    })) as { id: string; anchorId: string }
    listings[agentName] = (await mutate(convex, 'testing/marketplace:insertListingForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: goldenWorkspaceId,
      agentId: registered.id,
      anchorId: registered.anchorId,
      publishId: hubPublish._id,
      agentName,
      agentSubpath: agentName,
      createdByUserId: owner.user._id,
      now: 10_000,
    })) as string
  }
  sharedGolden = { workspaceId: goldenWorkspaceId, listings }
  return { goldenWorkspaceId, workspaceId, listings }
}

/**
 * A verified listing whose TITLE differs from its slug.
 *
 * The shared golden fixture registers listings with no title at all, so
 * `resolveListingMetadata` falls back to the agent name and title-preference
 * becomes indistinguishable from slug-fallback. A test about which one wins
 * needs the two to differ.
 */
async function seedTitledListing(
  goldenWorkspaceId: string,
  agentName: string,
  title: string,
): Promise<string> {
  const registered = (await mutate(owner.client, 'domains/agents/model:registerAgent', {
    workspaceId: goldenWorkspaceId,
    path: `official/${agentName}`,
    slug: agentName,
    name: agentName,
  })) as { id: string; anchorId: string }
  const hubPublish = (await query(convex, 'testing/marketplace:publishBySlugForTest', {
    internalKey: INTERNAL_KEY,
    workspaceId: goldenWorkspaceId,
    slug: 'official-agents',
  })) as { _id: string }
  return (await mutate(convex, 'testing/marketplace:insertListingForTest', {
    internalKey: INTERNAL_KEY,
    workspaceId: goldenWorkspaceId,
    agentId: registered.id,
    anchorId: registered.anchorId,
    publishId: hubPublish._id,
    agentName,
    agentSubpath: agentName,
    titleOverride: title,
    createdByUserId: owner.user._id,
    now: 10_000,
  })) as string
}

/**
 * A listing owned by an arbitrary publisher workspace, used by the tests that
 * need a SECOND publisher — the shared golden fixture deliberately has only
 * one, which is what let name-keyed install look correct for so long.
 */
async function seedListing(
  workspaceId: string,
  agentName: string,
  options: { verified: boolean },
): Promise<string> {
  const publish = (await mutate(owner.client, 'domains/publishes/model:createPublish', {
    workspaceId,
    path: `agents/${agentName}`,
    kind: 'folder',
    slug: `${agentName}-${++sequence}`,
    now: 10_000,
  })) as { id: string }
  const registered = (await mutate(owner.client, 'domains/agents/model:registerAgent', {
    workspaceId,
    path: `agents/${agentName}`,
    slug: agentName,
    name: agentName,
  })) as { id: string; anchorId: string }
  if (options.verified) {
    await mutate(convex, 'testing/marketplace:markVerifiedPublisherForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      now: 10_000,
    })
  }
  return (await mutate(convex, 'testing/marketplace:insertListingForTest', {
    internalKey: INTERNAL_KEY,
    workspaceId,
    agentId: registered.id,
    anchorId: registered.anchorId,
    publishId: publish.id,
    agentName,
    agentSubpath: '',
    createdByUserId: owner.user._id,
    now: 10_000,
  })) as string
}

async function createWorkspace(prefix: string): Promise<string> {
  return await createWorkspaceWithSlug(`${prefix}-${Date.now()}-${++sequence}`)
}

async function createWorkspaceWithSlug(slug: string): Promise<string> {
  const workspaceId = (await mutate(owner.client, 'testing/workspaces:createWorkspaceForTest', {
    internalKey: INTERNAL_KEY,
    slug,
    name: `${slug} Workspace`,
  })) as string
  await mutate(owner.client, 'testing/workspaces:markWorkspaceLiveForTest', {
    internalKey: INTERNAL_KEY,
    workspaceId,
    now: Date.now(),
  })
  return workspaceId
}
