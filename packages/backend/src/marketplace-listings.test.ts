import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

import { ConvexHttpClient } from 'convex/browser'

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

const INTERNAL_KEY = 'test-marketplace-listings-internal-key'
const BACKEND_DIR = new URL('..', import.meta.url).pathname
const STAGING_EDGE = 'edge-staging.duet.so'

let convex: ConvexDevFixture
let owner: { client: ConvexHttpClient; user: { _id: string; email: string } }
let sequence = 0

describe('marketplace listings', () => {
  beforeAll(async () => {
    convex = await convexDev(BACKEND_DIR, {
      env: {
        ...generateAuthKeys(),
        DUET_API_INTERNAL_KEY: INTERNAL_KEY,
        DUET_TEST_AUTH_CODE: TEST_AUTH_CODE,
        DUET_TEST_AUTH_EMAIL: '1',
        DUET_APP_URL: 'http://localhost:3000',
        DUET_EDGE_HOST: STAGING_EDGE,
      },
      reset: true,
    })
    owner = await signInWithMagicLink(convex, uniqueEmail('listings-owner'), 'Listings Owner')
  }, 240_000)

  afterAll(async () => {
    await convex?.stop()
  })

  test('a listing anchored on the agent folder derives a root-zip source url', async () => {
    const listing = await listingFixture('root')
    const resolved = (await query(convex, 'testing/marketplace:resolvedListingForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: listing.workspaceId,
      agentName: listing.agentName,
    })) as { sourceUrl: string | null; metadata: { title: string; summary: string } }

    // No agent segment: the publish anchor IS the agent folder (slice 00).
    expect(resolved.sourceUrl).toBe(
      `https://${STAGING_EDGE}/${listing.workspaceSlug}/${listing.publishSlug}?zip`,
    )
  }, 120_000)

  test('a listing under a parent-folder publish keeps its agent subpath', async () => {
    const listing = await listingFixture('nested', { agentSubpath: 'sec-triage' })
    const resolved = (await query(convex, 'testing/marketplace:resolvedListingForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: listing.workspaceId,
      agentName: listing.agentName,
    })) as { sourceUrl: string | null }
    expect(resolved.sourceUrl).toBe(
      `https://${STAGING_EDGE}/${listing.workspaceSlug}/${listing.publishSlug}/sec-triage?zip`,
    )
  }, 120_000)

  test('a listing whose publish is gone resolves to null, never a broken url', async () => {
    const listing = await listingFixture('stranded')
    await mutate(convex, 'testing/marketplace:deletePublishRowForTest', {
      internalKey: INTERNAL_KEY,
      publishId: listing.publishId,
    })
    const resolved = (await query(convex, 'testing/marketplace:resolvedListingForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: listing.workspaceId,
      agentName: listing.agentName,
    })) as { sourceUrl: string | null }
    expect(resolved.sourceUrl).toBeNull()
  }, 120_000)

  test('an explicit override wins over derived metadata and survives it changing', async () => {
    const listing = await listingFixture('override', {
      titleOverride: 'Sec Triage Pro',
      derivedTitle: 'Sec Triage',
      derivedSummary: 'Triages alerts.',
    })
    const resolved = (await query(convex, 'testing/marketplace:resolvedListingForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: listing.workspaceId,
      agentName: listing.agentName,
    })) as { metadata: { title: string; summary: string } }

    // Title is the publisher's; summary still falls through to derived, so the
    // two columns resolve independently rather than as one blob.
    expect(resolved.metadata).toEqual({ title: 'Sec Triage Pro', summary: 'Triages alerts.' })
  }, 120_000)

  test('a declaration-only change converges without any file changing', async () => {
    // The defect this slice exists for: appliedEtag is stat-derived over FILES,
    // so a publisher who edits only a command or a scope moves nothing the ETag
    // can see, and before the second clock existed that change never reached
    // installers at all.
    //
    // Driven through the SWEEP, which is the cron-scheduled owner. Calling a
    // recompute helper directly proves the fingerprint function works while the
    // stored column never moves in production — which is exactly how this clock
    // shipped dead the first time.
    const listing = await listingFixture('declarations')
    const revisionOf = async (now: number) => {
      await mutate(convex, 'domains/marketplace/listings:sweepListingAppDeclarations', {
        internalKey: INTERNAL_KEY,
        now,
      })
      const listings = (await query(convex, 'testing/marketplace:rawListingsForTest', {
        internalKey: INTERNAL_KEY,
      })) as { _id: string; appDeclarationRevision?: string }[]
      return listings.find(row => row._id === listing.listingId)?.appDeclarationRevision
    }

    const before = await revisionOf(20_000)
    expect(before).toBeString()

    await mutate(owner.client, 'domains/apps/model:registerApp', {
      workspaceId: listing.workspaceId,
      path: `agents/${listing.agentName}/apps/board`,
      slug: 'board',
      name: 'Board',
      command: 'bun run start',
      apiScopes: [],
      installCommand: 'bun install',
    })
    const afterAdd = await revisionOf(21_000)

    // A new declaration moves the revision...
    expect(afterAdd).not.toBe(before)
    // ...and sweeping again with nothing changed does not, so the clock is
    // stable rather than time- or order-dependent.
    expect(await revisionOf(22_000)).toBe(afterAdd)

    // The case the slice actually promises: widen a SCOPE and nothing else.
    // No file moves, so appliedEtag cannot see it — only this clock can.
    await mutate(owner.client, 'domains/apps/model:updateApp', {
      workspaceId: listing.workspaceId,
      slug: 'board',
      apiScopes: ['files:write'],
    })
    const afterScope = await revisionOf(23_000)
    expect(afterScope).not.toBe(afterAdd)

    // And a command-only change moves it too.
    await mutate(owner.client, 'domains/apps/model:updateApp', {
      workspaceId: listing.workspaceId,
      slug: 'board',
      command: 'bun run serve',
    })
    expect(await revisionOf(24_000)).not.toBe(afterScope)
  }, 120_000)

  test('the declaration sweep is bounded per pass and rotates across listings', async () => {
    // WHY A BUDGET: a Convex mutation is ONE transaction with a per-transaction
    // document-read ceiling. Fingerprinting a listing reads its publisher's
    // whole app list, so folding it into the availability sweep made one pass
    // cost O(listings x publisher apps) — enough listings with enough apps and
    // the pass exceeds the ceiling and fails ENTIRELY. Nothing gets stamped,
    // the least-recently-checked ordering re-selects the same rows, and the
    // catalog stalls forever. The budget is what makes a pass finite.
    const first = await listingFixture('budget-a')
    const second = await listingFixture('budget-b')
    const revisions = async () => {
      const rows = (await query(convex, 'testing/marketplace:rawListingsForTest', {
        internalKey: INTERNAL_KEY,
      })) as { _id: string; appDeclarationRevision?: string }[]
      return [first.listingId, second.listingId].map(
        id => rows.find(row => row._id === id)?.appDeclarationRevision,
      )
    }

    // A budget of one document cannot finish both listings in one pass.
    const pass1 = (await mutate(
      convex,
      'domains/marketplace/listings:sweepListingAppDeclarations',
      { internalKey: INTERNAL_KEY, readBudget: 1, now: 30_000 },
    )) as { scanned: number }
    expect(pass1.scanned).toBe(1)

    // ...and the next pass picks up the OTHER one, because rotation runs off a
    // stamp of its own rather than sharing the availability sweep's.
    await mutate(convex, 'domains/marketplace/listings:sweepListingAppDeclarations', {
      internalKey: INTERNAL_KEY,
      readBudget: 1,
      now: 31_000,
    })
    const [a, b] = await revisions()
    expect(a).toBeString()
    expect(b).toBeString()
  }, 120_000)

  test('the catalog lists app display names, stamped by the declaration sweep', async () => {
    // The catalog is the whole-catalog read path, so it must stay O(listings):
    // it reads a stamped column and never walks publisher apps itself. The
    // walk happens in the budgeted declaration sweep, which already has the
    // apps in hand for the fingerprint.
    const listing = await listingFixture('app-names')
    await mutate(owner.client, 'domains/apps/model:registerApp', {
      workspaceId: listing.workspaceId,
      path: `agents/${listing.agentName}/apps/board`,
      slug: 'board',
      name: 'Board',
      command: 'bun run start',
      apiScopes: [],
    })
    const catalogRow = async () => {
      const catalog = (await query(convex, 'domains/marketplace/listings:catalog', {
        internalKey: INTERNAL_KEY,
      })) as { listings: { id: string; appNames?: string[] }[] }
      return catalog.listings.find(entry => entry.id === listing.listingId)
    }

    // Unstamped reads as "no apps yet" — never a live walk on the catalog path.
    expect((await catalogRow())?.appNames).toEqual([])

    await mutate(convex, 'domains/marketplace/listings:sweepListingAppDeclarations', {
      internalKey: INTERNAL_KEY,
      now: 25_000,
    })
    expect((await catalogRow())?.appNames).toEqual(['Board'])

    // A display-name rename moves NO declaration, so the revision fingerprint
    // cannot see it — only the sweep's own name comparison can. Without it the
    // catalog would advertise the old name forever.
    await mutate(owner.client, 'domains/apps/model:updateApp', {
      workspaceId: listing.workspaceId,
      slug: 'board',
      name: 'Account Board',
    })
    await mutate(convex, 'domains/marketplace/listings:sweepListingAppDeclarations', {
      internalKey: INTERNAL_KEY,
      now: 26_000,
    })
    expect((await catalogRow())?.appNames).toEqual(['Account Board'])
  }, 120_000)

  test('the detail derives app names live, so it never waits on the sweep', async () => {
    // One listing makes the walk affordable, and it keeps the names and the
    // consent declarations derived from the same app rows. An app with no
    // display name falls back to its slug rather than vanishing.
    const listing = await listingFixture('app-names-detail')
    await mutate(owner.client, 'domains/apps/model:registerApp', {
      workspaceId: listing.workspaceId,
      path: `agents/${listing.agentName}/apps/tracker`,
      slug: 'tracker',
      command: 'bun run start',
      apiScopes: [],
    })
    const detail = (await query(convex, 'domains/marketplace/listings:detail', {
      internalKey: INTERNAL_KEY,
      publisherSlug: listing.workspaceSlug,
      agentName: listing.agentName,
    })) as { appNames?: string[]; apps: { path: string }[] }
    expect(detail.appNames).toEqual(['tracker'])
    expect(detail.apps.map(app => app.path)).toEqual([`agents/${listing.agentName}/apps/tracker`])
  }, 120_000)

  test('the availability sweep no longer reads publisher apps', async () => {
    // Availability must stay O(listings): it is the whole-catalog pass, and it
    // is the one that must never be able to blow its own transaction.
    const listing = await listingFixture('availability-cost')
    await mutate(convex, 'domains/marketplace/listings:sweepListingAvailability', {
      internalKey: INTERNAL_KEY,
      now: 40_000,
    })
    const rows = (await query(convex, 'testing/marketplace:rawListingsForTest', {
      internalKey: INTERNAL_KEY,
    })) as { _id: string; appDeclarationRevision?: string; availabilityCheckedAt?: number }[]
    const row = rows.find(entry => entry._id === listing.listingId)
    expect(row?.availabilityCheckedAt).toBe(40_000)
    expect(row?.appDeclarationRevision).toBeUndefined()
  }, 120_000)

  test('a paused publisher greys its listings, because the edge would not serve them', async () => {
    // The edge serves a paused workspace its PAUSED PAGE — a non-archive 200.
    // The sweep used to check only workspace status, so a paused publisher read
    // as available, admitted installs, and only failed at pull time on a
    // content-type check.
    const listing = await listingFixture('paused-publisher')
    const availabilityOf = async () => {
      const catalog = (await query(convex, 'domains/marketplace/listings:catalog', {
        internalKey: INTERNAL_KEY,
      })) as { listings: { id: string; availability: string }[] }
      return catalog.listings.find(entry => entry.id === listing.listingId)?.availability
    }
    expect(await availabilityOf()).toBe('available')

    await mutate(convex, 'testing/workspaces:setServicingStatusForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: listing.workspaceId,
      servicingStatus: 'paused',
    })
    await mutate(convex, 'domains/marketplace/listings:sweepListingAvailability', {
      internalKey: INTERNAL_KEY,
      now: 90_000,
    })
    expect(await availabilityOf()).toBe('unavailable')
  }, 120_000)

  test('the availability sweep walks past its own window instead of rescanning it', async () => {
    // A fixed `.take(N)` over a stable order re-scans the same rows every run,
    // so listing N+1 never gets a verdict — silently, and forever. The contract
    // is coverage: with a window of one, N runs must reach all N listings.
    await listingFixture('sweep-window-a')
    await listingFixture('sweep-window-b')
    const allListings = async () =>
      (await query(convex, 'testing/marketplace:rawListingsForTest', {
        internalKey: INTERNAL_KEY,
      })) as Array<{ _id: string; state: string; availabilityCheckedAt?: number }>
    const listed = (await allListings()).filter(row => row.state === 'listed')
    expect(listed.length).toBeGreaterThan(1)

    for (let run = 0; run < listed.length; run += 1) {
      await mutate(convex, 'domains/marketplace/listings:sweepListingAvailability', {
        internalKey: INTERNAL_KEY,
        limit: 1,
        now: 70_000 + run,
      })
    }

    const unchecked = (await allListings()).filter(
      row => row.state === 'listed' && row.availabilityCheckedAt === undefined,
    )
    expect(unchecked).toEqual([])
  }, 120_000)

  // An install writes its rows before a byte lands on the drive, and the VM's
  // first sync after that reports the folder missing — conclusively, from a
  // full marker walk. That absence is the install in flight, not a deletion:
  // reaping on it deleted one of a new user's three starter picks at random.
  test('the drive sync does not reap an install whose folder has not landed yet', async () => {
    const listing = await listingFixture('arriving')
    const target = await registeredInstallerWorkspace('arriving')
    const installed = (await mutate(convex, 'domains/marketplace/model:install', {
      internalKey: INTERNAL_KEY,
      actorId: owner.user._id,
      workspaceId: target.workspaceId,
      listingId: listing.listingId,
    })) as { id: string; anchorId?: string; state: string }
    expect(installed.state).toBe('installing')
    expect(installed.anchorId).toBeDefined()
    const conclusivelyMissing = (now: number) =>
      mutate(convex, 'domains/anchors/model:applyRename', {
        internalKey: INTERNAL_KEY,
        vmTokenHash: target.vmTokenHash,
        reports: [
          {
            anchorId: installed.anchorId,
            candidates: [],
            anchorPathExists: false,
            consecutiveMissingPolls: 3,
            markerMatches: [],
            missingIsConclusive: true,
          },
        ],
        now,
      })
    const liveSubscriptions = async () =>
      (await query(convex, 'domains/marketplace/model:listByWorkspace', {
        internalKey: INTERNAL_KEY,
        workspaceId: target.workspaceId,
      })) as Array<{ id: string; state: string }>

    await conclusivelyMissing(10_000)
    expect(await liveSubscriptions()).toMatchObject([{ id: installed.id, state: 'installing' }])
    expect(
      await query(owner.client, 'domains/anchors/model:getById', { anchorId: installed.anchorId }),
    ).toMatchObject({ state: 'active' })

    // Once the pull lands the folder is really there; if it later leaves, the
    // ordinary verdict applies again.
    await mutate(convex, 'domains/marketplace/model:applyPullReports', {
      internalKey: INTERNAL_KEY,
      workspaceId: target.workspaceId,
      reports: [
        {
          subscriptionId: installed.id,
          state: 'active',
          appliedEtag: 'etag-1',
          lastAppliedAt: 11_000,
        },
      ],
      now: 11_000,
    })
    expect(await liveSubscriptions()).toMatchObject([{ id: installed.id, state: 'active' }])
    await conclusivelyMissing(12_000)
    expect(await liveSubscriptions()).toEqual([])
    expect(
      await query(owner.client, 'domains/anchors/model:getById', { anchorId: installed.anchorId }),
    ).toMatchObject({ state: 'orphaned' })
  })

  test('takedown drains EVERY subscriber, not just the first batch', async () => {
    // The drain used to return `remaining` to a caller that had to loop, and no
    // production caller existed — so every subscriber past the first batch kept
    // marketplace ownership of their agent forever. It now reschedules itself.
    const listing = await listingFixture('takedown-drain')
    const targets = [
      await installerWorkspace('drain-a'),
      await installerWorkspace('drain-b'),
      await installerWorkspace('drain-c'),
    ]
    for (const workspaceId of targets) {
      await mutate(convex, 'domains/marketplace/model:install', {
        internalKey: INTERNAL_KEY,
        actorId: owner.user._id,
        workspaceId,
        listingId: listing.listingId,
      })
    }

    // limit 1 forces three batches; only the first is executed inline.
    const first = (await mutate(convex, 'domains/marketplace/listings:takedownListing', {
      internalKey: INTERNAL_KEY,
      listingId: listing.listingId,
      limit: 1,
      now: 50_000,
    })) as { detached: number; remaining: boolean }
    expect(first).toMatchObject({ detached: 1, remaining: true })

    // The scheduler carries the rest. Poll rather than assume an interval.
    const deadline = Date.now() + 30_000
    let live = targets.length
    while (Date.now() < deadline && live > 0) {
      const rows = (await query(convex, 'testing/marketplace:rawSubscriptionsForTest', {
        internalKey: INTERNAL_KEY,
        workspaceId: targets[live - 1]!,
      })) as Array<{ state: string }>
      if (rows.every(row => row.state === 'detached')) live -= 1
      else await new Promise(resolve => setTimeout(resolve, 250))
    }
    expect(live).toBe(0)
  }, 120_000)

  test('takedown refuses immediately and drains detaches in bounded batches', async () => {
    const listing = await listingFixture('takedown')
    const target = await installerWorkspace('takedown-installer')
    await mutate(convex, 'domains/marketplace/model:install', {
      internalKey: INTERNAL_KEY,
      actorId: owner.user._id,
      workspaceId: target,
      listingId: listing.listingId,
    })

    const first = (await mutate(convex, 'domains/marketplace/listings:takedownListing', {
      internalKey: INTERNAL_KEY,
      listingId: listing.listingId,
      limit: 1,
      now: 30_000,
    })) as { detached: number; remaining: boolean }
    expect(first.detached).toBe(1)

    // Removed listings leave the catalog at once — refusal does not wait for
    // the drain to finish.
    const catalog = (await query(convex, 'domains/marketplace/listings:catalog', {
      internalKey: INTERNAL_KEY,
    })) as { listings: { id: string }[] }
    expect(catalog.listings.some(entry => entry.id === listing.listingId)).toBe(false)

    // A second pass is a no-op rather than a double-detach.
    const second = (await mutate(convex, 'domains/marketplace/listings:takedownListing', {
      internalKey: INTERNAL_KEY,
      listingId: listing.listingId,
      limit: 1,
      now: 31_000,
    })) as { detached: number; remaining: boolean }
    expect(second).toMatchObject({ detached: 0, remaining: false })
  }, 120_000)

  test('takedown advances through live state lanes behind 1000 detached tombstones', async () => {
    const listing = await listingFixture('takedown-tombstones')
    const target = await installerWorkspace('td-tombstone')
    await mutate(convex, 'testing/marketplace:seedSubscriptionListHistoryForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: target,
      listingId: listing.listingId,
      createdByUserId: owner.user._id,
      detachedCount: 1_000,
      live: [
        { agentName: 'error-last', path: 'agents/error-last', state: 'error' },
        { agentName: 'active-second', path: 'agents/active-second', state: 'active' },
        { agentName: 'installing-first', path: 'agents/installing-first', state: 'installing' },
      ],
    })

    const first = (await mutate(convex, 'domains/marketplace/listings:takedownListing', {
      internalKey: INTERNAL_KEY,
      listingId: listing.listingId,
      limit: 2,
      now: 51_000,
    })) as { detached: number; remaining: boolean }
    expect(first).toEqual({ detached: 2, remaining: true })
    const live = (await query(convex, 'testing/marketplace:rawSubscriptionsForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: target,
    })) as Array<{ agentName: string; state: string }>
    expect(live.filter(row => row.state !== 'detached')).not.toContainEqual(
      expect.objectContaining({ agentName: 'installing-first' }),
    )
    expect(live.filter(row => row.state !== 'detached')).not.toContainEqual(
      expect.objectContaining({ agentName: 'active-second' }),
    )
  }, 120_000)

  test('the availability sweep derives greying from the publisher, and is reversible', async () => {
    const listing = await listingFixture('availability')
    const availabilityOf = async () => {
      const catalog = (await query(convex, 'domains/marketplace/listings:catalog', {
        internalKey: INTERNAL_KEY,
      })) as { listings: { id: string; availability: string }[] }
      return catalog.listings.find(entry => entry.id === listing.listingId)?.availability
    }

    // The sweep is the ONE writer, and it derives its verdict rather than
    // taking one: a caller-supplied verdict would let any installer grey out
    // a rival's listing.
    expect(await availabilityOf()).toBe('available')

    // The publisher's workspace going non-active IS the origin going away —
    // servicing decommission, archival and deletion all land here.
    await mutate(convex, 'testing/workspaces:setWorkspaceStatusForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: listing.workspaceId,
      status: 'retired',
    })
    // The sweep is catalog-wide, so its `changed` count belongs to every
    // fixture in this file; only THIS listing's verdict is this test's subject.
    await mutate(convex, 'domains/marketplace/listings:sweepListingAvailability', {
      internalKey: INTERNAL_KEY,
      now: 40_000,
    })
    expect(await availabilityOf()).toBe('unavailable')

    // Recovery is automatic — nothing has to be re-listed by hand.
    await mutate(convex, 'testing/workspaces:setWorkspaceStatusForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: listing.workspaceId,
      status: 'active',
    })
    await mutate(convex, 'domains/marketplace/listings:sweepListingAvailability', {
      internalKey: INTERNAL_KEY,
      now: 41_000,
    })
    expect(await availabilityOf()).toBe('available')

    // A deleted publish is the other way an origin dies: the URL would 404.
    await mutate(convex, 'testing/marketplace:deletePublishRowForTest', {
      internalKey: INTERNAL_KEY,
      publishId: listing.publishId,
    })
    await mutate(convex, 'domains/marketplace/listings:sweepListingAvailability', {
      internalKey: INTERNAL_KEY,
      now: 42_000,
    })
    expect(await availabilityOf()).toBe('unavailable')
  }, 120_000)

  test('the gate refuses registration server-side, with zero writes', async () => {
    const seed = await registrationFixture('gated')
    // The fixture boots with publishing off, which is the shipping default —
    // a hidden button is not what makes this refuse.
    await expect(
      mutate(convex, 'domains/marketplace/listings:registerListingFromAgent', {
        internalKey: INTERNAL_KEY,
        actorId: owner.user._id,
        ...seed.args,
      }),
    ).rejects.toThrow(/publishing_disabled/)

    const catalog = (await query(convex, 'domains/marketplace/listings:catalog', {
      internalKey: INTERNAL_KEY,
    })) as {
      listings: { publisherSlug: string }[]
      canPublishListings: boolean
    }
    expect(catalog.canPublishListings).toBe(false)
    // Nothing was written for the refused workspace. Other fixtures in this
    // file insert listing rows directly, so the catalog is not empty overall.
    expect(catalog.listings.some(entry => entry.publisherSlug === seed.workspaceSlug)).toBe(false)
  }, 120_000)

  test('listing registration ignores 1000 detached subscription tombstones', async () => {
    const publisher = await listingFixture('reg-tombs', { skipListingRow: true })
    const foreign = await listingFixture('reg-source')
    await mutate(convex, 'testing/marketplace:seedSubscriptionListHistoryForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: publisher.workspaceId,
      listingId: foreign.listingId,
      createdByUserId: owner.user._id,
      detachedCount: 1_000,
      live: [],
    })

    const result = (await mutate(convex, 'testing/marketplace:registerListingImplForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: publisher.workspaceId,
      agentId: publisher.agentId,
      anchorId: publisher.anchorId,
      publishId: publisher.publishId,
      agentName: publisher.agentName,
      actorId: owner.user._id,
      now: 12_000,
    })) as { listing?: { anchorId: string }; error?: string }
    expect(result).toMatchObject({ listing: { anchorId: publisher.anchorId } })
  }, 120_000)
})

