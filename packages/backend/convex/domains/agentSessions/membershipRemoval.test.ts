import { expect, test } from 'bun:test'

import { getFunctionName, type FunctionReference } from 'convex/server'

import type { Id } from '../../_generated/dataModel'
import type { ActionCtx } from '../../_generated/server'
import { dispatchMembershipRemoval } from './membershipRemoval'

test.each(['page', 'advance'] as const)(
  'dispatcher-level %s failure reschedules the same checkpoint',
  async failure => {
    const args = {
      membershipId: 'membership_a' as Id<'workspaceMembers'>,
      expectedAfterSessionId: null,
    }
    const scheduled: Array<{ delay: number; args: typeof args }> = []
    const ctx = {
      runQuery: async () => {
        if (failure === 'page') throw new Error('transient page failure')
        return {
          status: 'ready' as const,
          sessionIds: ['session_a' as Id<'agentSessions'>],
          scannedThroughSessionId: 'session_a' as Id<'agentSessions'>,
          hasMore: false,
        }
      },
      runMutation: async (reference: FunctionReference<'mutation'>) => {
        if (failure === 'advance' && getFunctionName(reference).endsWith(':advance')) {
          throw new Error('transient advance failure')
        }
      },
      scheduler: {
        runAfter: async (delay: number, _reference: unknown, retryArgs: typeof args) => {
          scheduled.push({ delay, args: retryArgs })
        },
      },
    } as unknown as Pick<ActionCtx, 'runQuery' | 'runMutation' | 'scheduler'>

    await dispatchMembershipRemoval(ctx, args)

    expect(scheduled).toHaveLength(1)
    expect(scheduled[0]!.delay).toBeGreaterThan(0)
    expect(scheduled[0]!.args).toEqual(args)
  },
)
