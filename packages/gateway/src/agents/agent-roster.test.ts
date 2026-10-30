import { expect, test } from 'bun:test'

import type { GatewayAgentConfig } from '@repo/contract'

import { createAgentRoster } from './agent-roster'

const ROOT: GatewayAgentConfig = { kind: 'root', slug: 'root', name: 'Duet' }
const RESEARCH: GatewayAgentConfig = {
  kind: 'agent',
  agentId: 'agent-1',
  anchorId: 'anchor-1',
  anchorPath: 'agents/research',
  slug: 'research',
  name: 'Research',
}

/* "Nobody has told us yet" is not "there is nobody". A snapshot that starts
   empty makes a cold gateway indistinguishable from a quiesced workspace, so
   every reader downstream reports emptiness as fact before it has ever asked. */
test('a roster that has never arrived is undefined, not empty', () => {
  const roster = createAgentRoster()
  expect(roster.snapshot()).toBeUndefined()

  roster.accept(undefined)
  expect(roster.snapshot()).toBeUndefined()

  roster.accept([])
  expect(roster.snapshot()).toEqual([])
})

test('the newest accepted roster wins, and callers cannot mutate it', () => {
  const roster = createAgentRoster()

  roster.accept([ROOT])
  roster.accept([ROOT, RESEARCH])
  const seen = roster.snapshot()
  expect(seen).toEqual([ROOT, RESEARCH])

  // Snapshots are copies in both directions: mutating what you were given, or
  // what you handed in, must not reach the next reader.
  seen?.pop()
  expect(roster.snapshot()).toEqual([ROOT, RESEARCH])
})

/* The skew rule the wire schema promises: absent means an older API that has
   never heard of the roster — keep what you have. Empty means a producer that
   deliberately sent nothing (a quiesced workspace) — clear. Collapsing the two
   would blank every session's colleagues whenever an old API answers a poll. */
test('an absent roster preserves the previous snapshot; an empty one clears it', () => {
  const roster = createAgentRoster()
  roster.accept([ROOT, RESEARCH])
  roster.accept(undefined)
  expect(roster.snapshot()).toEqual([ROOT, RESEARCH])
  roster.accept([])
  expect(roster.snapshot()).toEqual([])
})
