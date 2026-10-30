import { describe, expect, test } from 'bun:test'

import { APP_AUTO_PORT_RANGE_START, APP_AUTO_PORT_RANGE_END } from '../apps/index'
import { COLLECTION_PAGE_DEFAULT_LIMIT, COLLECTION_PAGE_MAX_LIMIT } from '../pagination/index'
import { MAX_ICON_PATH_UTF8_BYTES } from '../relative-path/index'
import {
  AGENT_FIRST_MESSAGE_MAX_LENGTH,
  AgentConfigSchema,
  agentIsLaunchable,
  AgentListResponseSchema,
  AgentListQuerySchema,
  AgentNameSchema,
  agentResolutionCandidate,
  AgentResponseSchema,
  AgentRosterPageQuerySchema,
  AgentRosterPageSchema,
  AgentSchema,
  DeleteAgentResponseSchema,
  GatewayAgentConfigSchema,
  AgentIconSchema,
  MAX_AGENT_NAME_LENGTH,
  AGENT_TAGS,
  MAX_AGENT_TAGS,
  gatewayAgentCandidate,
  groupAgentsByParent,
  groupAppsByAgent,
  RegisterAgentRequestSchema,
  resolveAgentConfig,
  resolveNearestAgent,
  SetAgentDisabledRequestSchema,
  SetAgentOnboardedRequestSchema,
  UpdateAgentRequestSchema,
  UpdateDefaultAgentRequestSchema,
} from './index'

const agent = {
  id: 'agent-1',
  workspaceId: 'workspace-1',
  anchorId: 'anchor-1',
  anchorPath: 'agents/research',
  anchorState: 'active',
  slug: 'research',
  listingSubscriptionId: 'subscription-1',
  createdAt: 1,
  updatedAt: 2,
} as const

