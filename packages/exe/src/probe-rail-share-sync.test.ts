import { describe, expect, test } from 'bun:test'

import {
  anchorMarkersStayLocal,
  areComplementaryReadyReports,
  hasPrunedShareState,
  hasRelocatedShareState,
  redactProbeText,
} from '../scripts/probe-rail-share-sync.ts'

describe('rail share-sync probe safety boundary', () => {
  test('prints help without loading staging credentials', async () => {
    const child = Bun.spawn(
      [
        process.execPath,
        new URL('../scripts/probe-rail-share-sync.ts', import.meta.url).pathname,
        '--help',
      ],
      {
        env: {},
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )

    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      expect(exitCode, stderr).toBe(0)
      expect(stdout.replace(/\s+/g, ' ')).toContain(
        'never calls a gateway share/sync mutation route',
      )
      expect(stderr).toBe('')
    } finally {
      if (child.exitCode === null) child.kill()
      await child.exited
    }
  })

  test('redacts configured credentials and bearer-shaped values from failures', () => {
    const redacted = redactProbeText(
      'request failed private=chosen-secret Authorization: Bearer opaque-auth and token=duet_vm_abcdef',
      ['chosen-secret'],
    )

    expect(redacted).toBe(
      'request failed private=<redacted> Authorization: Bearer <redacted> and token=<redacted>',
    )
  })

  test('accepts role-specific generations once both complementary reports are ready', () => {
    const origin = { shareId: 'share-a', generation: 'origin-generation', state: 'ready' as const }
    const recipient = {
      shareId: 'share-a',
      generation: 'recipient-generation',
      state: 'ready' as const,
    }
    expect(areComplementaryReadyReports({ origin, recipient })).toBe(true)
    expect(areComplementaryReadyReports({ recipient })).toBe(false)
    expect(areComplementaryReadyReports({ origin })).toBe(false)
    expect(
      areComplementaryReadyReports({ origin: { ...origin, state: 'applying' }, recipient }),
    ).toBe(false)
    expect(
      areComplementaryReadyReports({ origin, recipient: { ...recipient, state: 'applying' } }),
    ).toBe(false)
    expect(
      areComplementaryReadyReports({ origin, recipient: { ...recipient, shareId: 'share-b' } }),
    ).toBe(false)
  })

  test('distinguishes each side owning its own anchor marker from a crossed marker', () => {
    expect(
      anchorMarkersStayLocal(
        'duet-anchor:v1:origin-anchor:origin-nonce',
        'duet-anchor:v1:recipient-anchor:recipient-nonce',
      ),
    ).toBe(true)
    expect(
      anchorMarkersStayLocal(
        'duet-anchor:v1:origin-anchor:origin-nonce',
        'duet-anchor:v1:origin-anchor:origin-nonce',
      ),
    ).toBe(false)
    expect(
      anchorMarkersStayLocal('must-not-cross', 'duet-anchor:v1:recipient-anchor:recipient-nonce'),
    ).toBe(false)
    expect(
      anchorMarkersStayLocal('duet-anchor:v1:origin-anchor:origin-nonce', 'must-not-cross'),
    ).toBe(false)
  })

  test('requires both the mount registry and Syncthing folder to reach the relocated path', () => {
    const state = {
      mounts: [
        {
          id: 'share-a',
          shareId: 'a',
          path: 'shared/new',
          mode: 'write' as const,
          role: 'recipient' as const,
        },
      ],
      folders: [
        {
          id: 'share-a',
          path: '/home/exedev/drive/shared/new',
          type: 'sendreceive',
          deviceIds: ['peer-a'],
        },
      ],
    }

    expect(hasRelocatedShareState(state, 'share-a', 'shared/new')).toBe(true)
    expect(hasRelocatedShareState(state, 'share-a', 'shared/old')).toBe(false)
    expect(
      hasRelocatedShareState(
        { ...state, mounts: [{ ...state.mounts[0]!, path: 'shared/old' }] },
        'share-a',
        'shared/new',
      ),
    ).toBe(false)
    expect(
      hasRelocatedShareState(
        { ...state, folders: [{ ...state.folders[0]!, path: '/home/exedev/drive/shared/old' }] },
        'share-a',
        'shared/new',
      ),
    ).toBe(false)
    expect(
      hasRelocatedShareState(
        { ...state, mounts: [{ ...state.mounts[0]!, id: 'share-b' }] },
        'share-a',
        'shared/new',
      ),
    ).toBe(false)
    expect(
      hasRelocatedShareState(
        { ...state, folders: [{ ...state.folders[0]!, id: 'share-b' }] },
        'share-a',
        'shared/new',
      ),
    ).toBe(false)
  })

  test('keeps a shared peer device while pruning only the unlinked share', () => {
    const state = {
      folders: [{ id: 'share-b' }],
      mounts: [{ id: 'share-b' }],
      devices: [{ id: 'peer-a' }],
    }

    expect(hasPrunedShareState(state, 'share-a', 'peer-a', 'present')).toBe(true)
    expect(hasPrunedShareState(state, 'share-a', 'peer-a', 'absent')).toBe(false)
    expect(hasPrunedShareState(state, 'share-b', 'peer-a', 'present')).toBe(false)
    expect(
      hasPrunedShareState(
        { ...state, folders: [{ id: 'share-a' }] },
        'share-a',
        'peer-a',
        'present',
      ),
    ).toBe(false)
    expect(
      hasPrunedShareState(
        { ...state, mounts: [{ id: 'share-a' }] },
        'share-a',
        'peer-a',
        'present',
      ),
    ).toBe(false)
  })
})
