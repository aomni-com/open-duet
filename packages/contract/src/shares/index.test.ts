import { describe, expect, test } from 'bun:test'

import { AnchorSchema } from '../anchors/index'
import { ANCHOR_MARKER_IGNORE } from '../sync-ignore/index'
import {
  AcceptShareRequestSchema,
  CreateShareRequestSchema,
  DEFAULT_SHARE_IGNORE_PATTERNS,
  SetSharePausedRequestSchema,
  ShareMutationErrorSchema,
  ShareListResponseSchema,
  ShareRequestSchema,
  shareIgnorePatterns,
  MAX_SHARE_IGNORE_PATTERN_UTF8_BYTES,
  MAX_SHARE_USER_IGNORE_PATTERNS,
} from './index'

describe('share default ignore patterns (ledger #14)', () => {
  test('excludes git and node_modules — a repo under two writers corrupts, node_modules is wrong-arch', () => {
    expect(DEFAULT_SHARE_IGNORE_PATTERNS).toContain('**/.git')
    // (?d) lets Syncthing delete an ignored node_modules; the modifier must
    // abut its pattern with no space or the match silently fails.
    expect(DEFAULT_SHARE_IGNORE_PATTERNS).toContain('(?d)**/node_modules')
  })

  test('excludes root and nested anchor markers without changing mirror policy', () => {
    expect(ANCHOR_MARKER_IGNORE).toEqual(['.duet-anchor', '**/.duet-anchor'])
    expect(DEFAULT_SHARE_IGNORE_PATTERNS).toContain('.duet-anchor')
    expect(DEFAULT_SHARE_IGNORE_PATTERNS).toContain('**/.duet-anchor')
  })

  test('does NOT ignore .env — shares treat secrets as normal files (sometimes the user wants to share them)', () => {
    expect(DEFAULT_SHARE_IGNORE_PATTERNS.some(pattern => pattern.includes('.env'))).toBe(false)
  })
})

describe('shareIgnorePatterns — user patterns ADD to the default floor', () => {
  test('no user patterns keeps exactly the default floor', () => {
    expect(shareIgnorePatterns(undefined)).toEqual([...DEFAULT_SHARE_IGNORE_PATTERNS])
    expect(shareIgnorePatterns([])).toEqual([...DEFAULT_SHARE_IGNORE_PATTERNS])
  })

  test('bounds user patterns before merging them into a persisted share', () => {
    const atLimit = Array.from(
      { length: MAX_SHARE_USER_IGNORE_PATTERNS },
      (_, index) =>
        `${index}-${'x'.repeat(MAX_SHARE_IGNORE_PATTERN_UTF8_BYTES - String(index).length - 1)}`,
    )
    expect(
      CreateShareRequestSchema.parse({
        path: 'shared/reports',
        toEmail: 'reader@example.com',
        mode: 'read',
        ignorePatterns: atLimit,
      }).ignorePatterns,
    ).toEqual(atLimit)
    expect(
      CreateShareRequestSchema.safeParse({
        path: 'shared/reports',
        toEmail: 'reader@example.com',
        mode: 'read',
        ignorePatterns: [...atLimit, 'extra'],
      }).success,
    ).toBe(false)
    expect(
      CreateShareRequestSchema.safeParse({
        path: 'shared/reports',
        toEmail: 'reader@example.com',
        mode: 'read',
        ignorePatterns: [`${'x'.repeat(MAX_SHARE_IGNORE_PATTERN_UTF8_BYTES - 3)}🚀`],
      }).success,
    ).toBe(false)
  })

  test('user patterns append to the floor; the breakage-preventing default is never removed', () => {
    expect(shareIgnorePatterns(['.env', 'secrets/'])).toEqual([
      ...DEFAULT_SHARE_IGNORE_PATTERNS,
      '.env',
      'secrets/',
    ])
  })

  test('a user pattern equal to a default is not duplicated', () => {
    expect(shareIgnorePatterns(['**/.git', '**/.duet-anchor', 'private.key'])).toEqual([
      ...DEFAULT_SHARE_IGNORE_PATTERNS,
      'private.key',
    ])
  })
})

