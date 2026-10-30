import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createAgentSessionsController } from './coordinator'
import { createAgentSessionLedger, type GatewaySessionEnvelope } from './ledger'

test('an existing unbound session resolves to the root browser owner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'duet-browser-owner-root-'))
  try {
    const stateDir = join(root, '.duet')
    await createAgentSessionLedger({ stateDir, now: () => 1 }).write(envelope('root-session'))
    const controller = createAgentSessionsController({
      stateDir,
      driveDir: join(root, 'drive'),
      memoryDbPath: join(root, 'memory.db'),
      getVmToken: async () => null,
    })

    expect(await controller.browserOwnerForSession('root-session')).toEqual({
      ok: true,
      owner: { kind: 'root' },
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a bound session resolves through its anchor to the stable agent id', async () => {
  const root = await mkdtemp(join(tmpdir(), 'duet-browser-owner-agent-'))
  try {
    const stateDir = join(root, '.duet')
    await createAgentSessionLedger({ stateDir, now: () => 1 }).write({
      ...envelope('agent-session'),
      agentAnchorId: 'anchor-1',
    })
    const controller = createAgentSessionsController({
      stateDir,
      driveDir: join(root, 'drive'),
      memoryDbPath: join(root, 'memory.db'),
      getVmToken: async () => null,
      anchors: () => [
        {
          id: 'anchor-1',
          workspaceId: 'workspace-1',
          path: 'agents/researcher',
          kind: 'agent',
          settings: {},
          state: 'active',
          createdAt: 1,
          updatedAt: 1,
          markerNonce: 'marker-1',
          agentId: 'agent-stable-1',
        },
      ],
    })

    expect(await controller.browserOwnerForSession('agent-session')).toEqual({
      ok: true,
      owner: { kind: 'agent', agentId: 'agent-stable-1' },
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('missing and unresolved sessions never fall back to root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'duet-browser-owner-errors-'))
  try {
    const stateDir = join(root, '.duet')
    const ledger = createAgentSessionLedger({ stateDir, now: () => 1 })
    await ledger.write({ ...envelope('unresolved-session'), agentAnchorId: 'missing-anchor' })
    await ledger.write(envelope('discarded-session'))
    await ledger.discard('discarded-session')
    const controller = createAgentSessionsController({
      stateDir,
      driveDir: join(root, 'drive'),
      memoryDbPath: join(root, 'memory.db'),
      getVmToken: async () => null,
      anchors: () => [],
    })

    expect(await controller.browserOwnerForSession('unknown-session')).toEqual({
      ok: false,
      error: 'browser_session_not_found',
    })
    expect(await controller.browserOwnerForSession('discarded-session')).toEqual({
      ok: false,
      error: 'browser_session_not_found',
    })
    expect(await controller.browserOwnerForSession('unresolved-session')).toEqual({
      ok: false,
      error: 'browser_owner_unavailable',
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

function envelope(sessionId: string): GatewaySessionEnvelope {
  return {
    version: 1,
    sessionId,
    launch: { tier: 'balanced' },
    acceptedThroughSeq: 0,
    inFlightCommands: [],
    relayOutbox: [],
    updatedAt: 1,
  }
}
