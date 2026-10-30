import { describe, expect, test } from 'bun:test'

import {
  resolveSessionDiscoveryScope,
  resolvePreloadedSessionAccess,
  sessionAccessAllows,
} from './access'

describe('session point access policy', () => {
  test('a workspace principal can process a specific session without a membership', () => {
    expect(
      resolvePreloadedSessionAccess({
        identity: {
          principal: { kind: 'workspace' },
          actorId: 'surrogate_owner',
        },
        membership: null,
        session: {
          audience: {
            kind: 'specific',
            membershipGrant: { membershipId: 'member_viewer' },
          },
          agentState: 'agent',
        },
      }),
    ).toEqual({ ok: true, basis: 'workspace' })
  })

  test('a missing or foreign session is generic not-found even for workspace principals', () => {
    expect(
      resolvePreloadedSessionAccess({
        identity: { principal: { kind: 'workspace' }, actorId: 'surrogate_owner' },
        membership: null,
        session: null,
      }),
    ).toEqual({ ok: false, error: 'not_found' })
  })

  test('editor and viewer participants are admitted by their membership generation', () => {
    for (const role of ['editor', 'viewer'] as const) {
      expect(
        resolvePreloadedSessionAccess({
          identity: {
            principal: { kind: 'human', userId: `user_${role}` },
            actorId: `user_${role}`,
          },
          membership: {
            membershipId: `membership_${role}`,
            userId: `user_${role}`,
            role,
          },
          session: {
            audience: {
              kind: 'specific',
              membershipGrant: { membershipId: `membership_${role}` },
            },
            agentState: 'agent',
          },
        }),
      ).toEqual({
        ok: true,
        basis: 'specific-participant',
        membership: {
          membershipId: `membership_${role}`,
          userId: `user_${role}`,
          role,
        },
      })
    }
  })

  test('every current member can access a workspace-visible session', () => {
    expect(
      resolvePreloadedSessionAccess({
        identity: { principal: { kind: 'human', userId: 'user_viewer' }, actorId: 'user_viewer' },
        membership: {
          membershipId: 'membership_viewer',
          userId: 'user_viewer',
          role: 'viewer',
        },
        session: { audience: { kind: 'workspace' }, agentState: 'root' },
      }),
    ).toEqual({
      ok: true,
      basis: 'workspace-member',
      membership: {
        membershipId: 'membership_viewer',
        userId: 'user_viewer',
        role: 'viewer',
      },
    })
  })

  test('an owner overrides a specific audience without becoming a participant', () => {
    expect(
      resolvePreloadedSessionAccess({
        identity: { principal: { kind: 'human', userId: 'user_owner' }, actorId: 'user_owner' },
        membership: { membershipId: 'membership_owner', userId: 'user_owner', role: 'owner' },
        session: {
          audience: {
            kind: 'specific',
            membershipGrant: { membershipId: 'membership_viewer' },
          },
          agentState: 'agent',
        },
      }),
    ).toEqual({
      ok: true,
      basis: 'owner-override',
      membership: { membershipId: 'membership_owner', userId: 'user_owner', role: 'owner' },
    })
  })

  test('removed, rejoined, and ordinary nonparticipants receive the same not-found verdict', () => {
    const identity = {
      principal: { kind: 'human' as const, userId: 'user_viewer' },
      actorId: 'user_viewer',
    }
    const session = {
      audience: {
        kind: 'specific' as const,
        membershipGrant: { membershipId: 'membership_old' },
      },
      agentState: 'agent' as const,
    }

    expect(resolvePreloadedSessionAccess({ identity, membership: null, session })).toEqual({
      ok: false,
      error: 'not_found',
    })
    expect(
      resolvePreloadedSessionAccess({
        identity,
        membership: {
          membershipId: 'membership_new',
          userId: 'user_viewer',
          role: 'viewer',
        },
        session,
      }),
    ).toEqual({ ok: false, error: 'not_found' })
    expect(
      resolvePreloadedSessionAccess({
        identity,
        membership: {
          membershipId: 'membership_other',
          userId: 'user_someone_else',
          role: 'editor',
        },
        session,
      }),
    ).toEqual({ ok: false, error: 'not_found' })
  })

  test('substituting an owner actor id never upgrades the authenticated principal', () => {
    expect(
      resolvePreloadedSessionAccess({
        identity: {
          principal: { kind: 'human', userId: 'user_editor' },
          actorId: 'user_owner',
        },
        membership: {
          membershipId: 'membership_editor',
          userId: 'user_editor',
          role: 'editor',
        },
        session: {
          audience: {
            kind: 'specific',
            membershipGrant: { membershipId: 'membership_viewer' },
          },
          agentState: 'agent',
        },
      }),
    ).toEqual({ ok: false, error: 'not_found' })
  })

  test('human access fails closed for a session whose agent row is gone', () => {
    for (const role of ['owner', 'editor', 'viewer'] as const) {
      expect(
        resolvePreloadedSessionAccess({
          identity: {
            principal: { kind: 'human', userId: `user_${role}` },
            actorId: `user_${role}`,
          },
          membership: {
            membershipId: `membership_${role}`,
            userId: `user_${role}`,
            role,
          },
          session: {
            audience: { kind: 'workspace' },
            agentState: 'missing',
          },
        }),
      ).toEqual({ ok: false, error: 'not_found' })
    }
  })

  test('the onboarding session remains owner/editor-only while workspace runners can process it', () => {
    const session = { audience: { kind: 'workspace' as const }, agentState: 'onboarding' as const }
    for (const role of ['owner', 'editor', 'viewer'] as const) {
      const result = resolvePreloadedSessionAccess({
        identity: {
          principal: { kind: 'human', userId: `user_${role}` },
          actorId: `user_${role}`,
        },
        membership: {
          membershipId: `membership_${role}`,
          userId: `user_${role}`,
          role,
        },
        session,
      })
      expect(result.ok).toBe(role !== 'viewer')
    }
    expect(
      resolvePreloadedSessionAccess({
        identity: { principal: { kind: 'workspace' }, actorId: 'surrogate_owner' },
        membership: null,
        session,
      }),
    ).toEqual({ ok: true, basis: 'workspace' })
  })
})

