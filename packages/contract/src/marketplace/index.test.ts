import { describe, expect, test } from 'bun:test'

import { MAX_APPS_PER_WORKSPACE } from '../apps/index'
import { DUET_EDGE_HOST, DUET_STAGING_EDGE_HOST } from '../edge/index'
import {
  ListingDerivedMetadataSchema,
  MAX_MARKETPLACE_AGENTS_MD_UTF8_BYTES,
  MAX_MARKETPLACE_CHANGELOG_UTF8_BYTES,
  MAX_MARKETPLACE_LISTING_SKILLS,
  MAX_MARKETPLACE_LAST_ERROR_CODE_UTF8_BYTES,
  MAX_MARKETPLACE_SUMMARY_UTF8_BYTES,
  ListingSourceUrlSchema,
  skillNamesFromAgentPaths,
  MarketplaceAgentInstallRequestSchema,
  MarketplaceAgentMutationErrorSchema,
  MarketplaceAgentNameSchema,
  MarketplaceListingDetailSchema,
  MarketplaceListingSummarySchema,
  MarketplaceInspectionResponseSchema,
  MarketplaceCatalogQuerySchema,
  MarketplaceAgentPullReportSchema,
  MarketplaceAgentSubscriptionSchema,
  VmDesiredMarketplaceAgentsSchema,
  WorkspaceOnboardingRequestSchema,
  deriveListingSourceUrl,
  marketplaceAgentInstallPath,
} from './index'

const marketplaceListingSummary = {
  id: 'listing-1',
  publisherSlug: 'acme',
  verifiedPublisher: false,
  agentName: 'research',
  title: 'Research',
  summary: 'Does research.',
  skills: [],
  installs: 0,
  availability: 'available' as const,
}

test('marketplace listing app metadata follows the workspace app ceiling', () => {
  const appNames = Array.from({ length: MAX_APPS_PER_WORKSPACE }, (_, index) => `App ${index}`)
  expect(
    MarketplaceListingSummarySchema.safeParse({ ...marketplaceListingSummary, appNames }).success,
  ).toBe(true)
  expect(
    MarketplaceListingSummarySchema.safeParse({
      ...marketplaceListingSummary,
      appNames: [...appNames, 'One app too many'],
    }).success,
  ).toBe(false)

  const apps = Array.from({ length: MAX_APPS_PER_WORKSPACE }, (_, index) => ({
    path: `apps/app-${index}`,
    command: 'bun run start',
    apiScopes: [],
  }))
  expect(
    MarketplaceListingDetailSchema.safeParse({
      ...marketplaceListingSummary,
      changelog: '',
      apps,
    }).success,
  ).toBe(true)
  expect(
    MarketplaceListingDetailSchema.safeParse({
      ...marketplaceListingSummary,
      changelog: '',
      apps: [...apps, { path: 'apps/overflow', command: 'bun run start', apiScopes: [] }],
    }).success,
  ).toBe(false)
})

test('marketplace stored and wire metadata has structural UTF-8 and array bounds', () => {
  const base = { title: 'Agent', summary: 'Useful', skills: [], changelog: '', tags: [] }
  expect(
    ListingDerivedMetadataSchema.safeParse({
      ...base,
      summary: `${'x'.repeat(MAX_MARKETPLACE_SUMMARY_UTF8_BYTES - 4)}🚀`,
    }).success,
  ).toBe(true)
  expect(
    ListingDerivedMetadataSchema.safeParse({
      ...base,
      summary: `${'x'.repeat(MAX_MARKETPLACE_SUMMARY_UTF8_BYTES - 3)}🚀`,
    }).success,
  ).toBe(false)
  expect(
    ListingDerivedMetadataSchema.safeParse({
      ...base,
      changelog: 'x'.repeat(MAX_MARKETPLACE_CHANGELOG_UTF8_BYTES + 1),
    }).success,
  ).toBe(false)
  expect(
    ListingDerivedMetadataSchema.safeParse({
      ...base,
      skills: Array.from({ length: MAX_MARKETPLACE_LISTING_SKILLS + 1 }, (_, i) => `skill-${i}`),
    }).success,
  ).toBe(false)

  expect(
    MarketplaceInspectionResponseSchema.safeParse({
      ok: true,
      entries: 1,
      bytes: 1,
      origin: {
        agentsMd: 'x'.repeat(MAX_MARKETPLACE_AGENTS_MD_UTF8_BYTES + 1),
        changelogMd: null,
        skills: [],
        agentJson: null,
      },
    }).success,
  ).toBe(false)
})

