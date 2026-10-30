import { describe, expect, test } from 'bun:test'

import type { Agent, App } from '@repo/contract'

import { workCollectionPhase } from './work-collection'
import {
  chatCreationPlacement,
  greetingForDate,
  greetingForHour,
  followRouteAgent,
  projectWorkApps,
  toggleExpandedAgent,
} from './work-projection'

describe('Team Space presentation projection', () => {
  test('uses greeting boundaries within the shared display time zone', () => {
    expect(greetingForHour(0)).toBe('morning')
    expect(greetingForHour(11)).toBe('morning')
    expect(greetingForHour(12)).toBe('afternoon')
    expect(greetingForHour(17)).toBe('afternoon')
    expect(greetingForHour(18)).toBe('evening')
  })

  test('uses the same UTC day owner as the formatted Home date', () => {
    expect(greetingForDate(new Date('2026-08-30T02:00:00.000Z'))).toBe('morning')
    expect(greetingForDate(new Date('2026-08-30T19:00:00.000Z'))).toBe('evening')
  })

  test('puts one chat creation action where the collection state calls for it', () => {
    expect(chatCreationPlacement(true, 'empty', 0)).toBe('empty-list')
    expect(chatCreationPlacement(true, 'ready', 1)).toBe('heading')
    expect(chatCreationPlacement(false, 'empty', 0)).toBe('hidden')
  })

  test('keeps root apps with Duet and resolves nested app ownership by anchor', () => {
    const agents = [
      {
        id: 'agent_research',
        slug: 'research',
        name: 'Research',
        anchorId: 'anchor_research',
        anchorPath: 'agents/research',
      },
    ] as Agent[]
    const apps = [
      {
        id: 'root_app',
        slug: 'briefs',
        anchorPath: 'apps/briefs',
        updatedAt: 1,
      },
      {
        id: 'agent_app',
        slug: 'signals',
        anchorPath: 'agents/research/apps/signals',
        updatedAt: 2,
      },
    ] as App[]

    expect(
      projectWorkApps(agents, apps).map(item => [item.app.id, item.ownerSlug, item.ownerName]),
    ).toEqual([
      ['agent_app', 'research', 'Research'],
      ['root_app', 'root', 'Duet'],
    ])
  })

  test('offers continuation recovery before claiming a classified collection is empty', () => {
    expect(
      workCollectionPhase({
        pending: false,
        initialError: false,
        continuationError: true,
        itemCount: 0,
        // A failed continuation outranks the drain: the read that would have
        // resolved "nothing yet" is the read that failed.
        draining: true,
      }),
    ).toBe('continuation-error')
  })
})

/* The sidebar's agent groups used to be an accordion: one slug in state, so
   opening any group closed the one before it. A reader comparing two owners'
   work — which is most of what this column is for — could not hold both open,
   and every navigation to an agent-owned conversation shut whatever they had
   arranged. The state is a set now, and these are the three transitions that
   act on it. */
describe('expanded agent groups', () => {
  test('opening a second group leaves the first one open', () => {
    const afterFirst = toggleExpandedAgent(new Set(), 'research')
    expect([...toggleExpandedAgent(afterFirst, 'reviewer')].sort()).toEqual([
      'research',
      'reviewer',
    ])
  })

  test('toggling a group that is open closes only that one', () => {
    const both: ReadonlySet<string> = new Set(['research', 'reviewer'])
    expect([...toggleExpandedAgent(both, 'research')]).toEqual(['reviewer'])
  })

  /* Following the address is an *addition*. It used to be an assignment, which
     is why arriving at one agent's conversation collapsed every other group the
     reader had opened. */
  test('following the route opens that agent without closing the others', () => {
    const open: ReadonlySet<string> = new Set(['research'])
    expect([...followRouteAgent(open, 'reviewer')].sort()).toEqual(['research', 'reviewer'])
  })

  test('following the route to an already-open agent changes nothing', () => {
    const open: ReadonlySet<string> = new Set(['research'])
    const next = followRouteAgent(open, 'research')
    expect([...next]).toEqual(['research'])
    // Same set, so a re-render is not scheduled for a no-op.
    expect(next).toBe(open)
  })
})
