import { expect, test } from 'bun:test'

import { SERVICING_ARCHIVE_AFTER_MS, TRIAL_WINDOW_MS } from '@repo/contract'

import type { Doc } from '../convex/_generated/dataModel'
import { servicingStatusFor } from '../convex/domains/credits/subscriptions'
import { servicingDecommissionDueAt } from '../convex/domains/workspaces/provisioningCore'

/* ============================================================================
   The two clocks a lapsing workspace runs, and the rule that they are
   SEQUENTIAL.

   The trial runs `TRIAL_WINDOW_MS`; when it ends the workspace stops serving
   and the wall appears. The workspace is destroyed `SERVICING_ARCHIVE_AFTER_MS`
   after THAT, so the wall is a warning with real time behind it rather than an
   epitaph. Neither number is written down here — the point is the ordering, and
   a test that restated the policy would go red every time the policy moved
   without a single behaviour having changed.

   Both halves read one field, `servicingStatusChangedAt`: the wall shows while
   `servicingStatus` is `paused`, and `servicingDecommissionCandidates` selects
   rows whose `servicingStatusChangedAt` is at least `SERVICING_ARCHIVE_AFTER_MS`
   old. So the rule holds only while that field means "when the user was
   PAUSED". The moment it can carry an older time, the two clocks run
   concurrently and the deadline arrives the day the trial ends.
   ========================================================================= */

const BIRTH = Date.UTC(2026, 7, 5, 8, 4)
const TRIAL_ENDS = BIRTH + TRIAL_WINDOW_MS

/** A payer mid-trial: entitled until `trialExpiresAt`, never subscribed. */
function trialUser(balanceMicroUsd: number): Doc<'users'> {
  return {
    billing: {
      trialExpiresAt: TRIAL_ENDS,
      wallet: { balanceMicroUsd, reserveMicroUsd: 0 },
    },
  } as unknown as Doc<'users'>
}

/** What the hourly sweep asks of one paused row, entitlement included. */
function isDecommissionCandidate(
  servicingStatusChangedAt: number,
  now: number,
  entitledUntil?: number,
): boolean {
  return (
    servicingDecommissionDueAt({
      servicingStatus: 'paused',
      servicingStatusChangedAt,
      ...(entitledUntil === undefined ? {} : { entitledUntil }),
    }) <= now
  )
}

test('the delete clock starts when the wall appears, not when the workspace was born', () => {
  /* Birth runs the same verdict every reconcile does, and stamps
     `servicingStatusChangedAt` with the birth time. A workspace whose trial
     credits have not landed in that instant is born PAUSED — the verdict is
     computed from the wallet, and an empty wallet is not entitled. */
  const bornPaused = servicingStatusFor({}, trialUser(0), BIRTH)
  expect(bornPaused).toBe('paused')

  /* The credits land a moment later and the trial runs its seven days. What
     `reconcileServicingStatus` does with that is the whole bug: it patches only
     when the verdict CHANGES, so a row that was born paused and is paused again
     at trial end never has its timestamp refreshed. It still reads BIRTH. */
  const stampedAt = BIRTH

  // The trial is over, the workspace stops serving, and this is the first
  // moment the user is shown the wall.
  expect(servicingStatusFor({}, trialUser(5_000_000), TRIAL_ENDS)).toBe('paused')

  // The rule: the window starts HERE, and now it does — the trial running past
  // the stamp is the proof that the window had not already started.
  expect(isDecommissionCandidate(stampedAt, TRIAL_ENDS, TRIAL_ENDS)).toBe(false)
  expect(
    isDecommissionCandidate(stampedAt, TRIAL_ENDS + SERVICING_ARCHIVE_AFTER_MS - 1, TRIAL_ENDS),
  ).toBe(false)
  expect(
    isDecommissionCandidate(stampedAt, TRIAL_ENDS + SERVICING_ARCHIVE_AFTER_MS, TRIAL_ENDS),
  ).toBe(true)
})

test('a timestamp that tracks the pause gives the user the window the rule promises', () => {
  // The same timeline with the field meaning what the sweep reads it as.
  const pausedAt = TRIAL_ENDS

  expect(isDecommissionCandidate(pausedAt, TRIAL_ENDS)).toBe(false)
  expect(isDecommissionCandidate(pausedAt, TRIAL_ENDS + SERVICING_ARCHIVE_AFTER_MS - 1)).toBe(false)
  expect(isDecommissionCandidate(pausedAt, TRIAL_ENDS + SERVICING_ARCHIVE_AFTER_MS)).toBe(true)
})

test('a ban owes no warning window: due on the next sweep, mid-trial or not', () => {
  // The window is a courtesy to a person whose trial lapsed. A ban is an
  // operator's verdict that there is no person to warn — and a farm's 154 VMs
  // running out their trials plus the window is eight more days of provider
  // bills for nobody.
  const bannedAt = BIRTH + Math.floor(TRIAL_WINDOW_MS / 2)
  expect(
    servicingDecommissionDueAt({
      servicingStatus: 'banned',
      servicingStatusChangedAt: bannedAt,
      entitledUntil: TRIAL_ENDS,
    }),
  ).toBe(bannedAt)
  // The same stamp under a pause still waits out the trial and the window.
  expect(
    servicingDecommissionDueAt({
      servicingStatus: 'paused',
      servicingStatusChangedAt: bannedAt,
      entitledUntil: TRIAL_ENDS,
    }),
  ).toBe(TRIAL_ENDS + SERVICING_ARCHIVE_AFTER_MS)
})