test('marketplace subscription diagnostics and report batches are bounded', () => {
  const over = 'x'.repeat(MAX_MARKETPLACE_LAST_ERROR_CODE_UTF8_BYTES + 1)
  expect(
    MarketplaceAgentSubscriptionSchema.safeParse({
      id: 'sub',
      listingId: 'listing',
      agentName: 'agent',
      path: 'agents/agent',
      mode: 'subscribe',
      state: 'error',
      lastErrorCode: over,
    }).success,
  ).toBe(false)
  expect(
    MarketplaceAgentPullReportSchema.safeParse({
      subscriptionId: 'sub',
      state: 'error',
      lastErrorCode: over,
    }).success,
  ).toBe(false)
})

const staging = {
  edgeHost: DUET_STAGING_EDGE_HOST,
  publisherWorkspaceSlug: 'acme-labs',
  publishSlug: 'sec-triage',
}

test('a publish anchored on the agent folder carries no agent segment', () => {
  // The correction this whole slice exists to pin: the publish root IS the
  // agent folder, so appending the agent name would address `sec-triage/sec-triage`.
  expect(deriveListingSourceUrl({ ...staging, agentSubpath: '' })).toBe(
    'https://edge-staging.duet.so/acme-labs/sec-triage?zip',
  )
})

test('a parent-folder publish addresses the agent by subpath', () => {
  // The official hub's layout: one publish over `agents/`, agents beneath it.
  expect(
    deriveListingSourceUrl({
      edgeHost: DUET_STAGING_EDGE_HOST,
      publisherWorkspaceSlug: 'official-agents-hub',
      publishSlug: 'marketplace',
      agentSubpath: 'research-assistant',
    }),
  ).toBe('https://edge-staging.duet.so/official-agents-hub/marketplace/research-assistant?zip')
})

test('production and staging edge hosts both derive', () => {
  expect(deriveListingSourceUrl({ ...staging, edgeHost: DUET_EDGE_HOST, agentSubpath: '' })).toBe(
    'https://edge.duet.so/acme-labs/sec-triage?zip',
  )
})

test('a nested subpath keeps every segment', () => {
  expect(deriveListingSourceUrl({ ...staging, agentSubpath: 'team/triage' })).toBe(
    'https://edge-staging.duet.so/acme-labs/sec-triage/team/triage?zip',
  )
})

test('derivation refuses a host that is not an edge host', () => {
  expect(() =>
    deriveListingSourceUrl({ ...staging, edgeHost: 'evil.com', agentSubpath: '' }),
  ).toThrow(/Invalid listing edge host/)
  // A lookalike must fail too: suffix matching would let `notedge.duet.so` and
  // `edge.duet.so.evil.com` through.
  expect(() =>
    deriveListingSourceUrl({ ...staging, edgeHost: 'edge.duet.so.evil.com', agentSubpath: '' }),
  ).toThrow(/Invalid listing edge host/)
  expect(() =>
    deriveListingSourceUrl({ ...staging, edgeHost: 'notedge.duet.so', agentSubpath: '' }),
  ).toThrow(/Invalid listing edge host/)
})

test('derivation refuses traversal, absolute, and empty subpath segments', () => {
  for (const agentSubpath of ['..', '../secrets', 'a/../..', '/absolute', 'a//b', 'a/', './x']) {
    expect(() => deriveListingSourceUrl({ ...staging, agentSubpath })).toThrow(
      /Invalid listing agentSubpath/,
    )
  }
})

test('derivation refuses percent-encoded traversal rather than decoding it', () => {
  // `%2e%2e` must not survive as a segment that a later decode turns into `..`.
  expect(() => deriveListingSourceUrl({ ...staging, agentSubpath: '%2e%2e' })).toThrow(
    /Invalid listing agentSubpath/,
  )
})

test('derivation refuses malformed workspace and publish slugs', () => {
  expect(() =>
    deriveListingSourceUrl({ ...staging, publisherWorkspaceSlug: 'Acme Labs', agentSubpath: '' }),
  ).toThrow()
  expect(() =>
    deriveListingSourceUrl({ ...staging, publishSlug: 'sec triage', agentSubpath: '' }),
  ).toThrow()
})

test('the schema accepts exactly what derivation produces', () => {
  for (const agentSubpath of ['', 'research-assistant', 'team/triage']) {
    const url = deriveListingSourceUrl({ ...staging, agentSubpath })
    expect(ListingSourceUrlSchema.safeParse(url).success).toBe(true)
  }
  expect(
    ListingSourceUrlSchema.safeParse(
      deriveListingSourceUrl({ ...staging, edgeHost: DUET_EDGE_HOST, agentSubpath: '' }),
    ).success,
  ).toBe(true)
})