describe('email-addressed share contract', () => {
  test('validates the share pause request and its typed inactive-share refusal', () => {
    expect(SetSharePausedRequestSchema.parse({ paused: true })).toEqual({ paused: true })
    expect(SetSharePausedRequestSchema.parse({ paused: false })).toEqual({ paused: false })
    expect(SetSharePausedRequestSchema.parse({ paused: true, detach: true })).toEqual({
      paused: true,
    })
    expect(ShareMutationErrorSchema.parse({ error: 'share_not_active' })).toEqual({
      error: 'share_not_active',
    })
  })

  test('share-mount is a first-class anchor kind', () => {
    expect(
      AnchorSchema.parse({
        id: 'anchor_1',
        workspaceId: 'workspace_1',
        path: 'shared/project',
        kind: 'share-mount',
        settings: {},
        state: 'active',
        createdAt: 1,
        updatedAt: 1,
      }).kind,
    ).toBe('share-mount')
  })

  test('create accepts an email and rejects the removed workspace-addressed body', () => {
    expect(
      CreateShareRequestSchema.parse({
        path: 'project',
        toEmail: 'Friend@Example.com',
        mode: 'read',
      }),
    ).toEqual({ path: 'project', toEmail: 'Friend@Example.com', mode: 'read' })
    expect(() =>
      CreateShareRequestSchema.parse({
        path: 'project',
        toWorkspaceId: 'workspace_legacy',
        mode: 'read',
      }),
    ).toThrow()
  })

  test('accept chooses the recipient workspace at consume time', () => {
    expect(
      AcceptShareRequestSchema.parse({
        toWorkspaceId: 'workspace_recipient',
        mountPath: 'shared/project',
      }),
    ).toEqual({
      toWorkspaceId: 'workspace_recipient',
      mountPath: 'shared/project',
    })
  })

  test('share paths preserve literal percent identities', () => {
    expect(
      CreateShareRequestSchema.parse({
        path: 'projects/100%',
        toEmail: 'friend@example.com',
        mode: 'read',
      }).path,
    ).toBe('projects/100%')
    expect(
      AcceptShareRequestSchema.parse({
        toWorkspaceId: 'workspace_recipient',
        mountPath: 'shared/a%2Fb',
      }).mountPath,
    ).toBe('shared/a%2Fb')
  })

  test('recipient requests expose the source facts needed to make an accept decision', () => {
    expect(
      ShareRequestSchema.parse({
        id: 'share_1',
        anchorId: 'anchor_1',
        originWorkspaceId: 'workspace_origin',
        fromWorkspaceId: 'workspace_origin',
        toEmail: 'friend@example.com',
        mode: 'read',
        ignorePatterns: [],
        state: 'pending',
        createdByUserId: 'user_1',
        createdAt: 1,
        expiresAt: 2,
        source: {
          workspaceName: 'Research Lab',
          path: 'Projects/qbr-deck',
          folderName: 'qbr-deck',
          sharerName: 'Ada Lovelace',
          originLive: true,
          apps: [{ slug: 'qbr', path: 'Projects/qbr-deck/app' }],
        },
      }).source,
    ).toEqual({
      workspaceName: 'Research Lab',
      path: 'Projects/qbr-deck',
      folderName: 'qbr-deck',
      sharerName: 'Ada Lovelace',
      originLive: true,
      apps: [{ slug: 'qbr', path: 'Projects/qbr-deck/app' }],
    })
  })

  test('public projections strip private sync state and outgoing mount paths', () => {
    const base = {
      id: 'share_1',
      anchorId: 'anchor_1',
      originWorkspaceId: 'workspace_origin',
      fromWorkspaceId: 'workspace_origin',
      toEmail: 'friend@example.com',
      mode: 'read',
      ignorePatterns: [],
      state: 'active',
      tokenPrefix: 'duet_share_1234',
      createdByUserId: 'user_1',
      createdAt: 1,
      expiresAt: 2,
      sourcePath: 'project',
    }
    expect(
      ShareListResponseSchema.parse({
        nextCursor: null,
        items: [
          {
            ...base,
            direction: 'outgoing',
            syncStatus: {
              origin: {
                state: 'ready',
                matchesCurrentGeneration: true,
                updatedAt: 3,
              },
              recipient: {
                state: 'paused',
                matchesCurrentGeneration: false,
                updatedAt: 4,
              },
            },
          },
        ],
      }).items[0]?.syncStatus,
    ).toEqual({
      origin: {
        state: 'ready',
        matchesCurrentGeneration: true,
        updatedAt: 3,
      },
      recipient: {
        state: 'paused',
        matchesCurrentGeneration: false,
        updatedAt: 4,
      },
    })
    const withMountPath = ShareListResponseSchema.parse({
      nextCursor: null,
      items: [{ ...base, direction: 'outgoing', mountPath: 'private/path' }],
    })
    expect('mountPath' in withMountPath.items[0]!).toBe(false)
    const withSync = ShareListResponseSchema.parse({
      nextCursor: null,
      items: [{ ...base, direction: 'outgoing', sync: { tokenSecret: 'never-public' } }],
    })
    expect('sync' in withSync.items[0]!).toBe(false)
    const withGeneration = ShareListResponseSchema.parse({
      nextCursor: null,
      items: [
        {
          ...base,
          direction: 'outgoing',
          syncStatus: {
            origin: {
              state: 'ready',
              matchesCurrentGeneration: true,
              generation: 'private-structural-generation',
              updatedAt: 3,
            },
          },
        },
      ],
    })
    expect('generation' in withGeneration.items[0]!.syncStatus!.origin!).toBe(false)
  })
})
