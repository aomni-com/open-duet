import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { ConvexHttpClient } from 'convex/browser'

import { SERVICING_ARCHIVE_AFTER_MS } from '@repo/contract'
import { buildOfficialSyncPlan } from '@repo/official-agents-seed'
import {
  officialSeedAgents,
  OFFICIAL_AGENTS_PUBLISH_SLUG,
} from '@repo/official-agents-seed/manifest'
import {
  convexDev,
  generateAuthKeys,
  query,
  signInWithMagicLink,
  TEST_AUTH_CODE,
  uniqueEmail,
  type ConvexDevFixture,
} from '@repo/test-harness'

const BACKEND_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const INTERNAL_KEY = 'test-official-hub-internal-key'
const OWNER_EMAIL = uniqueEmail('official-hub-owner')
let convex: ConvexDevFixture
let admin: { client: ConvexHttpClient; user: { _id: string; email: string } }

describe('official hub seed orchestration', () => {
  beforeAll(async () => {
    convex = await convexDev(BACKEND_DIR, {
      env: {
        ...generateAuthKeys(),
        DUET_API_INTERNAL_KEY: INTERNAL_KEY,
        DUET_TEST_AUTH_CODE: TEST_AUTH_CODE,
        DUET_TEST_AUTH_EMAIL: '1',
        DUET_TEST_FAKE_EXE: '1',
        DUET_VM_IMAGE_REF: 'ttl.sh/official-hub-test:1h',
        DUET_API_URL: 'http://api.example',
        DUET_APP_URL: 'http://localhost:3000',
      },
      reset: true,
    })
    admin = await signInWithMagicLink(
      convex,
      uniqueEmail('official-hub-admin').replace(/@[^@]+$/, '@duet.so'),
      'Hub Admin',
    )
    // The real owner (admin@duet.so) is an UNPAID system account whose
    // sign-in already bootstrapped a personal workspace — the golden
    // workspace is always its second. The seed must not depend on the
    // owner's billing state.
    await signInWithMagicLink(convex, OWNER_EMAIL, 'Official Hub Owner')
  }, 240_000)

  afterAll(async () => {
    await convex?.stop()
  })

  /** The hub row as it actually stands, read back through the snapshot query. */
  const hubWorkspace = async () => {
    const snapshot = (await query(convex, 'testing/internalAdmin:officialHubSeedSnapshot', {
      internalKey: INTERNAL_KEY,
    })) as {
      runs: Array<{ workspaceId: string }>
      workspaces: Array<{
        _id: string
        billingUserId: string
        servicingStatus?: string
        servicingExemptAt?: number
      }>
    }
    const workspaceId = snapshot.runs[0]?.workspaceId
    const hub = snapshot.workspaces.find(row => row._id === workspaceId)
    if (hub === undefined) throw new Error('hub workspace not found in snapshot')
    return hub
  }

  const reconcileAt = async (userId: string, now: number) =>
    await convex.mutation('testing/workspaces:reconcileServicingStatusForTest', {
      internalKey: INTERNAL_KEY,
      userId,
      now,
    })

  test('concurrent starts converge on one golden workspace', async () => {
    const input = {
      internalKey: INTERNAL_KEY,
      actorId: admin.user._id,
      ownerEmail: OWNER_EMAIL,
      requestId: 'official-hub-race',
      reason: 'Seed official hub fixture',
      now: 10_000,
    }

    const starts = (await Promise.all([
      convex.mutation('domains/internalAdmin/officialHub:beginSync', input),
      convex.mutation('domains/internalAdmin/officialHub:beginSync', input),
    ])) as Array<{ workspaceId: string; workspaceSlug: string; state: string }>

    const workspaceId = starts[0]!.workspaceId
    expect(starts[0]).toEqual(starts[1])
    const snapshot = (await query(convex, 'testing/internalAdmin:officialHubSeedSnapshot', {
      internalKey: INTERNAL_KEY,
    })) as { runs: Array<{ workspaceId: string }>; workspaces: Array<{ _id: string }> }
    expect(snapshot.runs).toEqual([expect.objectContaining({ workspaceId })])
    expect(snapshot.workspaces.map(row => row._id)).toContain(workspaceId)
  })

  // AFTER the owner's signup trial has lapsed. Every exemption assertion below
  // has to be made at this clock: a fresh magic-link account is granted trial
  // credits at birth, so at the fixture's small `now` values the owner is
  // genuinely entitled and the hub would read `active` with or without an
  // exemption. Asserting at those clocks passes whatever the code does — the
  // first draft of these tests did exactly that, and only the revoke case
  // failing revealed the other two were vacuous.
  const AFTER_TRIAL = Date.UTC(2100, 0, 1)

  test('the hub is born billing-exempt, and the exemption is what keeps it active', async () => {
    const hub = await hubWorkspace()
    expect(hub.servicingExemptAt).toEqual(expect.any(Number))

    // Reconcile at a clock where the owner is entitled to nothing. An
    // unexempt workspace on this payer would be paused here; birth stamping
    // the payer's verdict is precisely the bug this feature fixed.
    await reconcileAt(hub.billingUserId, AFTER_TRIAL)

    expect((await hubWorkspace()).servicingStatus).toBe('active')
  })

  test('an exempt hub is excluded from the decommission sweep even while paused', async () => {
    // Force `paused` behind the exemption's back, the way an archival
    // transition does, then prove the sweep will not reclaim it and the
    // reconciler restores it.
    const hub = await hubWorkspace()
    await convex.mutation('testing/workspaces:markWorkspaceLiveForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: hub._id,
      now: AFTER_TRIAL,
    })
    await convex.mutation('testing/workspaces:setWorkspaceServicingForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: hub._id,
      servicingStatus: 'paused',
      now: AFTER_TRIAL,
    })

    const candidates = (await query(
      convex,
      'domains/workspaces/provisioning:servicingDecommissionCandidates',
      { internalKey: INTERNAL_KEY, now: AFTER_TRIAL + SERVICING_ARCHIVE_AFTER_MS + 1 },
    )) as { workspaces?: Array<{ workspaceId: string }> } | Array<{ workspaceId: string }>
    const rows = Array.isArray(candidates) ? candidates : (candidates.workspaces ?? [])
    expect(rows.map(row => row.workspaceId)).not.toContain(hub._id)

    await reconcileAt(hub.billingUserId, AFTER_TRIAL + 1_000)
    expect((await hubWorkspace()).servicingStatus).toBe('active')
  })

  test('an admin can revoke the exemption, audited, and billing resumes', async () => {
    const hub = await hubWorkspace()
    const mutate = async (exempt: boolean, now: number) =>
      await convex.mutation('domains/internalAdmin/model:mutateWorkspace', {
        internalKey: INTERNAL_KEY,
        actorId: admin.user._id,
        workspaceId: hub._id,
        requestId: `official-hub-exempt-${now}`,
        reason: 'Servicing exemption fixture',
        now,
        operation: 'servicing_exempt',
        exempt,
      })

    // Revoking at a lapsed clock: the payer's verdict applies again at once.
    await mutate(false, AFTER_TRIAL)
    const revoked = await hubWorkspace()
    expect(revoked.servicingExemptAt).toBeUndefined()
    expect(revoked.servicingStatus).toBe('paused')

    await mutate(true, AFTER_TRIAL + 1_000)
    const restored = await hubWorkspace()
    expect(restored.servicingExemptAt).toEqual(expect.any(Number))
    expect(restored.servicingStatus).toBe('active')

    const audit = (await convex.query('domains/internalAdmin/model:listAdminAudit', {
      internalKey: INTERNAL_KEY,
      actorId: admin.user._id,
      workspaceId: hub._id,
    })) as { events: Array<{ action: string; requestId: string }> }
    expect(
      audit.events
        .filter(event => event.action.includes('servicing_exempt'))
        .map(event => ({ action: event.action, requestId: event.requestId }))
        .sort((a, b) => a.requestId.localeCompare(b.requestId)),
    ).toEqual(
      [AFTER_TRIAL, AFTER_TRIAL + 1_000].map(now => ({
        action: 'admin.workspace.servicing_exempt',
        requestId: `official-hub-exempt-${now}`,
      })),
    )
  })

  test('completion is idempotent and manifest rows agree with the official seed', async () => {
    const begun = (await convex.mutation('domains/internalAdmin/officialHub:beginSync', {
      internalKey: INTERNAL_KEY,
      actorId: admin.user._id,
      ownerEmail: OWNER_EMAIL,
      requestId: 'official-hub-complete',
      reason: 'Finish official hub fixture',
      now: 20_000,
    })) as { workspaceId: string }
    const input = {
      internalKey: INTERNAL_KEY,
      actorId: admin.user._id,
      requestId: 'official-hub-complete',
      reason: 'Finish official hub fixture',
      agents: buildOfficialSyncPlan().agents,
      now: 21_000,
    }

    const first = (await convex.mutation(
      'domains/internalAdmin/officialHub:completeSync',
      input,
    )) as { workspaceSlug: string }
    const second = await convex.mutation('domains/internalAdmin/officialHub:completeSync', input)

    // Ran again in full rather than short-circuiting. Convergence is asserted
    // on the PERSISTED state below — one publish, one hub row, one set of
    // agents — rather than on the returned shape, which says nothing about
    // whether the second run duplicated anything.
    expect(second).toEqual(first)
    const snapshot = (await query(convex, 'testing/internalAdmin:officialHubSeedSnapshot', {
      internalKey: INTERNAL_KEY,
    })) as {
      runs: Array<{ workspaceId: string }>
      anchors: Array<{ _id: string; path: string }>
      agents: Array<{ anchorId: string; slug: string; name?: string }>
      apps: Array<{
        anchorId: string
        slug: string
        name?: string
        command: string
        installCommand?: string
      }>
      publishes: Array<{ _id: string; workspaceId: string; slug: string }>
    }
    // One `officialHub` row, still pointing at the workspace `beginSync`
    // resolved — a second completion must not fork a second hub.
    expect(snapshot.runs).toHaveLength(1)
    expect(snapshot.runs[0]?.workspaceId).toBe(begun.workspaceId)
    const pathByAnchor = new Map(snapshot.anchors.map(anchor => [anchor._id, anchor.path]))
    expect(
      snapshot.agents
        .map(row => ({ slug: row.slug, name: row.name, path: pathByAnchor.get(row.anchorId) }))
        .sort((left, right) => left.slug.localeCompare(right.slug)),
    ).toEqual(
      officialSeedAgents
        .map(agent => ({ slug: agent.slug, name: agent.name, path: agent.path }))
        .sort((left, right) => left.slug.localeCompare(right.slug)),
    )
    /* An app is optional, so this compares against the agents that DECLARE
       one rather than assuming a one-to-one mapping. An app-less agent must
       register no app at all — not a placeholder row — and with the roster
       currently app-free that means the hub holds none. Asserting the derived
       set rather than a hardcoded empty array keeps this honest once the first
       real app lands. */
    expect(
      snapshot.apps
        .map(row => ({
          slug: row.slug,
          name: row.name,
          path: pathByAnchor.get(row.anchorId),
          command: row.command,
          installCommand: row.installCommand,
        }))
        .sort((left, right) => left.slug.localeCompare(right.slug)),
    ).toEqual(
      officialSeedAgents
        .flatMap(agent =>
          (agent.apps ?? []).map(app => ({
            slug: app.slug,
            name: app.name,
            path: app.path,
            command: app.command,
            installCommand: app.installCommand,
          })),
        )
        .sort((left, right) => left.slug.localeCompare(right.slug)),
    )
    // Exactly one publish after two completions, and it is the hub's own:
    // `createPublishImpl` is idempotent by anchor, so a second sync must not
    // mint a rival. Asserting only the count would pass if the second run
    // replaced the first rather than reusing it.
    expect(snapshot.publishes).toEqual([
      expect.objectContaining({
        workspaceId: begun.workspaceId,
        slug: OFFICIAL_AGENTS_PUBLISH_SLUG,
      }),
    ])
  })

  test('a repeat sync re-registers from the manifest instead of short-circuiting', async () => {
    // The predecessor returned an `existing` verdict here and the route relied
    // on it to bail before writing a single file — which is exactly what made
    // the hub un-updatable and what this feature reverses. A sync now always
    // runs; converging to the same place is what makes it safe to press.
    const readSnapshot = async () =>
      (await query(convex, 'testing/internalAdmin:officialHubSeedSnapshot', {
        internalKey: INTERNAL_KEY,
      })) as { agents: Array<{ slug: string }>; runs: Array<{ workspaceId: string }> }
    const before = await readSnapshot()

    const again = (await convex.mutation('domains/internalAdmin/officialHub:beginSync', {
      internalKey: INTERNAL_KEY,
      actorId: admin.user._id,
      requestId: 'official-hub-resync',
      reason: 'Sync official hub fixture again',
      ownerEmail: OWNER_EMAIL,
      now: 12_000,
    })) as { workspaceId: string }
    await convex.mutation('domains/internalAdmin/officialHub:completeSync', {
      internalKey: INTERNAL_KEY,
      actorId: admin.user._id,
      requestId: 'official-hub-resync',
      reason: 'Sync official hub fixture again',
      agents: buildOfficialSyncPlan().agents,
      now: 13_000,
    })

    // Same hub, no duplicate run ledger, no duplicated agent rows.
    expect(again.workspaceId).toBe(before.runs[0]!.workspaceId)
    const after = await readSnapshot()
    expect(after.runs).toHaveLength(1)
    expect(after.agents.map(row => row.slug).sort()).toEqual(
      officialSeedAgents.map(agent => agent.slug).toSorted(),
    )
  })

  test('a repeat sync keeps auto-assigned ports stable', async () => {
    // The manifest omits `port` for every seeded agent, which means "assign
    // one", not "have none". A sync must therefore see NO difference and leave
    // the assigned port alone — reassigning it would move a running app's
    // address on every press.
    const portOf = async (slug: string) => {
      const snapshot = (await query(convex, 'testing/internalAdmin:officialHubSeedSnapshot', {
        internalKey: INTERNAL_KEY,
      })) as { apps: Array<{ slug: string; port?: number }> }
      return snapshot.apps.find(row => row.slug === slug)?.port
    }
    /* Driven by a SYNTHETIC agent-with-app rather than the roster: port
       stability across repeat syncs is a property of the sync itself and must
       keep being proved regardless of what the catalog happens to contain. The
       app path derives from the agent's own folder — registration refuses a
       declaration outside it. */
    const first = buildOfficialSyncPlan().agents[0]!
    const withApp = {
      ...first,
      apps: [
        {
          path: `${first.path}/apps/port-fixture`,
          slug: 'port-fixture',
          command: 'bun run server.ts',
          apiScopes: [],
          installCommand: 'bun install',
        },
      ],
    }
    await convex.mutation('domains/internalAdmin/officialHub:completeSync', {
      internalKey: INTERNAL_KEY,
      actorId: admin.user._id,
      requestId: 'official-hub-port-seed',
      reason: 'Port stability fixture',
      agents: [withApp],
      now: 39_000,
    })
    const slug = withApp.apps[0]!.slug
    const before = await portOf(slug)
    expect(before).toEqual(expect.any(Number))

    await convex.mutation('domains/internalAdmin/officialHub:beginSync', {
      internalKey: INTERNAL_KEY,
      actorId: admin.user._id,
      ownerEmail: OWNER_EMAIL,
      requestId: 'official-hub-port',
      reason: 'Port stability fixture',
      now: 40_000,
    })
    await convex.mutation('domains/internalAdmin/officialHub:completeSync', {
      internalKey: INTERNAL_KEY,
      actorId: admin.user._id,
      requestId: 'official-hub-port',
      reason: 'Port stability fixture',
      agents: [withApp],
      now: 40_001,
    })

    expect(await portOf(slug)).toBe(before)
  })

  test('an app the manifest stopped declaring is retired from the hub', async () => {
    /* The manifest decides which roots are managed; inside a managed root the
       repo is the whole truth. Files already work that way — a sync reaps what
       the plan no longer claims. Registrations did not: a deleted app kept its
       row, kept appearing in the listing's contained apps, and kept being
       installed by subscribers into a folder whose files the reap had removed.
       That is the deadlock `data-analyst` and `research-assistant` sat in.

       An app dropped from an agent that is STILL managed is unambiguous
       deletion. (Dropping the whole agent is subtree deletion, owned by the
       next test.) */
    const base = buildOfficialSyncPlan().agents[0]!
    const declare = (slugs: string[]) => ({
      ...base,
      apps: slugs.map(slug => ({
        path: `${base.path}/apps/${slug}`,
        slug,
        command: 'bun run server.ts',
        apiScopes: [],
        installCommand: 'bun install',
      })),
    })
    const sync = async (agents: unknown[], requestId: string, now: number) => {
      await convex.mutation('domains/internalAdmin/officialHub:beginSync', {
        internalKey: INTERNAL_KEY,
        actorId: admin.user._id,
        ownerEmail: OWNER_EMAIL,
        requestId,
        reason: 'Retirement fixture',
        now,
      })
      await convex.mutation('domains/internalAdmin/officialHub:completeSync', {
        internalKey: INTERNAL_KEY,
        actorId: admin.user._id,
        requestId,
        reason: 'Retirement fixture',
        agents,
        now: now + 1,
      })
    }
    const liveApps = async () => {
      const snapshot = (await query(convex, 'testing/internalAdmin:officialHubSeedSnapshot', {
        internalKey: INTERNAL_KEY,
      })) as { apps: Array<{ slug: string; disabledAt?: number }> }
      // Scoped to this test's own two apps: the hub snapshot carries whatever
      // neighbouring tests declared, and this assertion is about retirement,
      // not about what else happens to live in the fixture.
      const mine = new Set(['keeper', 'goner'])
      return snapshot.apps
        .filter(row => row.disabledAt === undefined && mine.has(row.slug))
        .map(row => row.slug)
        .sort()
    }

    await sync([declare(['keeper', 'goner'])], 'official-hub-retire-seed', 44_000)
    expect(await liveApps()).toEqual(['goner', 'keeper'])

    // The repo drops one app and keeps the other.
    await sync([declare(['keeper'])], 'official-hub-retire', 45_000)
    expect(await liveApps()).toEqual(['keeper'])

    // And back again. Apps come and go constantly, so retirement has to be
    // reversible by the same mechanism that caused it: a plain re-register does
    // NOT clear `disabledAt`, so the sync has to assert both directions or a
    // re-added app stays dead forever.
    await sync([declare(['keeper', 'goner'])], 'official-hub-revive', 46_000)
    expect(await liveApps()).toEqual(['goner', 'keeper'])
  })

  test('an agent the manifest stopped declaring is deleted from the hub and unlisted', async () => {
    /* The old policy was demotion — a dropped agent kept its row and kept
       serving what it last had — and every retirement became a hand-run data
       operation: delete the row, delete the folder, unlist the listing, in two
       environments. The manifest is the whole truth for the hub, so the sync
       now carries deletion itself: absent from the plan means gone from the
       roster and out of the catalog, and the operator presses one button. */
    const plan = buildOfficialSyncPlan().agents
    const sync = async (agents: readonly unknown[], now: number) => {
      await convex.mutation('domains/internalAdmin/officialHub:beginSync', {
        internalKey: INTERNAL_KEY,
        actorId: admin.user._id,
        ownerEmail: OWNER_EMAIL,
        requestId: `official-hub-agent-retire-${now}`,
        reason: 'Agent retirement fixture',
        now,
      })
      return (await convex.mutation('domains/internalAdmin/officialHub:completeSync', {
        internalKey: INTERNAL_KEY,
        actorId: admin.user._id,
        requestId: `official-hub-agent-retire-${now}`,
        reason: 'Agent retirement fixture',
        agents,
        now: now + 1,
      })) as { retiredAgents: Array<{ slug: string; path: string }> }
    }
    const snapshot = async () =>
      (await query(convex, 'testing/internalAdmin:officialHubSeedSnapshot', {
        internalKey: INTERNAL_KEY,
      })) as {
        agents: Array<{ slug: string }>
        listings: Array<{ agentName: string; state: string }>
      }

    const goner = plan[0]!
    const seeded = await sync(plan, 60_000)
    expect(seeded.retiredAgents).toEqual([])
    expect((await snapshot()).agents.map(a => a.slug)).toContain(goner.slug)

    const retired = await sync(plan.slice(1), 61_000)
    expect(retired.retiredAgents).toEqual([{ slug: goner.slug, path: goner.path }])
    const after = await snapshot()
    // Deleted, not demoted: the row is gone, and the listing left the catalog.
    expect(after.agents.map(a => a.slug)).not.toContain(goner.slug)
    expect(after.listings.find(row => row.agentName === goner.slug)?.state).toBe('unlisted')

    // Restoration is the same press that retired it: the next full sync
    // re-registers the agent and puts its listing back in front of customers.
    await sync(plan, 62_000)
    const restored = await snapshot()
    expect(restored.agents.map(a => a.slug)).toContain(goner.slug)
    expect(restored.listings.find(row => row.agentName === goner.slug)?.state).toBe('listed')
  }, 120_000)

  test('a sync stamps every hub listing with the revision of the press that ran it', async () => {
    /* The revision is what lets a subscriber be told "you already have this"
       instead of asking the origin every half hour. The hub's bytes change
       through exactly one door — this press — so this is where the token is
       minted, and it is the press's own requestId so a revision is traceable
       to the run that caused it. Stamped unconditionally: an over-eager bump
       costs one conditional request per subscriber, while working out which
       agents' files actually moved would need changed paths threaded from the
       API's converge leg through a closed validator. */
    const sync = async (requestId: string, now: number) => {
      await convex.mutation('domains/internalAdmin/officialHub:beginSync', {
        internalKey: INTERNAL_KEY,
        actorId: admin.user._id,
        ownerEmail: OWNER_EMAIL,
        requestId,
        reason: 'Content revision fixture',
        now,
      })
      await convex.mutation('domains/internalAdmin/officialHub:completeSync', {
        internalKey: INTERNAL_KEY,
        actorId: admin.user._id,
        requestId,
        reason: 'Content revision fixture',
        agents: buildOfficialSyncPlan().agents,
        now: now + 1,
      })
      const snapshot = (await query(convex, 'testing/internalAdmin:officialHubSeedSnapshot', {
        internalKey: INTERNAL_KEY,
      })) as { listings: Array<{ agentName: string; contentRevision?: string }> }
      return snapshot.listings
    }

    const first = await sync('official-hub-revision-one', 70_000)
    expect(first.length).toBeGreaterThan(0)
    for (const listing of first) expect(listing.contentRevision).toBe('official-hub-revision-one')

    // A second press is a change signal by design — the operator pressed the
    // button because they believe the bytes moved, and the backend cannot see
    // whether they did.
    const second = await sync('official-hub-revision-two', 71_000)
    for (const listing of second) expect(listing.contentRevision).toBe('official-hub-revision-two')
  }, 120_000)

  test('the seed publishes its agents as verified marketplace listings', async () => {
    // Both mutations are idempotent, so this test seeds for itself rather than
    // inheriting whatever a neighbouring test left behind.
    const plan = buildOfficialSyncPlan().agents.map(agent => ({
      ...agent,
      derived: { ...agent.derived, skills: ['fixture-skill'], tags: ['personal'] },
    }))
    await convex.mutation('domains/internalAdmin/officialHub:beginSync', {
      internalKey: INTERNAL_KEY,
      actorId: admin.user._id,
      ownerEmail: OWNER_EMAIL,
      requestId: 'official-hub-listings',
      reason: 'Seed listings fixture',
      now: 30_000,
    })
    await convex.mutation('domains/internalAdmin/officialHub:completeSync', {
      internalKey: INTERNAL_KEY,
      actorId: admin.user._id,
      requestId: 'official-hub-listings',
      reason: 'Seed listings fixture',
      agents: plan,
      now: 31_000,
    })
    const catalog = (await query(convex, 'domains/marketplace/listings:catalog', {
      internalKey: INTERNAL_KEY,
    })) as {
      listings: {
        agentName: string
        verifiedPublisher: boolean
        title: string
        tags: string[]
        skills: string[]
      }[]
    }
    // Official agents are ordinary listings on the shared rail — the badge is
    // derived from the publisher workspace, not stored per listing.
    expect(catalog.listings.length).toBeGreaterThan(0)
    expect(catalog.listings.every(entry => entry.verifiedPublisher)).toBe(true)
    expect(catalog.listings.map(entry => entry.agentName).sort()).toEqual(
      officialSeedAgents.map(agent => agent.slug).sort(),
    )

    expect(
      catalog.listings
        .map(entry => ({ agentName: entry.agentName, skills: entry.skills, tags: entry.tags }))
        .sort((a, b) => a.agentName.localeCompare(b.agentName)),
    ).toEqual(
      plan
        .map(agent => ({
          agentName: agent.slug,
          skills: agent.derived.skills,
          tags: agent.derived.tags,
        }))
        .sort((a, b) => a.agentName.localeCompare(b.agentName)),
    )
  }, 120_000)

  test('a sync does not revive a listing an operator took down', async () => {
    // Takedown is the emergency lever; the sync is the routine one. If a press
    // could revive a removed official agent, an admin pulling a bad agent would
    // be undone by the next deploy, silently and in front of customers.
    const sync = async (now: number) => {
      await convex.mutation('domains/internalAdmin/officialHub:beginSync', {
        internalKey: INTERNAL_KEY,
        actorId: admin.user._id,
        ownerEmail: OWNER_EMAIL,
        requestId: `official-hub-takedown-${now}`,
        reason: 'Takedown stickiness fixture',
        now,
      })
      await convex.mutation('domains/internalAdmin/officialHub:completeSync', {
        internalKey: INTERNAL_KEY,
        actorId: admin.user._id,
        requestId: `official-hub-takedown-${now}`,
        reason: 'Takedown stickiness fixture',
        agents: buildOfficialSyncPlan().agents,
        now: now + 1,
      })
    }
    const listings = async () =>
      (
        (await query(convex, 'testing/internalAdmin:officialHubSeedSnapshot', {
          internalKey: INTERNAL_KEY,
        })) as { listings: Array<{ _id: string; agentName: string; state: string }> }
      ).listings

    await sync(50_000)
    const target = (await listings()).find(row => row.agentName === officialSeedAgents[0]!.slug)!
    await convex.mutation('domains/internalAdmin/model:takedownMarketplaceListing', {
      internalKey: INTERNAL_KEY,
      actorId: admin.user._id,
      requestId: 'official-hub-takedown',
      reason: 'Removing a bad official agent',
      listingId: target._id,
      confirmation: 'TAKE DOWN LISTING',
      now: 51_000,
    })
    expect((await listings()).find(row => row._id === target._id)?.state).toBe('removed')

    await sync(52_000)

    expect((await listings()).find(row => row._id === target._id)?.state).toBe('removed')
    // The other agents still reconcile — the guard is per listing, not a halt.
    expect(
      (await listings())
        .filter(row => row.state === 'listed')
        .map(row => row.agentName)
        .sort(),
    ).toEqual(
      officialSeedAgents
        .slice(1)
        .map(agent => agent.slug)
        .sort(),
    )
  }, 120_000)
})