test('the schema rejects a handed URL that is not an edge archive request', () => {
  const rejected = [
    'https://evil.com/acme-labs/sec-triage?zip',
    'https://edge-staging.duet.so.evil.com/a/b?zip',
    'http://edge-staging.duet.so/acme-labs/sec-triage?zip',
    'https://edge-staging.duet.so:8443/acme-labs/sec-triage?zip',
    'https://user:pw@edge-staging.duet.so/acme-labs/sec-triage?zip',
    'https://edge-staging.duet.so/acme-labs/sec-triage?raw',
    'https://edge-staging.duet.so/acme-labs/sec-triage',
    'https://edge-staging.duet.so/acme-labs/sec-triage?zip#frag',
    'https://edge-staging.duet.so/acme-labs//sec-triage?zip',
    'not a url',
    '',
  ]
  for (const url of rejected) {
    expect(ListingSourceUrlSchema.safeParse(url).success).toBe(false)
  }
})

describe('catalog wire tolerance', () => {
  test('the public catalog parses an explicit verified-publisher filter', () => {
    expect(
      MarketplaceCatalogQuerySchema.parse({ verifiedPublisher: 'true' }).verifiedPublisher,
    ).toBe(true)
    expect(
      MarketplaceCatalogQuerySchema.parse({ verifiedPublisher: 'false' }).verifiedPublisher,
    ).toBe(false)
  })
  /* web and api are separately deployed, so a newer SPA always spends some
     window parsing an older API's response. A required `tags` would turn that
     window into the marketplace's error state. */
  test('a catalog row without tags parses as untagged rather than failing', () => {
    const row = {
      id: 'listing-1',
      publisherSlug: 'acme',
      verifiedPublisher: false,
      agentName: 'research',
      title: 'Research',
      summary: 'Does research.',
      skills: [],
      installs: 0,
      availability: 'available' as const,
    }
    expect(MarketplaceListingSummarySchema.parse(row).tags).toEqual([])
    expect(MarketplaceListingSummarySchema.parse({ ...row, tags: ['sales'] }).tags).toEqual([
      'sales',
    ])
  })

  /* Same deploy-order window as tags: an older API sends no `appNames`, and a
     newer SPA must read that as "no apps", never as a parse failure. */
  test('a catalog row without appNames parses as app-less rather than failing', () => {
    const row = {
      id: 'listing-1',
      publisherSlug: 'acme',
      verifiedPublisher: false,
      agentName: 'research',
      title: 'Research',
      summary: 'Does research.',
      skills: [],
      installs: 0,
      availability: 'available' as const,
    }
    expect(MarketplaceListingSummarySchema.parse(row).appNames).toEqual([])
    expect(
      MarketplaceListingSummarySchema.parse({ ...row, appNames: ['Dashboard'] }).appNames,
    ).toEqual(['Dashboard'])
  })
})

describe('skill names from agent paths', () => {
  /* Two producers feed this: the gateway enumerates DIRECTORY entries of a
     remote folder, the seed only ever holds FILE paths of its own bytes. Both
     must land on the same list, or the same agent advertises different skills
     depending on who published it. */
  const dir = (relativePath: string) => ({ relativePath, kind: 'directory' as const })
  const file = (relativePath: string) => ({ relativePath, kind: 'file' as const })

  test('a directory entry and a file beneath it yield the same skill', () => {
    expect(skillNamesFromAgentPaths([dir('.agents/skills/evidence-brief')])).toEqual([
      'evidence-brief',
    ])
    expect(skillNamesFromAgentPaths([file('.agents/skills/evidence-brief/SKILL.md')])).toEqual([
      'evidence-brief',
    ])
  })

  /* The producers see different things — the gateway enumerates directories,
     the seed only ever holds file paths — so a stray REGULAR FILE sitting where
     a skill folder would go is the case that forks them. Inferring "a skill" by
     position alone made the seed advertise it and the gateway ignore it, which
     is the exact divergence this function exists to prevent. */
  test('a regular file where a skill folder would go is not a skill', () => {
    expect(skillNamesFromAgentPaths([file('.agents/skills/notes')])).toEqual([])
    expect(skillNamesFromAgentPaths([dir('.agents/skills/notes')])).toEqual(['notes'])
  })

  test('only the immediate child is a skill, and it is listed once', () => {
    expect(
      skillNamesFromAgentPaths([
        dir('.agents/skills/triage'),
        file('.agents/skills/triage/SKILL.md'),
        file('.agents/skills/triage/reference/deep.md'),
      ]),
    ).toEqual(['triage'])
  })

  test('paths outside the skills directory contribute nothing', () => {
    expect(
      skillNamesFromAgentPaths([
        file('AGENTS.md'),
        file('apps/board/server.ts'),
        file('.agents/notes.md'),
      ]),
    ).toEqual([])
  })

  test('the order is stable regardless of how the producer walked the tree', () => {
    expect(
      skillNamesFromAgentPaths([dir('.agents/skills/zeta'), dir('.agents/skills/alpha')]),
    ).toEqual(['alpha', 'zeta'])
  })
})