describe('agent wire contract', () => {
  test('agent icon paths are capped by UTF-8 bytes', () => {
    const atLimit = `${'a'.repeat(MAX_ICON_PATH_UTF8_BYTES - 4)}🚀`
    const overLimit = `${'a'.repeat(MAX_ICON_PATH_UTF8_BYTES - 3)}🚀`

    expect(new TextEncoder().encode(atLimit).byteLength).toBe(MAX_ICON_PATH_UTF8_BYTES)
    expect(AgentIconSchema.parse(atLimit)).toBe(atLimit)
    expect(AgentIconSchema.safeParse(overLimit).success).toBe(false)
  })

  // A markup-safety denylist, not a naming policy: a name is rendered into the
  // `<Agent …/>` mention tag and into the `[@Name](#…)` link a chip becomes, so
  // the characters that break those two grammars are refused and nothing else
  // is. Anything stricter takes names away from people for tidiness.
  test('refuses only the characters that break the mention grammars', () => {
    for (const name of ['Bad[name', 'Bad]name', 'Bad<name', 'Bad>name', 'Bad`name']) {
      expect(AgentNameSchema.safeParse(name).success).toBe(false)
    }
    // Control characters break a one-line tag as thoroughly as the brackets do,
    // and a name can only acquire one by accident.
    for (const name of ['Null\u0000name', 'Two\nlines', 'Delete\u007fkey', 'Next\u0085line']) {
      expect(AgentNameSchema.safeParse(name).success).toBe(false)
    }
    // Everything else a person might reasonably type stays legal — including
    // the zero-width joiner that holds a multi-person emoji together, which is
    // a format character rather than a control one.
    for (const name of [
      "Bob's Helper",
      'R&D',
      'Sales (EMEA)',
      'Data / Ops',
      '"Quoted"',
      'Zoë',
      '🤖 Scout',
      '👩‍💻 Pair',
    ]) {
      expect(AgentNameSchema.parse(name)).toBe(name)
    }
    expect(AgentNameSchema.parse('  Milo  ')).toBe('Milo')
    expect(AgentNameSchema.safeParse('   ').success).toBe(false)
    expect(AgentNameSchema.parse('x'.repeat(MAX_AGENT_NAME_LENGTH))).toBe(
      'x'.repeat(MAX_AGENT_NAME_LENGTH),
    )
    expect(AgentNameSchema.safeParse('x'.repeat(MAX_AGENT_NAME_LENGTH + 1)).success).toBe(false)
  })

  // Every seam that WRITES a name refuses one, so a bad name is a 400 at the
  // edge rather than a row the read paths have to tolerate later.
  test('refuses a markup-breaking name at every seam that writes one', () => {
    expect(
      RegisterAgentRequestSchema.safeParse({
        path: 'agents/research',
        slug: 'research',
        name: 'Bad<name>',
      }).success,
    ).toBe(false)
    expect(UpdateAgentRequestSchema.safeParse({ name: 'Bad<name>' }).success).toBe(false)
    expect(UpdateDefaultAgentRequestSchema.safeParse({ name: 'Bad<name>' }).success).toBe(false)
  })

  test('validates declared config fields hard while letting unknown ones through', () => {
    const retiredMode = {
      name: 'review',
      prompt: 'Review carefully',
      states: [{ kind: 'timer' as const, name: 'wait', wakeAfterMs: 1_000 }],
    }

    // `mode` is retired authored content: the loose schema preserves it as an
    // unknown field, while `resolveAgentConfig` ignores it below.
    expect(AgentConfigSchema.parse({ mode: retiredMode, triggers: [] })).toEqual({
      mode: retiredMode,
      triggers: [],
    })
    // `triggers` is reserved-and-empty but no longer required: a config that
    // only sets a newer field must not read as malformed on an older parser.
    expect(AgentConfigSchema.parse({ trainable: false })).toEqual({ trainable: false })
    expect(AgentConfigSchema.parse({})).toEqual({})
    // Declared fields still fail hard on a wrong type or a wrong value.
    expect(AgentConfigSchema.safeParse({ triggers: ['later'] }).success).toBe(false)
    expect(AgentConfigSchema.safeParse({ trainable: 'no' }).success).toBe(false)
    // An unknown key survives the parse rather than being rejected or dropped,
    // so a config written by a newer authoring surface round-trips intact.
    expect(AgentConfigSchema.parse({ triggers: [], futureKey: 7 })).toEqual({
      triggers: [],
      futureKey: 7,
    })
  })

  test('reads onboarding as chat, or as an app addressed by path under the agent root', () => {
    expect(AgentConfigSchema.parse({ onboarding: { kind: 'chat' } }).onboarding).toEqual({
      kind: 'chat',
    })
    // Dot-folders are legal so an author can keep the onboarding app out of the
    // way; the app is addressed by path because a replica's slug may be suffixed.
    expect(
      AgentConfigSchema.parse({
        onboarding: { kind: 'app', app: '.onboarding/style-picker' },
      }).onboarding,
    ).toEqual({ kind: 'app', app: '.onboarding/style-picker' })
    expect(AgentConfigSchema.safeParse({ onboarding: { kind: 'app' } }).success).toBe(false)
    expect(
      AgentConfigSchema.safeParse({ onboarding: { kind: 'app', app: '../escape' } }).success,
    ).toBe(false)
    expect(AgentConfigSchema.safeParse({ onboarding: { kind: 'wizard' } }).success).toBe(false)
  })

  test('resolves one effective config that owns the defaults and the fail-open state', () => {
    const retiredMode = {
      name: 'review',
      prompt: 'Review carefully',
      states: [{ kind: 'timer' as const, name: 'wait', wakeAfterMs: 1_000 }],
    }
    expect(resolveAgentConfig(JSON.stringify({ mode: retiredMode, triggers: [] }))).toEqual({
      readable: true,
      trainable: true,
      tags: [],
    })
    expect(resolveAgentConfig(JSON.stringify({ triggers: [] }))).toEqual({
      readable: true,
      trainable: true,
      tags: [],
    })
    expect(
      resolveAgentConfig(JSON.stringify({ trainable: false, onboarding: { kind: 'chat' } })),
    ).toEqual({ readable: true, trainable: false, tags: [], onboarding: { kind: 'chat' } })
    // `hideAfterOnboarded` defaults to true here and nowhere else, so the
    // gateway and the web app cannot disagree about what an omitted flag means.
    expect(
      resolveAgentConfig(JSON.stringify({ onboarding: { kind: 'app', app: 'picker' } })).onboarding,
    ).toEqual({ kind: 'app', app: 'picker', hideAfterOnboarded: true })
    expect(
      resolveAgentConfig(
        JSON.stringify({ onboarding: { kind: 'app', app: 'picker', hideAfterOnboarded: false } }),
      ).onboarding,
    ).toEqual({ kind: 'app', app: 'picker', hideAfterOnboarded: false })

    // Fail-open: a missing, unparseable, or schema-invalid config is a normal
    // state that reads as trainable and unlocked, never as an error.
    for (const source of [undefined, 'not json', JSON.stringify({ trainable: 'no' })]) {
      expect(resolveAgentConfig(source)).toEqual({ readable: false, trainable: true, tags: [] })
    }
  })

  /* THE TAG TRAP. `AgentConfigSchema` is `.loose()` and validates DECLARED
     fields hard, so declaring `tags` as an enum would make one unrecognised
     value throw — and the catch in `resolveAgentConfig` turns a throw into
     UNREADABLE_CONFIG, silently discarding the agent's onboarding block and
     its trainable flag. A tag typo would quietly break onboarding.

     So tags parse as plain strings and the vocabulary is applied downstream.
     What this test pins is not "unknown tags are dropped" on its own — it is
     that the REST OF THE CONFIG SURVIVES one. */
  test('an unrecognised tag drops without taking the rest of the config with it', () => {
    const resolved = resolveAgentConfig(
      JSON.stringify({
        tags: ['sales', 'not-a-real-tag'],
        trainable: false,
        onboarding: { kind: 'chat' },
      }),
    )

    expect(resolved.tags).toEqual(['sales'])
    expect(resolved.readable).toBe(true)
    expect(resolved.trainable).toBe(false)
    expect(resolved.onboarding).toEqual({ kind: 'chat' })
  })

  /* Same trap as tags: a wrong-typed `suggestedFirstMessage` must cost only
     itself, never the onboarding block riding in the same file. */
  test('a suggested first message resolves trimmed and drops alone when malformed', () => {
    expect(
      resolveAgentConfig(JSON.stringify({ suggestedFirstMessage: '  Hi — ready when you are.  ' }))
        .suggestedFirstMessage,
    ).toBe('Hi — ready when you are.')
    // Over-long authored text clamps at the read: the bubble shortens, and
    // the wire cap can never reject the user's first send over it.
    expect(
      resolveAgentConfig(
        JSON.stringify({ suggestedFirstMessage: 'y'.repeat(AGENT_FIRST_MESSAGE_MAX_LENGTH + 1) }),
      ).suggestedFirstMessage,
    ).toBe('y'.repeat(AGENT_FIRST_MESSAGE_MAX_LENGTH))
    // Absent, blank, and wrong-typed all mean "no suggestion" — never a throw,
    // and never at the expense of the rest of the config.
    expect(resolveAgentConfig(JSON.stringify({})).suggestedFirstMessage).toBeUndefined()
    expect(
      resolveAgentConfig(JSON.stringify({ suggestedFirstMessage: '   ' })).suggestedFirstMessage,
    ).toBeUndefined()
    const malformed = resolveAgentConfig(
      JSON.stringify({ suggestedFirstMessage: 42, onboarding: { kind: 'chat' } }),
    )
    expect(malformed.suggestedFirstMessage).toBeUndefined()
    expect(malformed.readable).toBe(true)
    expect(malformed.onboarding).toEqual({ kind: 'chat' })
  })

  test('tags normalize to the vocabulary rather than to what was typed', () => {
    // Vocabulary order, not authored order: two agents carrying the same tags
    // must render the same chip sequence.
    expect(resolveAgentConfig(JSON.stringify({ tags: ['personal', 'sales'] })).tags).toEqual([
      'sales',
      'personal',
    ])
    // Duplicates collapse; the cap keeps a card's chip row readable.
    expect(resolveAgentConfig(JSON.stringify({ tags: ['sales', 'sales'] })).tags).toEqual(['sales'])
    expect(resolveAgentConfig(JSON.stringify({ tags: [...AGENT_TAGS].reverse() })).tags).toEqual(
      AGENT_TAGS.slice(0, MAX_AGENT_TAGS),
    )
    // Absent, all-unknown, and wrong-typed all mean "no tags" — never a throw.
    expect(resolveAgentConfig(JSON.stringify({})).tags).toEqual([])
    expect(resolveAgentConfig(JSON.stringify({ tags: ['nope'] })).tags).toEqual([])
    expect(resolveAgentConfig(JSON.stringify({ tags: 'sales' })).tags).toEqual([])
    expect(resolveAgentConfig(undefined).tags).toEqual([])
  })

  test('validates CRUD fields hard while stripping fields the reader does not know', () => {
    expect(
      RegisterAgentRequestSchema.parse({
        path: ' agents/research ',
        slug: 'research',
        name: ' Research ',
        icon: ' assets/icon.png ',
      }),
    ).toEqual({
      path: 'agents/research',
      slug: 'research',
      name: 'Research',
      icon: 'assets/icon.png',
    })
    expect(
      RegisterAgentRequestSchema.safeParse({ path: 'agents/research', slug: 'Research' }).success,
    ).toBe(false)
    expect(
      RegisterAgentRequestSchema.parse({
        path: 'agents/research',
        slug: 'research',
        extra: true,
      }),
    ).toEqual({ path: 'agents/research', slug: 'research' })
    // The apps that are part of the agent ride the same register request. The
    // entry grammar is the shared app-declaration schema, so a path the drive
    // grammar rejects fails here rather than deep inside the mutation.
    expect(
      RegisterAgentRequestSchema.parse({
        path: 'agents/research',
        slug: 'research',
        apps: [
          {
            path: 'agents/research/apps/board/',
            slug: 'board',
            command: 'bun run server.ts',
            apiScopes: [],
          },
        ],
      }).apps,
    ).toEqual([
      {
        path: 'agents/research/apps/board',
        slug: 'board',
        command: 'bun run server.ts',
        apiScopes: [],
      },
    ])
    expect(
      RegisterAgentRequestSchema.safeParse({
        path: 'agents/research',
        slug: 'research',
        apps: [{ path: '../outside', slug: 'board', command: 'run', apiScopes: [] }],
      }).success,
    ).toBe(false)
    expect(UpdateAgentRequestSchema.safeParse({}).success).toBe(false)
    expect(UpdateAgentRequestSchema.safeParse({ slug: 'renamed' }).success).toBe(false)
    expect(SetAgentDisabledRequestSchema.parse({ disabled: true })).toEqual({ disabled: true })
    expect(SetAgentDisabledRequestSchema.parse({ disabled: false, extra: true })).toEqual({
      disabled: false,
    })
    expect(SetAgentOnboardedRequestSchema.parse({ onboarded: true })).toEqual({ onboarded: true })
    expect(SetAgentOnboardedRequestSchema.safeParse({ onboarded: 'yes' }).success).toBe(false)
    expect(AgentResponseSchema.parse({ agent })).toEqual({ agent })
    expect(AgentListResponseSchema.parse({ items: [agent], nextCursor: null })).toEqual({
      items: [agent],
      nextCursor: null,
    })
    expect(AgentListQuerySchema.parse({ id: 'agent-1' })).toEqual({
      id: 'agent-1',
      limit: COLLECTION_PAGE_DEFAULT_LIMIT,
    })
    expect(AgentListQuerySchema.parse({ slug: 'research' })).toEqual({
      slug: 'research',
      limit: COLLECTION_PAGE_DEFAULT_LIMIT,
    })
    expect(AgentListQuerySchema.safeParse({ id: 'agent-1', slug: 'research' }).success).toBe(false)
    expect(DeleteAgentResponseSchema.parse({ ok: true })).toEqual({ ok: true })
  })

  // The backend refuses reserved-range ports for every registration
  // (`assertExplicitAppPort`), so the request schema must refuse them too —
  // otherwise a declared reserved port passes HTTP validation and surfaces as
  // an unmapped 500 instead of a 400.
  test('declared agent apps refuse ports in the reserved auto-allocation range', () => {
    const request = (port?: number) => ({
      path: 'agents/research',
      slug: 'research',
      apps: [
        {
          path: 'agents/research/apps/board',
          slug: 'board',
          command: 'bun run server.ts',
          apiScopes: [],
          ...(port === undefined ? {} : { port }),
        },
      ],
    })
    expect(RegisterAgentRequestSchema.safeParse(request(APP_AUTO_PORT_RANGE_START)).success).toBe(
      false,
    )
    expect(RegisterAgentRequestSchema.safeParse(request(APP_AUTO_PORT_RANGE_END)).success).toBe(
      false,
    )
    expect(RegisterAgentRequestSchema.parse(request(8_080)).apps?.[0]?.port).toBe(8_080)
    expect(RegisterAgentRequestSchema.parse(request()).apps?.[0]?.port).toBeUndefined()
  })

  test('carries per-workspace onboarding completion on the agent row', () => {
    expect(AgentSchema.parse({ ...agent, onboardedAt: 1_753_000_000_000 }).onboardedAt).toBe(
      1_753_000_000_000,
    )
    expect(AgentSchema.parse(agent).onboardedAt).toBeUndefined()
    expect(AgentSchema.safeParse({ ...agent, onboardedAt: 'today' }).success).toBe(false)
    // A row projected by a newer backend must not fail an older reader.
    expect(AgentSchema.safeParse({ ...agent, futureField: true }).success).toBe(true)
  })

  test('rejects unsafe icon paths', () => {
    for (const icon of ['/icon.png', 'C:/icon.png', '../icon.png', 'icons/../icon.png']) {
      expect(
        RegisterAgentRequestSchema.safeParse({ path: 'agents/research', slug: 'research', icon })
          .success,
      ).toBe(false)
    }
  })
})

