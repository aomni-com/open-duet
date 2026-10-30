import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { ConvexHttpClient } from 'convex/browser'

import {
  MAX_AGENTS_PER_WORKSPACE,
  MAX_ICON_PATH_UTF8_BYTES,
  MAX_SLUG_LENGTH,
  agentIsLaunchable,
  type Agent,
  type App,
} from '@repo/contract'
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

const BACKEND_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const INTERNAL_KEY = 'test-agents-internal-key'

let convex: ConvexDevFixture
let owner: { client: ConvexHttpClient; user: { _id: string; email: string } }
let sequence = 0

describe('agents backend domain', () => {
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
    owner = await signInWithMagicLink(convex, uniqueEmail('agents-owner'), 'Agents Owner')
  }, 240_000)

  afterAll(async () => {
    await convex?.stop()
  })

  test('register creates an agent row and an agent-kind anchor', async () => {
    const workspaceId = await createWorkspace('agents-register')
    const agent = (await mutate(owner.client, 'domains/agents/model:registerAgent', {
      workspaceId,
      path: 'agents/research',
      slug: 'research',
      name: 'Research',
      icon: 'assets/icon.png',
      now: 10_000,
    })) as Agent

    expect(agent).toMatchObject({
      workspaceId,
      anchorPath: 'agents/research',
      anchorState: 'active',
      slug: 'research',
      name: 'Research',
      icon: 'assets/icon.png',
      createdAt: 10_000,
      updatedAt: 10_000,
    })
    expect(
      await query(owner.client, 'domains/anchors/model:getById', { anchorId: agent.anchorId }),
    ).toMatchObject({ path: 'agents/research', kind: 'agent', state: 'active' })
  })

  test('agent register and update enforce the shared icon byte ceiling', async () => {
    const workspaceId = await createWorkspace('agents-icon-bound')
    const atLimit = `${'a'.repeat(MAX_ICON_PATH_UTF8_BYTES - 4)}🚀`
    const overLimit = `${'a'.repeat(MAX_ICON_PATH_UTF8_BYTES - 3)}🚀`
    const agent = (await mutate(owner.client, 'domains/agents/model:registerAgent', {
      workspaceId,
      path: 'agents/bounded-icon',
      slug: 'bounded-icon',
      icon: atLimit,
    })) as Agent

    expect(agent.icon).toBe(atLimit)
    await expect(
      mutate(owner.client, 'domains/agents/model:updateAgent', {
        workspaceId,
        slug: agent.slug,
        icon: overLimit,
      }),
    ).rejects.toThrow('Icon path exceeds 1024 UTF-8 bytes')
    await expect(
      mutate(owner.client, 'domains/agents/model:registerAgent', {
        workspaceId,
        path: 'agents/oversized-icon',
        slug: 'oversized-icon',
        icon: overLimit,
      }),
    ).rejects.toThrow('Icon path exceeds 1024 UTF-8 bytes')
  })

  test('register preserves literal percent identities in agent and anchor paths', async () => {
    const workspaceId = await createWorkspace('agents-percent')
    const literalPercent = (await mutate(owner.client, 'domains/agents/model:registerAgent', {
      workspaceId,
      path: 'agents/100%',
      slug: 'literal-percent',
    })) as Agent
    const percentLooking = (await mutate(owner.client, 'domains/agents/model:registerAgent', {
      workspaceId,
      path: 'agents/a%2Fb',
      slug: 'percent-looking',
    })) as Agent

    expect([literalPercent.anchorPath, percentLooking.anchorPath]).toEqual([
      'agents/100%',
      'agents/a%2Fb',
    ])
    expect(literalPercent.anchorId).not.toBe(percentLooking.anchorId)
    expect(
      await Promise.all(
        [literalPercent.anchorId, percentLooking.anchorId].map(anchorId =>
          query(owner.client, 'domains/anchors/model:getById', { anchorId }),
        ),
      ),
    ).toEqual([
      expect.objectContaining({ kind: 'agent', path: 'agents/100%' }),
      expect.objectContaining({ kind: 'agent', path: 'agents/a%2Fb' }),
    ])
  })

  test('enforces slug and path uniqueness while allowing an existing share root', async () => {
    const workspaceId = await createWorkspace('agents-identity')
    const first = (await mutate(owner.client, 'domains/agents/model:registerAgent', {
      workspaceId,
      path: 'teams/research',
      slug: 'research',
    })) as Agent
    await expect(
      mutate(owner.client, 'domains/agents/model:registerAgent', {
        workspaceId,
        path: 'teams/other',
        slug: 'research',
      }),
    ).rejects.toThrow('Agent slug already exists')
    await expect(
      mutate(owner.client, 'domains/agents/model:registerAgent', {
        workspaceId,
        path: 'teams/research',
        slug: 'other',
      }),
    ).rejects.toThrow('Agent path already exists')

    const shareRoot = (await mutate(owner.client, 'testing/anchors:createAnchorForTest', {
      workspaceId,
      path: 'shared/team',
      kind: 'share-root',
      settings: {},
    })) as { id: string }
    const shared = (await mutate(owner.client, 'domains/agents/model:registerAgent', {
      workspaceId,
      path: 'shared/team',
      slug: 'shared-team',
    })) as Agent
    expect(shared.anchorId).toBe(shareRoot.id)
    expect(first.anchorId).not.toBe(shared.anchorId)
  })

  test('updates metadata only and lists agents deterministically by slug', async () => {
    const workspaceId = await createWorkspace('agents-update')
    await mutate(owner.client, 'domains/agents/model:registerAgent', {
      workspaceId,
      path: 'agents/zeta',
      slug: 'zeta',
    })
    const alpha = (await mutate(owner.client, 'domains/agents/model:registerAgent', {
      workspaceId,
      path: 'agents/alpha',
      slug: 'alpha',
      name: 'Before',
      icon: 'before.png',
      now: 20_000,
    })) as Agent
    const updated = (await mutate(owner.client, 'domains/agents/model:updateAgent', {
      workspaceId,
      slug: 'alpha',
      name: 'After',
      icon: 'assets/after.png',
      now: 20_000,
    })) as Agent

    expect(updated).toMatchObject({
      id: alpha.id,
      anchorId: alpha.anchorId,
      anchorPath: 'agents/alpha',
      slug: 'alpha',
      name: 'After',
      icon: 'assets/after.png',
      updatedAt: 20_001,
    })
    const listed = (await query(owner.client, 'domains/agents/model:listByWorkspace', {
      workspaceId,
    })) as Agent[]
    expect(listed.map(agent => agent.slug)).toEqual(['alpha', 'zeta'])
  })

  // Registration is not an update, so re-registering an existing folder must not
  // be a way to lose metadata. Convex deletes a field patched to `undefined`, so
  // the naive patch silently erased whatever the user had renamed the agent to —
  // and the caller most likely to re-register is the `manage-agents` skill,
  // which sends only what it is changing. Assert the persisted values, never the
  // row count: a count assertion passes against this bug.
  test('re-registering an existing anchor preserves metadata it does not send', async () => {
    const workspaceId = await createWorkspace('agents-reregister')
    await mutate(owner.client, 'domains/agents/model:registerAgent', {
      workspaceId,
      path: 'agents/mary',
      slug: 'mary',
      name: 'Mary',
      icon: 'icon.png',
    })

    const silent = (await mutate(owner.client, 'domains/agents/model:registerAgent', {
      workspaceId,
      path: 'agents/mary',
      slug: 'mary',
    })) as Agent
    expect(silent).toMatchObject({ name: 'Mary', icon: 'icon.png' })

    const renamedOnly = (await mutate(owner.client, 'domains/agents/model:registerAgent', {
      workspaceId,
      path: 'agents/mary',
      slug: 'mary',
      name: 'Mary Renamed',
    })) as Agent
    expect(renamedOnly).toMatchObject({ name: 'Mary Renamed', icon: 'icon.png' })

    const reiconedOnly = (await mutate(owner.client, 'domains/agents/model:registerAgent', {
      workspaceId,
      path: 'agents/mary',
      slug: 'mary',
      icon: 'next.png',
    })) as Agent
    expect(reiconedOnly).toMatchObject({ name: 'Mary Renamed', icon: 'next.png' })
  })

  // The product contract: the apps that are part of the agent are installed
  // when register is called on the agent, wherever the register comes from.
  // One call materialises the whole agent — an agent whose apps do not run is
  // a bug, not a variant.
  test('register with apps materialises the agent and its app rows in one call', async () => {
    const workspaceId = await createWorkspace('agents-with-apps')
    const agent = (await mutate(owner.client, 'domains/agents/model:registerAgent', {
      workspaceId,
      path: 'agents/researcher',
      slug: 'researcher',
      name: 'Researcher',
      apps: [
        {
          path: 'agents/researcher/apps/board',
          slug: 'board',
          name: 'Board',
          command: 'bun run server.ts',
          installCommand: 'bun install',
          apiScopes: [],
        },
      ],
      now: 50_000,
    })) as Agent

    expect(agent).toMatchObject({ slug: 'researcher', anchorPath: 'agents/researcher' })
    const apps = (await query(owner.client, 'domains/apps/model:listByWorkspace', {
      workspaceId,
    })) as App[]
    expect(apps).toEqual([
      expect.objectContaining({
        anchorPath: 'agents/researcher/apps/board',
        slug: 'board',
        name: 'Board',
        command: 'bun run server.ts',
        installCommand: 'bun install',
        apiScopes: [],
        visibility: 'folder',
        runtimeStatus: 'reconciling',
        port: expect.any(Number),
      }),
    ])
  })

  // A 201 must say what it did: a staging API once accepted `apps` and
  // silently discarded them (zod strips unknown keys), and no caller could
  // tell from the response. The register result carries every DECLARED app —
  // its actual slug, its path, and whether this call created it, rewrote it,
  // or found it already matching — so the caller can compare against intent.
  test('register reports each declared app as created, updated, or unchanged', async () => {
    const workspaceId = await createWorkspace('agents-apps-report')
    const boardDeclaration = {
      path: 'agents/reporter/apps/board',
      slug: 'board',
      command: 'bun run server.ts',
      apiScopes: [],
    }
    const registration = {
      workspaceId,
      path: 'agents/reporter',
      slug: 'reporter',
      apps: [boardDeclaration],
    }

    const created = (await mutate(owner.client, 'domains/agents/model:registerAgent', {
      ...registration,
      now: 70_000,
    })) as { apps?: unknown }
    expect(created.apps).toEqual([
      { slug: 'board', path: 'agents/reporter/apps/board', status: 'created' },
    ])

    const unchanged = (await mutate(owner.client, 'domains/agents/model:registerAgent', {
      ...registration,
      now: 71_000,
    })) as { apps?: unknown }
    expect(unchanged.apps).toEqual([
      { slug: 'board', path: 'agents/reporter/apps/board', status: 'unchanged' },
    ])

    const updated = (await mutate(owner.client, 'domains/agents/model:registerAgent', {
      ...registration,
      apps: [{ ...boardDeclaration, command: 'bun run rewritten.ts' }],
      now: 72_000,
    })) as { apps?: unknown }
    expect(updated.apps).toEqual([
      { slug: 'board', path: 'agents/reporter/apps/board', status: 'updated' },
    ])
  })

  test('register refuses an app path outside the agent folder', async () => {
    const workspaceId = await createWorkspace('agents-app-escape')
    await expect(
      mutate(owner.client, 'domains/agents/model:registerAgent', {
        workspaceId,
        path: 'agents/contained',
        slug: 'contained',
        apps: [
          {
            path: 'elsewhere/apps/board',
            slug: 'escape-board',
            command: 'bun run server.ts',
            apiScopes: [],
          },
        ],
      }),
    ).rejects.toThrow('App path is outside the agent folder')
    // The refusal is atomic: no half-registered agent survives it.
    expect(
      await query(owner.client, 'domains/agents/model:listByWorkspace', { workspaceId }),
    ).toEqual([])
  })

  test('re-registering an agent with the same apps changes nothing', async () => {
    const workspaceId = await createWorkspace('agents-apps-idem')
    const declaration = {
      workspaceId,
      path: 'agents/steady',
      slug: 'steady',
      name: 'Steady',
      apps: [
        {
          path: 'agents/steady/apps/panel',
          slug: 'panel',
          command: 'bun run server.ts',
          installCommand: 'bun install',
          apiScopes: [],
        },
      ],
    }
    await mutate(owner.client, 'domains/agents/model:registerAgent', {
      ...declaration,
      now: 60_000,
    })
    const appsBefore = (await query(owner.client, 'domains/apps/model:listByWorkspace', {
      workspaceId,
    })) as App[]

    await mutate(owner.client, 'domains/agents/model:registerAgent', {
      ...declaration,
      now: 61_000,
    })

    // Value-level idempotence, not a row count: same single row, same slug,
    // same port, same updatedAt — the repeat register wrote nothing.
    const appsAfter = (await query(owner.client, 'domains/apps/model:listByWorkspace', {
      workspaceId,
    })) as App[]
    expect(appsAfter).toEqual(appsBefore)
    expect(
      appsAfter.map(app => ({ slug: app.slug, port: app.port, updatedAt: app.updatedAt })),
    ).toEqual([{ slug: 'panel', port: appsBefore[0]!.port, updatedAt: 60_000 }])
  })

  // The default agent has no row, so its name lives on the workspace. The two
  // writers of that field must not be confused: onboarding is a first-write-wins
  // default at birth, this is an unconditional rename. Reusing onboarding would
  // make renaming a silent no-op for anyone who had already onboarded.
  test('renaming the default agent overwrites, and survives onboarding either way', async () => {
    const workspaceId = await createWorkspace('duet-rename')

    const renamed = (await mutate(owner.client, 'domains/agents/model:updateDefaultAgent', {
      workspaceId,
      name: 'Milo',
      now: 30_000,
    })) as { name: string }
    expect(renamed).toEqual({ name: 'Milo' })

    // Onboarding afterwards must not clobber the explicit rename.
    await mutate(owner.client, 'domains/workspaces/birth:completeWorkspaceOnboarding', {
      internalKey: INTERNAL_KEY,
      actorId: owner.user._id,
      workspaceId,
      duetName: 'Onboarded',
    })
    expect(await duetNameOf(workspaceId)).toBe('Milo')

    // And a rename after onboarding still wins.
    await mutate(owner.client, 'domains/agents/model:updateDefaultAgent', {
      workspaceId,
      name: 'Mary',
      now: 31_000,
    })
    expect(await duetNameOf(workspaceId)).toBe('Mary')

    expect(await auditEventNames(workspaceId)).toContain('workspace.duet_name_changed')
  })

  test('the default-agent rename validates its name and creates no agent row', async () => {
    const workspaceId = await createWorkspace('duet-rename-invalid')
    await expect(
      mutate(owner.client, 'domains/agents/model:updateDefaultAgent', { workspaceId, name: '   ' }),
    ).rejects.toThrow()
    await expect(
      mutate(owner.client, 'domains/agents/model:updateDefaultAgent', {
        workspaceId,
        name: 'x'.repeat(33),
      }),
    ).rejects.toThrow()

    await mutate(owner.client, 'domains/agents/model:updateDefaultAgent', {
      workspaceId,
      name: 'Milo',
    })
    const listed = (await query(owner.client, 'domains/agents/model:listByWorkspace', {
      workspaceId,
    })) as Agent[]
    expect(listed).toEqual([])
  })

  test('disable and enable gate launchability while recording the responsible editor', async () => {
    const workspaceId = await createWorkspace('agents-disable')
    await mutate(owner.client, 'domains/agents/model:registerAgent', {
      workspaceId,
      path: 'agents/research',
      slug: 'research',
      now: 25_000,
    })

    const disabled = (await mutate(owner.client, 'domains/agents/model:setAgentDisabled', {
      workspaceId,
      slug: 'research',
      disabled: true,
      now: 26_000,
    })) as Agent

    expect(disabled).toMatchObject({ slug: 'research', disabledAt: 26_000, updatedAt: 26_000 })
    expect(agentIsLaunchable(disabled)).toBe(false)
    expect(
      (
        (await query(convex, 'testing/agents:rawAgentsForTest', {
          internalKey: INTERNAL_KEY,
        })) as Doc<'agents'>[]
      ).find(agent => agent._id === disabled.id),
    ).toMatchObject({ disabledAt: 26_000, disabledByUserId: owner.user._id })
    expect(
      (
        (await query(owner.client, 'domains/workspaces/queries:getAuditEvents', {
          workspaceId,
        })) as Array<{ event: string; actorId: string; provenance?: Record<string, unknown> }>
      ).find(event => event.event === 'agent.disabled'),
    ).toMatchObject({
      event: 'agent.disabled',
      actorId: owner.user._id,
      provenance: {
        agentId: disabled.id,
        anchorId: disabled.anchorId,
        path: 'agents/research',
        slug: 'research',
      },
    })

    const enabled = (await mutate(owner.client, 'domains/agents/model:setAgentDisabled', {
      workspaceId,
      slug: 'research',
      disabled: false,
      now: 27_000,
    })) as Agent

    expect(enabled).not.toHaveProperty('disabledAt')
    expect(agentIsLaunchable(enabled)).toBe(true)
    const enabledRow = (
      (await query(convex, 'testing/agents:rawAgentsForTest', {
        internalKey: INTERNAL_KEY,
      })) as Doc<'agents'>[]
    ).find(agent => agent._id === enabled.id)
    expect(enabledRow).toMatchObject({ updatedAt: 27_000 })
    expect(enabledRow).not.toHaveProperty('disabledAt')
    expect(enabledRow).not.toHaveProperty('disabledByUserId')
    expect(
      (
        (await query(owner.client, 'domains/workspaces/queries:getAuditEvents', {
          workspaceId,
        })) as Array<{ event: string; actorId: string; provenance?: Record<string, unknown> }>
      ).find(event => event.event === 'agent.enabled'),
    ).toMatchObject({
      event: 'agent.enabled',
      actorId: owner.user._id,
      provenance: {
        agentId: enabled.id,
        anchorId: enabled.anchorId,
        path: 'agents/research',
        slug: 'research',
      },
    })
  })

  test('marks onboarding complete and clears it again on the same idempotent toggle', async () => {
    const workspaceId = await createWorkspace('agents-onboarded')
    await mutate(owner.client, 'domains/agents/model:registerAgent', {
      workspaceId,
      path: 'agents/ads',
      slug: 'ads',
      now: 25_000,
    })

    const onboarded = (await mutate(owner.client, 'domains/agents/model:setAgentOnboarded', {
      workspaceId,
      slug: 'ads',
      onboarded: true,
      now: 26_000,
    })) as Agent
    expect(onboarded).toMatchObject({ slug: 'ads', onboardedAt: 26_000, updatedAt: 26_000 })

    // Setting it twice is the same state, not a moved timestamp: the onboarding
    // app may retry its completion call and must not look newly onboarded.
    const again = (await mutate(owner.client, 'domains/agents/model:setAgentOnboarded', {
      workspaceId,
      slug: 'ads',
      onboarded: true,
      now: 27_000,
    })) as Agent
    expect(again.onboardedAt).toBe(26_000)

    expect(
      (
        (await query(owner.client, 'domains/workspaces/queries:getAuditEvents', {
          workspaceId,
        })) as Array<{ event: string; actorId: string; provenance?: Record<string, unknown> }>
      ).find(event => event.event === 'agent.onboarded'),
    ).toMatchObject({
      event: 'agent.onboarded',
      actorId: owner.user._id,
      provenance: { agentId: onboarded.id, path: 'agents/ads', slug: 'ads' },
    })

    // "Redo onboarding" is the same endpoint, not a second one.
    const reset = (await mutate(owner.client, 'domains/agents/model:setAgentOnboarded', {
      workspaceId,
      slug: 'ads',
      onboarded: false,
      now: 28_000,
    })) as Agent
    expect(reset).not.toHaveProperty('onboardedAt')
    expect(reset.updatedAt).toBe(28_000)
    expect(
      (
        (await query(convex, 'testing/agents:rawAgentsForTest', {
          internalKey: INTERNAL_KEY,
        })) as Doc<'agents'>[]
      ).find(agent => agent._id === reset.id),
    ).not.toHaveProperty('onboardedAt')
  })

  test('redo onboarding retires the old interview, and the next open is a fresh one', async () => {
    /* The open-or-create lookup returns the newest ACTIVE onboarding session.
       Redo used to clear only `onboardedAt`, so the reopened card handed the
       user the very conversation whose outcome they were redoing — observed
       live as a broken interview coming back verbatim after the reset. */
    const workspaceId = await createWorkspace('agents-redo-fresh')
    const registered = (await mutate(owner.client, 'domains/agents/model:registerAgent', {
      workspaceId,
      path: 'agents/fresh',
      slug: 'fresh',
      now: 40_000,
    })) as { id: string }
    const first = (await convex.mutation('domains/agentSessions/creation:openOnboardingSession', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      agentId: registered.id,
      actorId: owner.user._id,
      identity: { principal: { kind: 'human', userId: owner.user._id }, actorId: owner.user._id },
      now: 40_500,
    })) as { sessionId: string }

    // Same conversation while nothing has been redone: open-or-create.
    expect(
      (
        (await convex.mutation('domains/agentSessions/creation:openOnboardingSession', {
          internalKey: INTERNAL_KEY,
          workspaceId,
          agentId: registered.id,
          actorId: owner.user._id,
          identity: {
            principal: { kind: 'human', userId: owner.user._id },
            actorId: owner.user._id,
          },
          now: 40_600,
        })) as { sessionId: string }
      ).sessionId,
    ).toBe(first.sessionId)

    await mutate(owner.client, 'domains/agents/model:setAgentOnboarded', {
      workspaceId,
      slug: 'fresh',
      onboarded: true,
      now: 41_000,
    })
    await mutate(owner.client, 'domains/agents/model:setAgentOnboarded', {
      workspaceId,
      slug: 'fresh',
      onboarded: false,
      now: 42_000,
    })

    const reopened = (await convex.mutation(
      'domains/agentSessions/creation:openOnboardingSession',
      {
        internalKey: INTERNAL_KEY,
        workspaceId,
        agentId: registered.id,
        actorId: owner.user._id,
        identity: { principal: { kind: 'human', userId: owner.user._id }, actorId: owner.user._id },
        now: 42_500,
      },
    )) as { sessionId: string }
    expect(reopened.sessionId).not.toBe(first.sessionId)
  })

  // The onboarding agent runs INSIDE the session and knows only $DUET_SESSION_ID
  // — not the workspace slug, not its own agent slug. The first shipped
  // completion prompt made it derive both with a whoami + list + jq pipeline,
  // and the live e2e showed a real runner finishing its interview, announcing
  // "Onboarding complete.", and never attempting the ceremony — leaving the
  // user locked out of an agent that believes it is configured. The session id
  // is something it already has, so completion becomes a single call.
  test('an onboarding session marks its own agent onboarded by session id alone', async () => {
    const workspaceId = await createWorkspace('agents-session-onboarded')
    const registered = (await mutate(owner.client, 'domains/agents/model:registerAgent', {
      workspaceId,
      path: 'agents/scout',
      slug: 'scout',
      now: 30_000,
    })) as { id: string; anchorId: string }
    const opened = (await convex.mutation('domains/agentSessions/creation:openOnboardingSession', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      agentId: registered.id,
      actorId: owner.user._id,
      identity: { principal: { kind: 'human', userId: owner.user._id }, actorId: owner.user._id },
      now: 30_500,
    })) as { sessionId: string }

    const onboarded = (await convex.mutation('domains/agents/model:setSessionAgentOnboarded', {
      internalKey: INTERNAL_KEY,
      actorId: owner.user._id,
      workspaceId,
      sessionId: opened.sessionId,
      onboarded: true,
      now: 31_000,
    })) as { id: string; slug: string; onboardedAt?: number }
    expect(onboarded).toMatchObject({ id: registered.id, slug: 'scout', onboardedAt: 31_000 })

    // The audit trail must say the agent unlocked itself from its onboarding
    // conversation — distinguishable from a human pressing the card's toggle.
    expect(
      (
        (await query(owner.client, 'domains/workspaces/queries:getAuditEvents', {
          workspaceId,
        })) as Array<{ event: string; provenance?: Record<string, unknown> }>
      ).find(event => event.event === 'agent.onboarded'),
    ).toMatchObject({
      event: 'agent.onboarded',
      provenance: {
        agentId: registered.id,
        path: 'agents/scout',
        slug: 'scout',
        sessionId: opened.sessionId,
      },
    })
  })

  test('a session that is not an onboarding conversation cannot unlock the agent', async () => {
    const workspaceId = await createWorkspace('sess-onb-plain')
    // Registered so the session below attributes to a real agent — the
    // rejection must come from the session not being an onboarding
    // conversation, not from there being no agent at all.
    await mutate(owner.client, 'domains/agents/model:registerAgent', {
      workspaceId,
      path: 'agents/plain',
      slug: 'plain',
      now: 32_000,
    })
    await mutate(owner.client, 'domains/agents/model:setAgentOnboarded', {
      workspaceId,
      slug: 'plain',
      onboarded: true,
      now: 32_100,
    })
    // A regular conversation in the agent's own folder: correctly attributed to
    // the agent, but not its onboarding interview.
    const delivered = (await convex.mutation(
      'domains/agentSessions/model:prepareRunnerInputDelivery',
      {
        internalKey: INTERNAL_KEY,
        actorId: owner.user._id,
        identity: {
          principal: { kind: 'human', userId: owner.user._id },
          actorId: owner.user._id,
        },
        workspaceId,
        attemptId: 'session-onboarded-plain',
        now: 32_500,
        input: {
          kind: 'initial_prompt',
          prompt: 'hello',
          behavior: 'steer',
          sender: { kind: 'user', userId: owner.user._id },
          clientRequestId: '10000000-0000-4000-8000-0000000000a1',
          cwd: 'agents/plain',
        },
      },
    )) as { sessionId: string }
    await mutate(owner.client, 'domains/agents/model:setAgentOnboarded', {
      workspaceId,
      slug: 'plain',
      onboarded: false,
      now: 32_750,
    })

    expect(
      convex.mutation('domains/agents/model:setSessionAgentOnboarded', {
        internalKey: INTERNAL_KEY,
        actorId: owner.user._id,
        workspaceId,
        sessionId: delivered.sessionId,
        onboarded: true,
        now: 33_000,
      }),
    ).rejects.toThrow(/not an onboarding session/i)
  })

  test('a session id from another workspace is not found, not cross-unlocked', async () => {
    const workspaceId = await createWorkspace('sess-onb-mine')
    const otherWorkspaceId = await createWorkspace('sess-onb-other')
    const registered = (await mutate(owner.client, 'domains/agents/model:registerAgent', {
      workspaceId,
      path: 'agents/here',
      slug: 'here',
      now: 34_000,
    })) as { id: string }
    const opened = (await convex.mutation('domains/agentSessions/creation:openOnboardingSession', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      agentId: registered.id,
      actorId: owner.user._id,
      identity: { principal: { kind: 'human', userId: owner.user._id }, actorId: owner.user._id },
      now: 34_500,
    })) as { sessionId: string }

    expect(
      convex.mutation('domains/agents/model:setSessionAgentOnboarded', {
        internalKey: INTERNAL_KEY,
        actorId: owner.user._id,
        workspaceId: otherWorkspaceId,
        sessionId: opened.sessionId,
        onboarded: true,
        now: 35_000,
      }),
    ).rejects.toThrow(/session not found/i)
  })

  test('requires editor access to disable or enable an agent', async () => {
    const workspaceId = await createWorkspace('agents-disable-role')
    const viewer = (await signInWithMagicLink(
      convex,
      uniqueEmail('agents-disable-viewer'),
      'Agents Viewer',
    )) as typeof owner
    await mutate(owner.client, 'testing/workspaces:addWorkspaceMemberForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      userId: viewer.user._id,
      role: 'viewer',
    })
    await mutate(owner.client, 'domains/agents/model:registerAgent', {
      workspaceId,
      path: 'agents/research',
      slug: 'research',
    })

    await expect(
      mutate(viewer.client, 'domains/agents/model:setAgentDisabled', {
        workspaceId,
        slug: 'research',
        disabled: true,
      }),
    ).rejects.toThrow('Requires editor access')
  })

  test('agent deletion rechecks the authenticated principal in its transaction', async () => {
    const workspaceId = await createWorkspace('agents-delete-recheck')
    const viewer = (await signInWithMagicLink(
      convex,
      uniqueEmail('agents-delete-recheck-viewer'),
      'Delete Recheck Viewer',
    )) as typeof owner
    await mutate(owner.client, 'testing/workspaces:addWorkspaceMemberForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      userId: viewer.user._id,
      role: 'viewer',
    })
    await mutate(owner.client, 'domains/agents/model:registerAgent', {
      workspaceId,
      path: 'agents/recheck',
      slug: 'recheck',
    })

    await expect(
      convex.mutation('domains/agents/model:deleteAgent', {
        internalKey: INTERNAL_KEY,
        workspaceId,
        slug: 'recheck',
        actorId: viewer.user._id,
        identity: {
          principal: { kind: 'human', userId: viewer.user._id },
          actorId: viewer.user._id,
        },
      }),
    ).rejects.toThrow(/forbidden/i)
    expect(
      await query(owner.client, 'domains/agents/model:getBySlug', {
        workspaceId,
        slug: 'recheck',
      }),
    ).toMatchObject({ slug: 'recheck' })

    await convex.mutation('domains/agents/model:deleteAgent', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      slug: 'recheck',
      actorId: owner.user._id,
      identity: { principal: { kind: 'workspace' }, actorId: owner.user._id },
    })
    expect(
      await query(owner.client, 'domains/agents/model:getBySlug', {
        workspaceId,
        slug: 'recheck',
      }),
    ).toBeNull()
  })

  test('delete preserves the anchor so re-registration restores the path identity', async () => {
    const workspaceId = await createWorkspace('agents-delete')
    const original = (await mutate(owner.client, 'domains/agents/model:registerAgent', {
      workspaceId,
      path: 'agents/restorable',
      slug: 'restorable',
    })) as Agent
    // deleteAgent returns { ok: true, affectedRecipientWorkspaceIds } internally
    // (the API route strips the fan-out metadata before returning to clients);
    // matchObject tolerates it, matching the updateAgent test's style.
    expect(
      await mutate(owner.client, 'domains/agents/model:deleteAgent', {
        workspaceId,
        slug: 'restorable',
      }),
    ).toMatchObject({ ok: true })
    const restored = (await mutate(owner.client, 'domains/agents/model:registerAgent', {
      workspaceId,
      path: 'agents/restorable',
      slug: 'restorable',
    })) as Agent
    expect(restored.id).not.toBe(original.id)
    expect(restored.anchorId).toBe(original.anchorId)
  })

  test('deleting the only consumer orphans its anchor', async () => {
    const workspaceId = await createWorkspace('agents-delete-orphan')
    const agent = (await mutate(owner.client, 'domains/agents/model:registerAgent', {
      workspaceId,
      path: 'agents/retired',
      slug: 'retired',
    })) as Agent

    await mutate(owner.client, 'domains/agents/model:deleteAgent', {
      workspaceId,
      slug: 'retired',
      now: 35_000,
    })

    expect(
      await query(owner.client, 'domains/anchors/model:getById', { anchorId: agent.anchorId }),
    ).toMatchObject({ id: agent.anchorId, state: 'orphaned', updatedAt: 35_000 })
  })

  // Firing an agent takes its folder with it, so everything the folder held has
  // to go in the same breath — its own apps, its sub-agents, and their apps, all
  // the way down. There is no parentAgentId to walk: agent nesting is purely a
  // path relation on the anchors, which is exactly why this used to leave every
  // descendant row alive and anchored inside a folder that no longer exists.
  test('delete removes the whole subtree: apps, sub-agents, and their apps', async () => {
    const workspaceId = await createWorkspace('agents-delete-tree')
    await mutate(owner.client, 'domains/agents/model:registerAgent', {
      workspaceId,
      path: 'agents/lead',
      slug: 'lead',
      apps: [
        {
          path: 'agents/lead/apps/board',
          slug: 'lead-board',
          command: 'bun run server.ts',
          apiScopes: [],
        },
      ],
    })
    await mutate(owner.client, 'domains/agents/model:registerAgent', {
      workspaceId,
      path: 'agents/lead/junior',
      slug: 'junior',
      apps: [
        {
          path: 'agents/lead/junior/apps/panel',
          slug: 'junior-panel',
          command: 'bun run server.ts',
          apiScopes: [],
        },
      ],
    })
    // A bystander outside the fired folder proves the cascade is scoped to the
    // subtree and not just deleting the workspace's apps.
    await mutate(owner.client, 'domains/agents/model:registerAgent', {
      workspaceId,
      path: 'agents/bystander',
      slug: 'bystander',
      apps: [
        {
          path: 'agents/bystander/apps/kept',
          slug: 'bystander-kept',
          command: 'bun run server.ts',
          apiScopes: [],
        },
      ],
    })

    await mutate(owner.client, 'domains/agents/model:deleteAgent', {
      workspaceId,
      slug: 'lead',
      now: 37_000,
    })

    const agents = (await query(owner.client, 'domains/agents/model:listByWorkspace', {
      workspaceId,
    })) as Agent[]
    expect(agents.map(agent => agent.slug)).toEqual(['bystander'])
    const apps = (await query(owner.client, 'domains/apps/model:listByWorkspace', {
      workspaceId,
    })) as App[]
    expect(apps.map(app => app.slug)).toEqual(['bystander-kept'])
  })

  test('an agent adopts an orphaned app anchor without changing its identity marker', async () => {
    const workspaceId = await createWorkspace('agents-adopt-app')
    const app = (await mutate(owner.client, 'domains/apps/model:registerApp', {
      workspaceId,
      path: 'workspaces/repurposed',
      command: 'bun run start',
      apiScopes: [],
      slug: 'repurposed-app',
    })) as App
    const before = (
      (await query(convex, 'testing/anchors:rawAnchorsForTest', {
        internalKey: INTERNAL_KEY,
      })) as Doc<'anchors'>[]
    ).find(anchor => anchor._id === app.anchorId)

    await mutate(owner.client, 'domains/apps/model:deleteApp', {
      workspaceId,
      slug: 'repurposed-app',
      now: 36_000,
    })
    const agent = (await mutate(owner.client, 'domains/agents/model:registerAgent', {
      workspaceId,
      path: 'workspaces/repurposed',
      slug: 'repurposed-agent',
      now: 37_000,
    })) as Agent
    const after = (
      (await query(convex, 'testing/anchors:rawAnchorsForTest', {
        internalKey: INTERNAL_KEY,
      })) as Doc<'anchors'>[]
    ).find(anchor => anchor._id === app.anchorId)

    expect(before).toBeDefined()
    expect(agent).toMatchObject({ anchorId: app.anchorId, anchorState: 'active' })
    expect(after).toMatchObject({
      _id: app.anchorId,
      kind: 'agent',
      settings: {},
      state: 'active',
      updatedAt: 37_000,
      markerNonce: before?.markerNonce,
    })
  })

  test('an agent cannot adopt an app anchor while the app is still live', async () => {
    const workspaceId = await createWorkspace('agents-live-conflict')
    await mutate(owner.client, 'domains/apps/model:registerApp', {
      workspaceId,
      path: 'workspaces/live-app',
      command: 'bun run start',
      apiScopes: [],
      slug: 'live-app',
    })

    await expect(
      mutate(owner.client, 'domains/agents/model:registerAgent', {
        workspaceId,
        path: 'workspaces/live-app',
        slug: 'conflicting-agent',
      }),
      // 'app' is not in the agent adopt-list (only share-root and publish are,
      // per the publish-viewer coexistence matrix), so a live app anchor is
      // refused. The message names the kinds an agent may adopt.
    ).rejects.toThrow('Anchor path is not an agent, share-root, or publish anchor')
  })

  test('registration cannot overwrite a replica row', async () => {
    const workspaceId = await createWorkspace('agents-replica')
    const origin = (await mutate(owner.client, 'domains/agents/model:registerAgent', {
      workspaceId,
      path: 'agents/origin',
      slug: 'origin',
    })) as Agent
    const share = (await mutate(owner.client, 'testing/shares:createShareForTest', {
      internalKey: INTERNAL_KEY,
      fromWorkspaceId: workspaceId,
      toEmail: owner.user.email,
      path: 'shared-replica',
      mode: 'read',
    })) as { share: { id: string; anchorId: string } }
    await mutate(convex, 'testing/agents:insertReplicaForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      anchorId: share.share.anchorId,
      sourceShareId: share.share.id,
      sourceAgentId: origin.id,
      createdByUserId: owner.user._id,
      slug: 'replica',
      now: 30_000,
    })

    await expect(
      mutate(owner.client, 'domains/agents/model:registerAgent', {
        workspaceId,
        path: 'shared-replica',
        slug: 'replica',
      }),
    ).rejects.toThrow('Replica agents are read-only')
  })

  test('registration rejects a new agent at the workspace cap', async () => {
    const workspaceId = await createWorkspace('agents-cap')
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
      now: 40_000,
    })

    await expect(
      mutate(owner.client, 'domains/agents/model:registerAgent', {
        workspaceId,
        path: 'agents/overflow',
        slug: 'overflow',
      }),
    ).rejects.toThrow('Workspace agent limit exceeded')
  })
})