/** An installer workspace whose VM is registered, so the drive sync can speak for it. */
async function registeredInstallerWorkspace(
  prefix: string,
): Promise<{ workspaceId: string; vmTokenHash: string }> {
  await mutate(owner.client, 'testing/workspaces:activateCurrentUserSyntheticSubscriptionForTest', {
    internalKey: INTERNAL_KEY,
  })
  const slug = `${prefix}-${Date.now()}-${++sequence}`
  const provisioningToken = `token-${slug}`
  const now = Date.now()
  const begun = (await mutate(owner.client, 'testing/workspaces:prepareWorkspaceForRegistration', {
    internalKey: INTERNAL_KEY,
    actorId: owner.user._id,
    slug,
    name: `${prefix} Workspace`,
    imageRef: 'ttl.sh/duet-test-marketplace:1h',
    provisioningTokenHash: await sha256Hex(provisioningToken),
    provisioningTokenExpiresAt: now + 60_000,
    now,
  })) as { workspaceId: string }
  const registered = (await mutate(owner.client, 'domains/workspaces/provisioning:registerVm', {
    internalKey: INTERNAL_KEY,
    provisioningTokenHash: await sha256Hex(provisioningToken),
    workspaceHint: begun.workspaceId,
    vmName: `vm-${slug}`,
    sshDest: `exedev@vm-${slug}.exe.xyz`,
    httpsUrl: `https://${slug}.exe.xyz`,
    now: now + 1,
  })) as { vmToken: string }
  return { workspaceId: begun.workspaceId, vmTokenHash: await sha256Hex(registered.vmToken) }
}

