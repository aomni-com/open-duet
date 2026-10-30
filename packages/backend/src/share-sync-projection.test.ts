import { describe, expect, test } from 'bun:test'

import { VmDesiredShareSyncSchema } from '@repo/contract'

import { projectDesiredShareSync } from '../convex/domains/shares/syncProjection'

const SOURCE_DEVICE_ID = 'K5MNBGJ-QT4EVLE-KPBQKY7-CPT4L2N-QU4WHNA-2XBTUXO-Q7XCLHS-6MZ4DAY'
const TARGET_DEVICE_ID = 'A5MNBGJ-QT4EVLE-KPBQKY7-CPT4L2N-QU4WHNA-2XBTUXO-Q7XCLHS-6MZ4DAY'

describe('desired share sync projection', () => {
  test('projects complementary read-only snapshots without exposing the stored secret', async () => {
    const input = projectionFixture()

    const [source, target] = await Promise.all([
      projectDesiredShareSync({ ...input, workspaceId: 'workspace-source' }),
      projectDesiredShareSync({ ...input, workspaceId: 'workspace-target' }),
    ])

    expect(source.shares).toEqual([
      {
        shareId: 'share-1',
        generation: expect.stringMatching(/^[0-9a-f]{64}$/),
        folder: {
          id: 'share-share-1',
          path: 'projects/demo',
          mode: 'read',
          role: 'origin',
          peerDeviceId: TARGET_DEVICE_ID,
          ignorePatterns: ['**/.git', '(?d)**/node_modules', '.duet-anchor'],
          paused: false,
        },
        accept: {
          acceptId: 'accept-target-to-source',
          targetPort: 22_000,
          tokenDigest: await sha256Hex('target-to-source:nonce-target:200000'),
          expiresAt: 200_000,
        },
        bridge: {
          peerDeviceId: TARGET_DEVICE_ID,
          peerUrl: 'wss://target.example.test/v1/tunnel/accept/accept-source-to-target',
          tunnelToken: 'source-to-target:nonce-source:200000',
          acceptId: 'accept-source-to-target',
        },
      },
    ])
    expect(target.shares).toEqual([
      {
        shareId: 'share-1',
        generation: expect.stringMatching(/^[0-9a-f]{64}$/),
        folder: {
          id: 'share-share-1',
          path: 'shared/demo',
          mode: 'read',
          role: 'recipient',
          peerDeviceId: SOURCE_DEVICE_ID,
          ignorePatterns: ['**/.git', '(?d)**/node_modules', '.duet-anchor'],
          paused: false,
        },
        mount: { path: 'shared/demo' },
        accept: {
          acceptId: 'accept-source-to-target',
          targetPort: 22_000,
          tokenDigest: await sha256Hex('source-to-target:nonce-source:200000'),
          expiresAt: 200_000,
        },
        bridge: {
          peerDeviceId: SOURCE_DEVICE_ID,
          peerUrl: 'wss://source.example.test/v1/tunnel/accept/accept-target-to-source',
          tunnelToken: 'target-to-source:nonce-target:200000',
          acceptId: 'accept-target-to-source',
        },
      },
    ])
    expect(JSON.stringify({ source, target })).not.toContain('stored-token-secret')
    expect(VmDesiredShareSyncSchema.parse(source)).toEqual(source)
    expect(VmDesiredShareSyncSchema.parse(target)).toEqual(target)
  })

  test('keeps both roles writable for a write-mode share', async () => {
    const input = projectionFixture()
    input.shares[0]!.mode = 'write'

    const [source, target] = await Promise.all([
      projectDesiredShareSync({ ...input, workspaceId: 'workspace-source' }),
      projectDesiredShareSync({ ...input, workspaceId: 'workspace-target' }),
    ])

    expect(source.shares[0]?.folder).toMatchObject({ mode: 'write', role: 'origin' })
    expect(target.shares[0]?.folder).toMatchObject({ mode: 'write', role: 'recipient' })
  })

  test('withholds shares until both peers are live with device ids and removes ended links', async () => {
    const input = projectionFixture()
    input.workspaces[1]!.syncthingDeviceId = undefined
    expect(await projectDesiredShareSync({ ...input, workspaceId: 'workspace-source' })).toEqual({
      shares: [],
    })

    input.workspaces[1]!.syncthingDeviceId = TARGET_DEVICE_ID
    input.workspaces[1]!.live = false
    expect(await projectDesiredShareSync({ ...input, workspaceId: 'workspace-source' })).toEqual({
      shares: [],
    })

    input.workspaces[1]!.live = true
    for (const state of ['revoked', 'unlinked'] as const) {
      input.shares[0]!.state = state
      expect(await projectDesiredShareSync({ ...input, workspaceId: 'workspace-source' })).toEqual({
        shares: [],
      })
    }
    input.shares[0]!.state = 'active'
    input.shares[0]!.sync.tokenExpiresAt = input.now
    expect(await projectDesiredShareSync({ ...input, workspaceId: 'workspace-source' })).toEqual({
      shares: [],
    })
  })

  test('changes generation for a reprovisioned peer but not for renewed credentials', async () => {
    const input = projectionFixture()
    const initial = await projectDesiredShareSync({ ...input, workspaceId: 'workspace-source' })

    input.shares[0]!.sync.tokenSecret = 'rotated-secret'
    input.shares[0]!.sync.sourceToTargetNonce = 'rotated-source-nonce'
    input.shares[0]!.sync.targetToSourceNonce = 'rotated-target-nonce'
    input.shares[0]!.sync.tokenExpiresAt = 300_000
    const renewed = await projectDesiredShareSync({ ...input, workspaceId: 'workspace-source' })

    expect(renewed.shares[0]?.generation).toBe(initial.shares[0]?.generation)
    expect(renewed.shares[0]?.bridge?.tunnelToken).not.toBe(initial.shares[0]?.bridge?.tunnelToken)
    expect(renewed.shares[0]?.accept.tokenDigest).not.toBe(initial.shares[0]?.accept.tokenDigest)

    input.workspaces[1]!.syncthingDeviceId =
      'B5MNBGJ-QT4EVLE-KPBQKY7-CPT4L2N-QU4WHNA-2XBTUXO-Q7XCLHS-6MZ4DAY'
    const reprovisioned = await projectDesiredShareSync({
      ...input,
      workspaceId: 'workspace-source',
    })
    expect(reprovisioned.shares[0]?.generation).not.toBe(initial.shares[0]?.generation)
    expect(reprovisioned.shares[0]?.folder.peerDeviceId).toBe(
      input.workspaces[1]!.syncthingDeviceId,
    )
  })

  test('projects folder pause to both roles and changes both structural generations', async () => {
    const input = projectionFixture()
    const [runningSource, runningTarget] = await Promise.all([
      projectDesiredShareSync({ ...input, workspaceId: 'workspace-source' }),
      projectDesiredShareSync({ ...input, workspaceId: 'workspace-target' }),
    ])

    input.shares[0]!.pausedAt = 150_000
    const [pausedSource, pausedTarget] = await Promise.all([
      projectDesiredShareSync({ ...input, workspaceId: 'workspace-source' }),
      projectDesiredShareSync({ ...input, workspaceId: 'workspace-target' }),
    ])

    expect(runningSource.shares[0]?.folder.paused).toBe(false)
    expect(runningTarget.shares[0]?.folder.paused).toBe(false)
    expect(pausedSource.shares[0]?.folder.paused).toBe(true)
    expect(pausedTarget.shares[0]?.folder.paused).toBe(true)
    expect(pausedSource.shares[0]?.generation).not.toBe(runningSource.shares[0]?.generation)
    expect(pausedTarget.shares[0]?.generation).not.toBe(runningTarget.shares[0]?.generation)
  })

  test('projects reshare links from the parent mount and sorts multiple shares stably', async () => {
    const input = projectionFixture()
    input.workspaces.push({
      id: 'workspace-third',
      live: true,
      syncthingDeviceId: 'C5MNBGJ-QT4EVLE-KPBQKY7-CPT4L2N-QU4WHNA-2XBTUXO-Q7XCLHS-6MZ4DAY',
      httpsUrl: 'https://third.example.test',
    })
    input.anchors.push({
      id: 'anchor-third',
      workspaceId: 'workspace-third',
      path: 'from-bob/demo',
      kind: 'share-mount',
      state: 'active',
    })
    input.shares.unshift({
      id: 'share-2',
      state: 'active',
      parentShareId: 'share-1',
      fromWorkspaceId: 'workspace-target',
      toWorkspaceId: 'workspace-third',
      anchorId: 'anchor-source',
      mountAnchorId: 'anchor-third',
      mode: 'read',
      ignorePatterns: ['**/.git', '(?d)**/node_modules', '.duet-anchor'],
      pausedAt: undefined,
      sync: {
        sourceToTargetAcceptId: 'accept-2-source-to-target',
        targetToSourceAcceptId: 'accept-2-target-to-source',
        sourceToTargetNonce: 'nonce-2-source',
        targetToSourceNonce: 'nonce-2-target',
        tokenSecret: 'stored-token-secret-2',
        tokenExpiresAt: 200_000,
        preparedAt: 100_000,
      },
    })

    const target = await projectDesiredShareSync({
      ...input,
      workspaceId: 'workspace-target',
    })

    expect(target.shares.map(share => share.shareId)).toEqual(['share-1', 'share-2'])
    expect(target.shares.map(share => [share.folder.role, share.folder.path])).toEqual([
      ['recipient', 'shared/demo'],
      ['origin', 'shared/demo'],
    ])
  })

  test('keeps distinct shares to the same peer instead of collapsing the device pairing', async () => {
    const input = projectionFixture()
    input.anchors.push(
      {
        id: 'anchor-source-second',
        workspaceId: 'workspace-source',
        path: 'projects/second',
        kind: 'share-root',
        state: 'active',
      },
      {
        id: 'anchor-target-second',
        workspaceId: 'workspace-target',
        path: 'shared/second',
        kind: 'share-mount',
        state: 'active',
      },
    )
    input.shares.unshift({
      ...input.shares[0]!,
      id: 'share-0',
      anchorId: 'anchor-source-second',
      mountAnchorId: 'anchor-target-second',
      pausedAt: undefined,
      sync: {
        ...input.shares[0]!.sync,
        sourceToTargetAcceptId: 'accept-0-source-to-target',
        targetToSourceAcceptId: 'accept-0-target-to-source',
      },
    })

    const source = await projectDesiredShareSync({
      ...input,
      workspaceId: 'workspace-source',
    })

    expect(
      source.shares.map(share => ({
        shareId: share.shareId,
        path: share.folder.path,
        peerDeviceId: share.folder.peerDeviceId,
      })),
    ).toEqual([
      {
        shareId: 'share-0',
        path: 'projects/second',
        peerDeviceId: TARGET_DEVICE_ID,
      },
      {
        shareId: 'share-1',
        path: 'projects/demo',
        peerDeviceId: TARGET_DEVICE_ID,
      },
    ])
  })

  test('treats an app anchor shared at its root as the origin share root', async () => {
    const input = projectionFixture()
    input.anchors[0]!.kind = 'app'

    const source = await projectDesiredShareSync({
      ...input,
      workspaceId: 'workspace-source',
    })

    expect(source.shares[0]?.folder).toMatchObject({
      role: 'origin',
      path: 'projects/demo',
    })
  })
})

