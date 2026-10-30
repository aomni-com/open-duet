import { describe, expect, test } from 'bun:test'

import type { RunId } from '@convex-dev/action-retrier'

import type { Doc, Id } from '../convex/_generated/dataModel'
import {
  scheduleWorkspaceVm,
  shouldTerminalizeAfterAttachFailure,
} from '../convex/domains/workspaces/vmSchedule'
import {
  scheduleWorkspaceVmTeardown,
  shouldAttachAfterTeardown,
  shouldTerminalizeAfterTeardownFailure,
} from '../convex/domains/workspaces/vmTeardownSchedule'

const WORKSPACE_ID = 'jh76k7c1g8y5et2ez9q8m3v7ac' as Id<'workspaces'>
const TEARDOWN_RUN_ID = 'teardown-run' as RunId
const ATTACH_RUN_ID = 'attach-run' as RunId

describe('workspace VM teardown scheduling', () => {
  test('a paused workspace cannot attach after teardown', () => {
    expect(
      shouldAttachAfterTeardown({ status: 'provisioning', servicingStatus: 'paused' }),
    ).toBeFalse()
  })

  test('only a current paid recommission terminalizes after teardown failure', () => {
    expect(
      shouldTerminalizeAfterTeardownFailure(
        {
          status: 'provisioning',
          servicingStatus: 'active',
          attachAfterVmTeardown: true,
        },
        false,
      ),
    ).toBeTrue()
    expect(
      shouldTerminalizeAfterTeardownFailure(
        { status: 'archived', servicingStatus: 'paused', attachAfterVmTeardown: true },
        false,
      ),
    ).toBeFalse()
  })

  test('purchase upgrades an existing teardown to attach afterward', async () => {
    const harness = new ExistingTeardownHarness({
      vmTeardownRunId: TEARDOWN_RUN_ID,
    })

    expect(
      await scheduleWorkspaceVmTeardown(harness.ctx, WORKSPACE_ID, {
        attachAfterTeardown: true,
      }),
    ).toBe(TEARDOWN_RUN_ID)
    expect(harness.row).toEqual({
      vmTeardownRunId: TEARDOWN_RUN_ID,
      attachAfterVmTeardown: true,
    })
  })

  test('a duplicate teardown cannot clear a latched attach', async () => {
    const harness = new ExistingTeardownHarness({
      vmTeardownRunId: TEARDOWN_RUN_ID,
      attachAfterVmTeardown: true,
    })

    await scheduleWorkspaceVmTeardown(harness.ctx, WORKSPACE_ID)

    expect(harness.row).toEqual({
      vmTeardownRunId: TEARDOWN_RUN_ID,
      attachAfterVmTeardown: true,
    })
  })
})

describe('workspace VM attach scheduling', () => {
  test('a stale attach failure cannot overwrite a transitioned workspace', () => {
    expect(
      shouldTerminalizeAfterAttachFailure(
        { status: 'provisioning', servicingStatus: 'active' },
        true,
      ),
    ).toBeTrue()
    expect(
      shouldTerminalizeAfterAttachFailure({ status: 'archived', servicingStatus: 'paused' }, true),
    ).toBeFalse()
  })

  test('a duplicate attach request reuses the in-flight run', async () => {
    const row = { vmAttachRunId: ATTACH_RUN_ID } as Partial<Doc<'workspaces'>>
    const ctx = {
      db: { get: async () => row },
    } as unknown as Parameters<typeof scheduleWorkspaceVm>[0]

    expect(await scheduleWorkspaceVm(ctx, WORKSPACE_ID)).toBe(ATTACH_RUN_ID)
  })
})

class ExistingTeardownHarness {
  row: Partial<Doc<'workspaces'>>

  readonly ctx = {
    db: {
      get: async () => this.row,
      patch: async (_id: Id<'workspaces'>, patch: Partial<Doc<'workspaces'>>) => {
        this.row = { ...this.row, ...patch }
      },
    },
  } as unknown as Parameters<typeof scheduleWorkspaceVmTeardown>[0]

  constructor(row: Partial<Doc<'workspaces'>>) {
    this.row = row
  }
}
