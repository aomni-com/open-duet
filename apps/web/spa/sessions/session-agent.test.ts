import { expect, test } from 'bun:test'

import { sessionAgentIdentity } from './session-agent'

const PROFILES = [
  {
    id: 'agent_builder',
    slug: 'website-builder',
    name: 'Duet Builder',
    anchorPath: '/agents/website-builder',
    updatedAt: 1,
  },
  {
    id: 'agent_research',
    slug: 'research',
    name: undefined,
    anchorPath: '/agents/research',
    updatedAt: 1,
  },
]

test('a renamed agent speaks with its live name, not the one stamped at session creation', () => {
  const identity = sessionAgentIdentity({
    snapshotAgent: { id: 'agent_builder', name: 'website-builder' },
    pendingCwd: undefined,
    agents: PROFILES,
    workspaceSlug: 'acme',
  })
  expect(identity?.name).toBe('Duet Builder')
})

test('an agent the list no longer holds keeps the stamped name — the only one left', () => {
  const identity = sessionAgentIdentity({
    snapshotAgent: { id: 'agent_gone', name: 'old-hand' },
    pendingCwd: undefined,
    agents: PROFILES,
    workspaceSlug: 'acme',
  })
  expect(identity?.name).toBe('old-hand')
  expect(identity?.avatarKey).toBe('old-hand')
  expect(identity?.profile).toBeUndefined()
})

test('an agent never given a name is called by its slug', () => {
  const identity = sessionAgentIdentity({
    snapshotAgent: { id: 'agent_research', name: 'research' },
    pendingCwd: undefined,
    agents: PROFILES,
    workspaceSlug: 'acme',
  })
  expect(identity?.name).toBe('research')
  expect(identity?.avatarKey).toBe('research')
})

test('before the snapshot exists, the pending create names the agent by its cwd', () => {
  const identity = sessionAgentIdentity({
    snapshotAgent: undefined,
    pendingCwd: '/agents/website-builder',
    agents: PROFILES,
    workspaceSlug: 'acme',
  })
  expect(identity?.name).toBe('Duet Builder')
  expect(identity?.avatarKey).toBe('website-builder')
})

test('no snapshot and no pending cwd is a root session with no agent identity', () => {
  const identity = sessionAgentIdentity({
    snapshotAgent: undefined,
    pendingCwd: undefined,
    agents: PROFILES,
    workspaceSlug: 'acme',
  })
  expect(identity).toBeUndefined()
})

test('a pending cwd no agent anchors stays unattributed rather than guessed', () => {
  const identity = sessionAgentIdentity({
    snapshotAgent: undefined,
    pendingCwd: '/somewhere/else',
    agents: PROFILES,
    workspaceSlug: 'acme',
  })
  expect(identity).toBeUndefined()
})
