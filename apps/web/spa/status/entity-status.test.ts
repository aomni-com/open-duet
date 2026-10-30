import { describe, expect, test } from 'bun:test'

import type { Agent, App } from '@repo/contract'

import { agentDisplayStatus, appDisplayStatus, appStatusPresentation } from './entity-status'

type AppInput = Pick<App, 'runtimeStatus' | 'disabledAt' | 'anchorState'>
type AgentInput = Pick<Agent, 'anchorState' | 'disabledAt' | 'sourceShareId'>

describe('app display policy', () => {
  test('disabled state takes precedence over anchor and runtime failures', () => {
    const app: AppInput = {
      runtimeStatus: 'reconcile_failed',
      anchorState: 'broken',
      disabledAt: 1,
    }

    expect(appDisplayStatus(app)).toBe('disabled')
  })

  test('broken anchor takes precedence over a reconciled runtime', () => {
    const app: AppInput = {
      runtimeStatus: 'reconciled',
      anchorState: 'broken',
    }

    expect(appDisplayStatus(app)).toBe('broken')
  })

  test('maps runtime states when the app is active', () => {
    const statuses = [
      ['reconciled', 'reconciled'],
      ['reconciling', 'reconciling'],
      ['reconcile_failed', 'failed'],
    ] as const

    for (const [runtimeStatus, expected] of statuses) {
      expect(appDisplayStatus({ runtimeStatus, anchorState: 'active' })).toBe(expected)
    }
  })

  test('a replica app still projects reconciled — a share origin never repaints an app', () => {
    const replica: AppInput & Pick<App, 'sourceShareId'> = {
      runtimeStatus: 'reconciled',
      anchorState: 'active',
      sourceShareId: 'share-1',
    }

    expect(appDisplayStatus(replica)).toBe('reconciled')
  })

  test('shows pills only for starting, broken, and disabled apps', () => {
    expect(
      [
        { runtimeStatus: 'reconciled' as const, anchorState: 'active' as const },
        { runtimeStatus: 'reconciling' as const, anchorState: 'active' as const },
        { runtimeStatus: 'reconcile_failed' as const, anchorState: 'active' as const },
        { runtimeStatus: 'reconciled' as const, anchorState: 'broken' as const },
        {
          runtimeStatus: 'reconciled' as const,
          anchorState: 'active' as const,
          disabledAt: 1,
        },
      ].map(app => appStatusPresentation(app).pill),
    ).toEqual([undefined, 'starting', 'broken', 'broken', 'disabled'])
  })
})

describe('agent display policy', () => {
  test('a healthy, enabled, owned agent projects reconciled', () => {
    const agent: AgentInput = { anchorState: 'active' }

    expect(agentDisplayStatus(agent)).toBe('reconciled')
  })

  test('a replica agent projects shared', () => {
    const agent: AgentInput = { anchorState: 'active', sourceShareId: 'share-1' }

    expect(agentDisplayStatus(agent)).toBe('shared')
  })

  test('a disabled agent projects disabled', () => {
    const agent: AgentInput = { anchorState: 'active', disabledAt: 1 }

    expect(agentDisplayStatus(agent)).toBe('disabled')
  })

  test('a broken anchor projects broken', () => {
    const agent: AgentInput = { anchorState: 'broken' }

    expect(agentDisplayStatus(agent)).toBe('broken')
  })

  test('disabled takes precedence over a broken anchor', () => {
    const agent: AgentInput = { anchorState: 'broken', disabledAt: 1 }

    expect(agentDisplayStatus(agent)).toBe('disabled')
  })

  test('a broken anchor takes precedence over a share origin', () => {
    const agent: AgentInput = { anchorState: 'broken', sourceShareId: 'share-1' }

    expect(agentDisplayStatus(agent)).toBe('broken')
  })
})