describe('session discovery scope', () => {
  test('workspace principals and owners read the workspace lane; other members read their generation', () => {
    expect(
      resolveSessionDiscoveryScope({
        identity: { principal: { kind: 'workspace' }, actorId: 'surrogate_owner' },
        membership: null,
      }),
    ).toEqual({ ok: true, scope: { kind: 'workspace' } })
    expect(
      resolveSessionDiscoveryScope({
        identity: { principal: { kind: 'human', userId: 'user_owner' }, actorId: 'user_owner' },
        membership: { membershipId: 'membership_owner', userId: 'user_owner', role: 'owner' },
      }),
    ).toEqual({
      ok: true,
      scope: { kind: 'workspace', membershipId: 'membership_owner' },
    })
    expect(
      resolveSessionDiscoveryScope({
        identity: { principal: { kind: 'human', userId: 'user_viewer' }, actorId: 'user_viewer' },
        membership: { membershipId: 'membership_viewer', userId: 'user_viewer', role: 'viewer' },
      }),
    ).toEqual({
      ok: true,
      scope: { kind: 'membership', membershipId: 'membership_viewer' },
    })
  })

  test('removal denies discovery and a rejoin resolves only the new generation', () => {
    const identity = {
      principal: { kind: 'human' as const, userId: 'user_viewer' },
      actorId: 'user_owner',
    }
    expect(resolveSessionDiscoveryScope({ identity, membership: null })).toEqual({
      ok: false,
      error: 'not_found',
    })
    expect(
      resolveSessionDiscoveryScope({
        identity,
        membership: {
          membershipId: 'membership_new',
          userId: 'user_viewer',
          role: 'viewer',
        },
      }),
    ).toEqual({
      ok: true,
      scope: { kind: 'membership', membershipId: 'membership_new' },
    })
  })
})

describe('session capabilities', () => {
  test('viewers participate while editors and owners additionally control global lifecycle', () => {
    for (const role of ['owner', 'editor', 'viewer'] as const) {
      const access = resolvePreloadedSessionAccess({
        identity: {
          principal: { kind: 'human', userId: `user_${role}` },
          actorId: `user_${role}`,
        },
        membership: {
          membershipId: `membership_${role}`,
          userId: `user_${role}`,
          role,
        },
        session: {
          audience: {
            kind: 'specific',
            membershipGrant: { membershipId: `membership_${role}` },
          },
          agentState: 'agent',
        },
      })

      expect(sessionAccessAllows(access, 'participate')).toBe(true)
      expect(sessionAccessAllows(access, 'global-lifecycle')).toBe(role !== 'viewer')
    }
  })

  test('a workspace principal can participate and control lifecycle across the trust domain', () => {
    const access = resolvePreloadedSessionAccess({
      identity: { principal: { kind: 'workspace' }, actorId: 'surrogate_owner' },
      membership: null,
      session: {
        audience: {
          kind: 'specific',
          membershipGrant: { membershipId: 'membership_viewer' },
        },
        agentState: 'agent',
      },
    })

    expect(sessionAccessAllows(access, 'participate')).toBe(true)
    expect(sessionAccessAllows(access, 'global-lifecycle')).toBe(true)
  })
})