describe('agent resolution contract', () => {
  test('groups a nested app with its nearest agent candidate', () => {
    const candidates = [
      {
        agentId: 'agent_research',
        anchorId: 'anchor_research',
        rootPath: 'agents/research',
      },
    ]
    const nestedApp = { id: 'app_1', anchorPath: 'agents/research/tools/briefs' }

    expect(groupAppsByAgent(candidates, [nestedApp])).toEqual({
      root: [],
      byAgentId: new Map([['agent_research', [nestedApp]]]),
    })
  })

  test('groups an app with the nearest candidate when agent roots nest', () => {
    const candidates = [
      { agentId: 'agent_outer', anchorId: 'anchor_outer', rootPath: 'agents' },
      {
        agentId: 'agent_research',
        anchorId: 'anchor_research',
        rootPath: 'agents/research',
      },
    ]
    const nestedApp = { id: 'app_deep', anchorPath: 'agents/research/tools/briefs' }

    expect(groupAppsByAgent(candidates, [nestedApp])).toEqual({
      root: [],
      byAgentId: new Map([
        ['agent_outer', []],
        ['agent_research', [nestedApp]],
      ]),
    })
  })

  test('groups sibling-prefix and unowned app paths at root', () => {
    const candidates = [
      {
        agentId: 'agent_research',
        anchorId: 'anchor_research',
        rootPath: 'agents/research',
      },
    ]
    const siblingApp = { id: 'app_sibling', anchorPath: 'agents/research-notes' }
    const rootApp = { id: 'app_root', anchorPath: 'apps/reporting' }

    expect(groupAppsByAgent(candidates, [siblingApp, rootApp])).toEqual({
      root: [siblingApp, rootApp],
      byAgentId: new Map([['agent_research', []]]),
    })
  })

  test('chooses the deepest exact-or-ancestor agent without matching sibling prefixes', () => {
    const candidates = [
      { agentId: 'review', anchorId: 'anchor-review', rootPath: 'agents/rev' },
      { agentId: 'research', anchorId: 'anchor-research', rootPath: 'agents/research' },
      { agentId: 'notes', anchorId: 'anchor-notes', rootPath: 'agents/research/notes' },
    ]

    expect(resolveNearestAgent('agents/research/notes/today', candidates)?.agentId).toBe('notes')
    expect(resolveNearestAgent('agents/research', candidates)?.agentId).toBe('research')
    expect(resolveNearestAgent('agents/reviewer', candidates)).toBeNull()
    expect(resolveNearestAgent('', candidates)).toBeNull()
  })

  test('normalizes separators without decoding filename bytes and ignores unsafe candidates', () => {
    const candidates = [
      { agentId: 'unsafe', anchorId: 'anchor-unsafe', rootPath: '../agents/research/deeper' },
      {
        agentId: 'research',
        anchorId: 'anchor-research',
        rootPath: 'agents//research/',
        displayName: 'Research',
      },
    ]

    expect(resolveNearestAgent('agents\\research\\notes', candidates)).toBe(candidates[1]!)
    expect(resolveNearestAgent('agents/%72esearch/notes', candidates)).toBeNull()
    expect(resolveNearestAgent('../agents/research', candidates)).toBeNull()
  })
})

