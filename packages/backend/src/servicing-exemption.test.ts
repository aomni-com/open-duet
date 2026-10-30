import { expect, test } from 'bun:test'

import type { Doc } from '../convex/_generated/dataModel'
import { servicingStatusFor } from '../convex/domains/credits/subscriptions'

// A user with no subscription, no trial, and no balance: `desiredServicingStatus`
// returns 'paused' for them. Every case below varies only the WORKSPACE, so the
// payer is held fixed as the control.
const unpaidUser = { billing: {} } as unknown as Doc<'users'>

test('an exempt workspace stays active while its payer is not entitled', () => {
  const now = Date.UTC(2035, 6, 14)

  expect(servicingStatusFor({ servicingExemptAt: now }, unpaidUser, now)).toBe('active')
  // Same payer, no exemption — proves the verdict came from the workspace and
  // not from an accidentally-entitled fixture.
  expect(servicingStatusFor({}, unpaidUser, now)).toBe('paused')
})

test('a ban outranks an exemption', () => {
  const now = Date.UTC(2035, 6, 14)

  expect(
    servicingStatusFor({ servicingStatus: 'banned', servicingExemptAt: now }, unpaidUser, now),
  ).toBe('banned')
})

test('revoking an exemption returns the workspace to its payer-derived verdict', () => {
  const now = Date.UTC(2035, 6, 14)

  // The stored status is stale 'active' from while the exemption held; the
  // verdict must come from the payer again, not from what was last written.
  expect(servicingStatusFor({ servicingStatus: 'active' }, unpaidUser, now)).toBe('paused')
})