describe('marketplace subscription vocabulary', () => {
  test('uses one URL-safe name grammar for the canonical install path', () => {
    expect(MarketplaceAgentNameSchema.parse('research-assistant')).toBe('research-assistant')
    expect(marketplaceAgentInstallPath('research-assistant')).toBe('agents/research-assistant')
    expect(MarketplaceAgentNameSchema.safeParse('../escape').success).toBe(false)
    expect(() => marketplaceAgentInstallPath('../escape')).toThrow()
  })

  test('validates declared subscription fields and strips unknown ones', () => {
    const subscription = {
      id: 'subscription-1',
      agentId: 'agent-1',
      anchorId: 'anchor-1',
      listingId: 'listing-1',
      agentName: 'research-assistant',
      path: 'agents/research-assistant',
      mode: 'subscribe' as const,
      state: 'active' as const,
      appliedEtag: '"tree-v2"',
      acknowledgedEtag: '"tree-v1"',
      lastAppliedAt: 1_753_000_000_000,
    }

    expect(MarketplaceAgentSubscriptionSchema.parse(subscription)).toEqual(subscription)
    expect(
      MarketplaceAgentSubscriptionSchema.safeParse({ ...subscription, state: 'paused' }).success,
    ).toBe(false)
    expect(MarketplaceAgentSubscriptionSchema.parse({ ...subscription, unexpected: true })).toEqual(
      subscription,
    )
  })

  test('validates the backend-to-VM desired subscription wire shape', () => {
    const desired = {
      subscriptions: [
        {
          subscriptionId: 'subscription-1',
          listingId: 'listing-1',
          sourceUrl: 'https://edge.duet.so/acme-labs/research-assistant?zip',
          agentName: 'research-assistant',
          path: 'agents/research-assistant',
          anchorId: 'anchor-1',
          mode: 'subscribe' as const,
        },
      ],
    }

    expect(VmDesiredMarketplaceAgentsSchema.parse(desired)).toEqual(desired)
    expect(
      VmDesiredMarketplaceAgentsSchema.safeParse({
        ...desired,
        subscriptions: [{ ...desired.subscriptions[0], path: '../escape' }],
      }).success,
    ).toBe(false)

    // The revision rides the same entry and is optional FOREVER, not as a
    // migration shim: VM gateways upgrade on their own cadence, so a payload
    // from a newer backend must parse on a gateway that has never heard of the
    // field, and absence must survive the round trip as absence.
    const stamped = {
      subscriptions: [{ ...desired.subscriptions[0]!, contentRevision: 'press-7' }],
    }
    expect(VmDesiredMarketplaceAgentsSchema.parse(stamped)).toEqual(stamped)
    expect(VmDesiredMarketplaceAgentsSchema.parse(desired).subscriptions[0]).not.toHaveProperty(
      'contentRevision',
    )
  })

  test('discriminates successful and failed VM pull reports', () => {
    const applied = {
      subscriptionId: 'subscription-1',
      state: 'active' as const,
      appliedEtag: '"tree-v2"',
      lastAppliedAt: 1_753_000_000_000,
    }
    const failed = {
      subscriptionId: 'subscription-1',
      state: 'error' as const,
      lastErrorCode: 'recursive_limit_exceeded',
    }

    expect(MarketplaceAgentPullReportSchema.parse(applied)).toEqual(applied)
    expect(MarketplaceAgentPullReportSchema.parse(failed)).toEqual(failed)
    expect(
      MarketplaceAgentPullReportSchema.parse({
        subscriptionId: 'subscription-1',
        state: 'active',
        appliedEtag: '"tree-v2"',
        lastAppliedAt: 1_753_000_000_000,
        lastErrorCode: 'network_error',
      }),
    ).toEqual({
      subscriptionId: 'subscription-1',
      state: 'active',
      appliedEtag: '"tree-v2"',
      lastAppliedAt: 1_753_000_000_000,
    })
  })

  test('keeps install and pull failures as typed payloads and strips unknowns', () => {
    const pathExists = {
      error: 'path_exists' as const,
      path: 'agents/research-assistant',
      renameRequired: true as const,
    }

    expect(MarketplaceAgentMutationErrorSchema.parse(pathExists)).toEqual(pathExists)
    expect(MarketplaceAgentMutationErrorSchema.parse({ error: 'agent_limit_exceeded' })).toEqual({
      error: 'agent_limit_exceeded',
    })
    expect(MarketplaceAgentMutationErrorSchema.parse({ error: 'pull_failed' })).toEqual({
      error: 'pull_failed',
    })
    expect(
      MarketplaceAgentMutationErrorSchema.safeParse({ ...pathExists, renameRequired: false })
        .success,
    ).toBe(false)
    expect(
      MarketplaceAgentMutationErrorSchema.parse({ error: 'pull_failed', detail: 'internal' }),
    ).toEqual({ error: 'pull_failed' })
  })

  test('install identifies a LISTING, and the path defaults to canonical', () => {
    // A bare agent name is not installable: two publishers may ship the same
    // one, and the consent the user gave was to a specific publisher.
    expect(
      MarketplaceAgentInstallRequestSchema.safeParse({ name: 'research-assistant' }).success,
    ).toBe(false)
    // Naming is offered, never demanded: omitting it is a legal request that
    // means "use the listing's slug", so the server owns that fallback.
    expect(MarketplaceAgentInstallRequestSchema.parse({ listingId: 'listing-1' })).toEqual({
      listingId: 'listing-1',
    })
    expect(
      MarketplaceAgentInstallRequestSchema.parse({
        listingId: 'listing-1',
        name: '  Research  ',
      }),
    ).toEqual({ listingId: 'listing-1', name: 'Research' })
    // A name that IS typed must be usable — blank-after-trim and over-length
    // are the client's to fix, not ours to silently reinterpret or cut.
    for (const name of ['', '   ', 'x'.repeat(33)]) {
      expect(
        MarketplaceAgentInstallRequestSchema.safeParse({ listingId: 'listing-1', name }).success,
      ).toBe(false)
    }
    expect(
      MarketplaceAgentInstallRequestSchema.parse({
        listingId: 'listing-1',
        name: 'Research Assistant',
        path: 'agents/research-assistant-2',
      }),
    ).toEqual({
      listingId: 'listing-1',
      name: 'Research Assistant',
      path: 'agents/research-assistant-2',
    })
    expect(
      MarketplaceAgentInstallRequestSchema.safeParse({
        listingId: 'listing-1',
        name: 'Research Assistant',
        path: '../outside',
      }).success,
    ).toBe(false)
  })

  test('onboarding accepts one bounded set of starter names or an explicit skip', () => {
    expect(
      WorkspaceOnboardingRequestSchema.parse({
        duetName: '  Milo  ',
        selectedNames: ['research', 'writer'],
      }),
    ).toEqual({ duetName: 'Milo', selectedNames: ['research', 'writer'] })
    expect(WorkspaceOnboardingRequestSchema.parse({ duetName: 'Milo', skip: true })).toEqual({
      duetName: 'Milo',
      skip: true,
    })
    expect(
      WorkspaceOnboardingRequestSchema.safeParse({
        duetName: 'Milo',
        selectedNames: ['research', 'research'],
      }).success,
    ).toBe(false)
  })

  test('onboarding carries the purpose and analytics goal on both request shapes', () => {
    expect(
      WorkspaceOnboardingRequestSchema.parse({
        duetName: 'Milo',
        selectedNames: ['research'],
        purpose: '  Grow my bakery online  ',
        goal: 'grow-business',
      }),
    ).toEqual({
      duetName: 'Milo',
      selectedNames: ['research'],
      purpose: 'Grow my bakery online',
      goal: 'grow-business',
    })
    expect(
      WorkspaceOnboardingRequestSchema.parse({
        duetName: 'Milo',
        skip: true,
        purpose: 'Automate my invoicing busywork',
        goal: 'custom',
      }),
    ).toEqual({
      duetName: 'Milo',
      skip: true,
      purpose: 'Automate my invoicing busywork',
      goal: 'custom',
    })
    expect(
      WorkspaceOnboardingRequestSchema.safeParse({ duetName: 'Milo', skip: true, purpose: '   ' })
        .success,
    ).toBe(false)
  })

  test('onboarding can report an unexpected per-agent install failure without failing the request', () => {
    expect(MarketplaceAgentMutationErrorSchema.parse({ error: 'install_failed' })).toEqual({
      error: 'install_failed',
    })
  })
})