function projectionFixture() {
  return {
    now: 100_000,
    shares: [
      {
        id: 'share-1',
        state: 'active' as 'active' | 'revoked' | 'unlinked',
        parentShareId: undefined as string | undefined,
        fromWorkspaceId: 'workspace-source',
        toWorkspaceId: 'workspace-target',
        anchorId: 'anchor-source',
        mountAnchorId: 'anchor-target',
        mode: 'read' as 'read' | 'write',
        ignorePatterns: ['**/.git', '(?d)**/node_modules', '.duet-anchor'],
        pausedAt: undefined as number | undefined,
        sync: {
          sourceToTargetAcceptId: 'accept-source-to-target',
          targetToSourceAcceptId: 'accept-target-to-source',
          sourceToTargetNonce: 'nonce-source',
          targetToSourceNonce: 'nonce-target',
          tokenSecret: 'stored-token-secret',
          tokenExpiresAt: 200_000,
          preparedAt: 100_000,
        },
      },
    ],
    anchors: [
      {
        id: 'anchor-source',
        workspaceId: 'workspace-source',
        path: 'projects/demo',
        kind: 'share-root' as 'share-root' | 'share-mount' | 'app',
        state: 'active' as const,
      },
      {
        id: 'anchor-target',
        workspaceId: 'workspace-target',
        path: 'shared/demo',
        kind: 'share-mount' as 'share-root' | 'share-mount' | 'app',
        state: 'active' as const,
      },
    ],
    workspaces: [
      {
        id: 'workspace-source',
        live: true,
        syncthingDeviceId: SOURCE_DEVICE_ID as string | undefined,
        httpsUrl: 'https://source.example.test',
      },
      {
        id: 'workspace-target',
        live: true,
        syncthingDeviceId: TARGET_DEVICE_ID as string | undefined,
        httpsUrl: 'https://target.example.test',
      },
    ],
    signBearer: async (input: {
      claims: { direction: string }
      nonce: string
      expiresAt: number
    }) => `${input.claims.direction}:${input.nonce}:${input.expiresAt}`,
  }
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}
