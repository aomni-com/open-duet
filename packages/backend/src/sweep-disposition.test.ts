import { describe, expect, test } from 'bun:test'

import {
  ARCHIVE_RETRY_GRACE_MS,
  dispositionAfterArchiveFailure,
  servicingDecommissionDisposition,
} from '../convex/domains/workspaces/provisioningCore'

describe('decommission sweep disposition', () => {
  test('classifies the complete servicing and subscription-history table', () => {
    // A ban never archives, subscriber or not: the files of a workspace an
    // operator has thrown out are not evidence anyone will come back for, and
    // pulling them cost a farm's decommission twenty seconds a row.
    const rows = [
      ['paused', false, false, 'archived'],
      ['paused', true, true, 'archived'],
      ['banned', false, false, 'retired'],
      ['banned', true, false, 'retired'],
    ] as const

    expect(
      rows.map(([servicingStatus, everSubscribed]) => ({
        servicingStatus,
        everSubscribed,
        ...servicingDecommissionDisposition({ servicingStatus, everSubscribed }),
      })),
    ).toEqual(
      rows.map(([servicingStatus, everSubscribed, archive, targetStatus]) => ({
        servicingStatus,
        everSubscribed,
        archive,
        targetStatus,
      })),
    )
  })

  /* A retry is a bet, and a bet has a stake: every hour the archive fails, a
     VM nobody pays for runs for another hour. A live VM whose archive endpoint
     is broken would otherwise be retried forever — the archive must never hold
     the teardown hostage. After a day past due the files are abandoned and the
     teardown proceeds, on the same record the unhealthy path leaves. */
  test('a failing archive stops blocking the teardown a day past due', () => {
    expect(dispositionAfterArchiveFailure('active', ARCHIVE_RETRY_GRACE_MS - 1)).toBe('retry')
    expect(dispositionAfterArchiveFailure('active', ARCHIVE_RETRY_GRACE_MS)).toBe('teardown')
  })

  /* Retrying is a bet that the VM will answer next hour. For an `unhealthy`
     workspace that bet has already lost -- the status means the sync rail has
     been silent past VM_SYNC_STALE_MS, and the sweep only reaches this row
     a whole window after the pause. Retrying forever is how a VM nobody pays for
     becomes immortal, so the archive is abandoned and the teardown proceeds;
     `workspace.servicing_archived_without_archive` is the honest record of it. */
  test('an unreachable VM makes a transport failure terminal', () => {
    expect(dispositionAfterArchiveFailure('unhealthy', 0)).toBe('teardown')
  })
})