describe('agent launch eligibility', () => {
  test('is launchable only when enabled with an active anchor', () => {
    expect(agentIsLaunchable(agent)).toBe(true)
    expect(agentIsLaunchable({ ...agent, disabledAt: 1_000 })).toBe(false)
    expect(agentIsLaunchable({ ...agent, anchorState: 'broken' })).toBe(false)
    // 'orphaned' is a third anchor state; an allow-list on 'active' rejects it
    // where a deny-list on 'broken' would have leaked it through.
    expect(agentIsLaunchable({ ...agent, anchorState: 'orphaned' })).toBe(false)
  })
})

describe('agent resolution candidate adapter', () => {
  test('renames id and anchorPath into the resolveNearestAgent shape', () => {
    expect(agentResolutionCandidate(agent)).toEqual({
      agentId: 'agent-1',
      anchorId: 'anchor-1',
      rootPath: 'agents/research',
    })
  })

  test('feeds resolveNearestAgent so an agent row resolves by its anchor path', () => {
    const resolved = resolveNearestAgent('agents/research/notes', [agentResolutionCandidate(agent)])
    expect(resolved?.agentId).toBe('agent-1')
  })
})

describe('gateway agent config', () => {
  const agentRow = {
    kind: 'agent',
    agentId: 'agent-1',
    anchorId: 'anchor-1',
    anchorPath: 'agents/research',
    slug: 'research',
    name: 'Research',
  } as const

  test('parses an agent row, with onboardedAt optional', () => {
    expect(GatewayAgentConfigSchema.parse(agentRow)).toEqual(agentRow)
    expect(GatewayAgentConfigSchema.parse({ ...agentRow, onboardedAt: 1_700_000_000_000 })).toEqual(
      { ...agentRow, onboardedAt: 1_700_000_000_000 },
    )
  })

  test('parses the root member, which has no anchor and no database id', () => {
    expect(GatewayAgentConfigSchema.parse({ kind: 'root', slug: 'root', name: 'Duet' })).toEqual({
      kind: 'root',
      slug: 'root',
      name: 'Duet',
    })
  })

  // The reserved-slug grammar is what keeps the union honest: a registered
  // agent can never claim `root`, so `kind` and `slug` cannot contradict.
  test('rejects an agent row that claims the root slug', () => {
    expect(GatewayAgentConfigSchema.safeParse({ ...agentRow, slug: 'root' }).success).toBe(false)
  })

  // Same skew rule as GatewayAppConfigSchema: tolerate (drop) unknown fields
  // from a newer producer, never reject them — and never echo them onward.
  test('strips unknown fields instead of rejecting a newer producer', () => {
    expect(GatewayAgentConfigSchema.parse({ ...agentRow, futureField: 'x' })).toEqual(agentRow)
  })

  test('adapts an agent row into the resolveNearestAgent shape', () => {
    const adapted = gatewayAgentCandidate({ ...agentRow, kind: 'agent' })
    expect(adapted.rootPath).toBe('agents/research')
    expect(resolveNearestAgent('agents/research/notes', [adapted])?.agentId).toBe('agent-1')
  })
})

