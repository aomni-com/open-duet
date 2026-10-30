import { describe, expect, test } from 'bun:test'

import type { AgentActivity, SessionListPage } from '@repo/contract'

import {
  candidateWorkConversationOwners,
  unreadWorkOwnerIds,
  verifyWorkConversationOwners,
} from './work-agent-presence'

describe('candidateWorkConversationOwners', () => {
  test('excludes chat-only owners and retains owners whose bounded activity needs verification', () => {
    const owners: AgentActivity[] = [
      {
        agentId: 'chat-only',
        sessions: [],
        truncated: false,
        chat: {
          id: 'chat',
          title: 'Default chat',
          bucket: 'done',
          updatedAt: 1,
          unread: false,
        },
      },
      {
        agentId: 'has-activity',
        sessions: [
          {
            id: 'child-job',
            title: 'Child job',
            bucket: 'running',
            updatedAt: 2,
            unread: false,
          },
        ],
        truncated: false,
      },
      { agentId: 'truncated', sessions: [], truncated: true },
    ]

    expect(candidateWorkConversationOwners(owners).map(owner => owner.agentId)).toEqual([
      'has-activity',
      'truncated',
    ])
  })
})

describe('verifyWorkConversationOwners', () => {
  test('makes one exact filtered request per owner with bounded concurrency', async () => {
    let active = 0
    let peak = 0
    const requests: Array<Record<string, unknown>> = []
    let release!: () => void
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const owners: AgentActivity[] = Array.from({ length: 5 }, (_, index) => ({
      agentId: `agent-${index}`,
      sessions: [
        {
          id: `activity-${index}`,
          title: 'Activity',
          bucket: 'done',
          updatedAt: index,
          unread: false,
        },
      ],
      truncated: false,
    }))

    const pending = verifyWorkConversationOwners({
      owners,
      concurrency: 2,
      request: async query => {
        requests.push(query)
        active += 1
        peak = Math.max(peak, active)
        await gate
        active -= 1
        return {
          items:
            query.agentId === 'agent-4'
              ? []
              : ([{ id: `conversation-${query.agentId}` }] as SessionListPage['items']),
          nextCursor: null,
        }
      },
    })

    const startedBeforeRelease = requests.length
    release()
    const presence = await pending
    expect(startedBeforeRelease).toBe(2)
    expect(peak).toBe(2)
    expect(requests).toHaveLength(owners.length)
    expect(requests).toEqual(
      expect.arrayContaining(
        owners.map(owner => ({
          search: '',
          limit: 1,
          archived: 'exclude',
          agentId: owner.agentId,
          excludeDefault: true,
          topLevel: true,
        })),
      ),
    )
    expect(presence.visibleOwnerIds).toEqual(['agent-0', 'agent-1', 'agent-2', 'agent-3'])
    expect(presence.failedOwnerIds).toEqual([])
  })

  test('keeps successful owners when one independent request fails', async () => {
    const owners: AgentActivity[] = ['first', 'broken', 'last'].map((agentId, index) => ({
      agentId,
      sessions: [
        {
          id: `activity-${agentId}`,
          title: 'Activity',
          bucket: 'done',
          updatedAt: index,
          unread: false,
        },
      ],
      truncated: false,
    }))
    const requested: string[] = []

    const presence = await verifyWorkConversationOwners({
      owners,
      request: async query => {
        requested.push(query.agentId)
        if (query.agentId === 'broken') throw new Error('unavailable')
        return {
          items: [{ id: `conversation-${query.agentId}` }] as SessionListPage['items'],
          nextCursor: null,
        }
      },
    })

    expect(requested).toEqual(['first', 'broken', 'last'])
    expect(presence.visibleOwnerIds).toEqual(['first', 'last'])
    expect(presence.failedOwnerIds).toEqual(['broken'])
  })
})

describe('unreadWorkOwnerIds', () => {
  function owner(agentId: string, unreadFlags: readonly boolean[]): AgentActivity {
    return {
      agentId,
      truncated: false,
      sessions: unreadFlags.map((unread, index) => ({
        id: `${agentId}_${index}`,
        title: `Session ${index}`,
        bucket: 'done' as const,
        updatedAt: index,
        unread,
      })),
    }
  }

  /* The sidebar collapses an owner's conversations behind one row, and a
     collapsed row that says nothing is a workspace where new work is invisible
     until the reader goes looking for it owner by owner. Activity already
     carries `unread` for every owner in one poll — expanded or not — so this is
     a read of what the sidebar is holding rather than a reason to fetch. */
  test('names the owners whose work has something unread', () => {
    expect([
      ...unreadWorkOwnerIds([
        owner('agent_quiet', [false, false]),
        owner('agent_waiting', [false, true]),
        owner('agent_loud', [true, true]),
      ]),
    ]).toEqual(['agent_waiting', 'agent_loud'])
  })

  test('an owner with no work at all is not unread', () => {
    expect([...unreadWorkOwnerIds([owner('agent_empty', [])])]).toEqual([])
  })

  /* The owner's own chat is a row of its own further up the sidebar, carrying
     its own dot. Counting it here would mark the group for a conversation the
     group does not contain — and would double-report the one it does. */
  test("the owner's own unread chat does not mark the group", () => {
    const withUnreadChat: AgentActivity = {
      ...owner('agent_chat_only', []),
      chat: { id: 'chat', title: 'Default chat', bucket: 'done', updatedAt: 1, unread: true },
    }
    expect([...unreadWorkOwnerIds([withUnreadChat])]).toEqual([])
  })

  test('no owners at all is no dots', () => {
    expect([...unreadWorkOwnerIds([])]).toEqual([])
  })
})
