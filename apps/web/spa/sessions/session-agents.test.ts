import { expect, test } from 'bun:test'

import type { AgentRosterWireRow } from '@repo/contract'

import { agentRosterRows, type AgentRosterLabels } from './session-agents'

const labels: AgentRosterLabels = {
  self: 'You',
  parent: 'Parent',
  sibling: 'Sibling',
  child: 'Child',
  awaitingSetup: 'Awaiting setup',
}

const SELF = {
  slug: 'writer',
  name: 'Writer',
  path: 'agents/writer',
  locked: false,
  relationship: 'self',
} as const

const rowsFor = (...rows: AgentRosterWireRow[]) => agentRosterRows(rows, labels)

test('every row is badged with the relationship the gateway gave it', () => {
  const rows = rowsFor(
    SELF,
    { slug: 'root', name: 'Duet', locked: false, relationship: 'parent' },
    { slug: 'peer', name: 'Peer', path: 'agents/peer', locked: false, relationship: 'sibling' },
    { slug: 'scout', name: 'Scout', path: 'agents/scout', locked: false, relationship: 'child' },
  )

  expect(rows.map(row => [row.slug, row.scopeLabel])).toEqual([
    ['writer', 'You'],
    ['root', 'Parent'],
    ['peer', 'Sibling'],
    ['scout', 'Child'],
  ])
})

test('rows keep the order the gateway sent, not one of our own', () => {
  // The gateway orders; re-sorting here would make the picker disagree with the
  // roster the agent is reading in its prompt.
  const rows = rowsFor(
    SELF,
    { slug: 'zeta', name: 'Zeta', path: 'agents/zeta', locked: false, relationship: 'child' },
    { slug: 'alpha', name: 'Alpha', path: 'agents/alpha', locked: false, relationship: 'child' },
  )

  expect(rows.map(row => row.slug)).toEqual(['writer', 'zeta', 'alpha'])
})

test('a locked colleague is listed, flagged, and not selectable — whatever its relationship', () => {
  const rows = rowsFor(
    SELF,
    { slug: 'peer', name: 'Peer', path: 'agents/peer', locked: true, relationship: 'sibling' },
    { slug: 'scout', name: 'Scout', path: 'agents/scout', locked: true, relationship: 'child' },
  )

  expect(rows.slice(1).map(row => [row.disabled, row.disabledLabel])).toEqual([
    [true, 'Awaiting setup'],
    [true, 'Awaiting setup'],
  ])
})

test('an unlocked colleague carries no disabled flag at all', () => {
  const rows = rowsFor(SELF, {
    slug: 'scout',
    name: 'Scout',
    path: 'a',
    locked: false,
    relationship: 'child',
  })

  expect(rows[1]?.disabled).toBeUndefined()
})

test('colleagues sharing a name are still told apart on the row', () => {
  const rows = rowsFor(
    SELF,
    { slug: 'scout', name: 'Scout', path: 'agents/scout', locked: false, relationship: 'sibling' },
    {
      slug: 'scout-web',
      name: 'Scout',
      path: 'agents/scout-web',
      locked: false,
      relationship: 'child',
    },
  )

  expect(rows.slice(1).map(row => row.name)).toEqual(['Scout', 'Scout'])
  expect(rows.slice(1).map(row => row.description)).toEqual(['scout', 'scout-web'])
  // Row identity is the slug, so React cannot collapse the two.
  expect(rows.slice(1).map(row => row.id)).toEqual(['scout', 'scout-web'])
})

test('a root with nobody yet is an empty list, which is an answer', () => {
  // Never truly empty: the agent being talked to is always nameable.
  expect(rowsFor(SELF).map(row => row.slug)).toEqual(['writer'])
})