// The default agent's name lives on the workspace row, so read it there rather
// than through a projection that might supply the `'Duet'` fallback and hide
// whether anything was actually written.
async function duetNameOf(workspaceId: string): Promise<string | undefined> {
  const workspace = (await query(owner.client, 'testing/workspaces:rawWorkspaceByIdForTest', {
    internalKey: INTERNAL_KEY,
    workspaceId,
  })) as { duetName?: string } | null
  return workspace?.duetName
}

async function auditEventNames(workspaceId: string): Promise<string[]> {
  const events = (await query(owner.client, 'domains/workspaces/queries:getAuditEvents', {
    workspaceId,
  })) as Array<{ event: string }>
  return events.map(event => event.event)
}

async function createWorkspace(prefix: string): Promise<string> {
  await mutate(owner.client, 'testing/workspaces:activateCurrentUserSyntheticSubscriptionForTest', {
    internalKey: INTERNAL_KEY,
  })
  // Bound the slug: the timestamp and counter are 15+ characters, so a
  // descriptive prefix plus a two-digit counter overflows MAX_SLUG_LENGTH and
  // fails with `too_long` in whichever test happens to sit past the tenth.
  // Truncating the prefix keeps the unique part intact.
  const unique = `-${Date.now()}-${++sequence}`
  const slug = `${prefix.slice(0, MAX_SLUG_LENGTH - unique.length)}${unique}`.replace(/-+$/g, '')
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