describe('agent hierarchy', () => {
  const tree = [
    { agentId: 'research', anchorId: 'a1', rootPath: 'agents/research' },
    { agentId: 'scout', anchorId: 'a2', rootPath: 'agents/research/scout' },
    { agentId: 'deep', anchorId: 'a3', rootPath: 'agents/research/scout/deep' },
    // A sibling whose path is a string prefix of another's but not a folder
    // ancestor: `agents/research-notes` must not nest under `agents/research`.
    { agentId: 'notes', anchorId: 'a4', rootPath: 'agents/research-notes' },
    // Intervening non-agent folders do not create a layer. This is root's
    // direct child even though it sits three folders deep — "one layer" is
    // measured in agents, not in folders (D1).
    { agentId: 'buried', anchorId: 'a5', rootPath: 'projects/a/b/buried' },
  ]

  // The one that matters most. `resolveNearestAgent` counts an exact path match
  // as a hit, which is correct for apps but fatal here: reused unchanged, every
  // agent becomes its own parent and every roster renders empty — silently,
  // with no error anywhere to notice.
  test('never makes an agent its own parent or its own child', () => {
    const hierarchy = groupAgentsByParent(tree)
    for (const candidate of tree) {
      expect(hierarchy.parentByAgentId.get(candidate.agentId)?.agentId).not.toBe(candidate.agentId)
      expect(
        (hierarchy.childrenByAgentId.get(candidate.agentId) ?? []).map(child => child.agentId),
      ).not.toContain(candidate.agentId)
    }
  })

  test('places each agent under its nearest enclosing agent, deepest wins', () => {
    const hierarchy = groupAgentsByParent(tree)
    expect(hierarchy.parentByAgentId.get('scout')?.agentId).toBe('research')
    // `deep` sits inside research too, but scout is nearer.
    expect(hierarchy.parentByAgentId.get('deep')?.agentId).toBe('scout')
    expect(hierarchy.parentByAgentId.has('research')).toBe(false)
    expect(hierarchy.parentByAgentId.has('notes')).toBe(false)
    expect(hierarchy.parentByAgentId.has('buried')).toBe(false)
  })

  test('gives root the agents no agent encloses, however deep their folder', () => {
    expect(
      groupAgentsByParent(tree)
        .rootChildren.map(row => row.agentId)
        .sort(),
    ).toEqual(['buried', 'notes', 'research'])
  })

  test('lists only direct children, never grandchildren', () => {
    const hierarchy = groupAgentsByParent(tree)
    expect(hierarchy.childrenByAgentId.get('research')?.map(row => row.agentId)).toEqual(['scout'])
    expect(hierarchy.childrenByAgentId.get('scout')?.map(row => row.agentId)).toEqual(['deep'])
    expect(hierarchy.childrenByAgentId.get('deep')).toEqual([])
  })

  test('is stable under input order', () => {
    const forward = groupAgentsByParent(tree)
    const reversed = groupAgentsByParent([...tree].reverse())
    expect(reversed.rootChildren.map(row => row.agentId)).toEqual(
      forward.rootChildren.map(row => row.agentId),
    )
    expect(reversed.childrenByAgentId.get('research')?.map(row => row.agentId)).toEqual(
      forward.childrenByAgentId.get('research')?.map(row => row.agentId),
    )
  })

  test('skips a malformed anchor path instead of throwing', () => {
    const hierarchy = groupAgentsByParent([
      ...tree,
      { agentId: 'broken', anchorId: 'a6', rootPath: '../escape' },
    ])
    expect(hierarchy.parentByAgentId.has('broken')).toBe(false)
    expect(hierarchy.rootChildren.map(row => row.agentId)).not.toContain('broken')
  })
})