async function sha256Hex(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret))
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

async function installerWorkspace(prefix: string): Promise<string> {
  const slug = `${prefix}-${Date.now()}-${++sequence}`
  const workspaceId = (await mutate(owner.client, 'testing/workspaces:createWorkspaceForTest', {
    internalKey: INTERNAL_KEY,
    slug,
    name: `${prefix} Workspace`,
  })) as string
  await mutate(owner.client, 'testing/workspaces:markWorkspaceLiveForTest', {
    internalKey: INTERNAL_KEY,
    workspaceId,
    now: Date.now(),
  })
  return workspaceId
}

async function registrationFixture(prefix: string) {
  const base = await listingFixture(prefix, { skipListingRow: true })
  return {
    workspaceSlug: base.workspaceSlug,
    args: {
      workspaceId: base.workspaceId,
      agentSlug: base.agentName,
      derived: { title: 'Sec Triage', summary: 'Triages alerts.', skills: [], changelog: '' },
      now: 10_000,
    },
  }
}

async function listingFixture(
  prefix: string,
  overrides: {
    agentSubpath?: string
    titleOverride?: string
    derivedTitle?: string
    derivedSummary?: string
    skipListingRow?: boolean
  } = {},
) {
  await mutate(owner.client, 'testing/workspaces:activateCurrentUserSyntheticSubscriptionForTest', {
    internalKey: INTERNAL_KEY,
  })
  const slug = `${prefix}-${Date.now()}-${++sequence}`
  const workspaceId = (await mutate(owner.client, 'testing/workspaces:createWorkspaceForTest', {
    internalKey: INTERNAL_KEY,
    slug,
    name: `${prefix} Workspace`,
  })) as string
  await mutate(owner.client, 'testing/workspaces:markWorkspaceLiveForTest', {
    internalKey: INTERNAL_KEY,
    workspaceId,
    now: Date.now(),
  })
  // These fixtures stand in for a verified publisher whose listings are
  // installed by listing id.
  await mutate(convex, 'testing/marketplace:markVerifiedPublisherForTest', {
    internalKey: INTERNAL_KEY,
    workspaceId,
    now: 10_000,
  })
  // Unique per fixture so listing registration and assertions remain isolated.
  const agentName = `sec-triage-${prefix}`
  const agentPath = `agents/${agentName}`
  const agent = (await mutate(owner.client, 'domains/agents/model:registerAgent', {
    workspaceId,
    path: agentPath,
    slug: agentName,
    name: 'Sec Triage',
  })) as { id: string; anchorId: string }
  // The publish is anchored on the agent folder for the default case, and on
  // its parent when the fixture asks for a subpath — the two real layouts.
  const publishPath = overrides.agentSubpath === undefined ? agentPath : 'agents'
  const publish = (await mutate(owner.client, 'domains/publishes/model:createPublish', {
    workspaceId,
    path: publishPath,
    kind: 'folder',
    now: 10_000,
  })) as { slug: string; id: string }
  let listingId: string | undefined
  if (overrides.skipListingRow !== true)
    listingId = (await mutate(convex, 'testing/marketplace:insertListingForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      agentId: agent.id,
      anchorId: agent.anchorId,
      publishId: publish.id,
      agentName,
      agentSubpath: overrides.agentSubpath ?? '',
      createdByUserId: owner.user._id,
      now: 10_000,
      ...(overrides.titleOverride === undefined ? {} : { titleOverride: overrides.titleOverride }),
      ...(overrides.derivedTitle === undefined ? {} : { derivedTitle: overrides.derivedTitle }),
      ...(overrides.derivedSummary === undefined
        ? {}
        : { derivedSummary: overrides.derivedSummary }),
    })) as string
  return {
    workspaceId,
    workspaceSlug: slug,
    agentName,
    listingId: listingId as string,
    agentId: agent.id,
    anchorId: agent.anchorId,
    publishId: publish.id,
    publishSlug: publish.slug,
  }
}
