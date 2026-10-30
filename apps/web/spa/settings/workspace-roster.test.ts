import { expect, test } from 'bun:test'

import type { WorkspaceInvite, WorkspaceMember } from '@repo/contract'

import { projectWorkspaceRoster } from './workspace-roster'

const NOW = 1_700_000_000_000
const DAY = 24 * 60 * 60 * 1000

function member(overrides: Partial<WorkspaceMember> & { id: string }): WorkspaceMember {
  return {
    email: `${overrides.id}@example.com`,
    role: 'editor',
    isBillingUser: false,
    ...overrides,
  }
}

function invite(overrides: Partial<WorkspaceInvite> & { id: string }): WorkspaceInvite {
  return {
    email: `${overrides.id}@example.com`,
    role: 'editor',
    expiresAt: NOW + 7 * DAY,
    ...overrides,
  }
}

test('the roster reads members first, then the people who have not accepted yet', () => {
  const rows = projectWorkspaceRoster({
    members: [member({ id: 'ada' }), member({ id: 'grace' })],
    invites: [invite({ id: 'linus' })],
    now: NOW,
  })

  expect(rows).toEqual([
    { kind: 'member', id: 'ada', member: member({ id: 'ada' }) },
    { kind: 'member', id: 'grace', member: member({ id: 'grace' }) },
    { kind: 'invited', id: 'linus', invite: invite({ id: 'linus' }) },
  ])
})

test('a revoked, accepted, or expired invitation is nobody the roster still waits on', () => {
  const rows = projectWorkspaceRoster({
    members: [],
    invites: [
      invite({ id: 'revoked', revokedAt: NOW - DAY }),
      invite({ id: 'consumed', consumedAt: NOW - DAY }),
      invite({ id: 'expired', expiresAt: NOW - 1 }),
      invite({ id: 'open' }),
    ],
    now: NOW,
  })

  expect(rows).toEqual([{ kind: 'invited', id: 'open', invite: invite({ id: 'open' }) }])
})

test('someone already in the workspace is one row, not a member and a stranger', () => {
  const rows = projectWorkspaceRoster({
    members: [member({ id: 'ada', email: ' Ada@Example.com ' })],
    invites: [invite({ id: 'ada-again', email: '  ada@example.com  ' }), invite({ id: 'linus' })],
    now: NOW,
  })

  expect(rows).toEqual([
    { kind: 'member', id: 'ada', member: member({ id: 'ada', email: ' Ada@Example.com ' }) },
    { kind: 'invited', id: 'linus', invite: invite({ id: 'linus' }) },
  ])
})