describe('agent roster wire', () => {
  const sibling = {
    slug: 'scout',
    name: 'Scout',
    path: 'agents/research/scout',
    locked: false,
    relationship: 'sibling',
  } as const

  test('uses the universal strict query and page envelope', () => {
    expect(AgentRosterPageQuerySchema.parse({})).toEqual({ limit: COLLECTION_PAGE_DEFAULT_LIMIT })
    expect(
      AgentRosterPageQuerySchema.parse({
        cursor: 'opaque',
        limit: String(COLLECTION_PAGE_MAX_LIMIT),
      }),
    ).toEqual({
      cursor: 'opaque',
      limit: COLLECTION_PAGE_MAX_LIMIT,
    })
    expect(
      AgentRosterPageQuerySchema.safeParse({ limit: COLLECTION_PAGE_MAX_LIMIT + 1 }).success,
    ).toBe(false)
    expect(AgentRosterPageQuerySchema.safeParse({ extra: 'nope' }).success).toBe(false)

    expect(
      AgentRosterPageSchema.parse({
        items: [sibling],
        nextCursor: null,
        additive: true,
      }),
    ).toEqual({ items: [sibling], nextCursor: null })
    expect(AgentRosterPageSchema.safeParse({ rows: [sibling] }).success).toBe(false)
    expect(
      AgentRosterPageSchema.safeParse({
        items: Array(COLLECTION_PAGE_MAX_LIMIT + 1).fill(sibling),
        nextCursor: null,
      }).success,
    ).toBe(false)
  })

  test('carries the ordered rows with their relationships, dropping a newer producer’s extras', () => {
    expect(
      AgentRosterPageSchema.parse({
        items: [
          {
            slug: 'writer',
            name: 'Writer',
            path: 'agents/writer',
            locked: false,
            relationship: 'self',
          },
          { slug: 'root', name: 'Duet', locked: false, relationship: 'parent', hiddenChildren: 4 },
          { ...sibling, agentId: 'agent-1' },
        ],
        nextCursor: null,
      }),
    ).toEqual({
      items: [
        {
          slug: 'writer',
          name: 'Writer',
          path: 'agents/writer',
          locked: false,
          relationship: 'self',
        },
        { slug: 'root', name: 'Duet', locked: false, relationship: 'parent' },
        sibling,
      ],
      nextCursor: null,
    })
  })

  // The asymmetry is the contract: only root has no folder, and root is only
  // ever the agent you are or the agent above you.
  test('a folder is required of every row except the one that may be the drive root', () => {
    const parse = (row: Record<string, unknown>) =>
      AgentRosterPageSchema.safeParse({ items: [row], nextCursor: null }).success

    expect(parse({ slug: 'root', name: 'Duet', locked: false, relationship: 'self' })).toBe(true)
    expect(parse({ slug: 'root', name: 'Duet', locked: false, relationship: 'parent' })).toBe(true)
    expect(parse({ slug: 'scout', name: 'Scout', locked: false, relationship: 'sibling' })).toBe(
      false,
    )
    expect(parse({ slug: 'scout', name: 'Scout', locked: false, relationship: 'child' })).toBe(
      false,
    )
  })
})
