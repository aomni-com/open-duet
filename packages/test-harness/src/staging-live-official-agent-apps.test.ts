import { describe, expect, test } from 'bun:test'

import { canonicalAppUrl, type RegisterAgentResponse } from '@repo/contract'
import { type OfficialSeedAgent } from '@repo/official-agents-seed'

import {
  buildOfficialAgentAppJourneyPlan,
  officialAppLaunchPath,
  officialAppScreenshotNames,
  officialAppStateTextIsSettled,
  officialAppsAreReconciled,
  officialAppOwningAgents,
  officialAgentAppsWorkspaceSlug,
  officialOnboardingAgentSlugs,
} from './staging-live-official-agent-apps.ts'

describe('official agent app staging plan', () => {
  test('selects app owners in input order and excludes agents without apps', () => {
    const first = fixtureAgent('first', ['board', 'setup'])
    const last = fixtureAgent('last', ['status'])
    expect(
      officialAppOwningAgents([
        { slug: 'plain', name: 'Plain', path: 'agents/plain' },
        first,
        { slug: 'empty', name: 'Empty', path: 'agents/empty', apps: [] },
        last,
      ]),
    ).toEqual([first, last])
  })

  test('derives a deterministic run-unique workspace slug within every manifest app DNS label', () => {
    const firstLongRunIdentity = `staging-e2e-official-agent-apps-${'a'.repeat(200)}`
    const secondLongRunIdentity = `staging-e2e-official-agent-apps-${'b'.repeat(200)}`
    const agents = [fixtureAgent('fixture', ['a'.repeat(30), 'board'])]
    const first = officialAgentAppsWorkspaceSlug(firstLongRunIdentity, agents)
    const repeated = officialAgentAppsWorkspaceSlug(firstLongRunIdentity, agents)
    const second = officialAgentAppsWorkspaceSlug(secondLongRunIdentity, agents)

    expect(repeated).toBe(first)
    expect(second).not.toBe(first)
    for (const app of officialAppOwningAgents(agents).flatMap(agent => agent.apps ?? [])) {
      const label = new URL(
        canonicalAppUrl(first, app.slug, 'edge-staging.duet.so'),
      ).hostname.split('.')[0]!
      expect(Buffer.byteLength(label, 'utf8')).toBeLessThanOrEqual(63)
    }
  })

  test('uses API-returned collision slugs and encodes every route segment', () => {
    const sourceAgent: OfficialSeedAgent = {
      slug: 'source-agent',
      name: 'Source Agent',
      path: 'agents/source-agent',
      apps: [
        {
          slug: 'source-app',
          name: 'Source App',
          path: 'agents/source-agent/apps/source-app',
          command: 'bun run server.ts',
          apiScopes: [],
        },
      ],
    }
    const registered = registerResponse(sourceAgent, 'agent-returned-2', 'app-returned-3')

    const plan = buildOfficialAgentAppJourneyPlan({
      workspaceSlug: 'workspace % alpha',
      loads: [{ sourceAgent, reset: 'fresh', fileCount: 2, registered }],
      seedFiles: [
        {
          path: `${sourceAgent.apps![0]!.path}/page.html`,
          bytes: new TextEncoder().encode('<main><h1>Returned app heading</h1></main>'),
        },
      ],
    })

    expect(plan).toEqual([
      expect.objectContaining({
        sourceAgentSlug: 'source-agent',
        sourceAppSlug: 'source-app',
        agentSlug: 'agent-returned-2',
        appSlug: 'app-returned-3',
        route: '/w/workspace%20%25%20alpha/agents/agent-returned-2/apps/app-returned-3',
        launchPath: '/api/duet/ws/workspace%20%25%20alpha/apps/app-returned-3/launch',
        heading: 'Returned app heading',
        readinessSelector: '.empty:not([hidden])',
      }),
    ])
    expect(officialAppLaunchPath('workspace % alpha', 'app-returned-3')).toBe(
      '/api/duet/ws/workspace%20%25%20alpha/apps/app-returned-3/launch',
    )
  })

  test('rejects a registration response that omits a manifest app', () => {
    const seo = fixtureAgent('fixture', ['board', 'setup'])
    const registered = registerResponse(seo, 'seo-returned', 'content-returned')

    expect(() =>
      buildOfficialAgentAppJourneyPlan({
        workspaceSlug: 'workspace',
        loads: [{ sourceAgent: seo, reset: 'fresh', fileCount: 1, registered }],
        seedFiles: [],
      }),
    ).toThrow('Registration response app paths differed for fixture')
  })

  test('rejects a registration response that invents an extra app', () => {
    const account = fixtureAgent('fixture', ['board'])
    const registered = registerResponse(account, 'account-returned', 'board-returned')
    registered.apps.push({
      slug: 'invented',
      path: `${account.path}/apps/invented`,
      status: 'created',
    })

    expect(() =>
      buildOfficialAgentAppJourneyPlan({
        workspaceSlug: 'workspace',
        loads: [{ sourceAgent: account, reset: 'fresh', fileCount: 1, registered }],
        seedFiles: [],
      }),
    ).toThrow('Registration response app paths differed for fixture')
  })

  test('does not accept an app until both its anchor and runtime have reconciled', () => {
    const plan = [
      {
        sourceAgentSlug: 'source-agent',
        sourceAppSlug: 'source-app',
        sourceAppPath: 'agents/source-agent/apps/source-app',
        agentSlug: 'returned-agent',
        appSlug: 'returned-app',
        route: '/w/workspace/agents/returned-agent/apps/returned-app',
        launchPath: '/api/duet/ws/workspace/apps/returned-app/launch',
        heading: 'Source app',
        readinessSelector: '.empty:not([hidden])',
      },
    ]

    expect(
      officialAppsAreReconciled(plan, [
        {
          id: 'app-id',
          slug: 'returned-app',
          anchorPath: 'agents/source-agent/apps/source-app',
          anchorState: 'active',
          runtimeStatus: 'reconciling',
        },
      ]),
    ).toBe(false)
    expect(
      officialAppsAreReconciled(plan, [
        {
          id: 'app-id',
          slug: 'returned-app',
          anchorPath: 'agents/source-agent/apps/source-app',
          anchorState: 'broken',
          runtimeStatus: 'reconciled',
        },
      ]),
    ).toBe(false)
    expect(
      officialAppsAreReconciled(plan, [
        {
          id: 'app-id',
          slug: 'returned-app',
          anchorPath: 'agents/source-agent/apps/source-app',
          anchorState: 'active',
          runtimeStatus: 'reconciled',
        },
      ]),
    ).toBe(true)
  })

  test('waits past initial loading copy before accepting app-owned state', () => {
    expect(officialAppStateTextIsSettled('Loading accounts…')).toBe(false)
    expect(officialAppStateTextIsSettled('Checking what is connected…')).toBe(false)
    expect(officialAppStateTextIsSettled('No researched accounts yet.')).toBe(true)
  })

  test('pairs returned app identities to authored headings and distinct screenshot paths', () => {
    const sourceAgent = fixtureAgent('fixture', ['board', 'setup'])
    const registered = registerResponse(sourceAgent, 'returned-agent', 'returned-board')
    registered.apps.push({
      slug: 'returned-setup',
      path: sourceAgent.apps![1]!.path,
      status: 'created',
    })
    const plan = buildOfficialAgentAppJourneyPlan({
      workspaceSlug: 'workspace',
      loads: [{ sourceAgent, reset: 'fresh', fileCount: 2, registered }],
      seedFiles: sourceAgent.apps!.map((app, index) => ({
        path: `${app.path}/page.html`,
        bytes: new TextEncoder().encode(
          index === 0
            ? '<h1> Board <em>heading</em> </h1><div class="empty"></div>'
            : '<h1>Setup heading</h1><div class="pill waiting"></div>',
        ),
      })),
    })
    expect(plan.map(item => [item.appSlug, item.heading, item.readinessSelector])).toEqual([
      ['returned-board', 'Board heading', '.empty:not([hidden])'],
      ['returned-setup', 'Setup heading', '.pill'],
    ])
    const screenshots = plan.flatMap(item =>
      Object.values(officialAppScreenshotNames(item)).flatMap(names => Object.values(names)),
    )
    expect(screenshots).toEqual([
      'fixture--board--desktop--product.png',
      'fixture--board--desktop--iframe.png',
      'fixture--board--mobile--product.png',
      'fixture--board--mobile--iframe.png',
      'fixture--setup--desktop--product.png',
      'fixture--setup--desktop--iframe.png',
      'fixture--setup--mobile--product.png',
      'fixture--setup--mobile--iframe.png',
    ])
  })

  test('selects both onboarding kinds by returned identity, leaving undeclared and missing configs alone', () => {
    const loads = ['chat', 'app', 'plain', 'missing'].map(slug => {
      const sourceAgent = fixtureAgent(slug, ['board'])
      return {
        sourceAgent,
        reset: 'fresh' as const,
        fileCount: 1,
        registered: registerResponse(sourceAgent, `${slug}-returned`, 'board-returned'),
      }
    })
    const seedFiles = [
      {
        path: 'agents/chat/agent.json',
        bytes: new TextEncoder().encode('{"onboarding":{"kind":"chat"}}'),
      },
      {
        path: 'agents/app/agent.json',
        bytes: new TextEncoder().encode('{"onboarding":{"kind":"app","app":"board"}}'),
      },
      { path: 'agents/plain/agent.json', bytes: new TextEncoder().encode('{}') },
    ]
    expect(officialOnboardingAgentSlugs(loads, seedFiles)).toEqual([
      'chat-returned',
      'app-returned',
    ])
  })
})

function registerResponse(
  agent: OfficialSeedAgent,
  returnedAgentSlug: string,
  returnedAppSlug: string,
): RegisterAgentResponse {
  return {
    agent: {
      id: 'agent-id',
      workspaceId: 'workspace-id',
      anchorId: 'anchor-id',
      anchorPath: agent.path,
      anchorState: 'active',
      slug: returnedAgentSlug,
      name: agent.name,
      createdAt: 1,
      updatedAt: 1,
    },
    apps: [{ slug: returnedAppSlug, path: agent.apps![0]!.path, status: 'created' }],
  }
}

function fixtureAgent(slug: string, apps: string[]): OfficialSeedAgent {
  return {
    slug,
    name: slug,
    path: `agents/${slug}`,
    apps: apps.map(app => ({
      slug: app,
      path: `agents/${slug}/apps/${app}`,
      command: 'bun run server.ts',
      apiScopes: [],
    })),
  }
}
