import { afterEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { GatewayAnchor } from '@repo/contract'

import { resolveSpawnCwd } from './spawn-cwd'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function scratchRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'duet-spawn-cwd-'))
  roots.push(root)
  return root
}

test('resolveSpawnCwd returns the canonical requested cwd when it is usable', async () => {
  const root = await scratchRoot()
  const driveDir = join(root, 'drive')
  await mkdir(join(driveDir, 'agents', 'reviewer', 'project'), { recursive: true })

  expect(
    resolveSpawnCwd({
      driveDir,
      requestedCwd: 'agents//reviewer/work/../project/.',
      anchors: [agentAnchor('reviewer', 'agents/reviewer')],
      agentAnchorId: 'reviewer',
    }),
  ).toEqual({ cwd: 'agents/reviewer/project' })
  expect(resolveSpawnCwd({ driveDir, anchors: [] })).toEqual({})
})

test('resolveSpawnCwd reports every unusable-cwd reason and falls back by binding', async () => {
  const root = await scratchRoot()
  const driveDir = join(root, 'drive')
  const anchorPath = 'agents/reviewer'
  await mkdir(join(driveDir, anchorPath), { recursive: true })
  await mkdir(join(driveDir, 'other-agent'), { recursive: true })
  await writeFile(join(driveDir, 'notes.txt'), 'not a directory')
  await writeFile(join(driveDir, anchorPath, 'notes.txt'), 'not a directory')
  await mkdir(join(root, 'outside'), { recursive: true })
  await symlink(join(root, 'outside'), join(driveDir, 'escape'))
  await symlink(join(root, 'outside'), join(driveDir, anchorPath, 'escape'))
  const anchors = [agentAnchor('reviewer', anchorPath)]

  const cases = [
    {
      requestedCwd: 'agents/reviewer/deleted',
      agentAnchorId: 'reviewer',
      expected: {
        cwd: anchorPath,
        fallback: {
          from: 'agents/reviewer/deleted',
          to: anchorPath,
          reason: 'missing',
        },
      },
    },
    {
      requestedCwd: 'deleted',
      expected: {
        fallback: { from: 'deleted', to: '/', reason: 'missing' },
      },
    },
    {
      requestedCwd: 'notes.txt',
      expected: {
        fallback: { from: 'notes.txt', to: '/', reason: 'not_a_directory' },
      },
    },
    {
      requestedCwd: 'agents/reviewer/notes.txt',
      agentAnchorId: 'reviewer',
      expected: {
        cwd: anchorPath,
        fallback: {
          from: 'agents/reviewer/notes.txt',
          to: anchorPath,
          reason: 'not_a_directory',
        },
      },
    },
    {
      requestedCwd: '../outside',
      expected: {
        fallback: { from: '../outside', to: '/', reason: 'outside_drive' },
      },
    },
    {
      requestedCwd: 'agents/reviewer/escape',
      agentAnchorId: 'reviewer',
      expected: {
        cwd: anchorPath,
        fallback: {
          from: 'agents/reviewer/escape',
          to: anchorPath,
          reason: 'outside_drive',
        },
      },
    },
    {
      requestedCwd: 'other-agent',
      agentAnchorId: 'reviewer',
      expected: {
        cwd: anchorPath,
        fallback: {
          from: 'other-agent',
          to: anchorPath,
          reason: 'outside_agent_anchor',
        },
      },
    },
  ] as const

  for (const fixture of cases) {
    expect(
      resolveSpawnCwd({
        driveDir,
        requestedCwd: fixture.requestedCwd,
        anchors,
        ...('agentAnchorId' in fixture ? { agentAnchorId: fixture.agentAnchorId } : {}),
      }),
    ).toEqual(fixture.expected)
  }

  expect(resolveSpawnCwd({ driveDir, requestedCwd: 'escape', anchors })).toEqual({
    fallback: { from: 'escape', to: '/', reason: 'outside_drive' },
  })
})

test('resolveSpawnCwd terminalizes an unavailable bound-agent root', async () => {
  const root = await scratchRoot()
  const driveDir = join(root, 'drive')
  await mkdir(driveDir, { recursive: true })

  expect(
    resolveSpawnCwd({
      driveDir,
      requestedCwd: 'deleted',
      anchors: [],
      agentAnchorId: 'reviewer',
    }),
  ).toEqual({
    terminal: true,
  })

  expect(
    resolveSpawnCwd({
      driveDir,
      requestedCwd: 'agents/reviewer/deleted',
      anchors: [agentAnchor('reviewer', 'agents/reviewer')],
      agentAnchorId: 'reviewer',
    }),
  ).toEqual({
    terminal: true,
  })
})

function agentAnchor(id: string, path: string): GatewayAnchor {
  return {
    id,
    agentId: `agent_${id}`,
    workspaceId: 'workspace_1',
    path,
    kind: 'agent',
    settings: {},
    state: 'active',
    createdAt: 1,
    updatedAt: 1,
    markerNonce: `nonce-${id}`,
  }
}
