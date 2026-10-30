import { describe, expect, test } from 'bun:test'

import { nextChainState } from './onboarding-chain'

describe('onboarding campaign chain', () => {
  test('is done when the campaign declares no agents', () => {
    expect(
      nextChainState({
        steps: [],
        completedSlugs: [],
        subscriptions: [],
        agents: [],
        configs: new Map(),
      }),
    ).toEqual({ phase: 'done' })
  })

  test('projects the only agent ready when its subscription and chat config are ready', () => {
    const step = { slug: 'research' }
    expect(
      nextChainState({
        steps: [step],
        completedSlugs: [],
        subscriptions: [
          {
            id: 'subscription_research',
            agentId: 'agent_research',
            agentName: 'research',
            state: 'active',
          },
        ],
        agents: [
          {
            id: 'agent_research',
            slug: 'research',
          },
        ],
        configs: new Map([['agent_research', { onboarding: { kind: 'chat' } }]]),
      }),
    ).toEqual({ phase: 'ready', step, last: true })
  })

  test('projects the next incomplete agent and done when all agents are onboarded', () => {
    const steps = [{ slug: 'research' }, { slug: 'writer' }]
    const subscriptions = steps.map(({ slug }) => ({
      id: `subscription_${slug}`,
      agentId: `agent_${slug}`,
      agentName: slug,
      state: 'active' as const,
    }))
    const agents = steps.map(({ slug }) => ({
      id: `agent_${slug}`,
      slug,
      anchorPath: `agents/${slug}`,
    }))
    const configs = new Map(
      agents.map(agent => [agent.id, { onboarding: { kind: 'chat' as const } }]),
    )

    const first = nextChainState({
      steps,
      completedSlugs: [],
      subscriptions,
      agents,
      configs,
    })
    expect(first).toEqual({ phase: 'ready', step: steps[0]!, last: false })

    const second = nextChainState({
      steps,
      completedSlugs: [],
      subscriptions,
      agents: [{ ...agents[0]!, onboardedAt: 1 }, agents[1]!],
      configs,
    })
    expect(second).toEqual({ phase: 'ready', step: steps[1]!, last: true })

    expect(
      nextChainState({
        steps,
        completedSlugs: [],
        subscriptions,
        agents: agents.map(agent => ({ ...agent, onboardedAt: 1 })),
        configs,
      }),
    ).toEqual({ phase: 'done' })
  })

  test('skips an errored install instead of blocking the next agent', () => {
    const steps = [{ slug: 'research' }, { slug: 'writer' }]
    expect(
      nextChainState({
        steps,
        completedSlugs: [],
        subscriptions: [
          {
            id: 'subscription_research',
            agentName: 'research',
            state: 'error',
          },
          {
            id: 'subscription_writer',
            agentId: 'agent_writer',
            agentName: 'writer',
            state: 'active',
          },
        ],
        agents: [{ id: 'agent_writer', slug: 'writer' }],
        configs: new Map([['agent_writer', { onboarding: { kind: 'chat' } }]]),
      }),
    ).toEqual({ phase: 'skipped', step: steps[0]! })

    expect(
      nextChainState({
        steps,
        completedSlugs: ['research'],
        subscriptions: [
          { id: 'subscription_research', agentName: 'research', state: 'error' },
          {
            id: 'subscription_writer',
            agentId: 'agent_writer',
            agentName: 'writer',
            state: 'active',
          },
        ],
        agents: [{ id: 'agent_writer', slug: 'writer' }],
        configs: new Map([['agent_writer', { onboarding: { kind: 'chat' } }]]),
      }),
    ).toEqual({ phase: 'ready', step: steps[1]!, last: true })
  })

  test('skips an installed agent that declares no onboarding', () => {
    const step = { slug: 'research' }
    expect(
      nextChainState({
        steps: [step],
        completedSlugs: [],
        subscriptions: [
          {
            id: 'subscription_research',
            agentId: 'agent_research',
            agentName: 'research',
            state: 'active',
          },
        ],
        agents: [{ id: 'agent_research', slug: 'research' }],
        configs: new Map([['agent_research', { onboarding: undefined }]]),
      }),
    ).toEqual({ phase: 'skipped', step })
  })

  test('keeps an app-kind step installing until its resolved app is reconciled', () => {
    const step = { slug: 'analyst' }
    const input = {
      steps: [step],
      completedSlugs: [],
      subscriptions: [
        {
          id: 'subscription_analyst',
          agentId: 'agent_analyst',
          agentName: 'analyst',
          state: 'active' as const,
        },
      ],
      agents: [{ id: 'agent_analyst', slug: 'analyst' }],
    }

    expect(
      nextChainState({
        ...input,
        configs: new Map([
          ['agent_analyst', { onboarding: { kind: 'app', runtimeStatus: 'reconciling' } }],
        ]),
      }),
    ).toEqual({ phase: 'installing', step })

    expect(
      nextChainState({
        ...input,
        configs: new Map([
          ['agent_analyst', { onboarding: { kind: 'app', runtimeStatus: 'reconcile_failed' } }],
        ]),
      }),
    ).toEqual({ phase: 'skipped', step })

    expect(
      nextChainState({
        ...input,
        configs: new Map([
          ['agent_analyst', { onboarding: { kind: 'app', runtimeStatus: 'reconciled' } }],
        ]),
      }),
    ).toEqual({ phase: 'ready', step, last: true })
  })

  test('projects the same mid-chain position from a cloned input snapshot', () => {
    const steps = [{ slug: 'research' }, { slug: 'writer' }]
    const input = {
      steps,
      completedSlugs: [],
      subscriptions: steps.map(({ slug }) => ({
        id: `subscription_${slug}`,
        agentId: `agent_${slug}`,
        agentName: slug,
        state: 'active' as const,
      })),
      agents: [
        { id: 'agent_research', slug: 'research', onboardedAt: 1 },
        { id: 'agent_writer', slug: 'writer' },
      ],
      configs: new Map([
        ['agent_research', { onboarding: { kind: 'chat' as const } }],
        ['agent_writer', { onboarding: { kind: 'chat' as const } }],
      ]),
    }

    expect(nextChainState(input)).toEqual({
      phase: 'ready',
      step: steps[1]!,
      last: true,
    })
    expect(nextChainState(structuredClone(input))).toEqual({
      phase: 'ready',
      step: steps[1]!,
      last: true,
    })
  })

  test('does not rewind the cursor when an earlier agent is reset with Redo', () => {
    const steps = [{ slug: 'research' }, { slug: 'writer' }]
    expect(
      nextChainState({
        steps,
        completedSlugs: ['research'],
        subscriptions: steps.map(({ slug }) => ({
          id: `subscription_${slug}`,
          agentId: `agent_${slug}`,
          agentName: slug,
          state: 'active' as const,
        })),
        agents: [
          { id: 'agent_research', slug: 'research' },
          { id: 'agent_writer', slug: 'writer' },
        ],
        configs: new Map([
          ['agent_research', { onboarding: { kind: 'chat' } }],
          ['agent_writer', { onboarding: { kind: 'chat' } }],
        ]),
      }),
    ).toEqual({ phase: 'ready', step: steps[1]!, last: true })
  })

  test('waits for the subscription even when the agent row and config already look ready', () => {
    const step = { slug: 'research' }
    expect(
      nextChainState({
        steps: [step],
        completedSlugs: [],
        subscriptions: [
          {
            id: 'subscription_research',
            agentId: 'agent_research',
            agentName: 'research',
            state: 'installing',
          },
        ],
        agents: [{ id: 'agent_research', slug: 'research' }],
        configs: new Map([['agent_research', { onboarding: { kind: 'chat' } }]]),
      }),
    ).toEqual({ phase: 'installing', step })
  })
})
